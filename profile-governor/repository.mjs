import { chmodSync, closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { profileError } from './errors.mjs';
import { ACTIONS, computeFenceDigest, computeLeaseBindingDigest, digestLf, isRfc3339DateTime, STATES, validateActionFence } from './contracts.mjs';
import { validateEventIntegrity, validateRedactedEvent } from './events.mjs';
import { validateRecoveryReceipt } from './recovery.mjs';

// Compatibility decision (finding 3): retain exact old contract `webmcp-profile-session-governor-state/1`
// but enforce an explicit, bounded additive migration gate: states missing `eventIntegrityDigests`
// or containing legacy `leaseBindingDigest` without profileAlias are treated as ambiguous legacy
// and fail closed with PROFILE_GOVERNOR_STATE_INVALID. No silent endorsement of untrusted bytes;
// recovery is by clearing the state file (operator-approved) or deterministic migration via
// re-acquire which recomputes digests under the hardened projection.
// Alternative of bumping to /2 would require coordinated rollout; the chosen gate keeps /1
// bytes deterministic while making hardening explicit and recoverable.
const STATE_SCHEMA = 'webmcp-profile-session-governor-state/1';
const MAX_STATE_BYTES = 2 * 1024 * 1024;

function emptyState() {
  return { schema: STATE_SCHEMA, serviceGeneration: 0, writerGeneration: 0, writerId: null, resources: {}, leases: {}, events: [], eventIntegrityDigests: [], receipts: [] };
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LEASE_ID = /^lease_[0-9a-f]{16}$/;
const FENCE_ID = /^fence_[0-9a-f]{16}$/;
const TAB_ID = /^tab_[a-z0-9-]{4,128}$/;
const ALIAS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BINDING_ID = /^pb_[a-z0-9-]+$/;
const RUN_ID = /^run_[a-z0-9-]{8,96}$/;
const PHYSICAL_ID = /^prsc_[a-zA-Z0-9._-]{2,512}$/;
const ACTION_ID = /^[a-z0-9_-]{4,80}$/;
const OUTCOMES = new Set(['prepared', 'dispatched', 'confirmed', 'failed-known', 'indeterminate']);
const ACTION_KINDS = new Set(['click', 'type', 'scroll', 'waitForStable', 'batch', 'read', 'queryIndexedDB']);

function invalidState(message) { throw profileError('PROFILE_GOVERNOR_STATE_INVALID', message); }
function isIso(value) { return isRfc3339DateTime(value); }
function assertString(value, pattern, label, max = 512) { if (typeof value !== 'string' || value.length > max || (pattern && !pattern.test(value))) invalidState(`${label} is invalid`); }
function assertDigest(value, label) { assertString(value, DIGEST, label, 71); }
function assertInteger(value, label, min, max = 2 ** 31 - 1) { if (!Number.isInteger(value) || value < min || value > max) invalidState(`${label} is invalid`); }
function assertActions(value, label) { if (!Array.isArray(value) || value.length < 1 || value.length > 8 || new Set(value).size !== value.length || value.some((action) => !ACTIONS.includes(action))) invalidState(`${label} is invalid`); }
function assertClosed(value, allowed, label) { const unknown = Object.keys(value).find((key) => !allowed.has(key)); if (unknown) invalidState(`${label} contains an unknown field`); }

function parseJsonRejectingDuplicateKeys(text, { maxDepth = 128 } = {}) {
  if (typeof text !== 'string') throw new SyntaxError('JSON text is required');
  let index = 0;
  const fail = () => { throw new SyntaxError('Invalid or duplicate-key JSON'); };
  const whitespace = () => { while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1; };
  const string = () => {
    if (text[index] !== '"') fail();
    const start = index++;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (code <= 0x1f) fail();
      if (text[index] === '\\') {
        index += 1;
        if (index >= text.length || !/["\\/bfnrtu]/.test(text[index])) fail();
        if (text[index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) fail();
          index += 4;
        }
      }
      index += 1;
    }
    fail();
  };
  const value = (depth) => {
    if (depth > maxDepth) fail();
    whitespace();
    if (text[index] === '{') {
      index += 1;
      whitespace();
      const keys = new Set();
      if (text[index] === '}') { index += 1; return; }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (text[index++] !== ':') fail();
        value(depth + 1);
        whitespace();
        const separator = text[index++];
        if (separator === '}') return;
        if (separator !== ',') fail();
      }
    }
    if (text[index] === '[') {
      index += 1;
      whitespace();
      if (text[index] === ']') { index += 1; return; }
      for (;;) {
        value(depth + 1);
        whitespace();
        const separator = text[index++];
        if (separator === ']') return;
        if (separator !== ',') fail();
      }
    }
    if (text[index] === '"') { string(); return; }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) { index += literal.length; return; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (!number) fail();
    index += number[0].length;
  };
  value(0);
  whitespace();
  if (index !== text.length) fail();
  return JSON.parse(text);
}

const RESOURCE_KEYS = new Set(['physicalResourceId', 'profileAlias', 'aliases', 'state', 'stateReasonCode', 'stateChangedAt', 'fenceEpoch', 'currentLeaseId', 'needsReconciliation', 'livenessSummary', 'cooldownUntil', 'recoveryPlanDigest', 'recoverySubjectKind', 'recoveryBindingId', 'recoveryBindingRevision', 'recoveryBindingDigest', 'lastRecoveryEvidenceDigest', 'lastRecoveredAt']);
const LEASE_KEYS = new Set(['leaseId', 'physicalResourceId', 'profileAlias', 'bindingId', 'bindingRevision', 'bindingDigest', 'runId', 'runnerClaimDigest', 'leaseMode', 'fenceEpoch', 'leaseBindingDigest', 'state', 'stateReasonCode', 'stateChangedAt', 'issuedAt', 'expiresAt', 'heartbeatIntervalMs', 'leaseTtlMs', 'nodeId', 'ownerType', 'idempotencyKey', 'fingerprint', 'requestedActions', 'allowedActions', 'tabs', 'maxTabs', 'actionUses', 'actionJournal', 'fences', 'heartbeatCount', 'releasedAt', 'recoveryPlanDigest']);

function validateResource(resource, physicalResourceId, leases) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) invalidState('resource record is invalid');
  assertClosed(resource, RESOURCE_KEYS, 'resource record');
  assertString(physicalResourceId, PHYSICAL_ID, 'resource key');
  assertString(resource.physicalResourceId, PHYSICAL_ID, 'resource.physicalResourceId');
  if (resource.physicalResourceId !== physicalResourceId) invalidState('resource physical identity is inconsistent');
  assertString(resource.profileAlias, ALIAS, 'resource.profileAlias', 64);
  if (!Array.isArray(resource.aliases) || resource.aliases.length < 1 || resource.aliases.length > 16 || new Set(resource.aliases).size !== resource.aliases.length || resource.aliases.some((alias) => typeof alias !== 'string' || !ALIAS.test(alias))) invalidState('resource aliases are invalid');
  if (!resource.aliases.includes(resource.profileAlias)) invalidState('resource aliases must bind the lease profile alias');
  if (!STATES.includes(resource.state)) invalidState('resource state is invalid');
  assertInteger(resource.fenceEpoch, 'resource.fenceEpoch', 0);
  if (resource.currentLeaseId !== null && !LEASE_ID.test(resource.currentLeaseId)) invalidState('resource currentLeaseId is invalid');
  if (typeof resource.needsReconciliation !== 'boolean') invalidState('resource reconciliation flag is invalid');
  if (!['healthy', 'failed', 'unknown'].includes(resource.livenessSummary)) invalidState('resource liveness summary is invalid');
  if (resource.cooldownUntil !== null && !isIso(resource.cooldownUntil)) invalidState('resource cooldownUntil is invalid');
  if (resource.recoveryPlanDigest !== undefined) assertDigest(resource.recoveryPlanDigest, 'resource.recoveryPlanDigest');
  if (resource.stateReasonCode !== undefined) assertString(resource.stateReasonCode, /^[A-Z][A-Z0-9_]{2,63}$/, 'resource.stateReasonCode', 64);
  if (resource.stateChangedAt !== undefined && !isIso(resource.stateChangedAt)) invalidState('resource.stateChangedAt is invalid');
  const hasSubjectKind = resource.recoverySubjectKind !== undefined;
  const hasBindingId = resource.recoveryBindingId !== undefined;
  const hasBindingRev = resource.recoveryBindingRevision !== undefined;
  const hasBindingDigest = resource.recoveryBindingDigest !== undefined;
  const tupleCount = (hasSubjectKind ? 1 : 0) + (hasBindingId ? 1 : 0) + (hasBindingRev ? 1 : 0) + (hasBindingDigest ? 1 : 0);
  if (tupleCount !== 0 && tupleCount !== 4) invalidState('resource recovery binding tuple must be all-or-nothing');
  if (hasSubjectKind) {
    if (resource.recoverySubjectKind !== 'unregistered-external' && resource.recoverySubjectKind !== 'registered-external') invalidState('resource recovery subject is invalid');
    assertString(resource.recoveryBindingId, BINDING_ID, 'resource.recoveryBindingId', 96);
    assertInteger(resource.recoveryBindingRevision, 'resource.recoveryBindingRevision', 1);
    assertDigest(resource.recoveryBindingDigest, 'resource.recoveryBindingDigest');
  }
  if (resource.lastRecoveryEvidenceDigest !== undefined) assertDigest(resource.lastRecoveryEvidenceDigest, 'resource.lastRecoveryEvidenceDigest');
  if (resource.lastRecoveredAt !== undefined && !isIso(resource.lastRecoveredAt)) invalidState('resource.lastRecoveredAt is invalid');
  if (resource.currentLeaseId) {
    const lease = leases[resource.currentLeaseId];
    if (!lease || lease.physicalResourceId !== physicalResourceId || lease.fenceEpoch !== resource.fenceEpoch) invalidState('resource current lease reference is inconsistent');
    if (hasSubjectKind) {
      if (resource.recoveryBindingId !== lease.bindingId || resource.recoveryBindingRevision !== lease.bindingRevision || resource.recoveryBindingDigest !== lease.bindingDigest) invalidState('resource recovery binding tuple does not match current lease');
      if (resource.recoverySubjectKind === 'registered-external' && lease.ownerType !== 'external') invalidState('registered-external subject kind requires external lease ownerType');
      if (resource.recoverySubjectKind === 'unregistered-external' && lease.ownerType !== 'external') invalidState('unregistered-external subject kind requires external lease ownerType');
    } else {
      if (lease.ownerType === 'external') invalidState('external lease requires recovery binding tuple');
    }
  }
  if (['leased', 'active'].includes(resource.state) && !resource.currentLeaseId) invalidState('leased resource has no current lease');
  if (['ready', 'cooldown'].includes(resource.state) && resource.currentLeaseId) invalidState('reusable resource still has a current lease');
  if (resource.state === 'quarantined' && !resource.currentLeaseId) invalidState('quarantined resource has no durable owner barrier');
}

