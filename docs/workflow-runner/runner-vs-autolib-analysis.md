# Deep Comparison: WebMCP Runner vs Auto-Lib + Workflow-Runners-Lib

> **Date**: 2026-06-26  
> **Status**: Historical analysis for archived optional runner  
> **Context**: Comparing `.archive/runner/` with `flow-auto-browser-extension` packages:
> - `@gyga-browser/auto-lib` (~3000 LOC)
> - `@gyga-browser/workflow-runners` (~2500 LOC)

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────┐
│                   Current Runner (~250 LOC)                   │
│                                                               │
│  workflow-runner.js                                           │
│  ├── sendCommand(method, params) → HTTP POST                  │
│  ├── interpolate(value, variables) → {{VAR}} replacement      │
│  ├── executeAiVisionStep() → getInteractiveElements + match   │
│  ├── executeStep() → retry loop + command dispatch            │
│  └── runWorkflow() → sequential step executor                 │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│               auto-lib Engine (~3000 LOC)                     │
│                                                               │
│  WorkflowEngine                                               │
│  ├── StepExecutor                                             │
│  │   ├── ActionDispatcher (CDPDriver / ScriptingDriver)       │
│  │   ├── TargetResolver (SmartWait + fallbacks + shadow DOM)  │
│  │   ├── GuardEvaluator (conditional step execution)          │
│  │   ├── RetryController (exponential backoff + error filter) │
│  │   └── NestedExecutor (condition/loop/group)                │
│  ├── WorkflowContext (Map-based variable + result store)      │
│  ├── CancellationSource (AbortController)                     │
│  └── NetworkCaptureService                                    │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│           workflow-runners-lib (~2500 LOC)                     │
│                                                               │
│  BaseRunner (TypedEmitter<RunnerEventMap>)                     │
│  ├── SequentialRunner                                         │
│  ├── QueueRunner                                              │
│  ├── BatchRunner                                              │
│  ├── DaemonRunner                                             │
│  ├── PreviewRunner                                            │
│  └── RemoteRunner                                             │
│                                                               │
│  WorkflowComposer (fragment merger + diagnostics)             │
│  RecoveryManager                                              │
│  ├── CircuitBreaker (closed→open→half-open)                   │
│  ├── CheckpointResume (save/restore state)                    │
│  ├── StaleElementRetry                                        │
│  └── GracefulDegradation                                      │
│                                                               │
│  ProgressEmitter (start/progress/step/end events)             │
│  RunContext (runId, abort signal, metadata)                    │
└───────────────────────────────────────────────────────────────┘
```

---

## Gap Analysis: 10 Critical Differences

### 🔴 P0 — Must Have (Missing Core Robustness)

| # | Feature | auto-lib / runners | Current Runner | Impact |
|---|---------|-------------------|----------------|--------|
| 1 | **Exponential Backoff** | `withBackoff()` — exp growth 50ms→1s, capped by `maxBackoffMs` | Linear: `backoffMs * attempt` | Retry too aggressive or too slow |
| 2 | **Cancellation / Abort** | `AbortController` + `CancellationToken` — propagates through all nested ops | ❌ None — Ctrl+C kills process | Can't stop a running workflow |
| 3 | **Step Duration Tracking** | `Date.now()` delta per step, in `StepResult.duration` | ❌ Not tracked | Can't measure performance |
| 4 | **Guard Clauses** | `guard: { type: 'element-exists', target }` — skip step if condition met | ❌ Not supported | Can't conditionally skip steps |
| 5 | **onSuccess / onFailure routing** | `onSuccess: 'step-id'`, `onFailure: { 'TARGET_NOT_FOUND': 'step-handle' }` | ❌ Sequential only | No error-specific routing |

### 🟡 P1 — Should Have (Missing Workflow Composition)

| # | Feature | auto-lib / runners | Current Runner | Impact |
|---|---------|-------------------|----------------|--------|
| 6 | **Workflow Composition** | `WorkflowComposer` — merge fragments, deduplicate IDs, diagnostics | ❌ Single-file only | Can't reuse sub-workflows |
| 7 | **Event Emitter** | `TypedEmitter<RunnerEventMap>` — start/progress/step/end/recovery | Console.log only | No programmatic hooks |
| 8 | **Step Result Store** | `WorkflowContext.addStepResult()` — results accessible to later steps | `captureAs` as string only | Can't reference structured data |

### 🟢 P2 — Nice to Have (Advanced Recovery)

| # | Feature | auto-lib / runners | Current Runner | Impact |
|---|---------|-------------------|----------------|--------|
| 9 | **Circuit Breaker** | Closes after N failures, half-opens after timeout | ❌ None | No protection against cascading failures |
| 10 | **Checkpoint/Resume** | Saves state per step, resumes from last successful | ❌ None | Can't resume interrupted workflows |

---

## What Runner Already Has (That Auto-Lib Doesn't)

| Feature | Runner ✅ | Auto-lib ❌ |
|---------|-----------|-------------|
| **AI Vision** | `getInteractiveElements` → fuzzy match → `dispatchClick` | No AI vision at all |
| **HTTP Gateway** | Works over HTTP — any language can drive it | Chrome extension APIs only |
| **Zero Dependencies** | Pure Node.js, no build step | 7 workspace packages + TypeScript |
| **Post-step Delays** | `wait: { type: "delay", ms: 3000 }` | Not built-in (requires separate step) |
| **Tab Auto-tracking** | `newTab` result → auto-tracks tabId | Manual via `__ACTIVE_TAB_ID` context variable |
| **CLI Interface** | `node run.js workflow.json --var KEY=VALUE` | No CLI, programmatic API only |

---

## Key Code Patterns from Auto-Lib Worth Porting

### 1. Exponential Backoff with Cap

**Source**: `auto-lib/src/utils/backoff.ts`

```javascript
// auto-lib pattern
function getRetryDelayMs(policy, retriesAlreadyUsed) {
  const baseDelay = policy.backoffMs ?? 1000;
  const uncapped = baseDelay * Math.pow(2, retriesAlreadyUsed);
  return typeof policy.maxBackoffMs === 'number'
    ? Math.min(uncapped, policy.maxBackoffMs)
    : uncapped;
}
```

### 2. AbortController Integration

**Source**: `auto-lib/src/engine/infra/cancellation.ts`

```javascript
// auto-lib CancellationToken pattern
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

