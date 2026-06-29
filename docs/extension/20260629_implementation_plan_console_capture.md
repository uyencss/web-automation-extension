# Implementation Plan — Console Capture (Extension-Level)

**Date:** 2026-06-29  
**Reference:** Claude Chrome Extension `read_console_messages` analysis  
**Scope:** Extension-level console capture, exposed as JSON-RPC commands  

---

## Problem

WebMCP hiện **không có cách nào** để AI đọc browser console output (`console.log`, `console.error`, `console.warn`, etc.) từ một tab. Đây là gap so với Claude Chrome Extension (v1.0.77) có tool `read_console_messages`.

**Use cases:**
1. **Debug JS errors** — AI click button → trang lỗi → đọc console errors → fix
2. **Monitor app logs** — SPA apps thường log state changes ra console
3. **Verify automation** — Sau khi inject script, kiểm tra console output
4. **Catch uncaught exceptions** — `Runtime.exceptionThrown` events

---

## Design Decisions

### D1: Extension-level command (không phải Page Tool)

Console capture sẽ là **extension-level command** (như `click`, `navigate`), **không phải** Page Tool (navigator.modelContext).

**Lý do:**
- Console messages cần CDP `Runtime.enable` → chỉ background SW có quyền
- Page Tools chạy trong content script context → không access được CDP
- Giữ nhất quán: network capture hiện tại cũng dùng CDP ở background

### D2: Manual start/stop (giống network capture)

Chọn approach **manual** thay vì **auto** (Claude style):

| Aspect | Auto (Claude) | Manual (chọn) |
|---|---|---|
| Memory | Luôn tốn | Chỉ khi cần |
| Debugger attach | Luôn attach mọi tab | Chỉ tab đang dùng |
| Overhead | Cao | Zero khi không dùng |
| Privacy | Ghi mọi thứ | Chỉ khi AI bật |

**Consistency:** Giống pattern `start_network_capture` / `stop_network_capture` đang có.

### D3: Tách module mới `console-capture.js`

Tạo file mới thay vì nhét vào `network-intercept.js`:
- Single responsibility
- Dễ test độc lập
- Giống pattern: 1 handler file = 1 concern

---

## Proposed Changes

### Component 1: Console Capture Handler

#### [NEW] `webmcp-extension/dist/bg/handlers/console-capture.js`

Module mới, follow cùng pattern với `network-intercept.js`:

**Data structures:**

```javascript
const MAX_MESSAGES_PER_SESSION = 500;

// tabId -> {
//   messages: ConsoleMessage[],   // ring buffer
//   filters: { level?, pattern? },
//   startedAt: number,
// }
const consoleSessions = new Map();

// ConsoleMessage = {
//   id: number,
//   level: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'exception',
//   text: string,
//   url: string,         // source URL
//   lineNumber: number,
//   columnNumber: number,
//   timestamp: number,   // Date.now()
//   stackTrace?: string, // for errors/exceptions
// }
```

**4 exported commands:**

| Command | Params | Description |
|---|---|---|
| `startConsoleCapture` | `tabId` | Bật Runtime.enable + đăng ký listener |
| `stopConsoleCapture` | `tabId` | Dọn session + Runtime.disable |
| `readConsoleMessages` | `tabId, { level?, pattern?, limit?, since? }` | Đọc messages đã capture |
| `clearConsoleMessages` | `tabId` | Xóa buffer, giữ session |

**CDP events cần listen:**

```
Runtime.consoleAPICalled  → console.log/warn/error/info/debug
Runtime.exceptionThrown   → uncaught exceptions + promise rejections
```

**Implementation pseudocode:**