function validateLease(lease, leaseId, resources) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) invalidState('lease record is invalid');
  assertClosed(lease, LEASE_KEYS, 'lease record');
  if (!LEASE_ID.test(leaseId) || lease.leaseId !== leaseId) invalidState('lease identity is inconsistent');
  assertString(lease.physicalResourceId, PHYSICAL_ID, 'lease.physicalResourceId');
  const resource = resources[lease.physicalResourceId];
  if (!resource) invalidState('lease physical resource is missing');
  assertString(lease.profileAlias, ALIAS, 'lease.profileAlias', 64);
  assertString(lease.bindingId, BINDING_ID, 'lease.bindingId', 96);
  assertInteger(lease.bindingRevision, 'lease.bindingRevision', 1);
  assertDigest(lease.bindingDigest, 'lease.bindingDigest');
  assertString(lease.runId, RUN_ID, 'lease.runId', 96);
  assertDigest(lease.runnerClaimDigest, 'lease.runnerClaimDigest');
  if (!['single-context', 'shared-trust-domain'].includes(lease.leaseMode)) invalidState('lease mode is invalid');
  assertInteger(lease.fenceEpoch, 'lease.fenceEpoch', 1);
  assertDigest(lease.leaseBindingDigest, 'lease.leaseBindingDigest');
  if (lease.leaseBindingDigest !== computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: lease.physicalResourceId, fenceEpoch: lease.fenceEpoch, profileAlias: lease.profileAlias })) invalidState('lease binding digest is inconsistent');
  if (!STATES.includes(lease.state)) invalidState('lease state is invalid');
  if (!isIso(lease.issuedAt) || !isIso(lease.expiresAt)) invalidState('lease timestamps are invalid');
  assertInteger(lease.heartbeatIntervalMs, 'lease.heartbeatIntervalMs', 1000, 120000);
  assertInteger(lease.leaseTtlMs, 'lease.leaseTtlMs', 5000, 600000);
  assertString(lease.nodeId, /^node-[a-z0-9-]+$/, 'lease.nodeId', 96);
  if (!['automation', 'external'].includes(lease.ownerType)) invalidState('lease ownerType is invalid');
  assertString(lease.idempotencyKey, /^[\x21-\x7e]{4,128}$/, 'lease.idempotencyKey', 128);
  assertString(lease.fingerprint, null, 'lease.fingerprint', 20000);
  assertActions(lease.requestedActions, 'lease.requestedActions');
  assertActions(lease.allowedActions, 'lease.allowedActions');
  if (!lease.tabs || typeof lease.tabs !== 'object' || Array.isArray(lease.tabs) || Object.keys(lease.tabs).length > 8) invalidState('lease tabs are invalid');
  assertInteger(lease.maxTabs, 'lease.maxTabs', 1, 8);
  for (const [tabHandle, tab] of Object.entries(lease.tabs)) {
    if (!TAB_ID.test(tabHandle) || !tab || typeof tab !== 'object' || Array.isArray(tab) || Object.keys(tab).some((key) => !['runId', 'createdAt'].includes(key)) || tab.runId !== lease.runId || !isIso(tab.createdAt)) invalidState('lease tab ownership is invalid');
  }
  assertInteger(lease.actionUses, 'lease.actionUses', 0, 1000000);
  if (!Array.isArray(lease.actionJournal) || lease.actionJournal.length > 64) invalidState('lease action journal is invalid');
  for (const entry of lease.actionJournal) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => !['actionId', 'fenceId', 'outcome', 'at', 'actionKind'].includes(key)) || !ACTION_ID.test(entry.actionId) || !OUTCOMES.has(entry.outcome) || !isIso(entry.at)) invalidState('lease action journal entry is invalid');
    if (entry.fenceId !== undefined && !FENCE_ID.test(entry.fenceId)) invalidState('lease action journal fence is invalid');
    if (entry.actionKind !== undefined && !ACTION_KINDS.has(entry.actionKind)) invalidState('lease action journal action kind is invalid');
  }
  if (!lease.fences || typeof lease.fences !== 'object' || Array.isArray(lease.fences)) invalidState('lease fences are invalid');
  for (const [fenceId, issued] of Object.entries(lease.fences)) {
    if (!FENCE_ID.test(fenceId) || !issued || typeof issued !== 'object' || Array.isArray(issued) || Object.keys(issued).some((key) => !['proof', 'uses'].includes(key)) || !Number.isInteger(issued.uses) || issued.uses < 0 || !issued.proof) invalidState('lease issued fence is invalid');
    try { validateActionFence(issued.proof); } catch { invalidState('lease issued fence proof is invalid'); }
    if (issued.proof.fenceId !== fenceId || issued.proof.leaseId !== leaseId || issued.proof.fenceEpoch !== lease.fenceEpoch || issued.proof.leaseBindingDigest !== lease.leaseBindingDigest || issued.proof.runId !== lease.runId || issued.proof.bindingId !== lease.bindingId || issued.proof.fenceDigest !== computeFenceDigest(issued.proof) || issued.uses > issued.proof.maxUses) invalidState('lease issued fence binding is inconsistent');
  }
  // lease identity must bind resource/profile identity (finding 1)
  if (!resource.aliases.includes(lease.profileAlias)) invalidState('lease profile alias must be bound by resource aliases');
  if (resource.profileAlias !== lease.profileAlias && !resource.aliases.includes(lease.profileAlias)) invalidState('lease identity does not bind resource profile identity');
  if (lease.stateReasonCode !== undefined) assertString(lease.stateReasonCode, /^[A-Z][A-Z0-9_]{2,63}$/, 'lease.stateReasonCode', 64);
  if (lease.stateChangedAt !== undefined && !isIso(lease.stateChangedAt)) invalidState('lease.stateChangedAt is invalid');
  if (lease.heartbeatCount !== undefined) assertInteger(lease.heartbeatCount, 'lease.heartbeatCount', 0, 1000000);
  if (lease.releasedAt !== undefined && !isIso(lease.releasedAt)) invalidState('lease.releasedAt is invalid');
  if (lease.recoveryPlanDigest !== undefined) assertDigest(lease.recoveryPlanDigest, 'lease.recoveryPlanDigest');
  if (!['cooldown'].includes(lease.state) && resource.currentLeaseId !== leaseId) invalidState('active lease is not the current resource owner');
}

