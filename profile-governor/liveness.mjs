import { profileError } from './errors.mjs';

function status(value) {
  if (value === true || value === 'healthy' || value === 'active') return 'healthy';
  if (value === false || value === 'failed' || value === 'terminal' || value === 'revoked') return 'failed';
  if (value === 'auth_required' || value === 'challenge' || value === 'rate_limited') return value;
  return 'unknown';
}

export function evaluateLiveness(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { summary: 'unknown', externalUse: false, probes: {} };
  const probes = {
    governor: status(input.governor ?? input.governorHealth),
    registry: status(input.registry ?? input.registryCurrent),
    runnerClaim: status(input.runnerClaim),
  };
  const browserAlive = input.browserAlive === true;
  const extensionConnected = input.extensionConnected === true;
  const values = Object.values(probes);
  const indeterminate = input.indeterminate === true;
  const browserStatus = Object.hasOwn(input, 'browserAlive') ? (browserAlive ? 'healthy' : 'failed') : 'unknown';
  const extensionStatus = Object.hasOwn(input, 'extensionConnected') ? (extensionConnected ? 'healthy' : 'failed') : 'unknown';
  const allValues = [...values, browserStatus, extensionStatus];
  const lifecycle = allValues.find((value) => ['auth_required', 'challenge', 'rate_limited'].includes(value));
  const summary = indeterminate || allValues.includes('unknown') ? 'unknown' : lifecycle || allValues.includes('failed') ? 'failed' : 'healthy';
  return {
    summary,
    indeterminate,
    externalUse: browserAlive && !extensionConnected,
    browserAlive,
    extensionConnected,
    lifecycleCode: lifecycle ? ({ auth_required: 'PROFILE_AUTH_REQUIRED', challenge: 'PROFILE_CHALLENGE_REQUIRED', rate_limited: 'PROFILE_RATE_LIMITED' })[lifecycle] : undefined,
    probes,
  };
}

export async function probeLiveness(adapter, context = {}) {
  if (typeof adapter !== 'function' && typeof adapter?.probe !== 'function') throw profileError('PROFILE_LIVENESS_UNKNOWN', 'Governor liveness adapter is unavailable');
  const result = await (typeof adapter === 'function' ? adapter(context) : adapter.probe(context));
  return evaluateLiveness(result);
}

export function requireHealthyLiveness(liveness) {
  if (liveness.summary !== 'healthy') throw profileError('PROFILE_LIVENESS_UNKNOWN', 'Governor liveness is not authoritative');
  return liveness;
}
