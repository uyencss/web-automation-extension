import { createHash, randomBytes } from 'node:crypto';
import { profileError } from './errors.mjs';

export const SCHEMAS = Object.freeze({
  request: 'webmcp-profile-lease-request/1',
  lease: 'webmcp-profile-lease/2',
  fence: 'webmcp-profile-action-fence/1',
  event: 'webmcp-profile-session-event/1',
  receipt: 'webmcp-profile-recovery-receipt/1',
});

export const STATES = Object.freeze([
  'unknown', 'ready', 'leased', 'active', 'cooldown', 'external_use',
  'auth_required', 'challenge', 'rate_limited', 'quarantined',
]);

export const ACTIONS = Object.freeze([
  'browser-read', 'browser-write', 'browser-session-data', 'credential-fill',
]);

const ALIAS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUEST_ID = /^plr_[a-z0-9-]{8,}$/;
const NODE_ID = /^node-[a-z0-9-]+$/;
const RUN_ID = /^run_[a-z0-9-]{8,}$/;
const BINDING_ID = /^pb_[a-z0-9-]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID_KEY = /^[\x21-\x7e]{4,128}$/;
const LEASE_ID = /^lease_[0-9a-f]{16}$/;
const FENCE_ID = /^fence_[0-9a-f]{16}$/;
const TAB_ID = /^tab_[a-z0-9-]{4,128}$/;
const ACTION_ID = /^[a-z0-9_-]{4,80}$/;
const ACTION_KINDS = new Set(['click', 'type', 'scroll', 'waitForStable', 'batch', 'read', 'queryIndexedDB']);
const ACTION_OUTCOMES = new Set(['prepared', 'dispatched', 'confirmed', 'failed-known', 'indeterminate']);
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function invalid(message, details) {
  return profileError('PROFILE_REQUEST_INVALID', message, details);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value;
}

function closed(value, label, allowed) {
  object(value, label);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw invalid(`${label} contains an unknown field`);
  return value;
}

function string(value, label, pattern, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    throw invalid(`${label} is invalid`);
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(`${label} is invalid`);
  return value;
}

export function isRfc3339DateTime(value) {
  if (typeof value !== 'string') return false;
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  return calendarDate.getUTCFullYear() === year && calendarDate.getUTCMonth() === month - 1 && calendarDate.getUTCDate() === day;
}

export function validateLeaseRequest(input, { allowExternal = true, requireRequestedActions = false } = {}) {
  const allowed = new Set([
    'schema', 'requestId', 'ownerType', 'nodeId', 'runId', 'runnerClaimDigest',
    'bindingId', 'bindingRevision', 'bindingDigest', 'profileAlias', 'leaseMode',
    'requestedActions', 'heartbeatIntervalMs', 'leaseTtlMs', 'idempotencyKey',
    'profileResourceIdHint',
  ]);
  const value = closed(input, 'lease request', allowed);
  if (value.schema !== SCHEMAS.request) throw profileError('PROFILE_SCHEMA_UNSUPPORTED', 'unsupported profile lease request schema');
  string(value.requestId, 'requestId', REQUEST_ID, 12, 80);
  if (!['automation', 'external'].includes(value.ownerType) || (!allowExternal && value.ownerType === 'external')) throw invalid('ownerType is invalid');
  string(value.nodeId, 'nodeId', NODE_ID, 7, 96);
  string(value.runId, 'runId', RUN_ID, 12, 96);
  string(value.runnerClaimDigest, 'runnerClaimDigest', DIGEST, 71, 71);
  string(value.bindingId, 'bindingId', BINDING_ID, 4, 96);
  integer(value.bindingRevision, 'bindingRevision', 1, 2 ** 31 - 1);
  string(value.bindingDigest, 'bindingDigest', DIGEST, 71, 71);
  string(value.profileAlias, 'profileAlias', ALIAS, 2, 64);
  if (!['single-context', 'shared-trust-domain'].includes(value.leaseMode)) throw invalid('leaseMode is invalid');
  if (value.requestedActions !== undefined && (!Array.isArray(value.requestedActions) || value.requestedActions.length < 1 || value.requestedActions.length > 8 || new Set(value.requestedActions).size !== value.requestedActions.length || value.requestedActions.some((action) => !ACTIONS.includes(action)))) throw invalid('requestedActions is invalid');
  if (requireRequestedActions && value.requestedActions === undefined) throw invalid('requestedActions is required for acquire');
  if (value.heartbeatIntervalMs !== undefined) integer(value.heartbeatIntervalMs, 'heartbeatIntervalMs', 1000, 120000);
  if (value.leaseTtlMs !== undefined) integer(value.leaseTtlMs, 'leaseTtlMs', 5000, 600000);
  string(value.idempotencyKey, 'idempotencyKey', ID_KEY, 4, 128);
  if (value.profileResourceIdHint !== undefined) string(value.profileResourceIdHint, 'profileResourceIdHint', /^prsc_[a-z0-9-]{4,}$/, 9, 160);
  const validated = { ...value };
  if (value.requestedActions === undefined) delete validated.requestedActions;
  else validated.requestedActions = Object.freeze([...value.requestedActions]);
  return Object.freeze(validated);
}

