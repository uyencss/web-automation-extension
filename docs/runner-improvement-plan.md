# Implementation Plan: WebMCP Command Workflow Runner V2

> **Date**: 2026-06-26
> **Status**: Implemented - Runner V2 core
> **Scope**: `web-automation-extension/runner/`
> **Primary goal**: upgrade the runner so it can reliably execute WebMCP command workflows defined in JSON.

Implementation now lives in `runner/` as a small set of focused CommonJS modules:

- `workflow-runner.js` owns execution, events, guards, routing, retry, timeout, cancellation, and tab tracking.
- `workflow-context.js`, `workflow-normalizer.js`, and `workflow-validator.js` own structured context, defaults, schema checks, template references, and route checks.
- `command-catalog.js`, `transport.js`, `errors.js`, and `runner-events.js` own WebMCP command capability checks, gateway I/O, normalized errors, and event envelopes.
- `run.js` exposes the CLI with dry-run diagnostics and JSON event output.

---

## 1. Scope Clarification

This runner is for `web-automation-extension` and its WebMCP gateway. It should run JSON workflows whose steps call WebMCP commands such as `newTab`, `navigate`, `evaluateJS`, `getInteractiveElements`, `dispatchClick`, `webmcp.invokeTool`, `screenshot`, and related extension commands.

`browser-auto-lib` and `browser-workflow-runners-lib` are reference material only. They should influence runtime quality patterns:

- structured workflow context
- validation and normalization
- retry policy with exponential backoff
- cancellation and timeout behavior
- guard checks and routing
- event emission and final summaries

They should not define this runner's workflow input schema. Supporting RPA Studio or auto-lib workflows such as `step.action.type` is out of scope for this runner.

Out of scope:

- Importing or executing RPA Studio workflow JSON.
- Translating auto-lib `action.type` workflows into WebMCP commands.
- Adding an auto-lib-compatible action adapter.
- Requiring the WebMCP extension to support another workflow dialect.

---

## 2. Current Runner Summary

Current files:

- `runner/workflow-runner.js`
- `runner/run.js`

Current behavior:

- Sends commands to `POST http://localhost:7865/api`.
- Executes steps sequentially.
- Supports `command` steps.
- Supports `strategy: "ai-vision"` as a runner-level helper that uses `getInteractiveElements` and `dispatchClick`.
- Supports simple `{{VAR}}` interpolation.
- Supports per-step `retryPolicy`, but retry delay is linear.
- Supports `captureAs`, but stores object results as JSON strings.
- Tracks `tabId` from `newTab`.
- Supports delay through `command: "wait"`, `command: "delay"`, and post-step `wait`.

Main gaps:

- Validation is too shallow.
- No structured context or step result store.
- No cancellation or real timeout control.
- No event API beyond console logs.
- No guard support.
- No `onSuccess` / `onFailure` step routing.
- Retry behavior is missing `maxBackoffMs` and `retryOn`.
- Command capability validation is not tied to actual extension handlers.

---

## 3. WebMCP Workflow Schema

The runner should keep this native WebMCP workflow shape:

```json
{
  "id": "gemini-chat",
  "name": "Gemini Chat Interaction",
  "version": "1.0",
  "description": "Open Gemini, send a prompt, and extract the response.",
  "settings": {
    "defaultTimeout": 60000,
    "defaultRetryPolicy": {
      "maxAttempts": 2,
      "backoffMs": 1000,
      "maxBackoffMs": 10000,
      "retryOn": ["TIMEOUT", "GATEWAY_UNAVAILABLE"]
    },
    "continueOnNonCriticalFailure": true
  },
  "variables": {
    "TARGET_URL": "https://gemini.google.com/app",
    "PROMPT": "Hello"
  },
  "steps": [
    {
      "id": "open-gemini",
      "command": "newTab",
      "params": { "url": "{{TARGET_URL}}" },
      "wait": { "type": "delay", "ms": 5000 }
    },
    {
      "id": "type-prompt",
      "command": "evaluateJS",
      "params": {
        "code": "return document.title;"
      },
      "captureAs": "PAGE_TITLE"
    }
  ]
}
```

### Step Contract

Each step should support:

