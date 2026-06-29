# WebMCP Extension v2.1.2

Chrome extension for **AI-driven browser automation** over WebSocket. Provides **51 commands**
so an AI model can fully control the browser: inspect page structure, click/type at
coordinates, capture console output, manage cookies/storage, take screenshots, and more.

## Architecture

```
┌─────────────────────────┐         WebSocket          ┌─────────────────────────┐
│  Your AI Program        │ ◀═══════════════════════▶  │  Chrome Extension       │
│  (Python / Node.js)     │    ws://localhost:7865      │  (background.js)        │
│                         │    JSON-RPC 2.0             │                         │
│  Runs Gateway Server    │                             │  Connects as WS client  │
│  + AI Model integration │  ── Commands ─────────────▶ │  → chrome.debugger      │
│                         │  ◀── Results ──────────────│  → chrome.tabs          │
│                         │  ◀── Events ───────────────│  → chrome.downloads     │
│                         │                             │  → chrome.windows       │
│                         │                             │  → navigator.modelContext│
└─────────────────────────┘                             └─────────────────────────┘
```

## Quick Start

### Step 1: Load Extension Into Chrome

1. Open Chrome -> `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked** -> select the `dist/` directory
4. The extension icon appears in the toolbar

### Step 2: Start Gateway Server

Only needed when calling the gateway directly with scripts/curl. If using the MCP server,
skip this step; `server/mcp_server.mjs` starts the gateway automatically.

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension
npm run setup      # First time
npm run gateway
```

Output:

```
======================================================================
  WebMCP Automation Gateway Server is running!
  - Extension WebSocket Endpoint: ws://localhost:7865
  - Health Endpoint: GET http://localhost:7865/health
  - HTTP API Endpoint for Agents/Scripts: POST http://localhost:7865/api
======================================================================
```

### Step 3: Extension Auto-Connects

The extension auto-connects within 3 seconds. The gateway logs:

```
✓ Extension connected
✓ Extension ready: WebMCP Tools Provider v2.1.0
    51 capabilities registered
```

---

## All Commands (51)

Send as JSON-RPC 2.0 over WebSocket. If `tabId` is omitted, the command targets the active tab.

### Tab Management (5)

| Method         | Params            | Description                            |
| -------------- | ----------------- | -------------------------------------- |
| `listTabs`     | `{}`              | List all tabs                          |
| `navigate`     | `{ url, tabId? }` | Navigate a tab to a URL (waits for load) |
| `newTab`       | `{ url? }`        | Open a new tab                         |
| `closeTab`     | `{ tabId? }`      | Close a tab                            |
| `getActiveTab` | `{}`              | Current active tab info                |

### Page Interaction — JS-based (10)

| Method              | Params                                          | Description                              |
| ------------------- | ----------------------------------------------- | ---------------------------------------- |
| `listFrames`        | `{ flat?, force?, tabId? }`                     | List iframe/frame contexts               |
| `click`             | `{ selector, frame?, tabId? }`                  | Click an element by CSS selector         |
| `type`              | `{ selector, text, frame?, tabId? }`            | Type text into an input (React/Vue compatible) |
| `waitForSelector`   | `{ selector, timeout?, frame?, tabId? }`        | Wait for an element to appear            |
| `getPageContent`    | `{ format?, maxLength?, offset?, frame?, tabId? }` | Get page title, text, and/or HTML     |
| `querySelectorAll`  | `{ selector, limit?, offset?, fields?, pierceShadow?, frame?, tabId? }` | Extract elements as structured records |
| `getWindowVariable` | `{ path, maxLength?, offset?, frame?, tabId? }` | Read globals like `__NEXT_DATA__`        |
| `findByText`        | `{ text, exact?, selector?, pierceShadow?, frame?, tabId? }` | Find elements by visible text |
| `pageFetch`         | `{ url, method?, headers?, body?, responseType?, frame?, tabId? }` | Fetch from page origin/session |
| `evaluateJS`        | `{ code, frame?, tabId? }`                      | Run arbitrary JavaScript                 |

### CDP — Chrome DevTools Protocol (2)

| Method       | Params                        | Description                  |
| ------------ | ----------------------------- | ---------------------------- |
| `executeCDP` | `{ method, params?, tabId? }` | Send **any** CDP command     |
| `screenshot` | `{ fullPage?, tabId? }`       | Capture screenshot (base64 PNG) |

