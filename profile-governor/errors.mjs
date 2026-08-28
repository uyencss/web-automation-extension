const CODES = [
  'PROFILE_REQUEST_INVALID', 'PROFILE_SCHEMA_UNSUPPORTED', 'PROFILE_GOVERNOR_STATE_INVALID',
  'PROFILE_GOVERNOR_UNAVAILABLE', 'PROFILE_GOVERNOR_MULTI_WRITER',
  'PROFILE_STATE_INVALID', 'PROFILE_STATE_UNAVAILABLE', 'PROFILE_SINGLE_WRITER', 'PROFILE_LEASE_CONFLICT',
  'PROFILE_CLAIM_REQUIRED', 'PROFILE_CLAIM_INVALID', 'PROFILE_BINDING_STALE',
  'PROFILE_GOVERNOR_NOT_READY', 'PROFILE_LEASE_NOT_FOUND', 'PROFILE_LEASE_EXPIRED',
  'PROFILE_LEASE_REVOKED', 'PROFILE_FENCE_REQUIRED', 'PROFILE_FENCE_STALE',
  'PROFILE_FENCE_INVALID', 'PROFILE_TAB_NOT_OWNED', 'PROFILE_TAB_LIMIT',
  'PROFILE_LIVENESS_UNKNOWN', 'PROFILE_EXTERNAL_USE', 'PROFILE_ACTION_DENIED',
  'PROFILE_AUTH_REQUIRED', 'PROFILE_CHALLENGE_REQUIRED', 'PROFILE_RATE_LIMITED',
  'PROFILE_RESOURCE_UNKNOWN', 'PROFILE_QUARANTINED',
  'PROFILE_RECLAIM_UNSAFE', 'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED',
  'PROFILE_OUTWARD_EFFECT_INDETERMINATE', 'PROFILE_TRANSITION_INVALID', 'PROFILE_IPC_AUTH', 'PROFILE_SERVICE_UNAVAILABLE',
];

export class ProfileGovernorError extends Error {
  constructor(code, message, details = undefined) {
    if (!CODES.includes(code)) throw new TypeError(`unknown Profile Governor error code: ${code}`);
    super(message);
    this.name = 'ProfileGovernorError';
    this.code = code;
    this.details = details;
    this.exitCode = code === 'PROFILE_REQUEST_INVALID' || code === 'PROFILE_IPC_AUTH' || code === 'PROFILE_AUTH_REQUIRED' ? 2 : 1;
  }
}

export function profileError(code, message, details) {
  return new ProfileGovernorError(code, message, details);
}

export function isProfileGovernorError(error) {
  return error instanceof ProfileGovernorError;
}

export { CODES as PROFILE_ERROR_CODES };