```javascript
import { ensureDebuggerAttached, sendCDPCommand } from '../cdp-bridge.js';

const MAX_MESSAGES_PER_SESSION = 500;
const consoleSessions = new Map();
let messageIdCounter = 0;

// ─── Public command handlers ─────────────────────────────────

export async function startConsoleCapture(tabId) {
  if (consoleSessions.has(tabId)) {
    return { success: true, already_running: true };
  }
  await ensureDebuggerAttached(tabId);
  await sendCDPCommand(tabId, 'Runtime.enable', {});

  consoleSessions.set(tabId, {
    messages: [],
    startedAt: Date.now(),
  });
  return { success: true };
}

export async function stopConsoleCapture(tabId) {
  const session = consoleSessions.get(tabId);
  if (!session) return { success: true, was_running: false };

  consoleSessions.delete(tabId);
  try {
    await sendCDPCommand(tabId, 'Runtime.disable', {});
  } catch {
    // tab may be gone
  }
  return { success: true, was_running: true, captured_count: session.messages.length };
}

export async function readConsoleMessages(tabId, {
  level,          // 'log' | 'warn' | 'error' | 'info' | 'debug' | 'exception'
  pattern,        // substring match against message text
  limit = 100,    // max messages to return
  since,          // timestamp — only messages after this time
  clear = false,  // clear returned messages after reading (consume semantics)
} = {}) {
  const session = consoleSessions.get(tabId);
  if (!session) {
    throw new Error('Console capture not started. Call startConsoleCapture first.');
  }

  let results = session.messages;

  // Apply filters
  if (level) {
    results = results.filter(m => m.level === level);
  }
  if (pattern) {
    results = results.filter(m => m.text.includes(pattern));
  }
  if (since) {
    results = results.filter(m => m.timestamp >= since);
  }

  // Newest first, apply limit
  const output = results.slice(-limit);

  if (clear) {
    // Remove returned messages from buffer
    const ids = new Set(output.map(m => m.id));
    session.messages = session.messages.filter(m => !ids.has(m.id));
  }

  return {
    count: output.length,
    total_buffered: session.messages.length,
    capture_started_at: session.startedAt,
    messages: output,
  };
}

export async function clearConsoleMessages(tabId) {
  const session = consoleSessions.get(tabId);
  if (!session) {
    throw new Error('Console capture not started. Call startConsoleCapture first.');
  }
  const cleared = session.messages.length;
  session.messages = [];
  return { success: true, cleared_count: cleared };
}

// ─── CDP event hook ──────────────────────────────────────────

function handleCDPEvent(source, method, params) {
  const tabId = source.tabId;
  const session = consoleSessions.get(tabId);
  if (!session) return;

  if (method === 'Runtime.consoleAPICalled') {
    const args = params.args || [];
    // Serialize RemoteObject args to readable text
    const text = args.map(arg => {
      if (arg.type === 'string') return arg.value;
      if (arg.type === 'number' || arg.type === 'boolean') return String(arg.value);
      if (arg.type === 'undefined') return 'undefined';
      if (arg.subtype === 'null') return 'null';
      if (arg.type === 'object') return arg.description || JSON.stringify(arg.preview) || '[object]';
      return arg.description || String(arg.value ?? '');
    }).join(' ');

    const entry = {
      id: ++messageIdCounter,
      level: params.type || 'log',  // log, warn, error, info, debug, etc.
      text,
      url: params.stackTrace?.callFrames?.[0]?.url || '',
      lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber ?? -1,
      columnNumber: params.stackTrace?.callFrames?.[0]?.columnNumber ?? -1,
      timestamp: Date.now(),
    };

    session.messages.push(entry);
    // Ring buffer eviction
    if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
      session.messages.shift();
    }
  }

  if (method === 'Runtime.exceptionThrown') {
    const detail = params.exceptionDetails || {};
    const exc = detail.exception || {};
    const text = exc.description || detail.text || 'Unknown exception';

    const entry = {
      id: ++messageIdCounter,
      level: 'exception',
      text,
      url: detail.url || '',
      lineNumber: detail.lineNumber ?? -1,
      columnNumber: detail.columnNumber ?? -1,
      timestamp: Date.now(),
      stackTrace: detail.stackTrace
        ? detail.stackTrace.callFrames.map(f =>
            `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`
          ).join('\n')
        : undefined,
    };

    session.messages.push(entry);
    if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
      session.messages.shift();
    }
  }
}

// Register once — IMPORTANT: shares chrome.debugger.onEvent with network-intercept.js
// The existing listener in events.js forwards ALL CDP events, so we hook into it.
chrome.debugger.onEvent.addListener(handleCDPEvent);

// Cleanup on debugger detach
chrome.debugger.onDetach.addListener((source) => {
  consoleSessions.delete(source.tabId);
});
```