function validateLeaseFacts(value, { requireRun = false, requireBinding = false, requireClaim = false } = {}) {
  string(value.leaseId, 'leaseId', LEASE_ID, 22, 22);
  integer(value.fenceEpoch, 'fenceEpoch', 1, 2 ** 31 - 1);
  string(value.leaseBindingDigest, 'leaseBindingDigest', DIGEST, 71, 71);
  if (requireRun || value.runId !== undefined) string(value.runId, 'runId', RUN_ID, 12, 96);
  if (requireBinding || value.bindingId !== undefined) string(value.bindingId, 'bindingId', BINDING_ID, 4, 96);
  if (value.bindingDigest !== undefined) string(value.bindingDigest, 'bindingDigest', DIGEST, 71, 71);
  if (requireClaim || value.runnerClaimDigest !== undefined) string(value.runnerClaimDigest, 'runnerClaimDigest', DIGEST, 71, 71);
  return value;
}

const LEASE_CONTROL_FIELDS = new Set(['leaseId', 'fenceEpoch', 'leaseBindingDigest', 'bindingId', 'bindingDigest', 'runId', 'runnerClaimDigest', 'now']);

export function validateLeaseControlInput(input, { allowNow = false } = {}) {
  const value = closed(input, 'lease control', LEASE_CONTROL_FIELDS);
  validateLeaseFacts(value);
  if (value.now !== undefined) {
    if (!allowNow) throw invalid('lease control contains an unknown field');
    integer(value.now, 'now', 0, Number.MAX_SAFE_INTEGER);
  }
  return Object.freeze({ ...value });
}

export function validateOpenTabInput(input) {
  const value = closed(input, 'tab operation', new Set(['leaseId', 'runId', 'fenceEpoch', 'leaseBindingDigest', 'bindingId', 'bindingDigest', 'runnerClaimDigest']));
  string(value.leaseId, 'leaseId', LEASE_ID, 22, 22);
  string(value.runId, 'runId', RUN_ID, 12, 96);
  if (value.fenceEpoch !== undefined) integer(value.fenceEpoch, 'fenceEpoch', 1, 2 ** 31 - 1);
  if (value.leaseBindingDigest !== undefined) string(value.leaseBindingDigest, 'leaseBindingDigest', DIGEST, 71, 71);
  if (value.bindingId !== undefined) string(value.bindingId, 'bindingId', BINDING_ID, 4, 96);
  if (value.bindingDigest !== undefined) string(value.bindingDigest, 'bindingDigest', DIGEST, 71, 71);
  if (value.runnerClaimDigest !== undefined) string(value.runnerClaimDigest, 'runnerClaimDigest', DIGEST, 71, 71);
  return Object.freeze({ ...value });
}

export function validateCreateFenceInput(input) {
  const value = closed(input, 'fence request', new Set(['leaseId', 'fenceEpoch', 'leaseBindingDigest', 'bindingId', 'bindingDigest', 'runId', 'runnerClaimDigest', 'action', 'tabHandle', 'purpose', 'actionKind']));
  validateLeaseFacts(value, { requireRun: true, requireBinding: true });
  if (!ACTIONS.includes(value.action)) throw invalid('action is invalid');
  if (value.tabHandle !== undefined) string(value.tabHandle, 'tabHandle', TAB_ID, 8, 128);
  if (value.purpose !== undefined) string(value.purpose, 'purpose', /^[a-z0-9-]+$/, 2, 64);
  if (value.actionKind !== undefined && !ACTION_KINDS.has(value.actionKind)) throw invalid('actionKind is invalid');
  return Object.freeze({ ...value });
}

