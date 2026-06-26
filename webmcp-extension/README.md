# WebMCP Extension v2.1.0

Chrome extension cho **AI-driven browser automation** qua WebSocket. Cung cấp **34 commands** để AI model có thể điều khiển browser hoàn toàn: nhìn cấu trúc trang, click/type tại tọa độ, quản lý cookies/storage, screenshot...

## Architecture

```
┌─────────────────────────┐         WebSocket          ┌─────────────────────────┐
│  Your AI Program        │ ◀═══════════════════════▶  │  Chrome Extension       │
│  (Python / Node.js)     │    ws://localhost:7865      │  (background.js)        │
│                         │    JSON-RPC 2.0             │                         │
│  Runs WebSocket Server  │                             │  Connects as WS client  │
│  + AI Model integration │  ── Commands ─────────────▶ │  → chrome.debugger      │
│                         │  ◀── Results ──────────────│  → chrome.tabs          │
│                         │  ◀── Events ───────────────│  → chrome.downloads     │
│                         │                             │  → chrome.windows       │
│                         │                             │  → navigator.modelContext│
└─────────────────────────┘                             └─────────────────────────┘
```

## Quick Start

### Step 1: Load Extension vào Chrome

1. Mở Chrome → `chrome://extensions`
2. Bật **Developer mode** (toggle góc trên phải)
3. Click **Load unpacked** → chọn thư mục `dist/`
4. Extension icon xuất hiện trên toolbar

### Step 2: Start WebSocket Server

**Node.js:**
```bash
cd server
npm install       # Lần đầu
node websocket_server.js
```

**Python:**
```bash
cd server
pip install websockets   # Lần đầu
python websocket_server.py
```

Output:
```
============================================================
  WebMCP Tools Provider — WebSocket Server
  Listening on ws://localhost:7865
============================================================
```

### Step 3: Extension tự kết nối

Extension tự connect trong 3 giây. Server sẽ chạy auto-test:
```
✓ Extension connected
✓ Extension ready: WebMCP Tools Provider v2.1.0
    34 capabilities registered
```

---

## Tất cả Commands (34)

Gửi dưới dạng JSON-RPC 2.0 qua WebSocket. Nếu bỏ `tabId`, command sẽ target tab đang active.

### Tab Management (5)

| Method | Params | Mô tả |
|--------|--------|-------|
| `listTabs` | `{}` | Liệt kê tất cả tabs |
| `navigate` | `{ url, tabId? }` | Điều hướng tab đến URL (chờ load xong) |
| `newTab` | `{ url? }` | Mở tab mới |
| `closeTab` | `{ tabId? }` | Đóng tab |
| `getActiveTab` | `{}` | Thông tin tab đang active |

### Page Interaction — JS-based (5)

| Method | Params | Mô tả |
|--------|--------|-------|
| `click` | `{ selector, tabId? }` | Click element bằng CSS selector |
| `type` | `{ selector, text, tabId? }` | Gõ text vào input (React/Vue compatible) |
| `waitForSelector` | `{ selector, timeout?, tabId? }` | Chờ element xuất hiện |
| `getPageContent` | `{ tabId? }` | Lấy title + text + HTML của trang |
| `evaluateJS` | `{ code, tabId? }` | Chạy JavaScript tùy ý |

### CDP — Chrome DevTools Protocol (2)

| Method | Params | Mô tả |
|--------|--------|-------|
| `executeCDP` | `{ method, params?, tabId? }` | Gửi **bất kỳ** lệnh CDP nào |
| `screenshot` | `{ fullPage?, tabId? }` | Chụp screenshot (base64 PNG) |

### WebMCP Tools (2)

| Method | Params | Mô tả |
|--------|--------|-------|
| `webmcp.listTools` | `{ tabId? }` | Liệt kê WebMCP tools trên trang |
| `webmcp.invokeTool` | `{ toolName, input?, tabId? }` | Gọi một WebMCP tool |

### 🆕 AI Vision — Page Structure (4)

AI cần "nhìn" được cấu trúc trang để biết click vào đâu.

