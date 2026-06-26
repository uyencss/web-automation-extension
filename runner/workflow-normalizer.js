const DEFAULT_SETTINGS = {
  defaultTimeout: 30000,
  defaultRetryPolicy: {
    maxAttempts: 1,
    backoffMs: 1000,
    maxBackoffMs: 10000,
  },
  continueOnNonCriticalFailure: true,
};

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function normalizeRetryPolicy(policy = {}, defaults = DEFAULT_SETTINGS.defaultRetryPolicy) {
  const source = policy || {};
  return {
    maxAttempts: Math.max(1, Math.floor(toNumber(source.maxAttempts, defaults.maxAttempts || 1))),
    backoffMs: Math.max(0, toNumber(source.backoffMs, defaults.backoffMs || 1000)),
    maxBackoffMs: Math.max(0, toNumber(source.maxBackoffMs, defaults.maxBackoffMs || 10000)),
    ...(Array.isArray(source.retryOn) ? { retryOn: [...source.retryOn] } : {}),
  };
}

function normalizeWait(wait) {
  if (wait === undefined || wait === null || wait === false) return undefined;

  if (typeof wait === 'number') {
    return { type: 'delay', ms: wait };
  }

  if (typeof wait === 'object') {
    const type = wait.type || 'delay';
    const ms = toNumber(wait.ms ?? wait.timeout, undefined);
    return {
      ...wait,
      type: type === 'wait' ? 'delay' : type,
      ...(ms !== undefined ? { ms } : {}),
    };
  }

  return wait;
}

function normalizeSettings(settings = {}, options = {}) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...settings,
    defaultRetryPolicy: {
      ...DEFAULT_SETTINGS.defaultRetryPolicy,
      ...(settings.defaultRetryPolicy || {}),
    },
  };

  if (options.defaultTimeout !== undefined) {
    merged.defaultTimeout = options.defaultTimeout;
  }

  merged.defaultTimeout = Math.max(1, toNumber(merged.defaultTimeout, DEFAULT_SETTINGS.defaultTimeout));
  merged.defaultRetryPolicy = normalizeRetryPolicy(
    merged.defaultRetryPolicy,
    DEFAULT_SETTINGS.defaultRetryPolicy,
  );
  merged.continueOnNonCriticalFailure = merged.continueOnNonCriticalFailure !== false;

  return merged;
}

function normalizeStep(step, index, settings) {
  const normalized = {
    ...step,
    index,
    critical: step.critical !== false,
    timeoutMs: Math.max(1, toNumber(step.timeoutMs, settings.defaultTimeout)),
    retryPolicy: normalizeRetryPolicy(step.retryPolicy, settings.defaultRetryPolicy),
  };

  if (step.params === undefined && step.command) {
    normalized.params = {};
  }

  if (step.fallback) {
    normalized.fallback = {
      ...step.fallback,
      params: step.fallback.params || {},
    };
  }

  if (step.wait !== undefined) {
    normalized.wait = normalizeWait(step.wait);
  }

  return normalized;
}

function normalizeWorkflow(workflow, options = {}) {
  const source = clone(workflow) || {};
  const settings = normalizeSettings(source.settings || {}, {
    defaultTimeout: options.defaultTimeout,
  });

  return {
    ...source,
    settings,
    variables: source.variables || {},
    steps: Array.isArray(source.steps)
      ? source.steps.map((step, index) => normalizeStep(step, index, settings))
      : source.steps,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeWorkflow,
  normalizeSettings,
  normalizeStep,
  normalizeRetryPolicy,
  normalizeWait,
};
