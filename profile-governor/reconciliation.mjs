import { profileError } from './errors.mjs';
import { transition } from './state-machine.mjs';

export function reconcileResource(resource, { liveness, hasCurrentLease, now = new Date().toISOString() }) {
  if (liveness.summary !== 'healthy' || liveness.indeterminate) {
    if (resource.state !== 'unknown' && resource.state !== 'quarantined') transition(resource, liveness.externalUse ? 'external_use' : 'unknown', liveness.summary === 'failed' ? 'LIVENESS_FAILED' : 'LIVENESS_UNKNOWN', now);
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
    if (typeof resource.cooldownUntil !== 'string' || Date.parse(resource.cooldownUntil) > Date.parse(now)) {
      resource.needsReconciliation = true;
      resource.livenessSummary = liveness.summary;
      return resource;
    }
  }
  if (resource.state === 'cooldown' || resource.state === 'external_use' || resource.state === 'unknown') transition(resource, 'ready', 'RECOVERY_APPLIED', now);
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
