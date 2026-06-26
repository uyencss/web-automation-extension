const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringifyTemplateValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function makeRoot(context) {
  return {
    ...context.variables,
    steps: context.steps,
    last: context.last,
    outputs: context.outputs,
  };
}

function getPathValue(root, path) {
  if (!path) return undefined;
  if (Object.prototype.hasOwnProperty.call(root, path)) return root[path];

  const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
  let current = root;

  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(Object(current), part)) return undefined;
    current = current[part];
  }

  return current;
}

function setPathValue(root, path, value) {
  const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return;

  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function extractTemplatePaths(value, paths = new Set()) {
  if (typeof value === 'string') {
    let match;
    const pattern = new RegExp(TEMPLATE_PATTERN.source, 'g');
    while ((match = pattern.exec(value))) {
      paths.add(match[1].trim());
    }
    return paths;
  }

  if (Array.isArray(value)) {
    for (const item of value) extractTemplatePaths(item, paths);
    return paths;
  }

  if (isPlainObject(value)) {
    for (const item of Object.values(value)) extractTemplatePaths(item, paths);
  }

  return paths;
}

class WorkflowContext {
  constructor(workflowVariables = {}, runtimeVariables = {}, builtins = {}) {
    this.variables = {
      ...workflowVariables,
      ...runtimeVariables,
      ...builtins,
    };
    this.outputs = {};
    this.steps = {};
    this.last = null;
    this.lastStepId = null;
  }

  get(path) {
    return getPathValue(makeRoot(this), path);
  }

  set(path, value) {
    if (!path.includes('.')) {
      this.variables[path] = value;
      return;
    }
    setPathValue(this.variables, path, value);
  }

  setBuiltin(name, value) {
    this.variables[name] = value;
  }

  setCaptured(name, value) {
    this.variables[name] = value;
    this.outputs[name] = value;
  }

  setStepResult(stepId, record) {
    this.steps[stepId] = record;
    this.last = record;
    this.lastStepId = stepId;
  }

  getStepResult(stepId) {
    return this.steps[stepId];
  }

  getLastResult() {
    return this.last;
  }

  interpolate(value) {
    if (typeof value === 'string') {
      const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
      if (exact) {
        const resolved = this.get(exact[1].trim());
        return resolved === undefined ? value : resolved;
      }

      return value.replace(TEMPLATE_PATTERN, (match, expression) => {
        const resolved = this.get(expression.trim());
        return resolved === undefined ? match : stringifyTemplateValue(resolved);
      });
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.interpolate(item));
    }

    if (isPlainObject(value)) {
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        output[key] = this.interpolate(item);
      }
      return output;
    }

    return value;
  }

  serialize() {
    return {
      variables: this.variables,
      outputs: this.outputs,
      steps: this.steps,
      lastStepId: this.lastStepId,
    };
  }
}

module.exports = {
  WorkflowContext,
  TEMPLATE_PATTERN,
  extractTemplatePaths,
  stringifyTemplateValue,
};