### WebMCP Tools (2)

| Method              | Params                         | Description                     |
| ------------------- | ------------------------------ | ------------------------------- |
| `webmcp.listTools`  | `{ tabId? }`                   | List WebMCP tools on the page   |
| `webmcp.invokeTool` | `{ toolName, input?, tabId? }` | Invoke one WebMCP tool          |

### ARIA Snapshot Interaction (5)

| Method            | Params                         | Description                              |
| ----------------- | ------------------------------ | ---------------------------------------- |
| `getAriaSnapshot` | `{ maxDepth?, mode?, scope?, maxNodes?, maxChars?, includeOptions?, maxOptions?, refFormat?, viewportMargin?, frameId?, tabId? }` | Capture fast viewport-first semantic tree with compact persistent refs |
| `clickByRef`      | `{ ref, element?, frameId?, tabId? }` | Click using an ARIA snapshot ref |
| `typeByRef`       | `{ ref, text, submit?, frameId?, tabId? }` | Type using an ARIA snapshot ref |
| `hoverByRef`      | `{ ref, frameId?, tabId? }`    | Hover using an ARIA snapshot ref         |
| `selectByRef`     | `{ ref, values, frameId?, tabId? }` | Select option values by ARIA ref     |

### Page Stability (1)

| Method          | Params                                          | Description                              |
| --------------- | ----------------------------------------------- | ---------------------------------------- |
| `waitForStable` | `{ minStableMs?, maxWaitMs?, maxMutations?, watchSelector?, tabId? }` | Wait until DOM mutations quiet down |

### 🆕 AI Vision — Page Structure (4)

The AI needs to "see" the page structure to know where to click.

| Method                   | Params                                 | Description                                                                                                                 |
| ------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `getAccessibilityTree`   | `{ interestingOnly?, depth?, tabId? }` | Accessibility tree (roles, names, states). AI uses it to understand layout                                                  |
| `getDOMSnapshot`         | `{ computedStyles?, tabId? }`          | Full DOM + layout + styles snapshot                                                                                         |
| `getElementBounds`       | `{ selector, tabId? }`                 | Position (bounding box) of elements matching the selector                                                                   |
| `getInteractiveElements` | `{ tabId? }`                           | **⭐ Most important command** — lists ALL interactive elements (buttons, links, inputs...) + position + state                |

**Example `getInteractiveElements` response:**

```json
{
  "tabId": 123,
  "elements": [
    {
      "index": 0,
      "tag": "a",
      "text": "Learn more",
      "href": "https://example.com/more",
      "bounds": {
        "x": 200,
        "y": 180,
        "width": 100,
        "height": 20,
        "centerX": 250,
        "centerY": 190
      }
    },
    {
      "index": 1,
      "tag": "input",
      "type": "text",
      "placeholder": "Search...",
      "bounds": {
        "x": 300,
        "y": 50,
        "width": 200,
        "height": 30,
        "centerX": 400,
        "centerY": 65
      }
    }
  ]
}
```

### Console Observability (4)

Capture console output and uncaught exceptions with explicit start/read/clear/stop control.

| Method                 | Params                                          | Description                                      |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `startConsoleCapture`  | `{ tabId? }`                                    | Start buffering console calls and exceptions     |
| `readConsoleMessages`  | `{ level?, pattern?, limit?, since?, clear?, tabId? }` | Read buffered messages with filters       |
| `clearConsoleMessages` | `{ tabId? }`                                    | Clear the buffer while capture remains active    |
| `stopConsoleCapture`   | `{ tabId? }`                                    | Stop capture and release the Runtime listener    |

Example:

```json
{ "method": "readConsoleMessages", "params": { "level": "error", "limit": 20 } }
```

### 🆕 CDP Input Dispatch (7)

Real click/type through CDP: not blocked by anti-bot checks and works across frameworks.

