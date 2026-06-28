# Implementation Plan — WebSocket Communication Layer

## Current Problem

The current extension is only **passive**: it places tools on `navigator.modelContext` and
waits for Codex to read them. You want **your program** (running its own AI model) to
communicate directly with the extension and issue browser commands.

## How Codex Works (Analyzed)

```
Codex Host App ←──── Native Messaging (chrome.runtime.connectNative) ────→ Codex Extension
                     Protocol: JSON-RPC 2.0
                     App Name: "com.openai.codexextension"
```

Codex uses **Native Messaging**, which requires installing a native app on the machine and
is more complex. We will use **WebSocket** instead, which is simpler and cross-platform.

## New Architecture

```
┌─────────────────────────┐         WebSocket          ┌─────────────────────────┐
│  Your AI Program        │ ◀═══════════════════════▶  │  Extension              │
│  (Python / Node.js)     │    ws://localhost:7865      │  (background.js)        │
│                         │    JSON-RPC 2.0             │                         │
│  ┌───────────────────┐  │                             │  ┌───────────────────┐  │
│  │ AI Model (GPT/    │  │  ── Request ──────────────▶ │  │ Command Router    │  │
│  │ Claude/Gemini)    │  │  { method: "executeCDP",    │  │                   │  │
│  │                   │  │    params: {...}, id: 1 }   │  │ ┌───────────────┐ │  │
│  │ Decides action ───┼──┤                             │  │ │chrome.debugger│ │  │
│  │                   │  │  ◀── Response ────────────  │  │ │.sendCommand() │ │  │
│  │ Gets result ◀─────┼──┤  { result: {...}, id: 1 }  │  │ └───────────────┘ │  │
│  └───────────────────┘  │                             │  │ ┌───────────────┐ │  │
│                         │  ── Notification ─────────▶ │  │ │chrome.tabs    │ │  │
│  WebSocket Server       │  { method: "navigate",      │  │ │chrome.scripting│ │  │
│  on port 7865           │    params: {url: "..."} }   │  │ └───────────────┘ │  │
└─────────────────────────┘                             └─────────────────────────┘
```

## Protocol: JSON-RPC 2.0 (Like Codex)

### Request (AI Program → Extension)
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "navigate",
  "params": { "url": "https://google.com" }
}
```

### Response (Extension → AI Program)
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "tabId": 123, "url": "https://google.com", "title": "Google" }
}
```

### Error Response
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -1, "message": "Tab not found" }
}
```

### Event/Notification (Extension → AI Program, no id)
```json
{
  "jsonrpc": "2.0",
  "method": "onPageLoaded",
  "params": { "tabId": 123, "url": "https://google.com" }
}
```

---

## Proposed Commands (Methods)

### Tab Management
| Method | Params | Description |
|--------|--------|-------------|
| `listTabs` | `{}` | List all open tabs |
| `navigate` | `{ url, tabId? }` | Navigate a tab to URL |
| `newTab` | `{ url? }` | Open a new tab |
| `closeTab` | `{ tabId }` | Close a tab |
| `getActiveTab` | `{}` | Get the current active tab info |

### Page Interaction (via CDP)
| Method | Params | Description |
|--------|--------|-------------|
| `evaluateJS` | `{ tabId, code }` | Execute JS in the page and return result |
| `executeCDP` | `{ tabId, method, params }` | Send raw CDP command |
| `screenshot` | `{ tabId, fullPage? }` | Take a screenshot (returns base64) |

### WebMCP Tools (via page JS)
| Method | Params | Description |
|--------|--------|-------------|
| `webmcp.listTools` | `{ tabId }` | List registered WebMCP tools on the page |
| `webmcp.invokeTool` | `{ tabId, toolName, input }` | Invoke a WebMCP tool |

### High-Level Actions
| Method | Params | Description |
|--------|--------|-------------|
| `click` | `{ tabId, selector }` | Click an element |
| `type` | `{ tabId, selector, text }` | Type text into an element |
| `waitForSelector` | `{ tabId, selector, timeout? }` | Wait for element to appear |
| `getPageContent` | `{ tabId }` | Get page text content |

---

## Proposed Changes

### [MODIFY] manifest.json

Add `debugger` permission (needed for CDP) and update description.

```diff
  "permissions": [
    "activeTab",
    "scripting",
-   "storage"
+   "storage",
+   "debugger",
+   "tabs"
  ],
```

---

### [MODIFY] background.js — Complete Rewrite

The background service worker will:
1. Connect to a local WebSocket server (your AI program) on `ws://localhost:7865`
2. Listen for JSON-RPC commands
3. Execute them via `chrome.debugger`, `chrome.tabs`, `chrome.scripting`
4. Return results back over WebSocket

Key sections:
- **WebSocket Client** — connects to your server, auto-reconnects
- **Command Router** — dispatches JSON-RPC methods to handlers
- **CDP Bridge** — attaches `chrome.debugger` to tabs and sends CDP commands
- **Tab Manager** — wraps `chrome.tabs` API
- **WebMCP Bridge** — evaluates `navigator.modelContext` in pages

---

### [NEW] server/websocket-server.py — Example AI Server

A Python example showing how your AI program:
1. Starts a WebSocket server on `ws://localhost:7865`
2. Sends commands to the extension
3. Receives results
4. Integrates with an AI model (OpenAI/Anthropic API)

---

### [NEW] server/websocket-server.js — Node.js Alternative

Same as above but in Node.js.

---

## Open Questions

> [!IMPORTANT]
> 1. **Port number**: Default is `7865`. Do you want a different port?
> 2. **AI model**: Which AI model do you use? OpenAI GPT, Anthropic Claude, Google Gemini, or a local model? This determines the right server example.
> 3. **Reconnect behavior**: Should the extension automatically reconnect when it loses the WebSocket connection? I recommend yes, every 3 seconds.

## Verification Plan

### Manual Verification
1. Start the Python/Node WebSocket server
2. Load extension into Chrome
3. Server sends `{ method: "listTabs", id: 1 }` -> extension returns the tab list
4. Server sends `{ method: "navigate", params: { url: "https://google.com" }, id: 2 }` -> tab opens Google
5. Server sends `{ method: "evaluateJS", params: { code: "document.title" }, id: 3 }` -> returns "Google"
6. Server sends `{ method: "webmcp.listTools", id: 4 }` -> returns the tool list
7. Server sends `{ method: "webmcp.invokeTool", params: { toolName: "get_page_metadata" }, id: 5 }` -> returns metadata