function validateState(value) {
  const stateKeys = new Set(['schema', 'serviceGeneration', 'writerGeneration', 'writerId', 'resources', 'leases', 'events', 'eventIntegrityDigests', 'receipts']);
  // Explicit migration gate: legacy state missing eventIntegrityDigests or with ambiguous hardened fields must fail closed
  if (value && typeof value === 'object' && !Array.isArray(value) && value.schema === STATE_SCHEMA && (!Array.isArray(value.eventIntegrityDigests) || !Array.isArray(value.events))) {
    throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'legacy governor state without integrity digests is not trusted and requires migration');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || [...stateKeys].some((key) => !Object.hasOwn(value, key)) || value.schema !== STATE_SCHEMA || !Number.isInteger(value.serviceGeneration) || value.serviceGeneration < 0 || !Number.isInteger(value.writerGeneration) || value.writerGeneration < 0 || (value.writerId !== null && (typeof value.writerId !== 'string' || !/^[a-z0-9_-]{4,128}$/.test(value.writerId)))) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state schema is invalid');
  assertClosed(value, stateKeys, 'Governor state');
  for (const key of ['resources', 'leases']) if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state collections are invalid');
  if (!Array.isArray(value.events) || !Array.isArray(value.eventIntegrityDigests) || !Array.isArray(value.receipts)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state journals are invalid');
  if (value.events.length > 256 || value.receipts.length > 128) invalidState('Governor state journal bounds are invalid');
  validateEventIntegrity(value);
  for (const [physicalResourceId, resource] of Object.entries(value.resources)) validateResource(resource, physicalResourceId, value.leases);
  for (const [leaseId, lease] of Object.entries(value.leases)) validateLease(lease, leaseId, value.resources);
  for (const resource of Object.values(value.resources)) {
    if (resource.currentLeaseId) {
      const lease = value.leases[resource.currentLeaseId];
      if (!lease || lease.physicalResourceId !== resource.physicalResourceId) invalidState('current lease reference is invalid');
    }
  }
  for (const event of value.events) {
    validateRedactedEvent(event);
    const lease = value.leases[event.leaseId];
    if (!lease || event.profileAlias !== lease.profileAlias || event.bindingDigest !== lease.bindingDigest || (event.bindingId !== undefined && event.bindingId !== lease.bindingId) || (event.runId !== undefined && event.runId !== lease.runId) || event.fenceEpoch > lease.fenceEpoch) invalidState('event identity does not match its durable lease');
    if (event.leaseBindingDigest !== undefined && event.leaseBindingDigest !== computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: lease.physicalResourceId, fenceEpoch: event.fenceEpoch, profileAlias: lease.profileAlias })) invalidState('event lease binding digest is invalid');
  }
  for (const receipt of value.receipts) {
    validateRecoveryReceipt(receipt, { requireOperationalFields: true });
    const lease = value.leases[receipt.leaseId];
    if (!lease || receipt.profileAlias !== lease.profileAlias || (receipt.bindingId !== undefined && receipt.bindingId !== lease.bindingId) || (receipt.bindingRevision !== undefined && receipt.bindingRevision !== lease.bindingRevision) || (receipt.bindingDigest !== undefined && receipt.bindingDigest !== lease.bindingDigest) || (receipt.runId !== undefined && receipt.runId !== lease.runId) || receipt.newFenceEpoch > lease.fenceEpoch) invalidState('recovery receipt identity does not match its durable lease');
    if (receipt.eventId !== undefined) {
      const event = value.events.find((entry) => entry.eventId === receipt.eventId);
      if (!event || event.leaseId !== receipt.leaseId || event.profileAlias !== receipt.profileAlias || event.fenceEpoch !== receipt.newFenceEpoch || (receipt.bindingDigest !== undefined && event.bindingDigest !== receipt.bindingDigest)) {
        invalidState('recovery receipt referenced event is invalid or missing');
      }
    }
  }
  return value;
}