| Method          | Params                                        | Description                                             |
| --------------- | --------------------------------------------- | ------------------------------------------------------- |
| `dispatchClick` | `{ x, y, button?, clickCount?, tabId? }`      | Click at coordinates (x, y)                             |
| `moveMouse`     | `{ x, y, steps?, fromX?, fromY?, tabId? }`    | Move mouse smoothly in multiple steps                   |
| `pressKey`      | `{ key, text?, modifiers?, tabId? }`          | Press a key. `modifiers`: `['ctrl','shift','alt','meta']` |
| `typeText`      | `{ text, tabId? }`                            | Type text quickly (CDP `Input.insertText`)              |
| `scroll`        | `{ deltaX?, deltaY?, x?, y?, tabId? }`        | Scroll the page                                         |
| `hover`         | `{ selector, tabId? }`                        | Hover over an element (CSS selector)                    |
| `selectOption`  | `{ selector, value?, index?, text?, tabId? }` | Select an option in `<select>`                          |

**Special keys for `pressKey`:**
`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, `Space`

**Keyboard shortcuts:** `{ key: "a", modifiers: ["ctrl"] }` = Ctrl+A

### 🆕 Full Control (9)

| Method            | Params                                                   | Description                         |
| ----------------- | -------------------------------------------------------- | ----------------------------------- |
| `getCookies`      | `{ tabId? }`                                             | Read page cookies                   |
| `setCookie`       | `{ name, value, domain?, path?, tabId? }`                | Create/update a cookie              |
| `deleteCookies`   | `{ name, domain?, url?, tabId? }`                        | Delete a cookie                     |
| `getLocalStorage` | `{ tabId? }`                                             | Read all localStorage               |
| `setLocalStorage` | `{ key, value, tabId? }`                                 | Write localStorage                  |
| `listWindows`     | `{}`                                                     | List browser windows                |
| `createWindow`    | `{ url?, width?, height?, type? }`                       | Create a new window                 |
| `setViewport`     | `{ width, height, deviceScaleFactor?, mobile?, tabId? }` | Override viewport (responsive test) |
| `resetViewport`   | `{ tabId? }`                                             | Reset viewport to default           |

### Utility (2)

| Method             | Params | Description               |
| ------------------ | ------ | ------------------------- |
| `ping`             | `{}`   | Health check              |
| `getExtensionInfo` | `{}`   | Version + debugger status |

---

## Events (Extension → Server)

The extension automatically sends notifications:

| Event             | When                  | Params                                  |
| ----------------- | --------------------- | --------------------------------------- |
| `extensionReady`  | Extension connected   | `{ name, version, capabilities }`       |
| `tabUpdated`      | Tab finished loading  | `{ tabId, url, title, status }`         |
| `tabClosed`       | Tab was closed        | `{ tabId }`                             |
| `tabCreated`      | New tab was created   | `{ tabId, url, windowId }`              |
| `tabActivated`    | Tab switched          | `{ tabId, windowId }`                   |
| `cdpEvent`        | CDP event             | `{ tabId, method, params }`             |
| `downloadStarted` | Download started      | `{ id, url, filename, mime, fileSize }` |
| `downloadChanged` | Download state change | `{ id, state, filename, error }`        |
| `heartbeat`       | Every 20 seconds      | `{ timestamp }`                         |

---

## Protocol

### Send command (your program → extension):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getInteractiveElements",
  "params": {}
}
```

### Receive result (extension → your program):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tabId": 123,
    "elements": [
      {
        "tag": "button",
        "text": "Submit",
        "bounds": { "centerX": 400, "centerY": 300 }
      }
    ]
  }
}
```

### Receive event (no id):

```json
{
  "jsonrpc": "2.0",
  "method": "tabUpdated",
  "params": {
    "tabId": 123,
    "url": "https://google.com",
    "title": "Google",
    "status": "complete"
  }
}
```

---

## AI Automation Workflow

```python
# 1. AI sees the page
elements = send("getInteractiveElements")
# → [{ tag: "input", placeholder: "Search", bounds: { centerX: 400, centerY: 65 } }, ...]

# 2. AI clicks the search box
send("dispatchClick", { x: 400, y: 65 })

# 3. AI types text
send("typeText", { text: "hello world" })

# 4. AI presses Enter
send("pressKey", { key: "Enter" })

# 5. Wait for page load (receive tabUpdated event)
# 6. AI captures a screenshot to inspect the result
send("screenshot")

# 7. AI reads the new page structure
send("getAccessibilityTree")

