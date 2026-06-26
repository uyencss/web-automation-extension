const { EventEmitter } = require('events');
const { sendCommand: defaultSendCommand } = require('./transport');
const { WorkflowContext } = require('./workflow-context');
const { normalizeWorkflow } = require('./workflow-normalizer');
const { validateWorkflow } = require('./workflow-validator');
const { createEventFactory } = require('./runner-events');
const { RunnerError, normalizeError, errorToJSON } = require('./errors');

const COMMANDS_WITHOUT_ACTIVE_TAB = new Set([
  'listTabs',
  'newTab',
  'getActiveTab',
  'listWindows',
  'createWindow',
  'ping',
  'wait',
  'delay',
]);

const AI_STOPWORDS = new Set([
  'the',
  'and',
  'find',
  'click',
  'button',
  'that',
  'for',
  'with',
  'this',
  'input',
  'area',
  'text',
  'hay',
  'hoac',
  'hoặc',
  'dang',
  'đang',
]);

function generateRunId(workflowId) {
  const safeWorkflowId = String(workflowId || 'workflow').replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `${safeWorkflowId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeBuiltins(workflow, runId, tabId) {
  return {
    __TIMESTAMP__: Date.now().toString(),
    __DATE__: new Date().toISOString().slice(0, 10),
    __WORKFLOW_ID__: workflow.id || 'unknown',
    __RUN_ID__: runId,
    __ACTIVE_TAB_ID__: tabId ?? '',
  };
}

function sleep(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(normalizeError(signal.reason || new RunnerError('Workflow aborted', { code: 'ABORTED' })));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(normalizeError(signal.reason || new RunnerError('Workflow aborted', { code: 'ABORTED' })));
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function calculateBackoff(retryPolicy, failedAttempt) {
  const base = retryPolicy.backoffMs || 0;
  const cap = retryPolicy.maxBackoffMs ?? base;
  const delay = base * (2 ** Math.max(0, failedAttempt - 1));
  return Math.min(delay, cap);
}

function shouldRetry(error, retryPolicy, attempt) {
  if (attempt >= retryPolicy.maxAttempts) return false;
  if (Array.isArray(retryPolicy.retryOn) && retryPolicy.retryOn.length > 0) {
    return retryPolicy.retryOn.includes(error.code);
  }
  return true;
}

function extractCaptureValue(result) {
  if (
    result &&
    typeof result === 'object' &&
    Object.prototype.hasOwnProperty.call(result, 'result')
  ) {
    return result.result;
  }
  return result;
}

function pickRouteIndex(steps, targetStepId) {
  if (!targetStepId) return null;
  const index = steps.findIndex((step) => step.id === targetStepId);
  return index === -1 ? null : index;
}

function keywordTokens(instruction) {
  return String(instruction || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['"`]/g, '')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !AI_STOPWORDS.has(word));
}

function scoreInteractiveElement(element, instruction, tokens) {
  const combined = [
    element.text,
    element.placeholder,
    element.ariaLabel,
    element.href,
    element.name,
    element.id,
    element.role,
  ].filter(Boolean).join(' ').toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (combined.includes(token)) score += 1;
  }

  const loweredInstruction = String(instruction || '').toLowerCase();
  if (loweredInstruction.includes('button') && (element.tag === 'button' || element.role === 'button')) score += 2;
  if (loweredInstruction.includes('input') && element.tag === 'input') score += 2;
  if (loweredInstruction.includes('link') && element.tag === 'a') score += 2;
  if (loweredInstruction.includes('textbox') && (element.tag === 'textarea' || element.role === 'textbox')) score += 2;

  return score;
}

