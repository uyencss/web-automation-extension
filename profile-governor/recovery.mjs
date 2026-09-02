import { computeLeaseBindingDigest, opaqueId, digestLf, isRfc3339DateTime, SCHEMAS } from './contracts.mjs';
import { profileError } from './errors.mjs';
import { appendEvent } from './events.mjs';
import { transition } from './state-machine.mjs';

const RECEIPT_REASONS = new Set(['PROFILE_RECLAIM_UNSAFE', 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', 'RECOVERY_PRECONDITION_FAILED', 'RECOVERY_LIVENESS_UNKNOWN', 'RECOVERY_DEPENDENT_GRANT_REVOKE_FAILED', 'RECOVERY_QUARANTINE_TIMEOUT', 'RECOVERY_OPERATOR_RECONCILE', 'RECOVERY_HOST_RESTART', 'RECOVERY_EXTERNAL_USE_CLEARED']);
const RECEIPT_KEYS = new Set(['schema', 'receiptId', 'leaseId', 'profileAlias', 'bindingId', 'bindingRevision', 'bindingDigest', 'runId', 'priorState', 'newState', 'priorFenceEpoch', 'newFenceEpoch', 'reasonCode', 'probeOutcomes', 'lastActionOutcome', 'dependentGrantRevokeStatus', 'authorityKind', 'createdAt', 'receiptDigest', 'eventId']);
const BUILD_KEYS = new Set([...RECEIPT_KEYS].filter((key) => !['schema', 'receiptDigest'].includes(key)));
const PROBE_KEYS = new Set(['governorHealth', 'runnerClaim', 'browserAlive', 'extensionConnected', 'dependentGrantsRevoked', 'registryCurrent']);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OPERATIONAL_RECEIPT_FIELDS = ['probeOutcomes', 'lastActionOutcome', 'dependentGrantRevokeStatus', 'authorityKind'];

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function closed(value, label, allowed, code = 'PROFILE_GOVERNOR_STATE_INVALID') {
  if (!isPlainObject(value)) throw profileError(code, `${label} is invalid`);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw profileError(code, `${label} contains an unknown field`);
  return value;
}

export function computeRecoveryPlanDigest({ leaseId, bindingDigest, fenceEpoch, reasonCode }) {
  return digestLf('webmcp-digest-v1:recovery', { bindingDigest, fenceEpoch, leaseId, reasonCode });
}

export function assertSafeRecoveryEvidence(evidence = {}) {
  closed(evidence, 'Recovery evidence', new Set(['runnerClaim', 'browserAlive', 'extensionConnected', 'dependentGrantsRevoked', 'registryCurrent', 'expectedState', 'expectedFenceEpoch', 'expectedBindingDigest', 'expectedPlanDigest', 'indeterminateResolved', 'governorHealth']), 'PROFILE_RECLAIM_UNSAFE');
  const allowedClaims = ['terminal', 'revoked'];
  if (!allowedClaims.includes(evidence.runnerClaim) || evidence.browserAlive !== false || evidence.extensionConnected !== false || evidence.dependentGrantsRevoked !== true || evidence.registryCurrent !== true) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery evidence is insufficient for reclaim');
  if (evidence.governorHealth !== undefined && !['healthy', 'unknown', 'failed'].includes(evidence.governorHealth)) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery evidence governor health is invalid');
  if (!['unknown', 'quarantined'].includes(evidence.expectedState) || !Number.isInteger(evidence.expectedFenceEpoch) || !/^sha256:[0-9a-f]{64}$/.test(evidence.expectedBindingDigest || '') || !/^sha256:[0-9a-f]{64}$/.test(evidence.expectedPlanDigest || '') || evidence.indeterminateResolved !== true) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery evidence does not bind the durable recovery plan');
  return true;
}

export function assertSafeExternalRecoveryEvidence(evidence = {}) {
  closed(evidence, 'External recovery evidence', new Set(['runnerClaim', 'browserAlive', 'extensionConnected', 'dependentGrantsRevoked', 'registryCurrent', 'expectedState', 'expectedFenceEpoch', 'expectedBindingDigest', 'expectedPlanDigest', 'indeterminateResolved']), 'PROFILE_RECLAIM_UNSAFE');
  if (evidence.runnerClaim !== 'not-applicable' || evidence.browserAlive !== false || evidence.extensionConnected !== false || evidence.dependentGrantsRevoked !== true || evidence.registryCurrent !== true || evidence.expectedState !== 'external_use' || !Number.isInteger(evidence.expectedFenceEpoch) || !DIGEST.test(evidence.expectedBindingDigest || '') || !DIGEST.test(evidence.expectedPlanDigest || '') || evidence.indeterminateResolved !== true) throw profileError('PROFILE_RECLAIM_UNSAFE', 'External recovery evidence is insufficient or stale');
  return true;
}

export function computeExternalRecoveryEvidenceDigest({ profileAlias, bindingDigest, priorFenceEpoch, newFenceEpoch, evidence, subjectKind = 'unregistered-external' }) {
  return digestLf('webmcp-digest-v1:recovery', { bindingDigest, evidence, newFenceEpoch, priorFenceEpoch, profileAlias, subjectKind });
}

const RECEIPT_DIGEST_KEYS = new Set([
  'receiptId',
  'leaseId',
  'profileAlias',
  'bindingId',
  'bindingRevision',
  'bindingDigest',
  'runId',
  'priorState',
  'newState',
  'priorFenceEpoch',
  'newFenceEpoch',
  'reasonCode',
  'probeOutcomes',
  'lastActionOutcome',
  'dependentGrantRevokeStatus',
  'authorityKind',
  'createdAt',
  'eventId',
]);

export function computeReceiptDigest(receipt) {
  const projection = {};
  for (const key of RECEIPT_DIGEST_KEYS) {
    if (receipt[key] === undefined) continue;
    if (key === 'probeOutcomes' && receipt[key]) {
      const probe = {};
      for (const pk of PROBE_KEYS) {
        if (receipt[key][pk] !== undefined) probe[pk] = receipt[key][pk];
      }
      projection[key] = probe;
    } else {
      projection[key] = receipt[key];
    }
  }
  return digestLf('webmcp-digest-v1:terminal', projection);
}

function validateProbeOutcomes(value) {
  closed(value, 'Recovery probe outcomes', PROBE_KEYS);
  if (!['healthy', 'unknown', 'failed'].includes(value.governorHealth) || !['active', 'terminal', 'revoked', 'unknown'].includes(value.runnerClaim) || typeof value.browserAlive !== 'boolean' || typeof value.extensionConnected !== 'boolean') throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery probe outcomes are invalid');
  if (value.dependentGrantsRevoked !== undefined && typeof value.dependentGrantsRevoked !== 'boolean') throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery dependent grant outcome is invalid');
  if (value.registryCurrent !== undefined && typeof value.registryCurrent !== 'boolean') throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery Registry outcome is invalid');
}

export function validateRecoveryReceipt(receipt, { requireOperationalFields = false } = {}) {
  closed(receipt, 'Recovery receipt', RECEIPT_KEYS);
  if (receipt.schema !== SCHEMAS.receipt || !/^prr_[0-9a-f]{16}$/.test(receipt.receiptId || '') || !/^lease_[0-9a-f]{16}$/.test(receipt.leaseId || '') || typeof receipt.profileAlias !== 'string' || receipt.profileAlias.length < 2 || receipt.profileAlias.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(receipt.profileAlias) || !['unknown', 'leased', 'active', 'cooldown', 'external_use', 'auth_required', 'challenge', 'rate_limited', 'quarantined'].includes(receipt.priorState) || !['ready', 'quarantined', 'unknown', 'cooldown'].includes(receipt.newState) || !Number.isInteger(receipt.priorFenceEpoch) || receipt.priorFenceEpoch < 0 || !Number.isInteger(receipt.newFenceEpoch) || receipt.newFenceEpoch <= receipt.priorFenceEpoch || !RECEIPT_REASONS.has(receipt.reasonCode) || !isRfc3339DateTime(receipt.createdAt) || !DIGEST.test(receipt.receiptDigest || '')) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt is invalid');
  if (receipt.bindingId !== undefined && !/^pb_[a-z0-9-]+$/.test(receipt.bindingId)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt bindingId is invalid');
  if (receipt.bindingRevision !== undefined && (!Number.isInteger(receipt.bindingRevision) || receipt.bindingRevision < 1)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt bindingRevision is invalid');
  if (receipt.bindingDigest !== undefined && !DIGEST.test(receipt.bindingDigest)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt binding digest is invalid');
  if (receipt.runId !== undefined && !/^run_[a-z0-9-]{8,}$/.test(receipt.runId)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt runId is invalid');
  if (receipt.probeOutcomes !== undefined) validateProbeOutcomes(receipt.probeOutcomes);
  if (receipt.lastActionOutcome !== undefined && !['none', 'confirmed', 'failed-known', 'indeterminate', 'blocked-before-action'].includes(receipt.lastActionOutcome)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt outcome is invalid');
  if (receipt.dependentGrantRevokeStatus !== undefined && !['none', 'revoked', 'pending', 'failed'].includes(receipt.dependentGrantRevokeStatus)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt outcome is invalid');
  if (receipt.authorityKind !== undefined && !['governor-automatic', 'operator-approved'].includes(receipt.authorityKind)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt authority is invalid');
  if (requireOperationalFields && OPERATIONAL_RECEIPT_FIELDS.some((key) => receipt[key] === undefined)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt operational fields are required');
  if (receipt.eventId !== undefined && !/^pse_[0-9a-f]{16}$/.test(receipt.eventId)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt eventId is invalid');
  if (receipt.receiptDigest !== computeReceiptDigest(receipt)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt digest is invalid');
  return receipt;
}

function projectReceipt(receipt) {
  const result = {};
  for (const key of RECEIPT_KEYS) if (receipt[key] !== undefined) result[key] = key === 'probeOutcomes' && receipt[key] ? { ...receipt[key] } : receipt[key];
  return result;
}

export function buildRecoveryReceipt(input) {
  closed(input, 'Recovery receipt input', BUILD_KEYS);
  if (!RECEIPT_REASONS.has(input.reasonCode)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery reason is invalid');
  if (OPERATIONAL_RECEIPT_FIELDS.some((key) => input[key] === undefined)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery receipt operational fields are required before persistence');
  const receipt = {
    schema: SCHEMAS.receipt,
    receiptId: input.receiptId || opaqueId('prr'),
    leaseId: input.leaseId,
    profileAlias: input.profileAlias,
    bindingId: input.bindingId,
    bindingRevision: input.bindingRevision,
    bindingDigest: input.bindingDigest,
    runId: input.runId,
    priorState: input.priorState,
    newState: input.newState,
    priorFenceEpoch: input.priorFenceEpoch,
    newFenceEpoch: input.newFenceEpoch,
    reasonCode: input.reasonCode,
    probeOutcomes: input.probeOutcomes,
    lastActionOutcome: input.lastActionOutcome,
    dependentGrantRevokeStatus: input.dependentGrantRevokeStatus,
    authorityKind: input.authorityKind,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (input.eventId !== undefined) receipt.eventId = input.eventId;
  receipt.receiptDigest = computeReceiptDigest(receipt);
  validateRecoveryReceipt(receipt, { requireOperationalFields: true });
  return projectReceipt(receipt);
}

function appendReceipt(state, receipt) {
  state.receipts.push(receipt);
  if (state.receipts.length > 128) state.receipts.splice(0, state.receipts.length - 128);
  return receipt;
}

export function quarantineLease(repository, { physicalResourceId, leaseId, reasonCode = 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', lastActionOutcome = 'indeterminate', livenessSummary = 'unknown', probeOutcomes, dependentGrantRevokeStatus = 'pending', now = new Date().toISOString() }) {
  const grantStatus = dependentGrantRevokeStatus === 'revoked' ? 'pending' : dependentGrantRevokeStatus;
  const truthfulProbeOutcomes = probeOutcomes ?? {
    governorHealth: 'unknown',
    runnerClaim: 'unknown',
    browserAlive: false,
    extensionConnected: false,
    dependentGrantsRevoked: grantStatus === 'revoked',
  };
  return repository.transact((state) => {
    const resource = state.resources[physicalResourceId];
    const lease = state.leases[leaseId];
    if (!resource || !lease || resource.currentLeaseId !== leaseId) throw profileError('PROFILE_LEASE_NOT_FOUND', 'Governor lease is not current');
    const priorState = lease.state;
    const priorEpoch = resource.fenceEpoch;
    const newEpoch = priorEpoch + 1;
    transition(resource, 'quarantined', reasonCode, now);
    resource.fenceEpoch = newEpoch;
    resource.needsReconciliation = true;
    resource.livenessSummary = livenessSummary;
    lease.state = 'quarantined';
    lease.fenceEpoch = newEpoch;
    lease.leaseBindingDigest = computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: lease.physicalResourceId, fenceEpoch: newEpoch, profileAlias: lease.profileAlias });
    lease.fences = {};
    lease.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId, bindingDigest: lease.bindingDigest, fenceEpoch: newEpoch, reasonCode });
    resource.recoveryPlanDigest = lease.recoveryPlanDigest;
    const event = appendEvent(state, { leaseId, profileAlias: lease.profileAlias, state: 'quarantined', stateReasonCode: reasonCode, fenceEpoch: newEpoch, bindingDigest: lease.bindingDigest, bindingId: lease.bindingId, runId: lease.runId, timestamp: now, leaseBindingDigest: lease.leaseBindingDigest, livenessSummary, grantRevokeStatus: grantStatus });
    const receipt = buildRecoveryReceipt({
      leaseId, profileAlias: lease.profileAlias, bindingId: lease.bindingId, bindingRevision: lease.bindingRevision,
      bindingDigest: lease.bindingDigest, runId: lease.runId, priorState, newState: 'quarantined', priorFenceEpoch: priorEpoch,
      newFenceEpoch: newEpoch, reasonCode, lastActionOutcome, dependentGrantRevokeStatus: grantStatus,
      probeOutcomes: truthfulProbeOutcomes,
      authorityKind: 'governor-automatic', createdAt: now,
      eventId: event.eventId,
    });
    appendReceipt(state, receipt);
    return receipt;
  });
}

export function applyEvidenceRecovery(repository, { physicalResourceId, leaseId, evidence, probeOutcomes, livenessSummary, trustedAuthorization = false, reasonCode = 'RECOVERY_OPERATOR_RECONCILE', now = new Date().toISOString() }) {
  if (trustedAuthorization !== true) throw profileError('PROFILE_IPC_AUTH', 'Trusted recovery authorization is required');
  if (evidence?.expectedState === 'external_use' || reasonCode === 'RECOVERY_EXTERNAL_USE_CLEARED') {
    throw profileError('PROFILE_RECLAIM_UNSAFE', 'External-use recovery is contract-blocked until receipt contract binds evidence digest');
  }
  assertSafeRecoveryEvidence(evidence);
  return repository.transact((state) => {
    const resource = state.resources[physicalResourceId];
    const lease = state.leases[leaseId];
    if (!resource || !lease || resource.currentLeaseId !== leaseId) throw profileError('PROFILE_LEASE_NOT_FOUND', 'Governor lease is not current');
    if (resource.state === 'external_use') {
      throw profileError('PROFILE_RECLAIM_UNSAFE', 'External-use recovery is contract-blocked until receipt contract binds evidence digest');
    }
    if (resource.state !== 'quarantined' && resource.state !== 'unknown') throw profileError('PROFILE_RECLAIM_UNSAFE', 'Resource is not awaiting recovery');
    if (lease.actionJournal?.some((entry) => entry.outcome === 'indeterminate')) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery requires durable resolution of indeterminate actions');
    if (evidence.expectedState !== resource.state || evidence.expectedFenceEpoch !== resource.fenceEpoch || evidence.expectedBindingDigest !== lease.bindingDigest || evidence.expectedPlanDigest !== resource.recoveryPlanDigest || evidence.indeterminateResolved !== true) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery evidence is stale for the durable recovery plan');
    const priorState = resource.state;
    const priorEpoch = resource.fenceEpoch;
    const newEpoch = priorEpoch + 1;
    const finalReason = reasonCode === 'RECOVERY_OPERATOR_RECONCILE' ? 'RECOVERY_OPERATOR_RECONCILE' : reasonCode;
    transition(resource, 'ready', finalReason, now);
    resource.fenceEpoch = newEpoch;
    resource.currentLeaseId = null;
    resource.needsReconciliation = false;
    const effectiveLivenessSummary = livenessSummary !== undefined ? livenessSummary : (evidence.governorHealth === 'healthy' ? 'unknown' : 'unknown');
    resource.livenessSummary = effectiveLivenessSummary;
    lease.state = 'cooldown';
    lease.fenceEpoch = newEpoch;
    lease.leaseBindingDigest = computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: lease.physicalResourceId, fenceEpoch: newEpoch, profileAlias: lease.profileAlias });
    lease.fences = {};
    const safeRunnerClaim = (claim) => (['active', 'terminal', 'revoked'].includes(claim) ? claim : 'unknown');
    const finalProbeOutcomes = probeOutcomes ? {
      governorHealth: probeOutcomes.governorHealth,
      runnerClaim: safeRunnerClaim(probeOutcomes.runnerClaim ?? evidence.runnerClaim),
      browserAlive: probeOutcomes.browserAlive ?? evidence.browserAlive,
      extensionConnected: probeOutcomes.extensionConnected ?? evidence.extensionConnected,
      dependentGrantsRevoked: probeOutcomes.dependentGrantsRevoked ?? evidence.dependentGrantsRevoked ?? true,
      registryCurrent: probeOutcomes.registryCurrent ?? evidence.registryCurrent ?? true,
    } : {
      governorHealth: evidence.governorHealth || 'unknown',
      runnerClaim: safeRunnerClaim(evidence.runnerClaim),
      browserAlive: evidence.browserAlive,
      extensionConnected: evidence.extensionConnected,
      dependentGrantsRevoked: evidence.dependentGrantsRevoked ?? true,
      registryCurrent: evidence.registryCurrent ?? true,
    };
    const event = appendEvent(state, { leaseId, profileAlias: lease.profileAlias, state: 'ready', stateReasonCode: 'RECOVERY_APPLIED', fenceEpoch: newEpoch, bindingDigest: lease.bindingDigest, bindingId: lease.bindingId, runId: lease.runId, timestamp: now, leaseBindingDigest: lease.leaseBindingDigest, livenessSummary: effectiveLivenessSummary, grantRevokeStatus: 'revoked' });
    const receipt = buildRecoveryReceipt({
      leaseId, profileAlias: lease.profileAlias, bindingId: lease.bindingId, bindingRevision: lease.bindingRevision,
      bindingDigest: lease.bindingDigest, runId: lease.runId, priorState, newState: 'ready', priorFenceEpoch: priorEpoch,
      newFenceEpoch: newEpoch, reasonCode: finalReason,
      probeOutcomes: finalProbeOutcomes,
      lastActionOutcome: 'none', dependentGrantRevokeStatus: 'revoked',
      authorityKind: 'operator-approved', createdAt: now,
      eventId: event.eventId,
    });
    appendReceipt(state, receipt);
    return receipt;
  });
}

export function listRecoveryReceipts(state) {
  return state.receipts.map((receipt) => {
    validateRecoveryReceipt(receipt, { requireOperationalFields: true });
    return projectReceipt(receipt);
  });
}