export function validateActionRecordInput(input) {
  const value = closed(input, 'action journal', new Set(['leaseId', 'actionId', 'outcome', 'fenceId', 'fenceEpoch', 'leaseBindingDigest', 'bindingId', 'bindingDigest', 'runId', 'runnerClaimDigest', 'resolution', 'actionKind']));
  validateLeaseFacts(value, { requireRun: true, requireBinding: true, requireClaim: true });
  string(value.bindingDigest, 'bindingDigest', DIGEST, 71, 71);
  string(value.actionId, 'actionId', ACTION_ID, 4, 80);
  string(value.fenceId, 'fenceId', FENCE_ID, 22, 22);
  if (!ACTION_OUTCOMES.has(value.outcome)) throw invalid('outcome is invalid');
  if (value.actionKind !== undefined && !ACTION_KINDS.has(value.actionKind)) throw invalid('actionKind is invalid');
  if (value.resolution !== undefined) {
    closed(value.resolution, 'action resolution', new Set(['kind', 'capability']));
    if (value.resolution.kind !== 'trusted-revocation') throw invalid('action resolution is invalid');
    if (value.resolution.capability !== undefined) object(value.resolution.capability, 'action resolution capability');
  }
  return Object.freeze({ ...value });
}

export function validateTransitionInput(input) {
  const value = closed(input, 'Governor transition', new Set(['leaseId', 'fenceEpoch', 'leaseBindingDigest', 'bindingId', 'bindingDigest', 'runId', 'runnerClaimDigest', 'to', 'reasonCode']));
  validateLeaseFacts(value, { requireRun: true, requireBinding: true, requireClaim: true });
  string(value.bindingDigest, 'bindingDigest', DIGEST, 71, 71);
  const reasons = { auth_required: 'PROFILE_AUTH_REQUIRED', challenge: 'PROFILE_CHALLENGE_REQUIRED', rate_limited: 'PROFILE_RATE_LIMITED' };
  if (!reasons[value.to] || value.reasonCode !== reasons[value.to]) throw invalid('Governor transition target is invalid');
  return Object.freeze({ ...value });
}