---

### Component 2: Handler Registration

#### [MODIFY] `webmcp-extension/dist/bg/handlers/index.js`

Thêm import và spread console capture handlers:

```diff
 import { pageStabilityHandlers } from './page-stability.js';
 import { frameManagementHandlers } from './frame-management.js';
+import { consoleCaptureHandlers } from './console-capture.js';

 export const commandHandlers = {
   ...tabHandlers,
   ...frameManagementHandlers,
   ...cdpActionHandlers,
   ...highLevelHandlers,
   ...webmcpHandlers,
   ...aiVisionHandlers,
   ...cdpInputHandlers,
   ...fullControlHandlers,
   ...ariaSnapshotHandlers,
   ...pageStabilityHandlers,
+  ...consoleCaptureHandlers,
 };
```

**Note:** `console-capture.js` phải export:
```javascript
export const consoleCaptureHandlers = {
  startConsoleCapture: (params) => startConsoleCapture(resolveTabId(params), params),
  stopConsoleCapture:  (params) => stopConsoleCapture(resolveTabId(params), params),
  readConsoleMessages: (params) => readConsoleMessages(resolveTabId(params), params),
  clearConsoleMessages:(params) => clearConsoleMessages(resolveTabId(params), params),
};
```

Cần follow cùng pattern `resolveTabId` như các handler khác (lấy active tab nếu không truyền `tabId`).

---

### Component 3: Capability Advertisement

#### [MODIFY] `webmcp-extension/dist/bg/ws-client.js`

Thêm 4 commands mới vào `capabilities` array trong `extensionReady` handshake:

```diff
         // Utility
         'ping', 'getExtensionInfo',
+        // Console Observability
+        'startConsoleCapture', 'stopConsoleCapture',
+        'readConsoleMessages', 'clearConsoleMessages',
       ],
```

---

## API Reference

### `startConsoleCapture`

Bắt đầu capture console messages từ một tab.

```json
{
  "method": "startConsoleCapture",
  "params": { "tabId": 123 }
}
```

**Response:**
```json
{ "success": true }
```

**Side effects:**
- Attaches debugger nếu chưa attached
- Enables CDP `Runtime` domain
- Bắt đầu buffer `consoleAPICalled` và `exceptionThrown` events

---

### `stopConsoleCapture`

Dừng capture và dọn buffer.

```json
{
  "method": "stopConsoleCapture",
  "params": { "tabId": 123 }
}
```

**Response:**
```json
{ "success": true, "was_running": true, "captured_count": 42 }
```

---

### `readConsoleMessages`

Đọc console messages đã capture, với filter tùy chọn.

```json
{
  "method": "readConsoleMessages",
  "params": {
    "tabId": 123,
    "level": "error",
    "pattern": "TypeError",
    "limit": 50,
    "since": 1719654321000,
    "clear": false
  }
}
```

**All params are optional** (trừ tabId).

