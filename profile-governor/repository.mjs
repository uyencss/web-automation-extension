import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { profileError } from './errors.mjs';
import { ACTIONS, computeLeaseBindingDigest, digestLf, SCHEMAS, STATES, validateActionFence } from './contracts.mjs';

const STATE_SCHEMA = 'webmcp-profile-session-governor-state/1';
const MAX_STATE_BYTES = 2 * 1024 * 1024;

function emptyState() {
  return { schema: STATE_SCHEMA, serviceGeneration: 0, writerGeneration: 0, writerId: null, resources: {}, leases: {}, events: [], receipts: [] };
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

function invalidState(message) { throw profileError('PROFILE_GOVERNOR_STATE_INVALID', message); }
function isIso(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function assertString(value, pattern, label, max = 512) { if (typeof value !== 'string' || value.length > max || (pattern && !pattern.test(value))) invalidState(`${label} is invalid`); }
function assertDigest(value, label) { assertString(value, DIGEST, label, 71); }
function assertInteger(value, label, min, max = 2 ** 31 - 1) { if (!Number.isInteger(value) || value < min || value > max) invalidState(`${label} is invalid`); }
function assertActions(value, label) { if (!Array.isArray(value) || value.length < 1 || value.length > 8 || new Set(value).size !== value.length || value.some((action) => !ACTIONS.includes(action))) invalidState(`${label} is invalid`); }

function validateResource(resource, physicalResourceId, leases) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) invalidState('resource record is invalid');
  assertString(physicalResourceId, PHYSICAL_ID, 'resource key');
  assertString(resource.physicalResourceId, PHYSICAL_ID, 'resource.physicalResourceId');
  if (resource.physicalResourceId !== physicalResourceId) invalidState('resource physical identity is inconsistent');
  assertString(resource.profileAlias, ALIAS, 'resource.profileAlias', 64);
  if (!Array.isArray(resource.aliases) || resource.aliases.length < 1 || resource.aliases.length > 16 || new Set(resource.aliases).size !== resource.aliases.length || resource.aliases.some((alias) => typeof alias !== 'string' || !ALIAS.test(alias))) invalidState('resource aliases are invalid');
  if (!STATES.includes(resource.state)) invalidState('resource state is invalid');
  assertInteger(resource.fenceEpoch, 'resource.fenceEpoch', 0);
  if (resource.currentLeaseId !== null && !LEASE_ID.test(resource.currentLeaseId)) invalidState('resource currentLeaseId is invalid');
  if (typeof resource.needsReconciliation !== 'boolean') invalidState('resource reconciliation flag is invalid');
  if (!['healthy', 'failed', 'unknown'].includes(resource.livenessSummary)) invalidState('resource liveness summary is invalid');
  if (resource.cooldownUntil !== null && !isIso(resource.cooldownUntil)) invalidState('resource cooldownUntil is invalid');
  if (resource.recoveryPlanDigest !== undefined) assertDigest(resource.recoveryPlanDigest, 'resource.recoveryPlanDigest');
  if (resource.currentLeaseId) {
    const lease = leases[resource.currentLeaseId];
    if (!lease || lease.physicalResourceId !== physicalResourceId || lease.fenceEpoch !== resource.fenceEpoch) invalidState('resource current lease reference is inconsistent');
  }
  if (['leased', 'active'].includes(resource.state) && !resource.currentLeaseId) invalidState('leased resource has no current lease');
  if (['ready', 'cooldown'].includes(resource.state) && resource.currentLeaseId) invalidState('reusable resource still has a current lease');
  if (resource.state === 'quarantined' && !resource.currentLeaseId) invalidState('quarantined resource has no durable owner barrier');
}

