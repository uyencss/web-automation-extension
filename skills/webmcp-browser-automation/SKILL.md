---
name: webmcp-browser-automation
description: >
  Use the local WebMCP Chrome extension to control browser tabs and invoke
  page-registered tools from navigator.modelContext/register-tools.js. Use this
  skill when the user asks to use the browser extension, WebMCP, register-tools,
  @register-tools, browser automation, scraping, data extraction, form filling,
  clicking, navigation, screenshots, network capture, or operating the browser.
---

# WebMCP Browser Automation

## Mental Model

The WebMCP extension exposes three different tool layers. Do not mix them up.

1. **Extension commands** are JSON-RPC methods handled by the background service
   worker. Use them for tabs, navigation, screenshots, accessibility/interactive
   element discovery, real CDP mouse/keyboard input, storage, cookies, and
   viewport control.
2. **ARIA snapshot commands** (extension layer) provide ref-based element
   interaction. Call `getAriaSnapshot` to capture a fast viewport-first
   accessibility-like tree with compact persistent content-script refs (e.g.
   `ref=r1` in the main frame or `ref=f3r1` in an iframe), then use
   `clickByRef`, `typeByRef`, `hoverByRef`, or `selectByRef` to interact using
   those refs. Legacy fast refs like `F0:R1` are still accepted. `mode:
   "native"` uses the CDP Accessibility fallback with `ref=S1` style refs. This
   is **more robust than CSS selectors** on SPAs and dynamic pages — prefer this
   approach whenever possible.
3. **Page WebMCP tools** are registered by
   `webmcp-extension/dist/content-scripts/register-tools.js` into
   `navigator.modelContext`. These are page-local tools. You must discover them
   with `webmcp.listTools` and invoke them with `webmcp.invokeTool`.

Critical rule: a page tool name such as `query_selector_all` or
`click_element` is not an extension JSON-RPC method. It must be passed as
`params.toolName` to `webmcp.invokeTool`.

## First Choice Transport

When no native WebMCP/browser tool is already available in the agent runtime,
use the local HTTP gateway:

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension
npm run gateway
```

With the released npm package, the portable equivalent is:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit gateway start
```

The Chrome extension connects to `ws://localhost:7865`; scripts and agents call:

```bash
curl -sS http://localhost:7865/api \
  -H 'Content-Type: application/json' \
  -d '{"method":"ping","params":{}}'
```

Request shape:

```json
{ "method": "getActiveTab", "params": {} }
```

Response shape:

```json
{ "result": { "tabId": 123, "url": "https://example.com" } }
```