| Method | Params | Mô tả |
|--------|--------|-------|
| `getAccessibilityTree` | `{ interestingOnly?, depth?, tabId? }` | Accessibility tree (roles, names, states). AI dùng để hiểu layout |
| `getDOMSnapshot` | `{ computedStyles?, tabId? }` | Full DOM + layout + styles snapshot |
| `getElementBounds` | `{ selector, tabId? }` | Vị trí (bounding box) của elements match selector |
| `getInteractiveElements` | `{ tabId? }` | **⭐ Command quan trọng nhất** — liệt kê TẤT CẢ elements có thể tương tác (buttons, links, inputs...) + vị trí + trạng thái |

**Ví dụ `getInteractiveElements` response:**
```json
{
  "tabId": 123,
  "elements": [
    {
      "index": 0,
      "tag": "a",
      "text": "Learn more",
      "href": "https://example.com/more",
      "bounds": { "x": 200, "y": 180, "width": 100, "height": 20, "centerX": 250, "centerY": 190 }
    },
    {
      "index": 1,
      "tag": "input",
      "type": "text",
      "placeholder": "Search...",
      "bounds": { "x": 300, "y": 50, "width": 200, "height": 30, "centerX": 400, "centerY": 65 }
    }
  ]
}
```

### 🆕 CDP Input Dispatch (7)

Click/type **thật** qua CDP — không bị block bởi anti-bot, hoạt động trên mọi framework.

| Method | Params | Mô tả |
|--------|--------|-------|
| `dispatchClick` | `{ x, y, button?, clickCount?, tabId? }` | Click tại tọa độ (x, y) |
| `moveMouse` | `{ x, y, steps?, fromX?, fromY?, tabId? }` | Di chuyển chuột (mượt, nhiều steps) |
| `pressKey` | `{ key, text?, modifiers?, tabId? }` | Nhấn phím. `modifiers`: `['ctrl','shift','alt','meta']` |
| `typeText` | `{ text, tabId? }` | Gõ text nhanh (CDP `Input.insertText`) |
| `scroll` | `{ deltaX?, deltaY?, x?, y?, tabId? }` | Cuộn trang |
| `hover` | `{ selector, tabId? }` | Hover vào element (CSS selector) |
| `selectOption` | `{ selector, value?, index?, text?, tabId? }` | Chọn option trong `<select>` |

**Special keys cho `pressKey`:**
`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, `Space`

**Keyboard shortcuts:** `{ key: "a", modifiers: ["ctrl"] }` = Ctrl+A

### 🆕 Full Control (9)

| Method | Params | Mô tả |
|--------|--------|-------|
| `getCookies` | `{ tabId? }` | Đọc cookies của trang |
| `setCookie` | `{ name, value, domain?, path?, tabId? }` | Tạo/sửa cookie |
| `deleteCookies` | `{ name, domain?, url?, tabId? }` | Xoá cookie |
| `getLocalStorage` | `{ tabId? }` | Đọc toàn bộ localStorage |
| `setLocalStorage` | `{ key, value, tabId? }` | Ghi localStorage |
| `listWindows` | `{}` | Liệt kê browser windows |
| `createWindow` | `{ url?, width?, height?, type? }` | Tạo window mới |
| `setViewport` | `{ width, height, deviceScaleFactor?, mobile?, tabId? }` | Override viewport (responsive test) |
| `resetViewport` | `{ tabId? }` | Reset viewport về mặc định |

### Utility (2)

| Method | Params | Mô tả |
|--------|--------|-------|
| `ping` | `{}` | Health check |
| `getExtensionInfo` | `{}` | Version + debugger status |

---

## Events (Extension → Server)

Extension tự động gửi notifications:

| Event | Khi nào | Params |
|-------|---------|--------|
| `extensionReady` | Extension kết nối | `{ name, version, capabilities }` |
| `tabUpdated` | Tab load xong | `{ tabId, url, title, status }` |
| `tabClosed` | Tab bị đóng | `{ tabId }` |
| `tabCreated` | Tab mới được tạo | `{ tabId, url, windowId }` |
| `tabActivated` | Chuyển tab | `{ tabId, windowId }` |
| `cdpEvent` | CDP event | `{ tabId, method, params }` |
| `downloadStarted` | Bắt đầu download | `{ id, url, filename, mime, fileSize }` |
| `downloadChanged` | Download state change | `{ id, state, filename, error }` |
| `heartbeat` | Mỗi 20 giây | `{ timestamp }` |

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
    "elements": [{ "tag": "button", "text": "Submit", "bounds": { "centerX": 400, "centerY": 300 } }]
  }
}
```