```js
{
  id: string,
  label?: string,
  command?: string,
  params?: object,
  strategy?: 'ai-vision',
  instruction?: string,
  fallback?: { command: string, params?: object },
  wait?: { type: 'delay', ms: number },
  timeoutMs?: number,
  retryPolicy?: {
    maxAttempts?: number,
    backoffMs?: number,
    maxBackoffMs?: number,
    retryOn?: string[]
  },
  guard?: GuardClause,
  captureAs?: string,
  critical?: boolean,
  onSuccess?: string,
  onFailure?: string | Record<string, string>
}
```

`critical` defaults to `true`, matching the current runner.

### Normalized Internal Step

The runner can normalize all native WebMCP steps into:

```js
{
  id,
  label,
  critical,
  command,
  params,
  strategy,
  instruction,
  fallback,
  wait,
  timeoutMs,
  retryPolicy,
  guard,
  captureAs,
  onSuccess,
  onFailure
}
```

No `action.type` field is needed or supported.

---

## 4. WebMCP Command Catalog

Add a command catalog used by validation and dry-run output. It should be derived from the actual WebMCP extension capabilities, not from auto-lib.

Initial command groups:

- Tab management:
  - `listTabs`
  - `navigate`
  - `newTab`
  - `closeTab`
  - `getActiveTab`
- Page interaction:
  - `click`
  - `type`
  - `waitForSelector`
  - `getPageContent`
  - `evaluateJS`
- CDP:
  - `executeCDP`
  - `screenshot`
- WebMCP tools:
  - `webmcp.listTools`
  - `webmcp.invokeTool`
- AI vision:
  - `getAccessibilityTree`
  - `getDOMSnapshot`
  - `getElementBounds`
  - `getInteractiveElements`
- CDP input:
  - `dispatchClick`
  - `moveMouse`
  - `pressKey`
  - `typeText`
  - `scroll`
  - `hover`
  - `selectOption` only after confirming or adding the handler
- Full control:
  - `getCookies`
  - `setCookie`
  - `deleteCookies`
  - `getLocalStorage`
  - `setLocalStorage`
  - `listWindows`
  - `createWindow`
  - `setViewport`
  - `resetViewport`
  - `ping`

Important audit item: `ws-client.js` advertises `selectOption`, but the currently read handler modules do not define a `selectOption` handler. Phase 0 must either add it to the extension handler registry or mark it unsupported in runner validation.

---

## 5. Runtime Architecture

Refactor around a small `WorkflowRunner` class:

```js
class WorkflowRunner extends EventEmitter {
  constructor(workflow, options = {}) {}
  async run() {}
  abort(reason) {}
  getState() {}
}
```

Runner options:

```js
{
  runId,
  variables,
  gatewayUrl,
  tabId,
  timeoutMs,
  signal,
  dryRun,
  strictValidation,
  logger
}
```

Recommended files:

```text
runner/
  run.js
  workflow-runner.js
  transport.js
  workflow-context.js
  workflow-normalizer.js
  workflow-validator.js
  command-catalog.js
  runner-events.js
  errors.js
```

If the implementation stays two-file for now, keep these as sections with the same contracts.

---

## 6. Workflow Context

Replace the plain variables object with structured context:

```js
class WorkflowContext {
  constructor(workflowVariables, runtimeVariables) {}
  get(path) {}
  set(path, value) {}
  setStepResult(stepId, result) {}
  getStepResult(stepId) {}
  getLastResult() {}
  interpolate(value, options) {}
  serialize() {}
}
```

Interpolation should support:

- `{{VAR}}`
- `{{ user.email }}`
- `{{steps.step-id.result.foo}}`
- `{{steps.step-id.duration}}`
- `{{last.result}}`
- Built-ins:
  - `__TIMESTAMP__`
  - `__DATE__`
  - `__WORKFLOW_ID__`
  - `__RUN_ID__`
  - `__ACTIVE_TAB_ID`

`captureAs` should preserve structured values:

- strings remain strings
- numbers remain numbers
- objects remain objects
- arrays remain arrays

This is directly inspired by auto-lib `WorkflowContext`, but the stored values are WebMCP command results.

---

## 7. Command Execution Loop

Execution should follow this loop:

1. Normalize and validate workflow.
2. Merge workflow variables, runtime variables, and built-ins.
3. Start from the first step.
4. Evaluate `guard` if present.
5. Interpolate the step.
6. Execute either:
   - `command`
   - `strategy: "ai-vision"`
7. Store structured result in `steps[stepId]`.
8. Store result in `captureAs` when provided.
9. Track active tab ID from command results.
10. Apply post-step wait.
11. Route with `onSuccess` / `onFailure`, otherwise continue sequentially.
12. Emit final summary.

