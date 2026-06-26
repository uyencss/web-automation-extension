# Implementation Plan — WebMCP Extension v2.1.0

## Tổng quan

Extension cung cấp **AI-driven browser automation** qua WebSocket. Gateway server nhận lệnh HTTP từ agent/scripts, chuyển tiếp JSON-RPC 2.0 qua WebSocket tới extension để điều khiển browser.

## Kiến trúc

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

## Tất cả Commands (36 total)

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

> `executeCDP` là passthrough — có thể gửi **bất kỳ lệnh CDP nào** (e.g., `DOM.getDocument`, `Network.enable`, `Runtime.evaluate`).

---

### 4. WebMCP Tools (2 commands)

| Method | Params | Response |
|--------|--------|----------|
| `webmcp.listTools` | `{ tabId? }` | `{ tabId, tools: [...] }` |
| `webmcp.invokeTool` | `{ toolName, input?, tabId? }` | `{ tabId, result }` |

---

### 5. 🆕 Phase 1: AI Vision (4 commands)

Cho phép AI "nhìn" cấu trúc trang, biết được các elements có thể tương tác và vị trí của chúng.

| Method | Params | Response |
|--------|--------|----------|
| `getAccessibilityTree` | `{ interestingOnly?, depth?, tabId? }` | `{ tabId, nodeCount, nodes: [{ nodeId, role, name, value, disabled, focused, checked, backendDOMNodeId }] }` |
| `getDOMSnapshot` | `{ computedStyles?, tabId? }` | `{ tabId, documents: [...], strings: [...] }` |
| `getElementBounds` | `{ selector, tabId? }` | `{ tabId, elements: [{ index, tag, id, text, bounds: { x, y, width, height, centerX, centerY }, visible }] }` |
| `getInteractiveElements` | `{ tabId? }` | `{ tabId, elements: [{ index, tag, type, id, name, role, ariaLabel, text, href, value, checked, disabled, bounds }] }` |

**Giải thích:**
- `getAccessibilityTree` — Dùng CDP `Accessibility.getFullAXTree`. Trả về cây accessibility đã lọc (chỉ nodes có ý nghĩa: buttons, links, inputs, headings...). AI dùng để hiểu cấu trúc trang.
- `getDOMSnapshot` — Dùng CDP `DOMSnapshot.captureSnapshot`. Trả về full DOM + layout + styles. Nặng nhưng đầy đủ.
- `getElementBounds` — Trả về vị trí (bounding box) của tất cả elements match selector. AI dùng để biết click vào đâu.
- `getInteractiveElements` — Liệt kê TẤT CẢ elements có thể tương tác (a, button, input, select, textarea, [role=button]...) + vị trí + trạng thái. **Command quan trọng nhất cho AI.**

---

### 6. 🆕 Phase 2: CDP Input Dispatch (7 commands)

Click/type thật qua CDP — không bị block bởi anti-bot, hoạt động trên mọi framework (React, Vue, Angular).

| Method | Params | Response |
|--------|--------|----------|
| `dispatchClick` | `{ x, y, button?, clickCount?, tabId? }` | `{ tabId, clicked, x, y, button }` |
| `moveMouse` | `{ x, y, steps?, fromX?, fromY?, tabId? }` | `{ tabId, x, y }` |
| `pressKey` | `{ key, text?, modifiers?, tabId? }` | `{ tabId, key, modifiers }` |
| `typeText` | `{ text, tabId? }` | `{ tabId, typed }` |
| `scroll` | `{ deltaX?, deltaY?, x?, y?, tabId? }` | `{ tabId, deltaX, deltaY }` |
| `hover` | `{ selector, tabId? }` | `{ tabId, x, y, selector }` |
| `selectOption` | `{ selector, value?, index?, text?, tabId? }` | `{ tabId, success, value, text }` |

**Giải thích:**
- `dispatchClick` — Click tại tọa độ (x, y) qua CDP `Input.dispatchMouseEvent`. Kết hợp với `getInteractiveElements` để biết tọa độ.
- `moveMouse` — Di chuyển chuột mượt (nhiều steps). Dùng cho hover effects, tooltips.
- `pressKey` — Nhấn phím. Hỗ trợ `modifiers: ['ctrl', 'shift', 'alt', 'meta']` cho shortcuts (Ctrl+C, Ctrl+A...). Hỗ trợ special keys: Enter, Tab, Escape, Backspace, Arrow keys, etc.
- `typeText` — Gõ text nhanh qua CDP `Input.insertText`. Không cần focus trước.
- `scroll` — Cuộn trang bằng mouse wheel event.
- `hover` — Hover vào element (dùng CSS selector). Tự scroll-into-view trước.
- `selectOption` — Chọn option trong `<select>` dropdown.

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

Extension tự động gửi notifications khi có sự kiện:

| Event | Params | Khi nào |
|-------|--------|---------|
| `extensionReady` | `{ name, version, capabilities }` | Extension kết nối thành công |
| `tabUpdated` | `{ tabId, url, title, status }` | Tab load xong |
| `tabClosed` | `{ tabId }` | Tab bị đóng |
| `tabCreated` | `{ tabId, url, windowId }` | Tab mới được tạo |
| `tabActivated` | `{ tabId, windowId }` | Người dùng chuyển tab |
| `cdpEvent` | `{ tabId, method, params }` | CDP event (Network, DOM, etc.) |
| `downloadStarted` | `{ id, url, filename, mime, fileSize }` | Bắt đầu download |
| `downloadChanged` | `{ id, state, filename, error }` | Download thay đổi trạng thái |
| `heartbeat` | `{ timestamp }` | Mỗi 20 giây |

---

## AI Automation Workflow

Quy trình AI tự động hoá browser:

```
1. AI gọi getInteractiveElements() → biết được tất cả elements trên trang
2. AI phân tích: "Tôi cần click vào nút Search tại (450, 320)"
3. AI gọi dispatchClick({ x: 450, y: 320 })
4. AI gọi typeText({ text: "hello world" })
5. AI gọi pressKey({ key: "Enter" })
6. AI chờ tabUpdated event → trang mới đã load
7. AI gọi screenshot() → xem kết quả
8. AI gọi getAccessibilityTree() → hiểu cấu trúc trang mới
9. Lặp lại...
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
│   └── dist/                          # Extension files (load vào Chrome)
│       ├── manifest.json              # Manifest V3
│       ├── background.js              # WebSocket client + 36 command handlers
│       └── content-scripts/
│           ├── bridge.js              # Isolated-world bridge
│           └── register-tools.js      # 13 WebMCP tools (navigator.modelContext)
├── docs/                              # Documentation
│   ├── codex-extension-analysis.md
│   ├── compatibility-audit.md
│   └── implementation-plan.md
├── .agents/skills/                    # AI skills for Gemini/Antigravity
│   └── webmcp-browser-automation/
└── README.md
```

---

## Chrome Permissions

| Permission | Lý do |
|------------|-------|
| `activeTab` | Truy cập tab hiện tại |
| `scripting` | Inject content scripts |
| `storage` | Lưu extension state |
| `debugger` | CDP commands (Runtime.evaluate, Input.dispatch, Accessibility, DOM, Network...) |
| `tabs` | Tab management (query, create, update, remove) |
| `downloads` | Monitor download events |

## Verification

Current registry consistency:
- `npm run tools:generate` rebuilds the source-derived reference from runtime files.
- `npm run tools:check` confirms the generated reference is current and every announced capability has a handler.
- Generated reference lives at `.agents/skills/webmcp-browser-automation/references/generated-tools.md`.
