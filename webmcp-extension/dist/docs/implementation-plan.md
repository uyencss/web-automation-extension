# Implementation Plan — WebSocket Communication Layer

## Vấn đề hiện tại

Extension hiện tại chỉ **passive** — đặt tools lên `navigator.modelContext` và chờ Codex đọc. Nhưng bạn muốn **chương trình của bạn** (chạy AI model riêng) giao tiếp trực tiếp với extension để ra lệnh cho browser.

## Cách Codex làm (đã phân tích)

```
Codex Host App ←──── Native Messaging (chrome.runtime.connectNative) ────→ Codex Extension
                     Protocol: JSON-RPC 2.0
                     App Name: "com.openai.codexextension"
```

Codex dùng **Native Messaging** — yêu cầu cài native app lên máy, phức tạp. Chúng ta sẽ dùng **WebSocket** — đơn giản hơn, cross-platform.

## Kiến trúc mới

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

## Protocol: JSON-RPC 2.0 (giống Codex)

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
> 1. **Port number**: Mặc định `7865`. Bạn muốn port khác không?
> 2. **AI model**: Bạn dùng AI model nào? (OpenAI GPT, Anthropic Claude, Google Gemini, local model?) Để tôi tạo server example phù hợp.
> 3. **Reconnect behavior**: Khi extension mất kết nối WebSocket, tự động reconnect? (Tôi đề xuất: có, mỗi 3 giây)

## Verification Plan

### Manual Verification
1. Start the Python/Node WebSocket server
2. Load extension into Chrome
3. Server gửi `{ method: "listTabs", id: 1 }` → extension trả về danh sách tab
4. Server gửi `{ method: "navigate", params: { url: "https://google.com" }, id: 2 }` → tab mở Google
5. Server gửi `{ method: "evaluateJS", params: { code: "document.title" }, id: 3 }` → trả về "Google"
6. Server gửi `{ method: "webmcp.listTools", id: 4 }` → trả về danh sách tools
7. Server gửi `{ method: "webmcp.invokeTool", params: { toolName: "get_page_metadata" }, id: 5 }` → trả về metadata