function validateLease(lease, leaseId, resources) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) invalidState('lease record is invalid');
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
  if (lease.leaseBindingDigest !== computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: lease.physicalResourceId, fenceEpoch: lease.fenceEpoch })) invalidState('lease binding digest is inconsistent');
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
    if (!TAB_ID.test(tabHandle) || !tab || typeof tab !== 'object' || tab.runId !== lease.runId || !isIso(tab.createdAt)) invalidState('lease tab ownership is invalid');
  }
  assertInteger(lease.actionUses, 'lease.actionUses', 0, 1000000);
  if (!Array.isArray(lease.actionJournal) || lease.actionJournal.length > 64) invalidState('lease action journal is invalid');
  for (const entry of lease.actionJournal) {
    if (!entry || typeof entry !== 'object' || !ACTION_ID.test(entry.actionId) || !OUTCOMES.has(entry.outcome) || !isIso(entry.at)) invalidState('lease action journal entry is invalid');
    if (entry.fenceId !== undefined && !FENCE_ID.test(entry.fenceId)) invalidState('lease action journal fence is invalid');
    if (entry.actionKind !== undefined && typeof entry.actionKind !== 'string') invalidState('lease action journal action kind is invalid');
  }
  if (!lease.fences || typeof lease.fences !== 'object' || Array.isArray(lease.fences)) invalidState('lease fences are invalid');
  for (const [fenceId, issued] of Object.entries(lease.fences)) {
    if (!FENCE_ID.test(fenceId) || !issued || typeof issued !== 'object' || !Number.isInteger(issued.uses) || issued.uses < 0 || !issued.proof) invalidState('lease issued fence is invalid');
    try { validateActionFence(issued.proof); } catch { invalidState('lease issued fence proof is invalid'); }
    if (issued.proof.fenceId !== fenceId || issued.proof.leaseId !== leaseId || issued.proof.fenceEpoch !== lease.fenceEpoch || issued.proof.leaseBindingDigest !== lease.leaseBindingDigest || issued.proof.runId !== lease.runId || issued.proof.bindingId !== lease.bindingId || issued.uses > issued.proof.maxUses) invalidState('lease issued fence binding is inconsistent');
  }
  if (!['cooldown'].includes(lease.state) && resource.currentLeaseId !== leaseId) invalidState('active lease is not the current resource owner');
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== STATE_SCHEMA || !Number.isInteger(value.serviceGeneration) || value.serviceGeneration < 0 || (value.writerGeneration !== undefined && (!Number.isInteger(value.writerGeneration) || value.writerGeneration < 0)) || (value.writerId !== undefined && value.writerId !== null && typeof value.writerId !== 'string')) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state schema is invalid');
  if (value.writerGeneration === undefined) value.writerGeneration = 0;
  if (value.writerId === undefined) value.writerId = null;
  for (const key of ['resources', 'leases']) if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state collections are invalid');
  if (!Array.isArray(value.events) || !Array.isArray(value.receipts)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state journals are invalid');
  if (value.events.length > 256 || value.receipts.length > 128) invalidState('Governor state journal bounds are invalid');
  for (const [physicalResourceId, resource] of Object.entries(value.resources)) validateResource(resource, physicalResourceId, value.leases);
  for (const [leaseId, lease] of Object.entries(value.leases)) validateLease(lease, leaseId, value.resources);
  for (const resource of Object.values(value.resources)) {
    if (resource.currentLeaseId) {
      const lease = value.leases[resource.currentLeaseId];
      if (!lease || lease.physicalResourceId !== resource.physicalResourceId) invalidState('current lease reference is invalid');
    }
  }
  for (const event of value.events) {
    if (!event || typeof event !== 'object' || event.schema !== SCHEMAS.event || typeof event.eventId !== 'string' || !/^pse_[0-9a-f]{16}$/.test(event.eventId)) invalidState('event record is invalid');
  }
  for (const receipt of value.receipts) {
    if (!receipt || typeof receipt !== 'object' || receipt.schema !== SCHEMAS.receipt || typeof receipt.receiptId !== 'string' || !/^prr_[0-9a-f]{16}$/.test(receipt.receiptId) || !DIGEST.test(receipt.receiptDigest)) invalidState('recovery receipt is invalid');
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
    let stats;
    try { stats = statSync(this.statePath); } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw profileError('PROFILE_GOVERNOR_UNAVAILABLE', 'Governor state cannot be inspected');
    }
    if (stats.size > this.maxStateBytes) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state exceeds the bounded size');
    try {
      const file = lstatSync(this.statePath);
      if (!file.isFile() || (file.mode & 0o777) !== 0o600) throw new Error('not-private-regular');
    } catch { throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state must be a private regular file'); }
    let parsed;
    try { parsed = JSON.parse(readFileSync(this.statePath, 'utf8')); } catch { throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state is not valid JSON'); }
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
          owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
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
      const owner = JSON.parse(readFileSync(`${this.lockPath}/owner.json`, 'utf8'));
      if (owner.pid !== process.pid || owner.writerId !== this.writerId) throw new Error('owner changed');
    } catch { throw profileError('PROFILE_GOVERNOR_MULTI_WRITER', 'Governor writer ownership is lost'); }
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
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, text, { encoding: 'utf8' });
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.statePath);
      chmodSync(this.statePath, 0o600);
      const persisted = lstatSync(this.statePath);
      if (!persisted.isFile() || (persisted.mode & 0o777) !== 0o600) throw new Error('state-not-private');
      this._syncDirectory(dirname(this.statePath));
    } catch { if (fd !== undefined) closeSync(fd); throw profileError('PROFILE_GOVERNOR_UNAVAILABLE', 'Governor state could not be persisted'); }
    finally { try { rmdirSync(tmpDir); } catch { /* temp directory is private and normally empty */ } }
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
        resource.state = 'unknown';
        resource.stateReasonCode = 'RECOVERY_HOST_RESTART';
        resource.needsReconciliation = true;
        resource.livenessSummary = 'unknown';
        const lease = resource.currentLeaseId ? state.leases[resource.currentLeaseId] : null;
        if (lease) {
          lease.recoveryPlanDigest = digestLf('webmcp-digest-v1:recovery', { bindingDigest: lease.bindingDigest, fenceEpoch: resource.fenceEpoch, leaseId: lease.leaseId, reasonCode: 'RECOVERY_HOST_RESTART' });
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
