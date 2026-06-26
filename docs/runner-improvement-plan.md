# Implementation Plan: WebMCP JSON Runner V2

> **Date**: 2026-06-26  
> **Status**: Planned  
> **Goal**: Upgrade `workflow-runner.js` with P0 and P1 features from `auto-lib` while maintaining a zero-dependency, single-file architecture (< 500 LOC).

---

## 1. Core Architecture Updates

The runner will be refactored into a `WorkflowRunner` class to manage state, events, and cancellation cleanly, replacing the current functional approach.

```javascript
class WorkflowRunner extends EventEmitter {
  constructor(workflow, options = {}) {
    super();
    this.workflow = workflow;
    this.options = options;
    this.context = new WorkflowContext(workflow.variables, options.variables);
    this.abortController = new AbortController();
  }
  
  // ... methods
}
```

## 2. P0: Must-Have Features Implementation

### 2.1 Exponential Backoff with Cap

**Changes**: Update the retry loop in `executeStep`.

```javascript
// New backoff logic
function getRetryDelay(policy, attempt) {
  const baseDelay = policy.backoffMs || 1000;
  const uncapped = baseDelay * Math.pow(2, attempt - 1);
  return policy.maxBackoffMs ? Math.min(uncapped, policy.maxBackoffMs) : uncapped;
}
```

### 2.2 Cancellation (AbortController)

**Changes**: 
1. Add `AbortController` to the runner.
2. Implement `cancellableSleep`.
3. Check `this.abortController.signal.aborted` before every step.

```javascript
function cancellableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}
```

### 2.3 Step Duration Tracking

**Changes**: Record `startTime` before execution and calculate duration.

```javascript
const startTime = Date.now();
// ... execute ...
const duration = Date.now() - startTime;
return { status: 'success', stepId, result, duration };
```

### 2.4 Guard Clauses & Step Routing (onSuccess/onFailure)

**Changes**:
1. Add `evaluateGuard(guard, context)` function using `evaluateJS`.
2. Update the main workflow loop to support jumping to specific steps instead of simple sequential execution (or support conditional skipping).

```javascript
// Step execution loop
let currentStepId = workflow.steps[0].id;

while (currentStepId) {
  const step = workflow.steps.find(s => s.id === currentStepId);
  
  if (step.guard) {
    const passed = await evaluateGuard(step.guard, context);
    if (!passed) {
      this.emit('step_skipped', { stepId: step.id });
      currentStepId = getNextStepId(step.id); // Or follow onSuccess
      continue;
    }
  }
  
  // ... execute step ...
  
  if (result.status === 'success' && step.onSuccess) {
    currentStepId = step.onSuccess;
  } else if (result.status === 'failed' && step.onFailure) {
    currentStepId = typeof step.onFailure === 'string' ? step.onFailure : step.onFailure[result.error.code || 'default'];
  } else {
    currentStepId = getNextStepId(step.id);
  }
}
```

## 3. P1: Should-Have Features Implementation

### 3.1 Event Emitter (Hooks)

**Changes**: Make `WorkflowRunner` extend `events.EventEmitter`.

```javascript
this.emit('start', { workflowId: this.workflow.id });
this.emit('step_start', { stepId: step.id });
this.emit('step_end', { stepId: step.id, result });
this.emit('end', { summary });
```

### 3.2 Structured Step Result Store

**Changes**: Create a `WorkflowContext` class.

```javascript
class WorkflowContext {
  constructor(workflowVars, runtimeVars) {
    this.variables = { ...workflowVars, ...runtimeVars };
    this.stepResults = {};
  }
  
  // Interpolation now supports nested paths: {{steps.my-step.result.id}}
  interpolate(value) {
    // Implement Lodash-like get() for deep property access
  }
}
```

### 3.3 Workflow Composition (Include Fragments)

**Changes**: Add a compilation phase before execution.

```javascript
function composeWorkflow(workflowDef, baseDir) {
  const composedSteps = [];
  for (const step of workflowDef.steps) {
    if (step.include) {
      const fragmentPath = path.resolve(baseDir, step.include);
      const fragment = JSON.parse(fs.readFileSync(fragmentPath, 'utf-8'));
      // Prefix IDs and merge
      composedSteps.push(...fragment.steps.map(s => ({...s, id: `${step.id}_${s.id}`})));
    } else {
      composedSteps.push(step);
    }
  }
  return { ...workflowDef, steps: composedSteps };
}
```

## 4. Execution Steps

1. **Refactor `workflow-runner.js`** to object-oriented (`WorkflowRunner` class) and implement Event Emitter.
2. **Implement `WorkflowContext`** for structured variables and step results.
3. **Add Guard evaluation** logic using `evaluateJS`.
4. **Update Retry Logic** with exponential backoff.
5. **Implement `AbortController`** support and duration tracking.
6. **Implement Step Routing** (`onSuccess`/`onFailure`).
7. **Add composition logic** in `run.js` (CLI).
8. **Test** with a complex workflow utilizing all new features.
