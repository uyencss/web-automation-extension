import { computeLeaseBindingDigest, opaqueId, digestLf, SCHEMAS } from './contracts.mjs';
import { profileError } from './errors.mjs';
import { appendEvent } from './events.mjs';
import { transition } from './state-machine.mjs';

const RECEIPT_REASONS = new Set(['PROFILE_RECLAIM_UNSAFE', 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', 'RECOVERY_PRECONDITION_FAILED', 'RECOVERY_LIVENESS_UNKNOWN', 'RECOVERY_DEPENDENT_GRANT_REVOKE_FAILED', 'RECOVERY_QUARANTINE_TIMEOUT', 'RECOVERY_OPERATOR_RECONCILE', 'RECOVERY_HOST_RESTART', 'RECOVERY_EXTERNAL_USE_CLEARED']);

export function computeRecoveryPlanDigest({ leaseId, bindingDigest, fenceEpoch, reasonCode }) {
  return digestLf('webmcp-digest-v1:recovery', { bindingDigest, fenceEpoch, leaseId, reasonCode });
}

export function assertSafeRecoveryEvidence(evidence = {}) {
  if (!['terminal', 'revoked'].includes(evidence.runnerClaim) || evidence.browserAlive !== false || evidence.extensionConnected !== false || evidence.dependentGrantsRevoked !== true || evidence.registryCurrent !== true) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery evidence is insufficient for reclaim');
  if (!['unknown', 'quarantined', 'external_use'].includes(evidence.expectedState) || !Number.isInteger(evidence.expectedFenceEpoch) || !/^sha256:[0-9a-f]{64}$/.test(evidence.expectedBindingDigest || '') || !/^sha256:[0-9a-f]{64}$/.test(evidence.expectedPlanDigest || '') || evidence.indeterminateResolved !== true) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery evidence does not bind the durable recovery plan');
  return true;
}

function receiptProjection(input) {
  return {
    receiptId: input.receiptId, leaseId: input.leaseId, priorState: input.priorState, newState: input.newState,
    priorFenceEpoch: input.priorFenceEpoch, newFenceEpoch: input.newFenceEpoch, reasonCode: input.reasonCode,
    probeOutcomes: input.probeOutcomes, lastActionOutcome: input.lastActionOutcome || 'none',
    dependentGrantRevokeStatus: input.dependentGrantRevokeStatus || 'none',
  };
}

export function buildRecoveryReceipt(input) {
  if (!RECEIPT_REASONS.has(input.reasonCode)) throw profileError('PROFILE_GOVERNOR_STATE_INVALID', 'Recovery reason is invalid');
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
    lastActionOutcome: input.lastActionOutcome || 'none',
    dependentGrantRevokeStatus: input.dependentGrantRevokeStatus || 'none',
    authorityKind: input.authorityKind || 'governor-automatic',
    createdAt: input.createdAt || new Date().toISOString(),
  };
  receipt.receiptDigest = digestLf('webmcp-digest-v1:terminal', receiptProjection(receipt));
  return receipt;
}

function appendReceipt(state, receipt) {
  state.receipts.push(receipt);
  if (state.receipts.length > 128) state.receipts.splice(0, state.receipts.length - 128);
  return receipt;
}

export function quarantineLease(repository, { physicalResourceId, leaseId, reasonCode = 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', lastActionOutcome = 'indeterminate', livenessSummary = 'unknown', dependentGrantRevokeStatus = 'pending', now = new Date().toISOString() }) {
  const grantStatus = dependentGrantRevokeStatus === 'revoked' ? 'pending' : dependentGrantRevokeStatus;
  return repository.transact((state) => {
    const resource = state.resources[physicalResourceId];
    const lease = state.leases[leaseId];
    if (!resource || !lease || resource.currentLeaseId !== leaseId) throw profileError('PROFILE_LEASE_NOT_FOUND', 'Governor lease is not current');
    const priorState = resource.state;
    const priorEpoch = resource.fenceEpoch;
    const newEpoch = priorEpoch + 1;
    transition(resource, 'quarantined', reasonCode, now);
    resource.fenceEpoch = newEpoch;
    resource.needsReconciliation = true;
    lease.state = 'quarantined';
    lease.fenceEpoch = newEpoch;
    lease.leaseBindingDigest = computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: lease.physicalResourceId, fenceEpoch: newEpoch });
    lease.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId, bindingDigest: lease.bindingDigest, fenceEpoch: newEpoch, reasonCode });
    resource.recoveryPlanDigest = lease.recoveryPlanDigest;
    const receipt = buildRecoveryReceipt({
      leaseId, profileAlias: lease.profileAlias, bindingId: lease.bindingId, bindingRevision: lease.bindingRevision,
      bindingDigest: lease.bindingDigest, runId: lease.runId, priorState, newState: 'quarantined', priorFenceEpoch: priorEpoch,
      newFenceEpoch: newEpoch, reasonCode, lastActionOutcome, dependentGrantRevokeStatus: grantStatus,
      probeOutcomes: { governorHealth: 'healthy', runnerClaim: 'unknown', browserAlive: true, extensionConnected: true, dependentGrantsRevoked: grantStatus === 'revoked' },
      authorityKind: 'governor-automatic', createdAt: now,
    });
    appendReceipt(state, receipt);
    appendEvent(state, { leaseId, profileAlias: lease.profileAlias, state: 'quarantined', stateReasonCode: reasonCode, fenceEpoch: newEpoch, bindingDigest: lease.bindingDigest, bindingId: lease.bindingId, runId: lease.runId, timestamp: now, leaseBindingDigest: lease.leaseBindingDigest, livenessSummary, grantRevokeStatus: grantStatus });
    return receipt;
  });
}