**Response:**
```json
{
  "count": 3,
  "total_buffered": 42,
  "capture_started_at": 1719654300000,
  "messages": [
    {
      "id": 17,
      "level": "error",
      "text": "TypeError: Cannot read property 'foo' of undefined",
      "url": "https://example.com/app.js",
      "lineNumber": 142,
      "columnNumber": 15,
      "timestamp": 1719654321500
    },
    {
      "id": 23,
      "level": "exception",
      "text": "Uncaught ReferenceError: bar is not defined",
      "url": "https://example.com/utils.js",
      "lineNumber": 55,
      "columnNumber": 3,
      "timestamp": 1719654322100,
      "stackTrace": "  at onClick (https://example.com/utils.js:55:3)\n  at HTMLButtonElement.<anonymous> (https://example.com/app.js:200:10)"
    }
  ]
}
```

---

### `clearConsoleMessages`

Xóa buffer, giữ session chạy.

```json
{
  "method": "clearConsoleMessages",
  "params": { "tabId": 123 }
}
```

---

## Typical AI Workflow

```
AI: startConsoleCapture { tabId: 123 }
AI: click { selector: "#submit-btn" }
AI: waitForStable {}
AI: readConsoleMessages { tabId: 123, level: "error" }
    → Thấy "TypeError: Cannot read property 'email' of null"
AI: evaluateJS { expression: "document.querySelector('#email-input').value" }
    → Hiểu form field chưa được fill
AI: type { selector: "#email-input", text: "user@example.com" }
AI: click { selector: "#submit-btn" }
AI: readConsoleMessages { tabId: 123, level: "error", since: <timestamp> }
    → Không có error mới → success
AI: stopConsoleCapture { tabId: 123 }
```

---

## File Change Summary

| File | Action | Lines (est.) |
|---|---|---|
| `dist/bg/handlers/console-capture.js` | **NEW** | ~180 |
| `dist/bg/handlers/index.js` | MODIFY | +2 |
| `dist/bg/ws-client.js` | MODIFY | +3 |

**Total:** ~185 lines new code, 5 lines modified.

---

## Edge Cases & Safety

| Case | Handling |
|---|---|
| Tab closed while capturing | `chrome.debugger.onDetach` → auto cleanup session |
| Debugger already attached | `ensureDebuggerAttached` handles (reuse existing) |
| `Runtime.enable` conflicts with other CDP users | OK — Runtime.enable is additive, calling twice is safe |
| Ring buffer overflow (>500 messages) | Oldest messages evicted (FIFO shift) |
| Multiple tabs capturing simultaneously | Each has own session in `consoleSessions` Map |
| `readConsoleMessages` without `startConsoleCapture` | Throws clear error message |
| `stopConsoleCapture` on non-captured tab | Returns `{ was_running: false }` gracefully |
| RemoteObject serialization (complex objects) | Use `description` or `preview`, fallback to `[object]` |

---

## Verification Plan

### Automated

```bash
# 1. Build extension (nếu có build step)
cd webmcp-extension && npm run build

# 2. Load extension → open any page
# 3. From AI client:
startConsoleCapture { "tabId": <id> }
evaluateJS { "expression": "console.log('hello'); console.error('fail'); console.warn('caution')" }
readConsoleMessages { "tabId": <id> }
# Expected: 3 messages with levels log, error, warn

# 4. Test exception capture:
evaluateJS { "expression": "throw new Error('test exception')" }
readConsoleMessages { "tabId": <id>, "level": "exception" }
# Expected: 1 exception with stackTrace

# 5. Test filtering:
readConsoleMessages { "tabId": <id>, "level": "error", "pattern": "fail" }
# Expected: 1 message

# 6. Test clear:
clearConsoleMessages { "tabId": <id> }
readConsoleMessages { "tabId": <id> }
# Expected: count = 0

# 7. Test stop:
stopConsoleCapture { "tabId": <id> }
# Expected: { was_running: true, captured_count: 0 }
```

### Manual

- Load extension trên YouTube → startConsoleCapture → verify bắt được các console messages từ page
- Open page with JS errors → verify `exception` level entries có stack traces
- Test ring buffer: generate >500 messages → verify oldest được evict
