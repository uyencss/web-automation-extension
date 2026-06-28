# Implementation Plan — WebMCP Extension v2.1.0

## Overview

The extension provides **AI-driven browser automation** over WebSocket. The gateway server receives HTTP commands from agents/scripts and forwards JSON-RPC 2.0 over WebSocket to the extension to control the browser.

## Architecture

```
┌─────────────────────────┐         WebSocket          ┌─────────────────────────┐
│  Your AI Program        │ ◀═══════════════════════▶  │  Chrome Extension       │
│  (Python / Node.js)     │    ws://localhost:7865      │  (background.js)        │
│                         │    JSON-RPC 2.0             │                         │
│  Runs Gateway Server    │                             │  Connects as WS client  │
│  + AI Model integration │                             │                         │
│                         │  ── Commands ─────────────▶ │  → chrome.debugger      │
│                         │  ◀── Results ──────────────│  → chrome.tabs          │
│                         │  ◀── Events ───────────────│  → chrome.downloads     │
│                         │                             │  → chrome.windows       │
│                         │                             │  → navigator.modelContext│
└─────────────────────────┘                             └─────────────────────────┘
```

## Transport & Protocol

| Item | Value |
|------|-------|
| Transport | WebSocket |
| URL | `ws://localhost:7865` (configurable) |
| Protocol | JSON-RPC 2.0 |
| Direction | Extension is WS **client**, gateway is WS **server** |
| Reconnect | Auto-reconnect every 3 seconds |
| Keep-alive | Heartbeat every 20 seconds |

---

## All Commands (36 total)

### 1. Tab Management (5 commands)

| Method | Params | Response |
|--------|--------|----------|
| `listTabs` | `{}` | `{ tabs: [{ id, url, title, active, windowId }] }` |
| `navigate` | `{ url, tabId? }` | `{ tabId, url, title }` |
| `newTab` | `{ url? }` | `{ tabId, url, title }` |
| `closeTab` | `{ tabId? }` | `{ closed: true, tabId }` |
| `getActiveTab` | `{}` | `{ tabId, url, title, windowId }` |

---

### 2. Page Interaction — JS-based (5 commands)

| Method | Params | Response |
|--------|--------|----------|
| `click` | `{ selector, tabId? }` | `{ tabId, success, tag, text }` |
| `type` | `{ selector, text, tabId? }` | `{ tabId, success, tag, name }` |
| `waitForSelector` | `{ selector, timeout?, tabId? }` | `{ tabId, found, tag, text }` |
| `getPageContent` | `{ tabId? }` | `{ tabId, title, url, text, html }` |
| `evaluateJS` | `{ code, tabId? }` | `{ tabId, result }` |

---

### 3. CDP (Chrome DevTools Protocol) (2 commands)

| Method | Params | Response |
|--------|--------|----------|
| `executeCDP` | `{ method, params?, tabId? }` | `{ tabId, result }` |
| `screenshot` | `{ fullPage?, tabId? }` | `{ tabId, base64, format }` |

> `executeCDP` is a passthrough. It can send **any CDP command** (e.g., `DOM.getDocument`, `Network.enable`, `Runtime.evaluate`).

---

### 4. WebMCP Tools (2 commands)

| Method | Params | Response |
|--------|--------|----------|
| `webmcp.listTools` | `{ tabId? }` | `{ tabId, tools: [...] }` |
| `webmcp.invokeTool` | `{ toolName, input?, tabId? }` | `{ tabId, result }` |

---

### 5. 🆕 Phase 1: AI Vision (4 commands)

Allows the AI to "see" the page structure and understand which elements are interactive and where they are located.

| Method | Params | Response |
|--------|--------|----------|
| `getAccessibilityTree` | `{ interestingOnly?, depth?, tabId? }` | `{ tabId, nodeCount, nodes: [{ nodeId, role, name, value, disabled, focused, checked, backendDOMNodeId }] }` |
| `getDOMSnapshot` | `{ computedStyles?, tabId? }` | `{ tabId, documents: [...], strings: [...] }` |
| `getElementBounds` | `{ selector, tabId? }` | `{ tabId, elements: [{ index, tag, id, text, bounds: { x, y, width, height, centerX, centerY }, visible }] }` |
| `getInteractiveElements` | `{ tabId? }` | `{ tabId, elements: [{ index, tag, type, id, name, role, ariaLabel, text, href, value, checked, disabled, bounds }] }` |

**Explanation:**
- `getAccessibilityTree` — Uses CDP `Accessibility.getFullAXTree`. Returns a filtered accessibility tree with meaningful nodes only: buttons, links, inputs, headings, etc. The AI uses this to understand the page structure.
- `getDOMSnapshot` — Uses CDP `DOMSnapshot.captureSnapshot`. Returns full DOM + layout + styles. Heavy but complete.
- `getElementBounds` — Returns the position (bounding box) of all elements that match the selector. The AI uses this to know where to click.
- `getInteractiveElements` — Lists ALL interactive elements (`a`, `button`, `input`, `select`, `textarea`, `[role=button]`, etc.) + position + state. **The most important command for AI.**

---

### 6. 🆕 Phase 2: CDP Input Dispatch (7 commands)

Real click/type through CDP: not blocked by anti-bot checks and works across frameworks (React, Vue, Angular).