export function applyEvidenceRecovery(repository, { physicalResourceId, leaseId, evidence, trustedAuthorization = false, reasonCode = 'RECOVERY_OPERATOR_RECONCILE', now = new Date().toISOString() }) {
  if (trustedAuthorization !== true) throw profileError('PROFILE_IPC_AUTH', 'Trusted recovery authorization is required');
  assertSafeRecoveryEvidence(evidence);
  return repository.transact((state) => {
    const resource = state.resources[physicalResourceId];
    const lease = state.leases[leaseId];
    if (!resource || !lease || resource.currentLeaseId !== leaseId) throw profileError('PROFILE_LEASE_NOT_FOUND', 'Governor lease is not current');
    if (resource.state !== 'quarantined' && resource.state !== 'external_use' && resource.state !== 'unknown') throw profileError('PROFILE_RECLAIM_UNSAFE', 'Resource is not awaiting recovery');
    if (lease.actionJournal?.some((entry) => entry.outcome === 'indeterminate')) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery requires durable resolution of indeterminate actions');
    if (evidence.expectedState !== resource.state || evidence.expectedFenceEpoch !== resource.fenceEpoch || evidence.expectedBindingDigest !== lease.bindingDigest || evidence.expectedPlanDigest !== resource.recoveryPlanDigest || evidence.indeterminateResolved !== true) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery evidence is stale for the durable recovery plan');
    const priorState = resource.state;
    const priorEpoch = resource.fenceEpoch;
    const newEpoch = priorEpoch + 1;
    transition(resource, 'ready', reasonCode === 'RECOVERY_OPERATOR_RECONCILE' ? 'RECOVERY_OPERATOR_RECONCILE' : reasonCode, now);
    resource.fenceEpoch = newEpoch;
    resource.currentLeaseId = null;
    resource.needsReconciliation = false;
    resource.livenessSummary = 'healthy';
    lease.state = 'cooldown';
    lease.fenceEpoch = newEpoch;
    lease.leaseBindingDigest = computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: lease.physicalResourceId, fenceEpoch: newEpoch });
    const receipt = buildRecoveryReceipt({
      leaseId, profileAlias: lease.profileAlias, bindingId: lease.bindingId, bindingRevision: lease.bindingRevision,
      bindingDigest: lease.bindingDigest, runId: lease.runId, priorState, newState: 'ready', priorFenceEpoch: priorEpoch,
      newFenceEpoch: newEpoch, reasonCode: reasonCode === 'RECOVERY_OPERATOR_RECONCILE' ? 'RECOVERY_OPERATOR_RECONCILE' : 'RECOVERY_EXTERNAL_USE_CLEARED',
      probeOutcomes: { governorHealth: 'healthy', runnerClaim: evidence.runnerClaim, browserAlive: false, extensionConnected: false, dependentGrantsRevoked: true, registryCurrent: true },
      authorityKind: 'operator-approved', createdAt: now,
    });
    appendReceipt(state, receipt);
    appendEvent(state, { leaseId, profileAlias: lease.profileAlias, state: 'ready', stateReasonCode: 'RECOVERY_APPLIED', fenceEpoch: newEpoch, bindingDigest: lease.bindingDigest, bindingId: lease.bindingId, runId: lease.runId, timestamp: now, leaseBindingDigest: lease.leaseBindingDigest, livenessSummary: 'healthy', grantRevokeStatus: 'revoked' });
    return receipt;
  });
}

export function listRecoveryReceipts(state) {
  return state.receipts.map((receipt) => ({ ...receipt }));
}
