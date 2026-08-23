export class PoolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PoolError';
    this.code = code;
    this.exitCode = code === 'USAGE_ERROR' || code === 'RECLAIM_CONFIRMATION_REQUIRED' ? 2 : 1;
    this.details = details;
  }
}

export function usageError(message) {
  return new PoolError('USAGE_ERROR', message);
}

export function poolError(code, message, details) {
  return new PoolError(code, message, details);
}
