import { profileError } from './errors.mjs';
import { isRfc3339DateTime } from './contracts.mjs';
import { transition } from './state-machine.mjs';

export function reconcileResource(resource, { liveness, hasCurrentLease, now = new Date().toISOString() }) {
  if (!isRfc3339DateTime(now)) throw profileError('PROFILE_TRANSITION_INVALID', 'Governor reconciliation timestamp is invalid');
  const isExternal = resource.state === 'external_use' || resource.recoverySubjectKind === 'unregistered-external' || resource.recoverySubjectKind === 'registered-external';
  if (isExternal) {
    if (resource.state !== 'external_use') transition(resource, 'external_use', 'PROFILE_EXTERNAL_USE', now);
    resource.needsReconciliation = true;
    resource.livenessSummary = liveness.summary;
    return resource;
  }
  if (liveness.summary !== 'healthy' || liveness.indeterminate) {
    if (liveness.externalUse && resource.state !== 'external_use' && resource.state !== 'quarantined') transition(resource, 'external_use', 'PROFILE_EXTERNAL_USE', now);
    else if (!liveness.externalUse && resource.state !== 'unknown' && resource.state !== 'quarantined') transition(resource, 'unknown', 'LIVENESS_UNKNOWN', now);
    resource.needsReconciliation = true;
    resource.livenessSummary = liveness.summary;
    return resource;
  }
  if (liveness.externalUse && !hasCurrentLease) {
    if (resource.state !== 'external_use') transition(resource, 'external_use', 'PROFILE_EXTERNAL_USE', now);
    resource.needsReconciliation = true;
    resource.livenessSummary = liveness.summary;
    return resource;
  }
  if (hasCurrentLease) {
    resource.needsReconciliation = true;
    resource.livenessSummary = liveness.summary;
    return resource;
  }
  if (resource.state === 'quarantined') return resource;
  if (resource.state === 'cooldown') {
    if (!isRfc3339DateTime(resource.cooldownUntil) || Date.parse(resource.cooldownUntil) > Date.parse(now)) {
      resource.needsReconciliation = true;
      resource.livenessSummary = liveness.summary;
      return resource;
    }
  }
  if (resource.state === 'cooldown' || resource.state === 'unknown') transition(resource, 'ready', 'RECOVERY_APPLIED', now);
  resource.needsReconciliation = false;
  resource.livenessSummary = liveness.summary;
  return resource;
}

export function assertReconciliationForAcquire(resource) {
  if (!resource || resource.state !== 'ready' || resource.needsReconciliation) {
    if (resource?.state === 'external_use') throw profileError('PROFILE_EXTERNAL_USE', 'Profile resource is in external use');
    if (resource?.state === 'quarantined') throw profileError('PROFILE_QUARANTINED', 'Profile resource is quarantined');
    throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Profile resource requires reconciliation');
  }
}