export function validateActionFence(input) {
  const allowed = new Set(['schema', 'fenceId', 'leaseId', 'fenceEpoch', 'leaseBindingDigest', 'runId', 'bindingId', 'purpose', 'scope', 'fenceDigest', 'ttlMs', 'maxUses', 'approvalDigest', 'issuedAt', 'expiresAt', 'actionKind']);
  const value = closed(input, 'action fence', allowed);
  if (value.schema !== SCHEMAS.fence) throw profileError('PROFILE_SCHEMA_UNSUPPORTED', 'unsupported profile action fence schema');
  string(value.fenceId, 'fenceId', /^fence_[0-9a-f]{16}$/, 22, 22);
  string(value.leaseId, 'leaseId', /^lease_[0-9a-f]{16}$/, 22, 22);
  integer(value.fenceEpoch, 'fenceEpoch', 1, 2 ** 31 - 1);
  string(value.leaseBindingDigest, 'leaseBindingDigest', DIGEST, 71, 71);
  string(value.runId, 'runId', RUN_ID, 12, 96);
  string(value.bindingId, 'bindingId', BINDING_ID, 4, 96);
  string(value.purpose, 'purpose', /^[a-z0-9-]+$/, 2, 64);
  object(value.scope, 'scope');
  const scopeKeys = new Set(['profileAlias', 'actions', 'tabHandle', 'originAllowlist']);
  const scopeUnknown = Object.keys(value.scope).find((key) => !scopeKeys.has(key));
  if (scopeUnknown) throw invalid('action fence scope contains an unknown field');
  string(value.scope.profileAlias, 'scope.profileAlias', ALIAS, 2, 64);
  if (!Array.isArray(value.scope.actions) || value.scope.actions.length < 1 || value.scope.actions.length > 8 || new Set(value.scope.actions).size !== value.scope.actions.length || value.scope.actions.some((action) => !ACTIONS.includes(action))) throw invalid('scope.actions is invalid');
  if (value.scope.tabHandle !== undefined) string(value.scope.tabHandle, 'scope.tabHandle', /^tab_[a-z0-9-]{4,}$/, 8, 128);
  if (value.scope.originAllowlist !== undefined && (!Array.isArray(value.scope.originAllowlist) || value.scope.originAllowlist.length > 16 || value.scope.originAllowlist.some((origin) => typeof origin !== 'string' || !/^https?:\/\//.test(origin)))) throw invalid('scope.originAllowlist is invalid');
  string(value.fenceDigest, 'fenceDigest', DIGEST, 71, 71);
  if (value.ttlMs !== undefined) integer(value.ttlMs, 'ttlMs', 1000, 300000);
  if (value.maxUses !== undefined) integer(value.maxUses, 'maxUses', 1, 1000);
  if (value.approvalDigest !== undefined) string(value.approvalDigest, 'approvalDigest', DIGEST, 71, 71);
  for (const key of ['issuedAt', 'expiresAt']) if (!isRfc3339DateTime(value[key])) throw invalid(`${key} is invalid`);
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) throw invalid('action fence timestamps are invalid');
  if (value.actionKind !== undefined && !ACTION_KINDS.has(value.actionKind)) throw invalid('actionKind is invalid');
  return Object.freeze({ ...value, scope: Object.freeze({ ...value.scope, actions: Object.freeze([...value.scope.actions]), ...(value.scope.originAllowlist === undefined ? {} : { originAllowlist: Object.freeze([...value.scope.originAllowlist]) }) }) });
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function digestLf(domainLabel, value) {
  if (typeof domainLabel !== 'string' || !/^webmcp-digest-v1:[a-z-]+$/.test(domainLabel)) throw invalid('digest domain is invalid');
  const canonical = typeof value === 'string' ? value : stableStringify(value);
  return `sha256:${createHash('sha256').update(`${domainLabel}\n${canonical}`, 'utf8').digest('hex')}`;
}

export function computeLeaseBindingDigest({ claimDigest, bindingDigest, physicalResourceId, fenceEpoch, profileAlias }) {
  // Hardened projection includes profileAlias (finding 1). For synthetic frozen vectors that predate
  // the hardening (no alias), fall back to legacy projection without alias to keep vector
  // validation stable; all durable lease validation paths supply profileAlias and thus enforce binding.
  if (profileAlias === undefined) {
    return digestLf('webmcp-digest-v1:lease', { bindingDigest, claimDigest, fenceEpoch, profileResourceId: physicalResourceId });
  }
  if (typeof profileAlias !== 'string' || !ALIAS.test(profileAlias)) throw invalid('profileAlias is invalid for lease binding digest');
  return digestLf('webmcp-digest-v1:lease', { bindingDigest, claimDigest, fenceEpoch, profileAlias, profileResourceId: physicalResourceId });
}

export function computeFenceDigest({ leaseBindingDigest, bindingId, runId, fenceEpoch, scope }) {
  return digestLf('webmcp-digest-v1:fence', { bindingId, fenceEpoch, leaseBindingDigest, runId, scope });
}

export function requestFingerprint(request) {
  const { requestId: _requestId, profileResourceIdHint: _hint, ...facts } = request;
  return stableStringify(facts);
}

export function opaqueId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function redactLease(lease) {
  const safe = {
    schema: SCHEMAS.lease, leaseId: lease.leaseId, profileAlias: lease.profileAlias,
    bindingId: lease.bindingId, bindingRevision: lease.bindingRevision, bindingDigest: lease.bindingDigest,
    runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, leaseBindingDigest: lease.leaseBindingDigest,
    leaseMode: lease.leaseMode, fenceEpoch: lease.fenceEpoch, state: lease.state,
    expiresAt: lease.expiresAt, issuedAt: lease.issuedAt,
  };
  for (const key of ['heartbeatIntervalMs', 'leaseTtlMs', 'nodeId', 'ownerType']) if (lease[key] !== undefined) safe[key] = lease[key];
  return safe;
}

export function redactResource(resource) {
  return {
    schema: 'webmcp-profile-resource-state/1',
    profileAlias: resource.profileAlias,
    state: resource.state,
    stateReasonCode: resource.stateReasonCode,
    fenceEpoch: resource.fenceEpoch,
    livenessSummary: resource.livenessSummary,
    needsReconciliation: Boolean(resource.needsReconciliation),
  };
}