### Receive event (no id):
```json
{
  "jsonrpc": "2.0",
  "method": "tabUpdated",
  "params": { "tabId": 123, "url": "https://google.com", "title": "Google", "status": "complete" }
}
```

---

## AI Automation Workflow

```python
# 1. AI nhìn trang
elements = send("getInteractiveElements")
# → [{ tag: "input", placeholder: "Search", bounds: { centerX: 400, centerY: 65 } }, ...]

# 2. AI click vào search box
send("dispatchClick", { x: 400, y: 65 })

# 3. AI gõ text
send("typeText", { text: "hello world" })

# 4. AI nhấn Enter
send("pressKey", { key: "Enter" })

# 5. Chờ trang load (nhận tabUpdated event)
# 6. AI chụp screenshot để xem kết quả
send("screenshot")

# 7. AI đọc cấu trúc trang mới
send("getAccessibilityTree")

# Lặp lại...
```

---

## 10 Built-in WebMCP Tools

Tự động inject vào mỗi trang qua `navigator.modelContext`:

| # | Tool | Mô tả |
|---|------|-------|
| 1 | `get_page_metadata` | Title, meta tags, OG data, headings |
| 2 | `query_selector_all` | Tìm elements bằng CSS selector |
| 3 | `click_element` | Click element (+ scroll into view) |
| 4 | `fill_form_field` | Set giá trị input/textarea/select |
| 5 | `extract_table_data` | Extract bảng HTML → JSON |
| 6 | `wait_for_element` | Chờ element xuất hiện (MutationObserver) |
| 7 | `get_computed_styles` | Đọc CSS computed styles |
| 8 | `scroll_page` | Cuộn trang (top/bottom/element/delta) |
| 9 | `submit_form` | Fill nhiều fields + submit form |
| 10 | `execute_javascript` | Chạy JS tùy ý trong page context |

---

## Project Structure

```
webmcp-extension/
├── dist/                              # ← Load thư mục này vào Chrome
│   ├── manifest.json                  # Manifest V3 (permissions: debugger, tabs, downloads...)
│   ├── background.js                  # WebSocket client + 34 command handlers
│   ├── content-scripts/
│   │   └── register-tools.js          # Inject 10 WebMCP tools vào mỗi trang
│   └── icons/
├── server/                            # WebSocket server examples
│   ├── websocket_server.js            # Node.js server (with auto-test demo)
│   ├── websocket_server.py            # Python server alternative
│   └── package.json
├── docs/                              # Documentation
│   ├── codex-extension-analysis.md    # Phân tích Codex extension v1.1.5
│   ├── compatibility-audit.md         # So sánh với Codex
│   └── implementation-plan.md         # Chi tiết implementation
├── .agents/skills/                    # AI skills cho Gemini/Antigravity
│   └── webmcp-browser-automation/
└── README.md                          # File này
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

| Vấn đề | Giải pháp |
|---------|-----------|
| `ERR_CONNECTION_REFUSED` | Start WebSocket server trước. Extension auto-reconnect mỗi 3s. |
| `Another debugger is already attached` | Đóng extension khác (Codex) hoặc dùng tab khác. |
| `navigator.modelContext not found` | Trang chưa load. Dùng `waitForSelector` trước. Hoặc reload extension. |
| WebMCP tools không xuất hiện | Extension chưa load hoặc trang là `chrome://` URL. |
| Server không nhận connection | Kiểm tra extension đã load. Thử reload tại `chrome://extensions`. |
| `getAccessibilityTree` trả về ít nodes | Dùng `interestingOnly: false` để lấy tất cả nodes. |

## Documentation

- [Codex Extension Analysis](docs/codex-extension-analysis.md) — Cách Codex extension hoạt động
- [Implementation Plan](docs/implementation-plan.md) — Chi tiết thiết kế và tất cả commands
- [Compatibility Audit](docs/compatibility-audit.md) — So sánh với Codex v1.1.5