| Method | Params | Response |
|--------|--------|----------|
| `dispatchClick` | `{ x, y, button?, clickCount?, tabId? }` | `{ tabId, clicked, x, y, button }` |
| `moveMouse` | `{ x, y, steps?, fromX?, fromY?, tabId? }` | `{ tabId, x, y }` |
| `pressKey` | `{ key, text?, modifiers?, tabId? }` | `{ tabId, key, modifiers }` |
| `typeText` | `{ text, tabId? }` | `{ tabId, typed }` |
| `scroll` | `{ deltaX?, deltaY?, x?, y?, tabId? }` | `{ tabId, deltaX, deltaY }` |
| `hover` | `{ selector, tabId? }` | `{ tabId, x, y, selector }` |
| `selectOption` | `{ selector, value?, index?, text?, tabId? }` | `{ tabId, success, value, text }` |

**Explanation:**
- `dispatchClick` — Clicks at coordinates (x, y) through CDP `Input.dispatchMouseEvent`. Combine with `getInteractiveElements` to get coordinates.
- `moveMouse` — Moves the mouse smoothly in multiple steps. Useful for hover effects and tooltips.
- `pressKey` — Presses keys. Supports `modifiers: ['ctrl', 'shift', 'alt', 'meta']` for shortcuts (Ctrl+C, Ctrl+A...). Supports special keys: Enter, Tab, Escape, Backspace, Arrow keys, etc.
- `typeText` — Types text quickly through CDP `Input.insertText`. No need to focus first.
- `scroll` — Scrolls the page through mouse wheel events.
- `hover` — Hovers over an element using a CSS selector. Automatically scrolls it into view first.
- `selectOption` — Selects an option in a `<select>` dropdown.

---

### 7. 🆕 Phase 3: Full Control (9 commands)

| Method | Params | Response |
|--------|--------|----------|
| `getCookies` | `{ tabId? }` | `{ tabId, cookies: [...] }` |
| `setCookie` | `{ name, value, domain?, path?, tabId? }` | `{ tabId, success }` |
| `deleteCookies` | `{ name, domain?, url?, tabId? }` | `{ tabId, deleted }` |
| `getLocalStorage` | `{ tabId? }` | `{ tabId, data: { key: value } }` |
| `setLocalStorage` | `{ key, value, tabId? }` | `{ tabId, key, set }` |
| `listWindows` | `{}` | `{ windows: [{ id, focused, state, width, height, tabCount }] }` |
| `createWindow` | `{ url?, width?, height?, type? }` | `{ windowId, tabId }` |
| `setViewport` | `{ width, height, deviceScaleFactor?, mobile?, tabId? }` | `{ tabId, width, height }` |
| `resetViewport` | `{ tabId? }` | `{ tabId, reset }` |

---

### 8. Utility (2 commands)

| Method | Params | Response |
|--------|--------|----------|
| `ping` | `{}` | `{ pong, timestamp }` |
| `getExtensionInfo` | `{}` | `{ name, version, manifestVersion, attachedDebuggerTabs, websocketUrl }` |

---

## Events (Extension → Server)

The extension automatically sends notifications when events occur:

| Event | Params | When |
|-------|--------|---------|
| `extensionReady` | `{ name, version, capabilities }` | Extension connected successfully |
| `tabUpdated` | `{ tabId, url, title, status }` | Tab finished loading |
| `tabClosed` | `{ tabId }` | Tab was closed |
| `tabCreated` | `{ tabId, url, windowId }` | New tab was created |
| `tabActivated` | `{ tabId, windowId }` | User switched tabs |
| `cdpEvent` | `{ tabId, method, params }` | CDP event (Network, DOM, etc.) |
| `downloadStarted` | `{ id, url, filename, mime, fileSize }` | Download started |
| `downloadChanged` | `{ id, state, filename, error }` | Download status changed |
| `heartbeat` | `{ timestamp }` | Every 20 seconds |

---

## AI Automation Workflow

AI browser automation flow:

```
1. AI calls getInteractiveElements() -> sees all elements on the page
2. AI analyzes: "I need to click the Search button at (450, 320)"
3. AI calls dispatchClick({ x: 450, y: 320 })
4. AI calls typeText({ text: "hello world" })
5. AI calls pressKey({ key: "Enter" })
6. AI waits for the tabUpdated event -> the new page has loaded
7. AI calls screenshot() -> sees the result
8. AI calls getAccessibilityTree() -> understands the new page structure
9. Repeat...
```

---

## File Structure

```
web-automation-extension/
├── README.md                          # Kit quickstart
├── package.json                       # npm run gateway/health/call/tools:generate
├── server/
│   └── gateway_server.js              # HTTP + WebSocket gateway
├── webmcp-extension/
│   └── dist/                          # Extension files (load into Chrome)
│       ├── manifest.json              # Manifest V3
│       ├── background.js              # WebSocket client + 36 command handlers
│       └── content-scripts/
│           ├── bridge.js              # Isolated-world bridge
│           └── register-tools.js      # 13 WebMCP tools (navigator.modelContext)
├── docs/                              # Documentation
│   ├── codex-extension-analysis.md
│   ├── compatibility-audit.md
│   └── implementation-plan.md
├── skills/                            # Agent skill source (installed globally)
│   └── webmcp-browser-automation/
└── README.md
```

---

## Chrome Permissions

| Permission | Reason |
|------------|-------|
| `activeTab` | Access the current tab |
| `scripting` | Inject content scripts |
| `storage` | Store extension state |
| `debugger` | CDP commands (Runtime.evaluate, Input.dispatch, Accessibility, DOM, Network...) |
| `tabs` | Tab management (query, create, update, remove) |
| `downloads` | Monitor download events |

## Verification

Current registry consistency:
- `npm run tools:generate` rebuilds the source-derived reference from runtime files.
- `npm run tools:check` confirms the generated reference is current and every announced capability has a handler.
- Generated reference lives at `skills/webmcp-browser-automation/references/generated-tools.md`.
