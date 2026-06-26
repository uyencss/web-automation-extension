const {
  getCommand,
  hasCommand,
  isUnsupportedCommand,
  getUnsupportedReason,
  validateCommandParams,
} = require('./command-catalog');
const { extractTemplatePaths } = require('./workflow-context');

const SUPPORTED_STRATEGIES = new Set(['ai-vision']);
const SUPPORTED_GUARDS = new Set(['element-exists', 'element-absent', 'url-matches', 'expression']);
const BUILTIN_VARIABLES = new Set([
  '__TIMESTAMP__',
  '__DATE__',
  '__WORKFLOW_ID__',
  '__RUN_ID__',
  '__ACTIVE_TAB_ID__',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function routeTargets(step) {
  const targets = [];
  if (typeof step.onSuccess === 'string') targets.push({ label: 'onSuccess', target: step.onSuccess });

  if (typeof step.onFailure === 'string') {
    targets.push({ label: 'onFailure', target: step.onFailure });
  } else if (isObject(step.onFailure)) {
    for (const [code, target] of Object.entries(step.onFailure)) {
      targets.push({ label: `onFailure.${code}`, target });
    }
  }

  return targets;
}

function validateCommandUsage(commandName, params, label, errors, warnings, options) {
  if (!commandName) return;

  if (isUnsupportedCommand(commandName)) {
    errors.push(`${label}: command "${commandName}" is currently unsupported. ${getUnsupportedReason(commandName)}`);
    return;
  }

  if (!hasCommand(commandName)) {
    const message = `${label}: command "${commandName}" is not in the WebMCP command catalog`;
    if (options.allowUnknownCommand) warnings.push(`${message}; passthrough is enabled`);
    else errors.push(message);
    return;
  }

  if (params !== undefined && !isObject(params)) {
    errors.push(`${label}: params must be an object`);
    return;
  }

  errors.push(...validateCommandParams(commandName, params || {}).map((message) => `${label}: ${message}`));

  const command = getCommand(commandName);
  if (command?.group === 'runner' && params && Object.keys(params).length === 0 && commandName !== 'wait' && commandName !== 'delay') {
    warnings.push(`${label}: runner command "${commandName}" has no parameters`);
  }
}

function validateRetryPolicy(policy, label, errors) {
  if (!policy) return;
  if (!isObject(policy)) {
    errors.push(`${label}: retryPolicy must be an object`);
    return;
  }

  if (policy.maxAttempts !== undefined && (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1)) {
    errors.push(`${label}: retryPolicy.maxAttempts must be an integer >= 1`);
  }

  for (const key of ['backoffMs', 'maxBackoffMs']) {
    if (policy[key] !== undefined && (!Number.isFinite(policy[key]) || policy[key] < 0)) {
      errors.push(`${label}: retryPolicy.${key} must be a number >= 0`);
    }
  }

  if (policy.retryOn !== undefined && !Array.isArray(policy.retryOn)) {
    errors.push(`${label}: retryPolicy.retryOn must be an array of error codes`);
  }
}

function validateWait(wait, label, errors) {
  if (wait === undefined) return;
  if (!isObject(wait)) {
    errors.push(`${label}: wait must be an object`);
    return;
  }
  if (wait.type !== 'delay') {
    errors.push(`${label}: wait.type must be "delay"`);
  }
  if (!Number.isFinite(wait.ms) || wait.ms < 0) {
    errors.push(`${label}: wait.ms must be a number >= 0`);
  }
}

function validateGuard(guard, label, errors) {
  if (guard === undefined) return;
  if (!isObject(guard)) {
    errors.push(`${label}: guard must be an object`);
    return;
  }

  if (!SUPPORTED_GUARDS.has(guard.type)) {
    errors.push(`${label}: guard.type must be one of ${Array.from(SUPPORTED_GUARDS).join(', ')}`);
    return;
  }

  if ((guard.type === 'element-exists' || guard.type === 'element-absent') && !guard.selector && !guard.target) {
    errors.push(`${label}: ${guard.type} guard requires selector or target`);
  }
  if (guard.type === 'url-matches' && !guard.urlPattern) {
    errors.push(`${label}: url-matches guard requires urlPattern`);
  }
  if (guard.type === 'expression' && !guard.expression) {
    errors.push(`${label}: expression guard requires expression`);
  }
  if (guard.timeout !== undefined && (!Number.isFinite(guard.timeout) || guard.timeout < 0)) {
    errors.push(`${label}: guard.timeout must be a number >= 0`);
  }
}

function validateTemplateRefs(value, label, knownVariables, stepIds, errors, warnings, strict) {
  const refs = Array.from(extractTemplatePaths(value)).sort();

  for (const expression of refs) {
    const parts = expression.split('.').map((part) => part.trim()).filter(Boolean);
    const root = parts[0];

    if (!root) continue;
    if (BUILTIN_VARIABLES.has(expression) || BUILTIN_VARIABLES.has(root)) continue;
    if (root === 'last') continue;

    if (root === 'steps') {
      const stepId = parts[1];
      if (!stepId) {
        errors.push(`${label}: template "{{${expression}}}" must include a step id`);
      } else if (!stepIds.has(stepId)) {
        errors.push(`${label}: template "{{${expression}}}" references unknown step "${stepId}"`);
      }
      continue;
    }

    if (root === 'outputs') {
      const outputName = parts[1];
      if (!outputName || knownVariables.has(outputName)) continue;
      const message = `${label}: template "{{${expression}}}" references unknown captured output "${outputName}"`;
      if (strict) errors.push(message);
      else warnings.push(message);
      continue;
    }

    if (!knownVariables.has(root)) {
      const message = `${label}: template "{{${expression}}}" references unknown variable "${root}"`;
      if (strict) errors.push(message);
      else warnings.push(message);
    }
  }
}

function detectOnSuccessCycles(steps, stepById, errors) {
  for (const start of steps) {
    const seen = new Set();
    let current = start;

    while (current?.onSuccess) {
      if (seen.has(current.id)) {
        errors.push(`Step "${start.id}": onSuccess route contains a cycle at "${current.id}"`);
        break;
      }

      seen.add(current.id);
      current = stepById.get(current.onSuccess);
    }
  }
}

function validateWorkflow(workflow, options = {}) {
  const errors = [];
  const warnings = [];
  const strict = Boolean(options.strict);
  const allowUnknownCommand = Boolean(options.allowUnknownCommand);
  const runtimeVariables = options.runtimeVariables || {};
  const knownVariables = new Set([
    ...Object.keys(workflow?.variables || {}),
    ...Object.keys(runtimeVariables),
    ...BUILTIN_VARIABLES,
  ]);

  if (!workflow || !isObject(workflow)) {
    return { valid: false, errors: ['Workflow must be an object'], warnings };
  }

  if (!workflow.id) errors.push('Workflow is missing "id"');
  if (!workflow.name) errors.push('Workflow is missing "name"');
  if (workflow.settings !== undefined && !isObject(workflow.settings)) {
    errors.push('Workflow "settings" must be an object');
  }
  if (isObject(workflow.settings)) {
    if (!Number.isFinite(workflow.settings.defaultTimeout) || workflow.settings.defaultTimeout <= 0) {
      errors.push('Workflow settings.defaultTimeout must be a positive number');
    }
    validateRetryPolicy(workflow.settings.defaultRetryPolicy, 'Workflow settings.defaultRetryPolicy', errors);
  }
  if (!Array.isArray(workflow.steps)) {
    errors.push('Workflow "steps" must be an array');
    return { valid: false, errors, warnings };
  }
  if (workflow.steps.length === 0) errors.push('Workflow must contain at least one step');

  const stepById = new Map();
  const stepIds = new Set();
  for (let index = 0; index < workflow.steps.length; index++) {
    const step = workflow.steps[index];
    const label = `Step ${index + 1}${step?.id ? ` "${step.id}"` : ''}`;

    if (!isObject(step)) {
      errors.push(`${label}: step must be an object`);
      continue;
    }

    if (!step.id) {
      errors.push(`${label}: missing "id"`);
      continue;
    }
    if (stepIds.has(step.id)) errors.push(`${label}: duplicate step id "${step.id}"`);
    stepIds.add(step.id);
    stepById.set(step.id, step);
  }

  for (let index = 0; index < workflow.steps.length; index++) {
    const step = workflow.steps[index];
    if (!isObject(step)) continue;
    const label = `Step ${index + 1}${step.id ? ` "${step.id}"` : ''}`;

    if (!step.command && !step.strategy) {
      errors.push(`${label}: must define either "command" or "strategy"`);
    }

    if (step.command) {
      validateCommandUsage(step.command, step.params, label, errors, warnings, {
        allowUnknownCommand,
      });
    }

    if (step.strategy) {
      if (!SUPPORTED_STRATEGIES.has(step.strategy)) {
        errors.push(`${label}: unsupported strategy "${step.strategy}"`);
      }
      if (step.strategy === 'ai-vision' && !step.instruction) {
        errors.push(`${label}: strategy "ai-vision" requires instruction`);
      }
    }

    if (step.fallback) {
      if (!isObject(step.fallback)) {
        errors.push(`${label}: fallback must be an object`);
      } else {
        validateCommandUsage(step.fallback.command, step.fallback.params || {}, `${label} fallback`, errors, warnings, {
          allowUnknownCommand,
        });
      }
    }

    for (const route of routeTargets(step)) {
      if (typeof route.target !== 'string' || !stepIds.has(route.target)) {
        errors.push(`${label}: ${route.label} points to unknown step "${route.target}"`);
      }
      if (route.target === step.id) {
        errors.push(`${label}: ${route.label} cannot point to itself`);
      }
    }

    if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) {
      errors.push(`${label}: timeoutMs must be a positive number`);
    }

    validateRetryPolicy(step.retryPolicy, label, errors);
    validateWait(step.wait, label, errors);
    validateGuard(step.guard, label, errors);
    validateTemplateRefs(step, label, knownVariables, stepIds, errors, warnings, strict);

    if (step.captureAs) {
      knownVariables.add(step.captureAs);
    }
  }

  detectOnSuccessCycles(workflow.steps.filter(isObject), stepById, errors);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  BUILTIN_VARIABLES,
  SUPPORTED_STRATEGIES,
  SUPPORTED_GUARDS,
  validateWorkflow,
};