# Repeat...
```

---

## 14 Page-Registered WebMCP Tools

Automatically injected into every page through `navigator.modelContext`:

| #   | Tool                        | Description                                      |
| --- | --------------------------- | ------------------------------------------------ |
| 1   | `get_page_metadata`         | Title, meta tags, OG data, headings              |
| 2   | `query_selector_all`        | Find elements by CSS selector                    |
| 3   | `click_element`             | Click element (+ scroll into view)               |
| 4   | `fill_form_field`           | Set input/textarea/select value                  |
| 5   | `extract_table_data`        | Extract bảng HTML → JSON                         |
| 6   | `wait_for_element`          | Wait for an element to appear (MutationObserver) |
| 7   | `get_computed_styles`       | Read CSS computed styles                         |
| 8   | `scroll_page`               | Scroll the page (top/bottom/element/delta)       |
| 9   | `submit_form`               | Fill multiple fields + submit form               |
| 10  | `execute_javascript`        | Run arbitrary JS in the page context             |
| 11  | `start_network_capture`     | Capture network by URL pattern (multiple calls = multiple patterns) |
| 12  | `wait_for_network_response` | Wait for the next event-driven response + body; consume one at a time |
| 13  | `get_captured_requests`     | List all captured requests without consuming them (optional bodies/headers) |
| 14  | `stop_network_capture`      | Stop capture for one pattern or all patterns and clean up resources |

---

## Project Structure

```
web-automation-extension/
├── README.md                          # Kit quickstart
├── package.json                       # npm run gateway/health/call/tools:generate
├── server/
│   └── gateway_server.js              # HTTP + WebSocket gateway
├── webmcp-extension/
│   ├── README.md                      # This file
│   └── dist/                          # ← Load this directory into Chrome
│       ├── manifest.json              # Manifest V3
│       ├── background.js              # WebSocket client + 51 command handlers
│       ├── content-scripts/
│       │   ├── bridge.js              # Isolated-world bridge
│       │   └── register-tools.js      # Inject 13 WebMCP tools into every page
│       └── icons/
├── skills/
│   └── webmcp-browser-automation/     # Agent skill source (installed globally)
├── catalog/                           # Command catalog (source for MCP tools)
├── scripts/                           # Installer + tooling helpers
├── .examples/                         # Gateway examples + JSON workflows (git-ignored)
└── docs/                              # Architecture and setup notes
```

---

## Integration with AI Models

```python
# Python + OpenAI/Anthropic example
import asyncio, json
from websockets.asyncio.server import serve

extension_ws = None

async def handle_extension(ws):
    global extension_ws
    extension_ws = ws
    async for msg in ws:
        response = json.loads(msg)
        # Handle responses and events from extension

async def send_command(method, params={}):
    """Send a command to the extension and wait for response."""
    msg = { "jsonrpc": "2.0", "id": 1, "method": method, "params": params }
    await extension_ws.send(json.dumps(msg))

# AI Automation loop:
# 1. send_command("getInteractiveElements") → see the page
# 2. AI decides what to do
# 3. send_command("dispatchClick", { "x": 400, "y": 300 }) → click
# 4. send_command("screenshot") → verify result
# 5. Repeat

async def main():
    async with serve(handle_extension, "localhost", 7865):
        await asyncio.Future()  # Run forever

asyncio.run(main())
```

---

## Troubleshooting

| Problem                                | Solution                                                              |
| -------------------------------------- | --------------------------------------------------------------------- |
| `ERR_CONNECTION_REFUSED`               | Start the gateway server first. The extension auto-reconnects every 3s. |
| `Another debugger is already attached` | Close the other extension (Codex) or use another tab.                 |
| `navigator.modelContext not found`     | Page has not loaded yet. Use `waitForSelector` first, or reload the extension. |
| WebMCP tools do not appear             | Extension is not loaded, or the page is a `chrome://` URL.            |
| Server does not receive connection     | Check that the extension is loaded. Try reloading at `chrome://extensions`. |
| `getAccessibilityTree` returns few nodes | Use `interestingOnly: false` to retrieve all nodes.                 |

## Documentation

- [Root Kit Quickstart](../README.md) — Entrypoint for extension + gateway + skill
- [Generated Tool Reference](../skills/webmcp-browser-automation/references/generated-tools.md) — Source-derived commands/tools
- [Codex Extension Analysis](../docs/extension/codex-extension-analysis.md) — How the Codex extension works
- [Implementation Plan](../docs/extension/implementation-plan.md) — Design details and all commands
- [Compatibility Audit](../docs/extension/compatibility-audit.md) — Comparison with Codex v1.1.5