Terminal statuses:

- `completed`
- `completed_with_errors`
- `failed`
- `aborted`
- `timed_out`

---

## 8. Guards And Routing

Use a lightweight guard contract inspired by auto-lib, but implemented with WebMCP commands:

```js
{
  type: 'element-exists' | 'element-absent' | 'url-matches' | 'expression',
  selector?: string,
  target?: { mode: 'css' | 'xpath' | 'text' | 'id' | 'aria-label', value: string },
  urlPattern?: string,
  expression?: string,
  timeout?: number
}
```

Implementation mapping:

- `element-exists` with CSS selector -> `waitForSelector`.
- `element-absent` -> `evaluateJS`.
- `url-matches` -> `getActiveTab` or `evaluateJS` with `location.href`.
- `expression` -> `evaluateJS`.

Execution rules:

- `critical` defaults to `true`.
- If a guard fails on `critical: false`, emit a skipped step and continue.
- If a guard fails on a critical step, fail with `GUARD_FAILED`.
- `onSuccess` jumps to a step ID.
- `onFailure` accepts either a string step ID or an error-code map:

```json
{
  "onFailure": {
    "TIMEOUT": "recover-timeout",
    "default": "fallback-step"
  }
}
```

Validation must reject missing route targets before execution.

---

## 9. Retry, Timeout, And Cancellation

Adopt the retry and cancellation patterns from the reference libraries.

Retry policy:

```js
{
  maxAttempts: 3,
  backoffMs: 1000,
  maxBackoffMs: 10000,
  retryOn: ["TIMEOUT", "GATEWAY_UNAVAILABLE"]
}
```

Requirements:

- Use exponential backoff: `backoffMs * 2 ** retriesAlreadyUsed`.
- Cap the delay with `maxBackoffMs`.
- Respect `retryOn` when an error code is available.
- Make retry sleeps cancellable.
- Create one `AbortController` per run.
- Merge an external `options.signal` with the runner signal.
- Check cancellation before every step, before retries, during waits, and during guards.
- Track duration for every step and for the full workflow.
- Normalize timeout errors as `TIMEOUT`.

Transport note:

- `server/gateway_server.js` currently times out forwarded WebMCP commands after 60s.
- Runner `defaultTimeout` and per-step `timeoutMs` should not exceed that unless the gateway timeout is also made configurable.

---

## 10. Validation And Normalization

Replace the current shallow validation in `run.js` with runner-level validation.

Validation must check:

- Workflow has `id`, `name`, and non-empty `steps`.
- Step IDs are unique.
- Every step has either `command` or `strategy`.
- `strategy` is one of the runner-supported strategies.
- `command` exists in the WebMCP command catalog, unless passthrough mode is explicitly enabled.
- Required command params are present for known commands.
- `fallback.command` is valid when provided.
- `onSuccess` and `onFailure` targets exist.
- Obvious `onSuccess` cycles are detected.
- `retryPolicy` numbers are sane.
- `timeoutMs` and waits are positive numbers.
- Unknown variables produce warnings by default and errors in `--strict`.

Normalization must:

- Fill default settings:

```js
{
  defaultTimeout: 30000,
  defaultRetryPolicy: {
    maxAttempts: 1,
    backoffMs: 1000,
    maxBackoffMs: 10000
  },
  continueOnNonCriticalFailure: true
}
```

- Normalize `critical` to `true` unless explicitly `false`.
- Normalize `wait` and `delay` aliases.
- Normalize command params after interpolation.
- Attach workflow metadata to the final summary.

---

## 11. Event Contract

Use Node `EventEmitter`, with stable event payloads similar to workflow-runners-lib.

Events:

- `start`
- `progress`
- `step`
- `end`
- `recovery`

Event envelope:

```js
{
  version: 1,
  eventId,
  runId,
  workflowId,
  tabId,
  timestamp,
  type,
  payload
}
```

Step event payload:

```js
{
  type: 'started' | 'completed' | 'failed' | 'skipped' | 'retrying',
  stepId,
  stepIndex,
  totalSteps,
  command,
  strategy,
  attempt,
  duration,
  result,
  error
}
```

The CLI should keep readable logs by subscribing to events. Add `--json-events` for machine-readable event output.

---

## 12. CLI Updates

Update `run.js` options:

```bash
node runner/run.js workflows/gemini/chat.json \
  --var PROMPT="Hello" \
  --timeout 60000 \
  --gateway-url http://localhost:7865/api \
  --json-events
```

Required options:

- `--var KEY=VALUE`
- `--dry-run`
- `--timeout MS`
- `--gateway-url URL`
- `--run-id ID`
- `--json-events`
- `--strict`
- `--allow-unknown-command`

Dry run should show:

- workflow ID/name/version
- normalized steps
- validation errors and warnings
- command catalog matches
- unsupported or unknown commands
- route graph summary
- variables required by templates

---

## 13. Implementation Phases

### Phase 0: Capability Audit

- Audit `webmcp-extension/dist/bg/handlers/*`.
- Build `command-catalog.js` from actual supported commands.
- Resolve `selectOption` mismatch.
- Document gateway 60s timeout.

### Phase 1: Validator And Normalizer

- Add `workflow-validator.js`.
- Add `workflow-normalizer.js`.
- Keep support for existing workflow examples.
- Add dry-run diagnostics.

### Phase 2: Runtime Core

- Refactor `workflow-runner.js` around `WorkflowRunner`.
- Add `WorkflowContext`.
- Add structured step results and outputs.
- Add `getState()`.
- Preserve `runWorkflow()` export.

### Phase 3: Transport Hardening

- Move gateway calls into `transport.js`.
- Add command timeout support.
- Normalize HTTP/gateway/extension errors.
- Keep `sendCommand()` export for compatibility if needed.

### Phase 4: Reliability Features

- Add `AbortController`.
- Add cancellable sleep.
- Add exponential backoff with `maxBackoffMs`.
- Add `retryOn`.
- Add step duration tracking.
- Add guards.
- Add `onSuccess` / `onFailure`.
- Add critical/non-critical behavior.

### Phase 5: Events And CLI

- Add structured event emitter.
- Make console logging event-driven.
- Add `--json-events`.
- Add `--timeout`, `--gateway-url`, `--run-id`, `--strict`, and `--allow-unknown-command`.

### Phase 6: Advanced Backlog

- Workflow fragments/includes for reusable WebMCP command sequences.
- Checkpoint/resume for long workflows.
- Circuit breaker for repeated gateway failures.
- Queue/batch wrappers for running the same WebMCP workflow with different variable sets.
- Rich artifacts such as screenshots, extracted markdown, and downloaded files.

---

## 14. Verification Plan

Use mocked transport tests before browser integration.

Recommended fixtures:

```text
runner/fixtures/
  command-basic-workflow.json
  command-routing-workflow.json
  command-guard-workflow.json
  command-retry-workflow.json
  invalid-duplicate-step-id.json
  invalid-routing-reference.json
  invalid-unknown-command.json
```

Minimum checks:

- Existing workflows pass dry-run:
  - `workflows/facebook/post_text.json`
  - `workflows/facebook/post_with_gradient.json`
  - `workflows/gemini/chat.json`
- Existing workflows remain executable without schema changes.
- `{{steps.step-id.result.foo}}` interpolation works.
- `captureAs` preserves structured results.
- Retry delay is exponential and capped.
- Abort cancels sleep/retry/post-step wait.
- Timeout returns `timed_out`.
- Guard skip emits a skipped step event.
- Invalid `onSuccess` / `onFailure` references fail validation.
- Unknown command fails validation unless `--allow-unknown-command` is used.

Integration checks with gateway and extension running:

```bash
node runner/run.js workflows/gemini/chat.json --dry-run
node runner/run.js workflows/gemini/chat.json --var PROMPT="Test prompt"
```

Verify:

- `newTab` tracks `tabId`.
- `navigate`, `click`, `type`, `evaluateJS`, and `screenshot` execute through WebMCP.
- `strategy: "ai-vision"` still works.
- Gateway disconnect returns a normalized failure.

---

## 15. Acceptance Criteria

Runner V2 is ready when:

- Current WebMCP JSON workflows still run without edits.
- The runner validates workflow command steps before execution.
- Dry-run reports clear diagnostics and route structure.
- Runtime has structured context, step results, outputs, durations, and final summary.
- Retry, timeout, and cancellation work consistently.
- Guards and `onSuccess` / `onFailure` routing are implemented for WebMCP command steps.
- CLI can emit readable logs and JSON event envelopes.
- Unknown or unsupported WebMCP commands fail clearly.
- The implementation does not require a build step.