function targetPresenceExpression(target) {
  if (!target || !target.mode || target.value === undefined) return null;
  const value = JSON.stringify(target.value);

  switch (target.mode) {
    case 'css':
      return `document.querySelector(${value})`;
    case 'id':
      return `document.getElementById(${value})`;
    case 'aria-label':
      return `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label') === ${value})`;
    case 'text':
      return `Array.from(document.querySelectorAll('body *')).find((el) => ((el.innerText || el.textContent || '').trim()).includes(${value}))`;
    case 'xpath':
      return `document.evaluate(${value}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
    default:
      return null;
  }
}

class WorkflowRunner extends EventEmitter {
  constructor(workflow, options = {}) {
    super();

    const runId = options.runId || generateRunId(workflow?.id);
    this.workflow = normalizeWorkflow(workflow, {
      defaultTimeout: options.timeoutMs,
    });
    this.options = {
      ...options,
      runId,
      variables: options.variables || {},
      strictValidation: Boolean(options.strictValidation),
      allowUnknownCommand: Boolean(options.allowUnknownCommand),
    };
    this.transport = options.transport || defaultSendCommand;
    this.runId = runId;
    this.activeTabId = options.tabId ?? null;
    this.abortController = new AbortController();
    this.validation = null;
    this.state = {
      runId,
      workflowId: this.workflow.id,
      status: 'created',
      currentStepId: null,
      startedAt: null,
      endedAt: null,
      results: [],
    };

    this.context = new WorkflowContext(
      this.workflow.variables,
      this.options.variables,
      makeBuiltins(this.workflow, runId, this.activeTabId),
    );

    this.makeEvent = createEventFactory({
      runId,
      workflowId: this.workflow.id,
      getTabId: () => this.activeTabId ?? undefined,
    });

    if (options.signal?.aborted) {
      this.abort(options.signal.reason || 'External signal already aborted');
    } else if (options.signal) {
      options.signal.addEventListener('abort', () => {
        this.abort(options.signal.reason || 'External abort signal received');
      }, { once: true });
    }
  }

  validate() {
    this.validation = validateWorkflow(this.workflow, {
      strict: this.options.strictValidation,
      allowUnknownCommand: this.options.allowUnknownCommand,
      runtimeVariables: this.options.variables,
    });
    return this.validation;
  }

  abort(reason = 'Workflow aborted') {
    if (this.abortController.signal.aborted) return;
    const error = reason instanceof Error
      ? normalizeError(reason)
      : new RunnerError(String(reason), { code: 'ABORTED' });
    this.abortController.abort(error);
  }

  getState() {
    return {
      ...this.state,
      activeTabId: this.activeTabId,
      validation: this.validation,
      context: this.context.serialize(),
    };
  }

  emitRunnerEvent(type, payload = {}) {
    const event = this.makeEvent(type, payload);
    this.emit(type, event);
    this.emit('event', event);
    return event;
  }

  async run() {
    const startedAt = Date.now();
    this.state.status = 'running';
    this.state.startedAt = new Date(startedAt).toISOString();

    const validation = this.validate();
    this.emitRunnerEvent('start', {
      workflow: {
        id: this.workflow.id,
        name: this.workflow.name,
        version: this.workflow.version || '1.0',
      },
      totalSteps: Array.isArray(this.workflow.steps) ? this.workflow.steps.length : 0,
      settings: this.workflow.settings,
      warnings: validation.warnings,
    });

    if (!validation.valid) {
      const error = new RunnerError('Workflow validation failed', {
        code: 'VALIDATION_ERROR',
        details: validation.errors,
      });
      return this.finishRun(startedAt, 'failed', error);
    }

    const steps = this.workflow.steps;
    const maxTransitions = Math.max(steps.length * 20, 100);
    let currentIndex = 0;
    let transitions = 0;
    let fatalError = null;

    try {
      while (currentIndex !== null && currentIndex < steps.length) {
        this.checkAborted();
        transitions += 1;
        if (transitions > maxTransitions) {
          throw new RunnerError(`Workflow exceeded ${maxTransitions} route transitions`, {
            code: 'ROUTE_LOOP',
          });
        }

        const step = steps[currentIndex];
        this.state.currentStepId = step.id;
        const record = await this.executeStep(step, currentIndex, steps.length);
        this.state.results.push(record);

        if (record.status === 'success') {
          currentIndex = this.resolveSuccessRoute(step, currentIndex);
          continue;
        }

        if (record.status === 'skipped') {
          currentIndex += 1;
          continue;
        }

        const failureRouteIndex = this.resolveFailureRoute(step, record.error);
        if (failureRouteIndex !== null) {
          this.emitRunnerEvent('recovery', {
            stepId: step.id,
            error: record.error,
            nextStepId: steps[failureRouteIndex].id,
          });
          currentIndex = failureRouteIndex;
          continue;
        }

        const canContinue = !step.critical && this.workflow.settings.continueOnNonCriticalFailure;
        if (canContinue) {
          currentIndex += 1;
          continue;
        }

        fatalError = record.error;
        break;
      }
    } catch (error) {
      fatalError = errorToJSON(error);
    }

    if (fatalError) {
      const code = fatalError.code || 'COMMAND_FAILED';
      const status = code === 'TIMEOUT' ? 'timed_out' : (code === 'ABORTED' ? 'aborted' : 'failed');
      return this.finishRun(startedAt, status, fatalError);
    }

    const failedSteps = this.state.results.filter((result) => result.status === 'failed');
    const status = failedSteps.length > 0 ? 'completed_with_errors' : 'completed';
    return this.finishRun(startedAt, status);
  }

  finishRun(startedAt, status, error) {
    const endedAt = Date.now();
    const results = this.state.results;
    const summary = {
      runId: this.runId,
      workflowId: this.workflow.id,
      workflowName: this.workflow.name,
      workflowVersion: this.workflow.version || '1.0',
      status,
      duration: endedAt - startedAt,
      stepsCompleted: results.filter((result) => result.status === 'success').length,
      stepsFailed: results.filter((result) => result.status === 'failed').length,
      stepsSkipped: results.filter((result) => result.status === 'skipped').length,
      stepsTotal: Array.isArray(this.workflow.steps) ? this.workflow.steps.length : 0,
      results,
      context: this.context.serialize(),
      warnings: this.validation?.warnings || [],
      ...(error ? { error: error.code ? error : errorToJSON(error) } : {}),
    };

    this.state.status = status;
    this.state.currentStepId = null;
    this.state.endedAt = new Date(endedAt).toISOString();
    this.emitRunnerEvent('end', summary);
    return summary;
  }

  checkAborted() {
    if (!this.abortController.signal.aborted) return;
    throw normalizeError(this.abortController.signal.reason || new RunnerError('Workflow aborted', { code: 'ABORTED' }));
  }

  async executeStep(step, stepIndex, totalSteps) {
    const startedAt = Date.now();
    const basePayload = {
      stepId: step.id,
      stepIndex,
      totalSteps,
      command: step.command,
      strategy: step.strategy,
    };

    this.emitRunnerEvent('step', {
      type: 'started',
      ...basePayload,
    });

    const guardResult = await this.evaluateGuard(step);
    if (!guardResult.ok) {
      const duration = Date.now() - startedAt;
      if (!step.critical) {
        const record = {
          status: 'skipped',
          ...basePayload,
          duration,
          reason: guardResult.reason,
          guard: guardResult.result,
        };
        this.context.setStepResult(step.id, record);
        this.emitRunnerEvent('step', {
          type: 'skipped',
          ...basePayload,
          duration,
          reason: guardResult.reason,
        });
        return record;
      }

      const error = new RunnerError(guardResult.reason, {
        code: 'GUARD_FAILED',
        details: guardResult.result,
      });
      return this.makeFailedStepRecord(step, basePayload, startedAt, 0, error);
    }

    const retryPolicy = step.retryPolicy || this.workflow.settings.defaultRetryPolicy;
    let attempt = 0;
    let lastError = null;

    while (attempt < retryPolicy.maxAttempts) {
      attempt += 1;
      this.checkAborted();

      try {
        const result = await this.executeStepAttempt(step);

        if (step.wait) {
          await this.applyPostWait(step);
        }

        if (step.captureAs) {
          this.context.setCaptured(step.captureAs, extractCaptureValue(result));
          this.emitRunnerEvent('progress', {
            stepId: step.id,
            captureAs: step.captureAs,
          });
        }

        this.updateActiveTab(result);

        const duration = Date.now() - startedAt;
        const record = {
          status: 'success',
          ...basePayload,
          attempts: attempt,
          duration,
          result,
        };
        this.context.setStepResult(step.id, record);
        this.emitRunnerEvent('step', {
          type: 'completed',
          ...basePayload,
          attempt,
          duration,
          result,
        });
        return record;
      } catch (error) {
        const normalized = normalizeError(error);
        lastError = normalized;

        if (this.abortController.signal.aborted && normalized.code === 'ABORTED') {
          throw normalized;
        }

        if (shouldRetry(normalized, retryPolicy, attempt)) {
          const delayMs = calculateBackoff(retryPolicy, attempt);
          this.emitRunnerEvent('step', {
            type: 'retrying',
            ...basePayload,
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
            error: errorToJSON(normalized),
          });
          await sleep(delayMs, this.abortController.signal);
          continue;
        }

        return this.makeFailedStepRecord(step, basePayload, startedAt, attempt, lastError);
      }
    }

    return this.makeFailedStepRecord(step, basePayload, startedAt, attempt, lastError);
  }

  makeFailedStepRecord(step, basePayload, startedAt, attempts, error) {
    const duration = Date.now() - startedAt;
    const serializedError = errorToJSON(error);
    const record = {
      status: 'failed',
      ...basePayload,
      attempts,
      duration,
      error: serializedError,
    };
    this.context.setStepResult(step.id, record);
    this.emitRunnerEvent('step', {
      type: 'failed',
      ...basePayload,
      attempt: attempts,
      duration,
      error: serializedError,
    });
    return record;
  }

  async executeStepAttempt(step) {
    if (step.strategy === 'ai-vision') {
      return this.executeAiVisionStep(step);
    }

    if (step.command === 'wait' || step.command === 'delay') {
      const params = this.context.interpolate(step.params || {});
      const ms = Number(params.ms ?? params.timeout ?? 1000);
      await sleep(ms, this.abortController.signal);
      return { waited: ms };
    }

    if (!step.command) {
      throw new RunnerError(`Step "${step.id}" has no command or strategy`, {
        code: 'INVALID_STEP',
      });
    }

    const params = this.context.interpolate(step.params || {});
    return this.sendGatewayCommand(step.command, params, step.timeoutMs);
  }

  async executeAiVisionStep(step) {
    const instruction = this.context.interpolate(step.instruction || '');
    const observation = await this.sendGatewayCommand('getInteractiveElements', {}, step.timeoutMs);
    const elements = Array.isArray(observation?.elements) ? observation.elements : [];

    if (elements.length === 0) {
      throw new RunnerError('AI vision found no interactive elements on the page', {
        code: 'NO_TARGET',
      });
    }

    const tokens = keywordTokens(instruction);
    let bestMatch = null;
    let bestScore = 0;

    for (const element of elements) {
      const score = scoreInteractiveElement(element, instruction, tokens);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = element;
      }
    }

    if (!bestMatch || bestScore === 0 || !bestMatch.bounds) {
      if (step.fallback?.command) {
        const fallbackParams = this.context.interpolate(step.fallback.params || {});
        return this.sendGatewayCommand(step.fallback.command, fallbackParams, step.timeoutMs);
      }

      throw new RunnerError(`AI vision could not find a target for "${instruction}"`, {
        code: 'NO_TARGET',
      });
    }

    return this.sendGatewayCommand('dispatchClick', {
      x: bestMatch.bounds.centerX,
      y: bestMatch.bounds.centerY,
    }, step.timeoutMs);
  }

  async sendGatewayCommand(command, params, timeoutMs) {
    this.checkAborted();
    const resolvedParams = {
      ...(params || {}),
    };

    if (
      this.activeTabId !== null &&
      this.activeTabId !== undefined &&
      resolvedParams.tabId === undefined &&
      !COMMANDS_WITHOUT_ACTIVE_TAB.has(command)
    ) {
      resolvedParams.tabId = this.activeTabId;
    }

    const result = await this.transport(command, resolvedParams, {
      gatewayUrl: this.options.gatewayUrl,
      timeoutMs,
      signal: this.abortController.signal,
    });
    this.updateActiveTab(result);
    return result;
  }

  updateActiveTab(result) {
    if (!result || typeof result !== 'object' || result.tabId === undefined || result.tabId === null) return;
    this.activeTabId = result.tabId;
    this.context.setBuiltin('__ACTIVE_TAB_ID__', result.tabId);
  }

  async applyPostWait(step) {
    if (!step.wait) return;
    if (step.wait.type !== 'delay') {
      throw new RunnerError(`Unsupported wait type "${step.wait.type}"`, {
        code: 'INVALID_WAIT',
      });
    }
    await sleep(step.wait.ms, this.abortController.signal);
  }

  async evaluateGuard(step) {
    if (!step.guard) return { ok: true };

    const guard = this.context.interpolate(step.guard);
    const timeoutMs = guard.timeout || step.timeoutMs;

    if (guard.type === 'element-exists') {
      if (guard.selector) {
        const result = await this.sendGatewayCommand('waitForSelector', {
          selector: guard.selector,
          timeout: timeoutMs,
        }, timeoutMs);
        return {
          ok: result?.found !== false,
          result,
          reason: `Guard failed: selector not found (${guard.selector})`,
        };
      }
      return this.evaluateTargetPresenceGuard(guard.target, true, timeoutMs);
    }

    if (guard.type === 'element-absent') {
      if (guard.selector) {
        const result = await this.sendGatewayCommand('evaluateJS', {
          code: `return !document.querySelector(${JSON.stringify(guard.selector)});`,
        }, timeoutMs);
        const ok = Boolean(result?.result);
        return {
          ok,
          result,
          reason: `Guard failed: selector exists (${guard.selector})`,
        };
      }
      return this.evaluateTargetPresenceGuard(guard.target, false, timeoutMs);
    }

    if (guard.type === 'url-matches') {
      const result = await this.sendGatewayCommand('getActiveTab', {}, timeoutMs);
      let ok = false;
      try {
        ok = new RegExp(guard.urlPattern).test(result?.url || '');
      } catch (error) {
        throw new RunnerError(`Invalid guard urlPattern: ${guard.urlPattern}`, {
          code: 'VALIDATION_ERROR',
          cause: error,
        });
      }
      return {
        ok,
        result,
        reason: `Guard failed: URL did not match ${guard.urlPattern}`,
      };
    }

    if (guard.type === 'expression') {
      const expression = String(guard.expression || '').trim();
      const code = expression.startsWith('return ') ? expression : `return Boolean(${expression});`;
      const result = await this.sendGatewayCommand('evaluateJS', { code }, timeoutMs);
      return {
        ok: Boolean(result?.result),
        result,
        reason: 'Guard failed: expression evaluated to false',
      };
    }

    throw new RunnerError(`Unsupported guard type "${guard.type}"`, {
      code: 'VALIDATION_ERROR',
    });
  }

  async evaluateTargetPresenceGuard(target, expectedPresent, timeoutMs) {
    const expression = targetPresenceExpression(target);
    if (!expression) {
      throw new RunnerError('Guard target is missing or unsupported', {
        code: 'VALIDATION_ERROR',
        details: { target },
      });
    }

    const result = await this.sendGatewayCommand('evaluateJS', {
      code: `return Boolean(${expression});`,
    }, timeoutMs);
    const present = Boolean(result?.result);
    const ok = expectedPresent ? present : !present;
    return {
      ok,
      result,
      reason: expectedPresent
        ? 'Guard failed: target was not present'
        : 'Guard failed: target was present',
    };
  }

  resolveSuccessRoute(step, currentIndex) {
    if (!step.onSuccess) return currentIndex + 1;
    const routeIndex = pickRouteIndex(this.workflow.steps, step.onSuccess);
    if (routeIndex === null) {
      throw new RunnerError(`onSuccess target not found: ${step.onSuccess}`, {
        code: 'VALIDATION_ERROR',
      });
    }
    return routeIndex;
  }

  resolveFailureRoute(step, error) {
    if (!step.onFailure) return null;

    if (typeof step.onFailure === 'string') {
      return pickRouteIndex(this.workflow.steps, step.onFailure);
    }

    if (typeof step.onFailure === 'object') {
      const target = step.onFailure[error?.code] || step.onFailure.default;
      return pickRouteIndex(this.workflow.steps, target);
    }

    return null;
  }
}

async function runWorkflow(workflow, runtimeVars = {}, options = {}) {
  const runner = new WorkflowRunner(workflow, {
    ...options,
    variables: runtimeVars,
  });
  return runner.run();
}

function interpolate(value, variables = {}) {
  return new WorkflowContext(variables).interpolate(value);
}

module.exports = {
  WorkflowRunner,
  runWorkflow,
  sendCommand: defaultSendCommand,
  interpolate,
};