export class GovernorRepository {
  constructor({ statePath, path: statePathAlias, lockPath, maxStateBytes = MAX_STATE_BYTES } = {}) {
    statePath = statePath || statePathAlias;
    if (typeof statePath !== 'string' || !statePath) throw profileError('PROFILE_GOVERNOR_UNAVAILABLE', 'Governor state path is required');
    this.statePath = resolve(statePath);
    this.lockPath = resolve(lockPath || `${this.statePath}.writer`);
    this.maxStateBytes = maxStateBytes;
    this._ensureDirectory();
    this.writerId = `writer_${randomBytes(8).toString('hex')}`;
    this._closed = false;
    this._acquireWriter();
  }

  _ensureDirectory() {
    const parent = dirname(this.statePath);
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const directory = lstatSync(parent);
      if (!directory.isDirectory()) throw new Error('not-private-directory');
      chmodSync(parent, 0o700);
      if ((lstatSync(parent).mode & 0o777) !== 0o700) throw new Error('directory-mode');
    } catch { throw profileError('PROFILE_GOVERNOR_UNAVAILABLE', 'Governor state directory is unavailable'); }
  }

  _readUnlocked() {
    let file;
    try { file = lstatSync(this.statePath); } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw profileError('PROFILE_GOVERNOR_UNAVAILABLE', 'Governor state cannot be inspected');
    }
    if (!file.isFile() || (file.mode & 0o777) !== 0o600) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state must be a private regular file');
    if (file.size > this.maxStateBytes) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state exceeds the bounded size');
    let fd;
    let text;
    try {
      fd = openSync(this.statePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.dev !== file.dev || opened.ino !== file.ino || opened.size > this.maxStateBytes) throw new Error('state-inspection-race');
      text = readFileSync(fd, 'utf8');
    } catch { throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state must remain a private regular file'); }
    finally { if (fd !== undefined) closeSync(fd); }
    let parsed;
    try { parsed = parseJsonRejectingDuplicateKeys(text); } catch { throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state is not valid unique-key JSON'); }
    return validateState(parsed);
  }

  read() {
    return this._readUnlocked();
  }

  _acquireWriter() {
    const ownerPath = `${this.lockPath}/owner.json`;
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        mkdirSync(this.lockPath, { mode: 0o700 });
        const created = lstatSync(this.lockPath);
        if (!created.isDirectory() || (created.mode & 0o777) !== 0o700) throw new Error('writer-lock-not-private');
        writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, writerId: this.writerId }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        this._syncDirectory(this.lockPath);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw profileError('PROFILE_GOVERNOR_MULTI_WRITER', 'Governor writer lock is unavailable');
        let owner;
        try {
          const lock = lstatSync(this.lockPath);
          const ownerFile = lstatSync(ownerPath);
          if (!lock.isDirectory() || (lock.mode & 0o777) !== 0o700 || !ownerFile.isFile() || (ownerFile.mode & 0o777) !== 0o600) throw new Error('writer-files-not-private');
          owner = this._readWriterOwner(ownerPath);
        } catch { throw profileError('PROFILE_GOVERNOR_MULTI_WRITER', 'Governor writer ownership is indeterminate'); }
        const pid = owner?.pid;
        let alive = true;
        if (Number.isInteger(pid) && pid !== process.pid) {
          try { process.kill(pid, 0); } catch (probeError) { alive = probeError.code !== 'ESRCH'; }
        }
        if (alive) throw profileError('PROFILE_GOVERNOR_MULTI_WRITER', 'Another Governor writer is active');
        try { rmSync(this.lockPath, { recursive: true, force: false }); } catch { /* another writer won the race */ }
        if (Date.now() >= deadline) throw profileError('PROFILE_GOVERNOR_MULTI_WRITER', 'Governor writer restart window expired');
      }
    }
  }

  _assertWriter() {
    if (this._closed) throw profileError('PROFILE_GOVERNOR_MULTI_WRITER', 'Governor writer is closed');
    try {
      const lock = lstatSync(this.lockPath);
      if (!lock.isDirectory() || (lock.mode & 0o777) !== 0o700) throw new Error('lock changed');
      const owner = this._readWriterOwner(`${this.lockPath}/owner.json`);
      if (owner.pid !== process.pid || owner.writerId !== this.writerId) throw new Error('owner changed');
    } catch { throw profileError('PROFILE_GOVERNOR_MULTI_WRITER', 'Governor writer ownership is lost'); }
  }

  _readWriterOwner(ownerPath) {
    const before = lstatSync(ownerPath);
    if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size > 1024) throw new Error('owner-not-private-regular');
    let fd;
    try {
      fd = openSync(ownerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 1024) throw new Error('owner-inspection-race');
      const owner = parseJsonRejectingDuplicateKeys(readFileSync(fd, 'utf8'), { maxDepth: 4 });
      if (!owner || typeof owner !== 'object' || Array.isArray(owner) || Object.keys(owner).length !== 2 || !Object.hasOwn(owner, 'pid') || !Object.hasOwn(owner, 'writerId') || !Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.writerId !== 'string' || !/^[a-z0-9_-]{4,128}$/.test(owner.writerId)) throw new Error('owner-invalid');
      return owner;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  _syncDirectory(directory) {
    let fd;
    try { fd = openSync(directory, 'r'); fsyncSync(fd); } catch { throw profileError('PROFILE_GOVERNOR_UNAVAILABLE', 'Governor directory durability could not be confirmed'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  _writeUnlocked(state) {
    const text = `${JSON.stringify(validateState(state))}\n`;
    if (Buffer.byteLength(text, 'utf8') > this.maxStateBytes) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state exceeds the bounded size');
    const tmpDir = mkdtempSync(`${dirname(this.statePath)}/.governor-`);
    const tmp = `${tmpDir}/state.json`;
    let fd;
    try {
      this._assertSafeStateTarget();
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, text, { encoding: 'utf8' });
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      chmodSync(tmp, 0o600);
      this._assertSafeStateTarget();
      renameSync(tmp, this.statePath);
      chmodSync(this.statePath, 0o600);
      const persisted = lstatSync(this.statePath);
      if (!persisted.isFile() || (persisted.mode & 0o777) !== 0o600) throw new Error('state-not-private');
      this._syncDirectory(dirname(this.statePath));
    } catch (error) { if (fd !== undefined) closeSync(fd); if (error?.code?.startsWith?.('PROFILE_')) throw error; throw profileError('PROFILE_GOVERNOR_UNAVAILABLE', 'Governor state could not be persisted'); }
    finally { try { rmdirSync(tmpDir); } catch { /* temp directory is private and normally empty */ } }
  }

  _assertSafeStateTarget() {
    try {
      const target = lstatSync(this.statePath);
      if (!target.isFile() || (target.mode & 0o777) !== 0o600) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state replacement target is not a private regular file');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (error?.code?.startsWith?.('PROFILE_')) throw error;
      throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state replacement target is indeterminate');
    }
  }

  transact(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
    this._assertWriter();
    const state = this._readUnlocked();
    const writerGeneration = state.writerGeneration;
    const result = mutator(state);
    this._assertWriter();
    state.writerGeneration = writerGeneration + 1;
    state.writerId = this.writerId;
    this._writeUnlocked(state);
    return result;
  }

  markStartupUnknown() {
    return this.transact((state) => {
      state.serviceGeneration += 1;
      for (const resource of Object.values(state.resources)) {
        const lease = resource.currentLeaseId ? state.leases[resource.currentLeaseId] : null;
        const isExternal = resource.state === 'external_use' || resource.recoverySubjectKind === 'unregistered-external' || resource.recoverySubjectKind === 'registered-external' || lease?.ownerType === 'external';
        resource.state = isExternal ? 'external_use' : 'unknown';
        resource.stateReasonCode = isExternal ? 'PROFILE_EXTERNAL_USE' : 'RECOVERY_HOST_RESTART';
        resource.needsReconciliation = true;
        resource.livenessSummary = 'unknown';
        if (lease) {
          const planReason = isExternal ? 'PROFILE_EXTERNAL_USE' : 'RECOVERY_HOST_RESTART';
          lease.recoveryPlanDigest = digestLf('webmcp-digest-v1:recovery', { bindingDigest: lease.bindingDigest, fenceEpoch: resource.fenceEpoch, leaseId: lease.leaseId, reasonCode: planReason });
          resource.recoveryPlanDigest = lease.recoveryPlanDigest;
        }
      }
      return state.serviceGeneration;
    });
  }

  close() {
    if (this._closed) return;
    this._assertWriter();
    this._closed = true;
    try { rmSync(`${this.lockPath}/owner.json`, { force: true }); rmdirSync(this.lockPath); } catch { /* preserve ownership if cleanup is interrupted */ }
  }
}

export const createGovernorRepository = (options) => new GovernorRepository(options);

export { STATE_SCHEMA };
