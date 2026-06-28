# Implementation Plan — Enhanced Iframe Handling

**Date:** 2026-06-28  
**Review status:** Reviewed and revised before implementation on 2026-06-28.  
**Origin:** Comparison audit of WebMCP vs Flow-Auto `browser-auto-lib`.

WebMCP's current iframe handling relies on a page-level `postMessage` bridge
with CSS-only frame selectors and a flat single-level model. Flow-Auto has a
dual-driver CDP + Scripting frame system with nested paths, multiple selector
modes, Shadow DOM pierce, isolated-world execution, and coordinate offset
handling.

This plan brings the most useful Flow-Auto ideas into WebMCP without adopting a
full dual-driver architecture. The revised plan is deliberately stricter about
contracts, frame-id resolution, cache invalidation, and tests because iframe
support crosses Chrome extension, CDP, content-script, and page-message
boundaries.

**Reference:**
[`browser-auto-lib/src/drivers/cdp-driver.ts`](file:///Users/ttcenter/Desktop/VIBE_CODE/flow-auto-browser-extension/packages/automation/browser-auto-lib/src/drivers/cdp-driver.ts)
— frame resolution, frame tree traversal, isolated worlds, viewport offset
calculation.
[`browser-auto-lib/src/drivers/scripting-driver.ts`](file:///Users/ttcenter/Desktop/VIBE_CODE/flow-auto-browser-extension/packages/automation/browser-auto-lib/src/drivers/scripting-driver.ts)
— `webNavigation.getAllFrames()` fallback, `createInjectionTarget()`.
[`browser-auto-lib/src/types/target.ts`](file:///Users/ttcenter/Desktop/VIBE_CODE/flow-auto-browser-extension/packages/automation/browser-auto-lib/src/types/target.ts)
— `FrameContext`, `FrameSelector`, `FramePathSegment` type definitions.

---

## Review Findings Before Implementation

These findings change the implementation plan.

1. **Do not assume Chrome `frameId` and CDP `frame.id` are interchangeable.**
   `chrome.webNavigation.getAllFrames()` returns numeric Chrome frame IDs.
   `Page.getFrameTree` returns string CDP frame IDs. They must be returned and
   resolved as separate identifiers. Any URL/name/order based merge must be
   marked best-effort and rejected when ambiguous.

2. **`evaluateInFrame()` needs a shared frame resolver, not ad hoc lookup in
   every handler.** The resolver must return both possible execution targets:
   `{ cdpFrameId, chromeFrameId, documentId, path, source, confidence }`.
   CDP isolated-world execution uses `cdpFrameId`; scripting fallback uses
   `chromeFrameId`.

3. **ARIA frame support is not the same problem as `Runtime.evaluate`.**
   `Accessibility.getFullAXTree`, `DOM.resolveNode`, and ref-based actions need
   their own validation. Treat ARIA frame support as a separate phase after a
   spike confirms the exact CDP contract in Chrome.

4. **The current content-script tool surface has an existing iframe bug.**
   `fill_form_field` declares `frame_selector` but does not forward to
   `invokeIframe()`. Fix this in the iframe bridge phase.

5. **Background and page tools overlap.** The plan must update both background
   commands (`querySelectorAll`, `findByText`, `pageFetch`, etc.) and WebMCP page
   tools (`query_selector_all`, `click_element`, etc.) so the agent does not pick
   a visually similar tool that lacks frame support.

6. **The public catalog/capability list is part of the contract.**
   Runtime handlers are not enough. Update `catalog/command-catalog.js`,
   `webmcp-extension/dist/bg/ws-client.js`, generated skill references, and the
   `selectOption` catalog mismatch while touching input tools.

---

## Current State

### Content-script side

File: `webmcp-extension/dist/content-scripts/register-tools.js`

- `invokeIframe(frameSelector, cmd, params)` sends `postMessage` to an iframe
  found with `document.querySelector(cssSelector)`.
- The receiver runs in all frames via `all_frames: true`, listens for
  `WEBMCP_IFRAME_CMD`, and delegates to
  `navigator.modelContext.invokeTool(cmd, params)`.
- Limitations: CSS-only frame selector, single iframe hop, hard-coded 5 s
  timeout, wildcard `postMessage('*')`, no response-source validation, no typed
  timeout cleanup, no frame discovery, and no nested path.
- Tools with `frame_selector` schema today:
  `query_selector_all`, `click_element`, `fill_form_field`,
  `extract_table_data`, `wait_for_element`, `get_computed_styles`.
- Confirmed bug: `fill_form_field` has `frame_selector` in the schema but
  currently ignores it.

### Background side

File: `webmcp-extension/dist/bg/cdp-bridge.js`

- `evaluateInTab(tabId, expression)` runs `Runtime.evaluate` in the main frame
  only.
- `sendCDPCommand(tabId, method, params)` is a raw tab-scoped CDP pass-through.
- There is no frame tree cache, no isolated-world cache, and no
  `chrome.debugger.onEvent` invalidation.

Background handlers that should gain frame support:

- Core page JS: `evaluateJS`, `click`, `type`, `waitForSelector`,
  `getPageContent`, `querySelectorAll`, `getWindowVariable`, `findByText`,
  `pageFetch`.
- Observation: `getElementBounds`, `getInteractiveElements`.
- Input/coordinates: `dispatchClick`, `moveMouse`, `hover`, `selectOption`.
- WebMCP bridge: `webmcp.listTools`, `webmcp.invokeTool` should optionally run
  against a target frame so page-registered tools can be listed/invoked inside a
  frame.
- ARIA/ref tools: `getAccessibilityTree`, `getAriaSnapshot`, `clickByRef`,
  `typeByRef`, `hoverByRef`, `selectByRef` are deferred to the ARIA phase.

---

## Shared Frame Contract

All background commands that support iframes accept an optional `frame` object.
Omitting it keeps current behavior.

```json
{
  "frame": {
    "type": "object",
    "description": "Target a specific frame instead of the main frame.",
    "properties": {
      "cdpFrameId": {
        "type": "string",
        "description": "CDP Page frame ID returned by listFrames."
      },
      "frameId": {
        "type": "number",
        "description": "Chrome webNavigation frame ID. 0 is the main frame."
      },
      "documentId": {
        "type": "string",
        "description": "Chrome documentId from webNavigation, when available."
      },
      "frameUrl": {
        "type": "string",
        "description": "URL substring to match. Rejected if ambiguous."
      },
      "frameName": {
        "type": "string",
        "description": "Frame name to match. Rejected if ambiguous."
      },
      "frameIndex": {
        "type": "number",
        "description": "Zero-based index among the main document's child iframes."
      },
      "framePath": {
        "type": "array",
        "description": "Nested path of child frame selectors or indexes.",
        "items": {
          "oneOf": [
            { "type": "string" },
            { "type": "number" },
            {
              "type": "object",
              "properties": {
                "selector": { "type": "string" },
                "name": { "type": "string" },
                "url": { "type": "string" },
                "index": { "type": "number" }
              }
            }
          ]
        }
      },
      "frameSelector": {
        "type": "string",
        "description": "CSS selector for an iframe element in the main document. Prefer listFrames IDs when possible."
      }
    }
  }
}
```

Resolution rules:

1. Prefer exact IDs from `listFrames`: `cdpFrameId`, then `frameId`, then
   `documentId`.
2. Treat `frameUrl`, `frameName`, `frameIndex`, `frameSelector`, and
   `framePath` as convenience selectors. They must resolve to exactly one frame.
3. If matching is ambiguous, return a clear error that includes the matching
   candidates and tells the caller to use `listFrames`.
4. Do not silently cache convenience selectors across navigations. Cache only
   resolved exact IDs and invalidate them on frame navigation/detach.
5. Return `frame: { cdpFrameId, frameId, documentId, url, name, path }` in
   command results when a frame target was used.

---

## Feature 0 — Test Fixture First

Build the verification fixture before changing the runtime.

### Fixture requirements

Create a local static test page under a test/fixture directory with:

- Main page with two same-origin iframes.
- One nested iframe.
- One named iframe: `name="editor"`.
- Buttons, text inputs, select elements, tables, visible text, and an element
  requiring scroll.
- One cross-origin iframe fixture when practical, or a documented manual test
  URL if local cross-origin setup is not available.

### Why this is first

Iframe bugs often look correct on simple single-frame pages and fail on nested
or cross-origin pages. The fixture lets us validate `listFrames`,
content-script forwarding, `Runtime.evaluate`, and coordinate tools with the
same inputs.

---

## Feature 1 — Frame Discovery (`listFrames`)

### Problem

The agent has no reliable way to enumerate frames, choose stable IDs, or see
nested relationships.

### Solution

Add a background command `listFrames`.

Use two APIs:

1. `Page.getFrameTree` via CDP for hierarchy, CDP frame IDs, names, URLs, and
   parent relationships.
2. `chrome.webNavigation.getAllFrames({ tabId })` for numeric Chrome frame IDs
   and `documentId`.

The merge is best-effort. The response must expose the source of each field and
must not hide ambiguous mappings.

### Return shape

```json
{
  "tabId": 123,
  "frameCount": 3,
  "flat": false,
  "frames": [
    {
      "cdpFrameId": "ABCDEF1234",
      "frameId": 0,
      "documentId": "optional-document-id",
      "url": "https://example.com/",
      "origin": "https://example.com",
      "name": "",
      "parentCdpFrameId": null,
      "parentFrameId": -1,
      "childIndex": 0,
      "path": [],
      "mappingConfidence": "exact-main",
      "children": []
    }
  ],
  "warnings": []
}
```

### Files

- `webmcp-extension/dist/bg/handlers/frame-management.js` — new
- `webmcp-extension/dist/bg/handlers/index.js` — import and register
- `webmcp-extension/dist/bg/cdp-bridge.js` — shared frame-tree helpers
- `webmcp-extension/dist/manifest.json` — add `"webNavigation"` permission
- `catalog/command-catalog.js` — add `listFrames`
- `webmcp-extension/dist/bg/ws-client.js` — advertise `listFrames`

### Implementation notes

- Call `Page.enable` once per attached tab before relying on frame events.
- Use `chrome.debugger.onEvent` to invalidate frame-tree and isolated-world
  caches on `Page.frameNavigated`, `Page.frameDetached`, and target detach.
- Main frame mapping is exact: CDP root frame maps to Chrome frame ID `0`.
- Child frame mapping should use exact data when available and otherwise return
  `mappingConfidence: "ambiguous"` with warnings.
- `flat: true` returns a flat array; `flat: false` returns the nested tree.

---

## Feature 2 — Frame Resolver + `evaluateInFrame`

### Problem

Handlers should not each implement their own frame matching logic, and
`Runtime.evaluate` needs a CDP execution context for the selected frame.

### Solution

Add shared helpers in `cdp-bridge.js`:

- `listFrameContexts(tabId)`
- `resolveFrameTarget(tabId, frameSpec)`
- `evaluateInFrame(tabId, frameSpec, expression, awaitPromise = true)`
- `getOrCreateIsolatedWorld(tabId, cdpFrameId)`
- `invalidateFrameCaches(tabId, cdpFrameId?)`

### Execution strategy

Primary path:

1. Resolve `frameSpec` to a `cdpFrameId`.
2. Create or reuse an isolated world:
   `Page.createIsolatedWorld({ frameId: cdpFrameId, worldName: "WebMCP" })`.
3. Run `Runtime.evaluate({ contextId, awaitPromise, returnByValue: true,
   userGesture: true })`.

Fallback path:

1. Resolve `frameSpec` to a numeric `chromeFrameId`.
2. Use `chrome.scripting.executeScript({ target: { tabId, frameIds:
   [chromeFrameId] }, func })`.

Fallback is allowed only when the handler can safely pass a function and
structured args. String-based user code such as `evaluateJS` should prefer CDP
and fail clearly if no CDP target is available.

### Error handling

- `FRAME_NOT_FOUND`: no matching frame.
- `FRAME_AMBIGUOUS`: selector matched multiple frames; include candidates.
- `FRAME_NAVIGATED`: frame disappeared during execution; tell caller to rerun
  `listFrames`.
- `FRAME_UNSUPPORTED_FOR_HANDLER`: handler needs CDP or scripting and the
  resolved target lacks the required ID.

Errors should still be surfaced through the current JSON-RPC error envelope.
Typed classes are optional internally; user-visible messages must be stable.

---

## Feature 3 — Propagate `frame` to Background Handlers

### Pattern

Add a local evaluation selector to each JS-based handler:

```js
const tabId = await resolveTabId(params);
const frameTarget = params.frame
  ? await resolveFrameTarget(tabId, params.frame)
  : null;
const evaluate = frameTarget
  ? (expr) => evaluateInFrame(tabId, frameTarget, expr)
  : (expr) => evaluateInTab(tabId, expr);
```

### Phase 3a — Core page JS handlers

| Handler | File | Notes |
|---|---|---|
| `evaluateJS` | `cdp-actions.js` | CDP-only; return resolved frame metadata |
| `click` | `high-level.js` | Evaluate selector inside frame |
| `type` | `high-level.js` | Evaluate selector inside frame |
| `waitForSelector` | `high-level.js` | Observe DOM inside frame |
| `getPageContent` | `high-level.js` | Return frame document title/url/content |
| `querySelectorAll` | `high-level.js` | Preserve Shadow DOM helper behavior |
| `getWindowVariable` | `high-level.js` | Read frame window object |
| `findByText` | `high-level.js` | Bounds are frame-local unless offset is explicitly added |
| `pageFetch` | `high-level.js` | Fetch uses frame origin/session context |
| `webmcp.listTools` | `webmcp.js` | List tools registered in a frame |
| `webmcp.invokeTool` | `webmcp.js` | Invoke page tools in a frame |

### Phase 3b — Observation handlers

| Handler | File | Notes |
|---|---|---|
| `getElementBounds` | `ai-vision.js` | Return both frame-local and page-absolute bounds when possible |
| `getInteractiveElements` | `ai-vision.js` | Same bounds contract as above |

### Phase 3c — Coordinate/input handlers

| Handler | File | Notes |
|---|---|---|
| `dispatchClick` | `cdp-input.js` | Accept `frame`; apply viewport offset before dispatch |
| `moveMouse` | `cdp-input.js` | Accept `frame`; apply viewport offset |
| `hover` | `cdp-input.js` | Resolve selector in frame, then dispatch absolute coordinates |
| `selectOption` | `cdp-input.js` | Add to catalog correctly; accept `frame` |

### Explicitly not in this phase

- `getDOMSnapshot`: CDP returns full document snapshot; frame scoping needs a
  separate design.
- `screenshot`: frame clipping is useful but not required for iframe handling.
- Cookies, localStorage, viewport, windows, and tab commands.
- `waitForStable`: remains page-level unless we later add frame-scoped stability
  monitoring.

---

## Feature 4 — Upgrade Content-Script Iframe Bridge

### Problem

The current page-tool bridge is flat and CSS-only, and one declared tool does
not actually use iframe forwarding.

### Solution

Upgrade `invokeIframe()` and tool schemas in
`webmcp-extension/dist/content-scripts/register-tools.js`.

### New page-tool iframe fields

```json
{
  "frame_selector": {
    "oneOf": [
      { "type": "string" },
      {
        "type": "object",
        "properties": {
          "selector": { "type": "string" },
          "name": { "type": "string" },
          "index": { "type": "number" },
          "url": { "type": "string" }
        }
      }
    ]
  },
  "frame_path": {
    "type": "array",
    "items": { "oneOf": [{ "type": "string" }, { "type": "object" }] }
  },
  "frame_timeout_ms": {
    "type": "number",
    "default": 5000
  }
}
```

### Required bridge behavior

- Backward compatibility: a string `frame_selector` remains a CSS selector.
- Multi-mode selector: `selector`, `name`, `index`, and `url`.
- Nested path: `frame_path: ["#outer", { "name": "inner" }]`.
- Timeout is configurable and timers are cleared on success.
- Request IDs must be unique for the page lifetime.
- Parent must validate response source:
  `event.source === targetFrame.contentWindow`.
- Parent should use the iframe origin as `targetOrigin` when it can be parsed
  from `src`; use `'*'` only for `about:blank`, `srcdoc`, empty, or opaque
  origins.
- Receiver should respond to `event.source` and include the same request ID.
- Error payloads should distinguish not found, timeout, and nested path failure.

### Tools to update

- `query_selector_all`
- `click_element`
- `fill_form_field` — currently missing the forwarding branch
- `extract_table_data`
- `wait_for_element`
- `get_computed_styles`

---

## Feature 5 — Frame Viewport Offset for CDP Input

### Problem

CDP `Input.dispatchMouseEvent` expects coordinates in the top-level page
viewport. Element bounds collected inside a frame are frame-local. Nested frames
need cumulative offsets.

### Solution

Add `getFrameViewportOffset(tabId, cdpFrameId)` and apply it for coordinate
input handlers when `frame` is present.

Implementation outline:

```js
async function getFrameViewportOffset(tabId, cdpFrameId) {
  const chain = await getFrameChain(tabId, cdpFrameId);
  let x = 0;
  let y = 0;
  for (let i = 1; i < chain.length; i++) {
    const parentFrameId = chain[i - 1].cdpFrameId;
    const childFrameId = chain[i].cdpFrameId;
    const rect = await getChildFrameElementRect(tabId, parentFrameId, childFrameId);
    x += rect.left;
    y += rect.top;
  }
  return { x, y };
}
```

`getChildFrameElementRect` should prefer CDP owner-node APIs where possible
(`DOM.getFrameOwner`, `DOM.getBoxModel`) and fall back to parent-frame DOM
evaluation only when mapping by child URL/name/order is unambiguous.

### Files

- `webmcp-extension/dist/bg/cdp-bridge.js`
- `webmcp-extension/dist/bg/handlers/cdp-input.js`
- `webmcp-extension/dist/bg/handlers/ai-vision.js`
- `webmcp-extension/dist/bg/handlers/high-level.js`

---

## Feature 6 — ARIA / Ref-Based Frame Support

### Status

Deferred until after Features 1-5 are working. Do a small spike first.

### Spike questions

- Does current Chrome accept `frameId` for `Accessibility.getFullAXTree` through
  `chrome.debugger.sendCommand`?
- If not, can we reliably derive a frame-scoped root node via CDP DOM APIs and
  filter the AX tree?
- Do `backendDOMNodeId` values remain safe to store without a frame key?
- Do `DOM.getBoxModel` coordinates for nodes inside frames come back top-level
  absolute or frame-local in our target Chrome version?

### Implementation requirements after spike

- Ref maps must be keyed by `tabId + frame identity`, not only `tabId`.
- `getAriaSnapshot` must return the resolved frame metadata.
- `clickByRef`, `typeByRef`, `hoverByRef`, and `selectByRef` must reject stale
  refs from a different frame snapshot.
- Ref actions must reuse the coordinate/offset logic if box-model coordinates
  are frame-local.

---

## Shared Housekeeping

- `webmcp-extension/dist/manifest.json`: add `"webNavigation"`.
- `catalog/command-catalog.js`: add `listFrames`; add `frame` to supported
  commands; add `selectOption` or remove the stale unsupported marker after
  confirming handler registration.
- `webmcp-extension/dist/bg/ws-client.js`: advertise `listFrames` and any
  newly supported frame-aware commands.
- `skills/webmcp-browser-automation/references/generated-tools.md`: regenerate
  via `npm run tools:generate`.
- `skills/webmcp-browser-automation/references/tool-reference-card.md`: update
  if generation does not cover it.
- `skills/webmcp-browser-automation/SKILL.md`: update iframe guidance and tool
  routing examples.
- `webmcp-extension/README.md` and root `README.md`: update only if user-facing
  command examples change.
- Rebuild extension zip via `npm run build:extension` after implementation.

---

## Implementation Order

| Step | Feature | Effort | Dependencies |
|---|---:|---:|---|
| 0 | Build iframe test fixture | Low | None |
| 1 | Content-script bridge upgrade + `fill_form_field` fix | Medium | Fixture |
| 2 | `listFrames` + shared frame resolver | Medium | `webNavigation` permission |
| 3 | `evaluateInFrame` + core JS handlers | Medium | Step 2 |
| 4 | Observation handlers + coordinate offset | Medium | Step 3 |
| 5 | Catalog/capabilities/docs regeneration | Low | Steps 1-4 |
| 6 | ARIA spike and implementation decision | Medium | Steps 2-4 |
| 7 | Build zip + final verification | Low | Steps 1-6 as applicable |

Steps 1 and 2 can be developed independently after the fixture exists.

---

## Acceptance Criteria

| Feature | Test |
|---|---|
| Fixture | Local page contains main, sibling iframe, named iframe, nested iframe, form, table, button, and scroll target |
| `listFrames` tree | Nested fixture returns root + child + nested child with parent relationships |
| `listFrames` flat | Same fixture with `flat: true` returns all frames once |
| Ambiguous frame selector | Duplicate `frameName` or URL substring returns `FRAME_AMBIGUOUS` with candidates |
| `evaluateJS` in frame | `document.title` returns the iframe title, not the main title |
| `getPageContent` in frame | Text/HTML comes from the target iframe document |
| Background `querySelectorAll` | Finds elements inside the selected frame and preserves pagination |
| Background `pageFetch` | Fetch runs with the selected frame's origin/session |
| Content-script name selector | `query_selector_all` with `{ name: "editor" }` returns iframe elements |
| Content-script nested path | `click_element` with `frame_path` clicks a nested iframe button |
| Content-script form forwarding | `fill_form_field` with `frame_selector` updates an input inside an iframe |
| Content-script timeout | `frame_timeout_ms: 500` fails in roughly 500 ms |
| CDP click offset | `dispatchClick` with frame-local coordinates clicks the correct nested-frame target |
| WebMCP in frame | `webmcp.listTools` / `webmcp.invokeTool` can target a frame |
| Backward compatibility | Existing workflows without `frame` or `frame_selector` behave unchanged |
| Generated docs | `npm run tools:check` passes after generation |
| Build | `npm run build:extension` succeeds |

ARIA-specific acceptance criteria should be added only after the spike confirms
the exact CDP behavior.

---

## What We Do Not Adopt From Flow-Auto

| Flow-Auto Feature | Reason Not Adopted |
|---|---|
| Full dual-driver architecture | WebMCP's runtime is a small WS-command extension. A shared resolver plus CDP/scripting execution paths gives most of the value with less machinery. |
| `ActionDispatcher` routing table | WebMCP already routes by command name in `router.js`. A separate capability router is unnecessary for this scope. |
| Silent target backoff/retry | Frame resolution should fail clearly and let the caller rerun `listFrames`; silent retries risk acting in the wrong frame. |
| Full typed public error hierarchy | The external protocol currently returns JSON-RPC errors. Stable error codes/messages are enough for this phase. |
| Persisted frame targets across navigations | WebMCP commands are one-shot. We expose `documentId` and invalidate caches, but callers should rediscover frames after navigation. |

---

## Open Questions

1. Should frame support be exposed in the public MCP catalog as a generic
   `frame` object for all commands, or should the catalog list exact fields per
   command for simpler generated docs?
2. Should `listFrames` attach the debugger automatically, or first return the
   `webNavigation` view and include CDP fields only when debugger attachment
   succeeds?
3. Should frame-local bounds returned by observation handlers include both
   `bounds` and `absoluteBounds`, or should `bounds` become absolute whenever a
   frame is specified?