### 3. Guard Clauses

**Source**: `auto-lib/src/types/workflow.ts`

```typescript
interface GuardClause {
  type: 'element-exists' | 'element-absent' | 'url-matches' | 'expression';
  target?: Target;           // CSS selector or XPath
  urlPattern?: string;       // URL glob match
  expression?: string;       // JS expression to evaluate
  timeout?: number;          // How long to wait for guard condition
}
```

### 4. WorkflowContext (Structured State)

**Source**: `auto-lib/src/engine/workflow/workflow-context.ts`

```javascript
// auto-lib WorkflowContext — Map-based key-value store
class WorkflowContext {
  variables = new Map();
  stepResults = new Map();
  
  resolveTemplate(template) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => this.variables.get(key) ?? `{{${key}}}`);
  }
  
  addStepResult(stepId, result) {
    this.stepResults.set(stepId, result);
  }
}
```

### 5. Circuit Breaker Pattern

**Source**: `workflow-runners-lib/src/recovery/circuit-breaker.ts`

```
State Machine:
  CLOSED (normal) ──[N failures]──► OPEN (reject all)
      ▲                                │
      │                           [timeout]
      │                                ▼
      └──────[success]──── HALF-OPEN (try one)
```

---

## LOC Budget for Improvements

| Priority | Feature | LOC to Add | Complexity |
|----------|---------|------------|------------|
| 🔴 P0 | Exponential backoff with `maxBackoffMs` | ~5 | Trivial |
| 🔴 P0 | AbortController + cancellable sleep | ~30 | Low |
| 🔴 P0 | Step duration tracking | ~10 | Trivial |
| 🔴 P0 | Guard clauses (conditional skip) | ~40 | Medium |
| 🟡 P1 | onSuccess/onFailure step routing | ~35 | Medium |
| 🟡 P1 | Event hooks (onStepStart/End) | ~25 | Low |
| 🟡 P1 | Structured step results store | ~20 | Low |
| 🟡 P1 | Workflow composition (include) | ~50 | Medium |
| | **Total** | **~215** | |

Runner grows from ~250 LOC → ~465 LOC. Still a single file, zero dependencies.