If you are connected directly over WebSocket, send the same method and params
inside JSON-RPC 2.0:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "getActiveTab", "params": {} }
```

If an MCP client is available, use `server/mcp_server.mjs` or
`webmcp mcp` as a stdio MCP adapter. Best-practice installs keep the
gateway lifecycle explicit: start the gateway first, then let MCP connect to it.
For local development only, set `WEBMCP_GATEWAY_AUTOSTART=1` if MCP should spawn
the gateway when no local gateway is listening. MCP tool names replace dots with
underscores, so `webmcp.listTools` becomes `webmcp_list_tools` and
`webmcp.invokeTool` becomes `webmcp_invoke_tool`. The adapter also exposes
`browser_raw_command` for raw gateway calls.

If the environment exposes Codex's native WebMCP capability instead, the naming
is different:

```text
webmcp_list_tools({ browser_id, tab_id })
webmcp_invoke_tool({ browser_id, tab_id, tool_name, input, timeout_ms? })
```

Gateway/direct extension calls use `webmcp.listTools`, `webmcp.invokeTool`, and
`toolName`. Codex native calls use `webmcp_list_tools`,
`webmcp_invoke_tool`, and `tool_name`.

## Reading vs Interacting (decide first)

Before discovering page structure, decide what the task actually needs:

- **Reading / comprehension / extraction of prose** — the goal is to *answer a
  question from the page*, summarize an article, read docs, news, a blog post, a
  product description, or any mostly-text page. **Prefer `getPageText`** (already
  on a tab) or **`readPage`** (navigate + read in one call). It returns clean
  article text with nav/ads/boilerplate stripped, in far fewer tokens than a
  snapshot. This is the fast path — reach for it before `getAriaSnapshot`,
  `querySelectorAll`, or `screenshot` when you only need to *read*.
- **Interacting / acting** — the goal is to click, type, fill a form, navigate a
  flow, or operate a control. Use `getAriaSnapshot` → `clickByRef`/`typeByRef`.
- **Bulk structured data** (tables, repeated rows, lists of records) — use
  `evaluateJS`, `query_selector_all`, or `extract_table_data`, *not* page text.

Do not jump straight to `getAriaSnapshot` for a question that `getPageText` can
answer. Only escalate to a snapshot when the text path misses what you need
(e.g. the content is behind a control you must click first, or the page is an
app shell with little readable prose).

## Mandatory Run Loop

For every browser automation task:

1. Health check: call `ping`. If the gateway is unreachable, start
   `npm run gateway` or `webmcp gateway start`. If the gateway is up but
   the extension is not connected, reload the unpacked extension from
   `webmcp-extension/dist`.
2. Select a tab: call `getActiveTab`, `newTab`, or `navigate`.
3. Wait for readiness: `navigate` waits for page load; otherwise use
   `waitForSelector`, `waitForStable`, or the page tool `wait_for_element`.
4. Discover the page — match the tool to the goal (see *Reading vs
   Interacting* above):
   - **If you only need to read/answer from the page**, call `getPageText`
     (or `readPage` to navigate+read in one shot) first. Often this single
     call is the whole task — stop here if it answers the question.
   - **If you need to act on the page**, call `getAriaSnapshot` to get a
     ref-based accessibility tree — the preferred way to understand structure
     for interaction.
   - Call `webmcp.listTools` for page-registered tools.
5. Pick the smallest reliable action (in order of preference):
   - **ARIA ref interaction** (preferred): use `clickByRef`, `typeByRef`,
     `selectByRef` with refs from `getAriaSnapshot`. These are robust against
     DOM changes and work reliably on SPAs.
   - Page structure/data: use page WebMCP tools.
   - Real browser input (coordinate fallback): get a target's box with
     `getElementBounds` (in the minimal surface) and click its center with
     `dispatchClick`, then `pressKey`/`scroll`. `getInteractiveElements` is a
     richer discovery dump but is **hidden on the minimal surface** — reach it via
     `browser_raw_command` or `WEBMCP_TOOLS=core`.
   - CSS selector interaction (`click`, `type`) is also **hidden on minimal**
     (the `*ByRef` actions are preferred); use `browser_raw_command` or
     `WEBMCP_TOOLS=core`/`full` if you specifically need it.
   - Last-resort DOM/API logic: use `evaluateJS` or page tool
     `execute_javascript`.
6. Invoke one action. The extension **automatically waits for page stability**
   after `click`, `type`, `clickByRef`, `typeByRef`, and `selectByRef`. For
   other actions, use `waitForStable` explicitly if needed.
7. Verify the postcondition with `getAriaSnapshot`, `screenshot`,
   `getInteractiveElements`, or a query.
8. Parse WebMCP results before reasoning from them.

## Calling Page WebMCP Tools

List tools:

```json
{
  "method": "webmcp.listTools",
  "params": { "tabId": 123 }
}
```

Invoke one page tool:

```json
{
  "method": "webmcp.invokeTool",
  "params": {
    "tabId": 123,
    "toolName": "query_selector_all",
    "input": {
      "selector": "button, a, input",
      "max_results": 20,
      "attributes": ["id", "class", "name", "type", "aria-label", "href"]
    }
  }
}
```

Typical nested result from the HTTP gateway:

```json
{
  "result": {
    "tabId": 123,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"count\":1,\"elements\":[...]}"
        }
      ]
    }
  }
}
```

Parse `response.result.result.content[0].text` as JSON when possible. Errors
are usually returned the same way:

```json
{ "error": true, "message": "No element found for selector: ..." }
```

Do not treat a successful JSON-RPC response as proof the page action worked;
inspect the parsed WebMCP payload.

## Extension Commands

These are background commands registered in
`webmcp-extension/dist/bg/handlers/index.js`.

> Tool exposure: by default the MCP server exposes a lean "minimal" set (~26
> tools) covering tabs, smart reads, ARIA ref interaction, a coordinate-click
> fallback (`getElementBounds` → `dispatchClick`), waits, and screenshots. Many
> commands listed below — cookies/storage, windows/viewport, console capture,
> `moveMouse`/`typeText`, `executeCDP`, `pageFetch`, `listFrames`,
> `ping`/`getExtensionInfo`, plus the superseded
> `getPageContent`/`getAccessibilityTree`/`getDOMSnapshot`/`getInteractiveElements`
> and the CSS-selector variants `click`/`type`/`hover`/`selectOption` — do **not**
> appear as their own MCP tool on the minimal surface. They are still callable via
> `browser_raw_command` (`{ method, params }`). Set `WEBMCP_TOOLS=core` for the
> broader lean set, or `WEBMCP_TOOLS=full` to expose every command as its own tool.

| Command | Use for | Params |
|---|---|---|
| `ping` | Health check | `{}` |
| `getExtensionInfo` | Extension version and debugger attachment info | `{}` |
| `getActiveTab` | Resolve current target tab | `{}` |
| `listTabs` | Find tabs by URL/title | `{}` |
| `newTab` | Open a new active tab | `{ url? }` |
| `navigate` | Navigate active or selected tab | `{ url, tabId? }` |
| `closeTab` | Close a tab | `{ tabId? }` |
| `waitForSelector` | Wait for a CSS selector in page JS | `{ selector, timeout?, tabId? }` |
| `getPageContent` | Read raw title/text/html snapshot | `{ format?, maxLength?, offset?, tabId? }` |
| `getPageText` | Smart readable article text (semantic container + cleanup) | `{ maxLength?, offset?, frame?, tabId? }` |
| `readPage` | One-shot open+read: navigate, wait, return smart text | `{ url?, maxLength?, offset?, frame?, tabId? }` |
| `click` | JS selector click | `{ selector, tabId? }` |
| `type` | JS selector value set | `{ selector, text, tabId? }` |
| `evaluateJS` | Execute page JavaScript | `{ code, tabId? }` |
| `executeCDP` | Send raw CDP command | `{ method, params?, tabId? }` |
| `screenshot` | Capture PNG base64 | `{ fullPage?, tabId? }` |
| `webmcp.listTools` | List `navigator.modelContext` tools | `{ tabId? }` |
| `webmcp.invokeTool` | Invoke a page-registered tool | `{ toolName, input?, tabId? }` |
| `getAccessibilityTree` | Read accessible page structure | `{ interestingOnly?, depth?, tabId? }` |
| `getDOMSnapshot` | Capture DOM/layout snapshot | `{ computedStyles?, tabId? }` |
| `getElementBounds` | Get selector bounds | `{ selector, tabId? }` |
| `getInteractiveElements` | List clickable/focusable elements with centers | `{ tabId? }` |
| **ARIA Snapshot** | | |
| `getAriaSnapshot` | Capture fast viewport-first tree with compact ref IDs (e.g. `ref=r1`, iframe `ref=f3r1`; native fallback uses `ref=S1`) | `{ maxDepth?, mode?, scope?, maxNodes?, maxChars?, includeOptions?, maxOptions?, refFormat?, viewportMargin?, frameId?, tabId? }` |
| `clickByRef` | Click element by ARIA ref — more robust than CSS selector | `{ ref, element?, frameId?, tabId? }` |
| `typeByRef` | Type into element by ARIA ref, optionally submit | `{ ref, text, submit?, frameId?, tabId? }` |
| `hoverByRef` | Hover over element by ARIA ref | `{ ref, frameId?, tabId? }` |
| `selectByRef` | Select dropdown option(s) by ARIA ref | `{ ref, values, frameId?, tabId? }` |
| **Page Stability** | | |
| `waitForStable` | Wait for page DOM to settle (no mutations) | `{ minStableMs?, maxWaitMs?, maxMutations?, tabId? }` |
| **Console Observability** | | |
| `startConsoleCapture` | Start buffering console calls and uncaught exceptions | `{ tabId? }` |
| `readConsoleMessages` | Read captured console output with filters | `{ level?, pattern?, limit?, since?, clear?, tabId? }` |
| `clearConsoleMessages` | Clear the console buffer without stopping capture | `{ tabId? }` |
| `stopConsoleCapture` | Stop console capture and release Runtime capture state | `{ tabId? }` |
| **CDP Input** | | |
| `dispatchClick` | Real CDP click at coordinates | `{ x, y, button?, clickCount?, tabId? }` |
| `moveMouse` | Real CDP mouse move | `{ x, y, steps?, fromX?, fromY?, tabId? }` |
| `pressKey` | Real CDP key press | `{ key, text?, modifiers?, tabId? }` |
| `typeText` | Real CDP text insertion into focused element | `{ text, tabId? }` |
| `scroll` | Real CDP mouse-wheel scroll | `{ deltaX?, deltaY?, x?, y?, tabId? }` |
| `hover` | Real CDP hover by selector | `{ selector, tabId? }` |
| `selectOption` | Select an HTML `<select>` option | `{ selector, value?, index?, text?, frame?, tabId? }` |
| **Storage & Browser** | | |
| `getCookies` | Read cookies for current page | `{ tabId? }` |
| `setCookie` | Set a cookie | `{ name, value, domain?, path?, tabId? }` |
| `deleteCookies` | Delete a cookie | `{ name, domain?, url?, tabId? }` |
| `getLocalStorage` | Read localStorage | `{ tabId? }` |
| `setLocalStorage` | Write localStorage | `{ key, value, tabId? }` |
| `listWindows` | List browser windows | `{}` |
| `createWindow` | Create browser window | `{ url?, width?, height?, type? }` |
| `setViewport` | Override viewport | `{ width, height, deviceScaleFactor?, mobile?, tabId? }` |
| `resetViewport` | Clear viewport override | `{ tabId? }` |

### ARIA Snapshot vs CSS Selectors

Prefer ARIA ref-based interaction (`getAriaSnapshot` → `clickByRef`/`typeByRef`)
over CSS selector-based interaction (`click`/`type`) whenever possible:

- **ARIA refs** are stable across DOM re-renders on SPAs — CSS selectors break
  when classes/IDs change.
- **ARIA refs** identify elements by semantic role — the AI understands what
  each element does (button, textbox, link, etc.).
- **CSS selectors** are still useful for simple static pages or when you need
  `query_selector_all` for bulk extraction.

Use `selectOption` for native `<select>` elements when CDP/background control is
preferred. Use `selectByRef` when you already have an ARIA ref. Use page tool
`fill_form_field` when staying in the WebMCP page-tool layer is simpler.

### evaluateJS return values and bulk extraction

`evaluateJS` runs your code inside an async IIFE — `(async () => { CODE })()` —
so `await` always works and the result is returned to you.

- **A single expression is auto-returned.** `document.title`,
  `[...document.querySelectorAll("table tr")].map(tr => tr.innerText)`, or a
  nested `(() => { ... })()` resolve to their value with no explicit `return`.
- **A multi-statement body needs an explicit top-level `return`.** Once you use
  declarations, loops, or `if`/`try` at the top level, add `return <value>` at
  the end — otherwise the call resolves to `undefined` (you'll only see
  `tabId` come back). This is the classic gotcha; the auto-return above covers
  the common single-expression case, but bodies are still yours to return from.
- **Prefer `evaluateJS` / `query_selector_all` / `extract_table_data` over ARIA
  snapshots for bulk row/table/data extraction.** ARIA snapshots are optimized
  for interactive controls and may omit dense tabular rows, hidden tooltips, or
  chart/SVG internals. Use the snapshot to *navigate and click*; use a DOM query
  to *pull structured data out in bulk*.

```js
// Good — single expression, auto-returned
[...document.querySelectorAll("#trends li")].map(li => ({
  rank: li.querySelector(".rank")?.textContent?.trim(),
  label: li.querySelector(".label")?.textContent?.trim(),
}))

