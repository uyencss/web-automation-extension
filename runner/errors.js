class RunnerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RunnerError';
    this.code = options.code || 'RUNNER_ERROR';
    this.status = options.status;
    this.details = options.details;
    this.retryable = Boolean(options.retryable);
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function classifyMessage(message) {
  const text = String(message || '').toLowerCase();

  if (text.includes('timed out') || text.includes('timeout')) return 'TIMEOUT';
  if (text.includes('extension is not connected')) return 'GATEWAY_UNAVAILABLE';
  if (text.includes('extension disconnected')) return 'GATEWAY_UNAVAILABLE';
  if (text.includes('method not found')) return 'UNKNOWN_COMMAND';
  if (text.includes('missing required param')) return 'VALIDATION_ERROR';
  if (text.includes('aborted') || text.includes('abort')) return 'ABORTED';

  return 'COMMAND_FAILED';
}

function isRetryableCode(code) {
  return code === 'TIMEOUT' || code === 'GATEWAY_UNAVAILABLE' || code === 'NETWORK_ERROR';
}

function normalizeError(error, fallbackCode = 'RUNNER_ERROR') {
  if (error instanceof RunnerError) return error;

  const message = error?.message || String(error || 'Unknown runner error');
  const code = error?.code || classifyMessage(message) || fallbackCode;

  return new RunnerError(message, {
    code,
    cause: error,
    retryable: isRetryableCode(code),
  });
}

function errorToJSON(error) {
  const normalized = normalizeError(error);
  return {
    name: normalized.name,
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    ...(normalized.status !== undefined ? { status: normalized.status } : {}),
    ...(normalized.details !== undefined ? { details: normalized.details } : {}),
  };
}

module.exports = {
  RunnerError,
  normalizeError,
  errorToJSON,
  classifyMessage,
  isRetryableCode,
};