// Good — multi-statement body, explicit return
const rows = [...document.querySelectorAll("table tbody tr")];
return rows.map(tr => [...tr.cells].map(td => td.innerText.trim()));
```

## Page-Registered Tools

These tools are registered by `register-tools.js` and should be called only via
`webmcp.invokeTool`.

| Tool | Use for | Required input |
|---|---|---|
| `get_page_metadata` | Title, URL, canonical, meta, Open Graph, optional headings/links | none |
| `query_selector_all` | DOM discovery by CSS selector, text, attributes, bounds | `selector` |
| `click_element` | DOM click by CSS selector | `selector` |
| `fill_form_field` | Set input/textarea/select/contenteditable value | `selector`, `value` |
| `extract_table_data` | Convert an HTML table to JSON rows | none |
| `wait_for_element` | Wait for selector using MutationObserver | `selector` |
| `get_computed_styles` | Inspect styles and bounds | `selector` |
| `scroll_page` | Scroll document/container to top, bottom, selector, or delta | none |
| `submit_form` | Fill fields and submit a form | none |
| `execute_javascript` | Run page JS as an escape hatch | `code` |
| `start_network_capture` | Start capture for a URL substring. Call repeatedly to capture multiple patterns at once. | `url_pattern` |
| `wait_for_network_response` | Wait (event-driven) for the next match; consumes it so repeat calls walk successive responses | `url_pattern` |
| `get_captured_requests` | List everything captured so far without consuming; bodies/headers optional | none |
| `stop_network_capture` | Stop capture (optionally one pattern) and clean up | none |

Use `listFrames` before targeting iframes from background commands. Most
selector/page commands accept a `frame` object such as `{ cdpFrameId }`,
`{ frameId }`, `{ frameName }`, `{ frameUrl }`, `{ frameSelector }`, or nested
`{ framePath: [...] }`.

Page-registered iframe forwarding is implemented for `query_selector_all`,
`click_element`, `fill_form_field`, `extract_table_data`, `wait_for_element`,
and `get_computed_styles`. These page tools accept `frame_selector`,
`frame_path`, and `frame_timeout_ms` inside the `input` passed to
`webmcp.invokeTool`.

Use standard CSS selectors only. Playwright-only selectors such as
`:has-text("Login")` are invalid here. To click by visible text, first call
`query_selector_all` and inspect text, or use `execute_javascript`.

## Tool Selection

| Need | Best action |
|---|---|
| Open or change page | `newTab` or `navigate` |
| Read / answer from a text page (do this first) | `getPageText` (or `readPage` to navigate+read in one call) — fast, clean, low-token; prefer over a snapshot when you only need to read |
| Understand page structure **to interact** | `getAriaSnapshot` — returns semantic tree with ref IDs |
| Know what can be clicked/typed | `getAriaSnapshot` (minimal); `getInteractiveElements` for a richer dump (hidden on minimal — use `browser_raw_command`/`core`) |
| Click a button/link on SPA | `getAriaSnapshot` → `clickByRef` (robust) |
| Fill a text field on SPA | `getAriaSnapshot` → `typeByRef` (robust) |
| Select a dropdown option | `getAriaSnapshot` → `selectByRef` (robust) |
| Extract visible repeated DOM data | `webmcp.invokeTool` -> `query_selector_all` |
| Extract page title/meta/headings/links | `webmcp.invokeTool` -> `get_page_metadata` |
| Fill ordinary form field (simple page) | `webmcp.invokeTool` -> `fill_form_field` |
| Submit form | `webmcp.invokeTool` -> `submit_form`, then wait |
| Anti-bot/framework requires real input | `getElementBounds` → `dispatchClick`, then `pressKey` (minimal-friendly). `getInteractiveElements`/`typeText` are hidden on minimal — use `browser_raw_command`/`core` |
| Wait for page to settle | `waitForStable` (auto-applied after click/type/clickByRef/typeByRef) |
| Infinite scroll | `scroll` or `scroll_page`, then query count again |
| Table extraction | `webmcp.invokeTool` -> `extract_table_data` |
| Need XHR/fetch body | `start_network_capture`, trigger action, `wait_for_network_response`, `stop_network_capture` |
| Need console errors/logs | `startConsoleCapture`, trigger action, `readConsoleMessages`, `stopConsoleCapture` |
| Need app state/local globals | `evaluateJS` or `execute_javascript` |
| Need visual verification | `screenshot` |

## Common Workflows

### Navigate, discover, extract

```json
{ "method": "newTab", "params": { "url": "https://example.com" } }
```

```json
{ "method": "webmcp.listTools", "params": { "tabId": 123 } }
```

```json
{
  "method": "webmcp.invokeTool",
  "params": {
    "tabId": 123,
    "toolName": "query_selector_all",
    "input": {
      "selector": "main a, main button, main article",
      "max_results": 50,
      "attributes": ["href", "role", "aria-label", "data-testid"]
    }
  }
}
```

### Click and type with ARIA refs (preferred)

1. Call `getAriaSnapshot` to see the page structure with ref IDs.
2. Identify the target element by its role and name (e.g. `ref=r5 button "Sign In"`).
3. Call `clickByRef` with `{ "ref": "r5" }`.
4. The extension auto-waits for page stability after clicking.
5. Call `getAriaSnapshot` again to see updated state.
6. To type, call `typeByRef` with `{ "ref": "r3", "text": "hello", "submit": true }`.

### Real click and type (CDP coordinates)

1. Get the target's box with `getElementBounds` (in the minimal surface). For a
   whole-page discovery dump use `getInteractiveElements` instead — it is hidden
   on minimal, so call it via `browser_raw_command` or `WEBMCP_TOOLS=core`.
2. Use the box's `centerX`/`centerY`.
3. Call `dispatchClick` with those coordinates.
4. Type: `typeText` inserts into the focused element (hidden on minimal — use
   `browser_raw_command`/`core`); otherwise prefer `typeByRef` from a snapshot.
5. Call `pressKey` with `Enter` if needed.
6. Verify with `waitForSelector`, `getAriaSnapshot`, or `screenshot`.

### Form fill with ARIA refs (preferred for SPAs)

1. Call `getAriaSnapshot` to discover form fields with refs.
2. `typeByRef` for each text field.
3. `selectByRef` for dropdowns.
4. `clickByRef` on the submit button.
5. Extension auto-waits; then call `getAriaSnapshot` to verify result.

### Form fill with page tools (alternative)

1. `webmcp.invokeTool` -> `wait_for_element` with `selector: "form"`.
2. `webmcp.invokeTool` -> `query_selector_all` with
   `selector: "form input, form select, form textarea, form button"`.
3. `webmcp.invokeTool` -> `fill_form_field` for each field.
4. `webmcp.invokeTool` -> `click_element` or `submit_form`.
5. Wait for the expected success selector or navigation.

### Network capture

1. `webmcp.invokeTool` -> `start_network_capture` with a URL substring such as
   `"graphql"` or `"/api/search"`. Call it again with other substrings to watch
   several endpoints at once.
2. Trigger the page action with a click/type/form submit. Note: synthetic CDP
   typing may not fire a site's input listeners; if the request never appears,
   trigger it directly (e.g. `execute_javascript` -> `fetch(...)`) or use a real
   click on the submit control.
3. Read the result one of two ways:
   - `wait_for_network_response` — blocks until the next match arrives and
     consumes it; call again to get the following response.
   - `get_captured_requests` — pull the full list at once (set
     `include_bodies: true` for bodies); does not consume.
4. `webmcp.invokeTool` -> `stop_network_capture`.

Captured records include `method`, `status`, `mimeType`, `durationMs`,
`fromCache`, and (for `wait_for_network_response` / `include_bodies`) `body` plus
`base64Encoded`. Failed requests are returned with `failed: true` and
`errorText` instead of hanging.

## Safety And Reliability

- Ask before submitting irreversible forms, purchases, deletions, or sending
  private messages.
- Do not read cookies, localStorage, tokens, or secrets unless the user asks for
  that specific task.
- **Prefer ARIA ref-based interaction** (`getAriaSnapshot` → `clickByRef` /
  `typeByRef`) over CSS selectors for clicking and typing. ARIA refs are stable
  across DOM re-renders.
- Fall back to a coordinate click (`getElementBounds` → `dispatchClick`) when
  ARIA refs are not available or JS clicks/synthetic events fail. The richer
  `getInteractiveElements` dump is hidden on the minimal surface — reach it via
  `browser_raw_command` or `WEBMCP_TOOLS=core`.
- The extension **auto-waits for page stability** after `click`, `type`,
  `clickByRef`, `typeByRef`, and `selectByRef`. For other actions, use
  `waitForStable` explicitly after navigation, form submits, route changes,
  modal opens, and infinite scroll actions.
- When using CSS selectors, keep them resilient: prefer stable IDs, names, roles,
  labels, `data-testid`, `aria-label`, and meaningful containers.
- Avoid brittle absolute DOM paths like `body > div > div > div:nth-child(4)`.
- When a ref or selector fails, call `getAriaSnapshot` again to refresh refs
  instead of repeating the same failing call.
- ARIA refs are **session-scoped per tab** — they are invalidated after page
  navigation or full reload. Always call `getAriaSnapshot` after navigating.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Gateway is not reachable | Start `npm run gateway`, `webmcp gateway start`, or use `WEBMCP_GATEWAY_AUTOSTART=1` for local dev autostart. |
| `Chrome extension is not connected to the gateway` | Gateway is up but no extension is attached: reload the unpacked extension. |
| `Method not found` | You called a page tool as a background command. Use `webmcp.invokeTool` with `toolName`, or choose one of the extension commands above. |
| `navigator.modelContext not found` | Use a normal web page, wait for load, navigate/reload the tab, and confirm `register-tools.js` is injected. Chrome internal pages cannot use it. |
| Empty `webmcp.listTools` result | Reload extension and page; make sure the unpacked extension points at `webmcp-extension/dist`. |
| `No element found` | Wait, scroll, call `query_selector_all` with broader selectors, or use `getInteractiveElements`. |
| `Another debugger is already attached` | Only one debugger client can attach to a tab. Close conflicting automation extensions or use another tab. |
| Network capture says not started | Call `start_network_capture` before triggering the request, on the same tab. |

## Source Of Truth

- Page tool definitions: `webmcp-extension/dist/content-scripts/register-tools.js`
- Extension background command registry:
  `webmcp-extension/dist/bg/handlers/index.js`
- HTTP gateway for agents/scripts: `server/gateway_server.js`
- Generated source-derived command and page-tool reference:
  `references/generated-tools.md`
- Quick reference: `references/tool-reference-card.md`
