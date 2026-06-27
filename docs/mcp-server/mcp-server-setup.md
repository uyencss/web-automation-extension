# Guide — Chạy & Setup MCP Server (WebMCP Browser)

> File này hướng dẫn chạy MCP server sau khi đã implement theo
> [mcp-server-plan.md](./mcp-server-plan.md). MCP server cho phép Claude Desktop,
> Cursor, Claude Code... điều khiển Chrome thật (đã login) qua extension.

## 0. Mô hình chạy — cần 3 thứ cùng lúc

```
[1] Chrome + extension đã load   →  connect tới  →  [2] Gateway (ws://localhost:7865)
                                                          ▲ HTTP /api
[3] MCP server (stdio)  ──────────────────────────────────┘
        ▲ stdio
   MCP client (Claude Desktop / Cursor / Claude Code)
```

- **[1] và [2]** luôn phải chạy (như hiện tại).
- **[3]** thường **do MCP client tự spawn** — bạn KHÔNG chạy tay. Bạn chỉ cần khai báo
  lệnh chạy nó trong file config của client.

## 1. Chuẩn bị một lần — cài bằng MỘT lệnh theo runtime

Nếu bạn chỉ muốn dùng package release từ npm, cấu hình MCP client bằng:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "npx",
      "args": ["-y", "@gyga-browser/webmcp-browser-automation-kit", "mcp"]
    }
  }
}
```

Và chạy gateway bằng package release:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit gateway start
```

Các lệnh dưới đây dành cho local development từ checkout này.

Mỗi lệnh dưới đây tự `npm run setup` (cài deps gồm MCP SDK) **rồi** cài skill + ghi/in
cấu hình MCP cho đúng runtime. Cuối cùng luôn in reminder phải chạy gateway trước.

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension

npm run install:claude        # Claude Code  — copy skill -> ~/.claude/skills + `claude mcp add -s user`
npm run install:codex         # Codex        — copy skill -> ~/.codex/skills + thêm MCP vào ~/.codex/config.toml
npm run install:copilot       # GitHub Copilot (VS Code) — in snippet MCP global để dán
npm run install:antigravity   # Antigravity  — in snippet MCP để dán
npm run install:cursor        # Cursor       — ghi ~/.cursor/mcp.json (global)
npm run install:agent         # (không target) in cấu hình cho TẤT CẢ runtime
```

Hoặc chỉ cài deps thủ công, tự cấu hình client sau:

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension
npm run setup                       # cài deps cho server (gồm @modelcontextprotocol/sdk)
```

Load extension: `chrome://extensions` → Developer mode → Load unpacked → chọn
`webmcp-extension/dist`.

## 2. Chạy hub (gateway) — luôn cần

```bash
npm run gateway
```

Kỳ vọng log: `Extension is ready ... capabilities registered`. Cứ để terminal này chạy.

## 3. Tự test MCP server trước khi gắn client

```bash
npx @modelcontextprotocol/inspector node server/mcp_server.mjs
```

Mở UI Inspector → tab **Tools** → bấm `ping` → ra `{ "ok": true }` là MCP server OK.
(Bước này không bắt buộc nhưng nên làm để tách lỗi.)

## 4. Cấu hình từng client

Local dev dùng đường dẫn tuyệt đối tới server:
`/Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/server/mcp_server.mjs`

Với package release trên npm, dùng dạng portable:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "npx",
      "args": ["-y", "@gyga-browser/webmcp-browser-automation-kit", "mcp"]
    }
  }
}
```

### 4.1 Claude Code (CLI)

Cách nhanh nhất:

```bash
claude mcp add webmcp -- node /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/server/mcp_server.mjs
```

Kiểm tra: `claude mcp list` → thấy `webmcp`. Trong phiên Claude Code, hỏi
"liệt kê tab đang mở" để thử.

### 4.2 Cursor

Sửa `~/.cursor/mcp.json` (hoặc `.cursor/mcp.json` trong project):

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "node",
      "args": [
        "/Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/server/mcp_server.mjs"
      ]
    }
  }
}
```

Restart Cursor → Settings → MCP → thấy server "connected" với danh sách tool.

### 4.3 Claude Desktop

Sửa file config:
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "node",
      "args": [
        "/Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/server/mcp_server.mjs"
      ]
    }
  }
}
```

Thoát hẳn Claude Desktop (Cmd+Q) rồi mở lại → biểu tượng tool (🔨) hiện các tool browser.

### 4.4 Tùy chỉnh qua biến môi trường (tùy chọn)

Nếu gateway chạy port khác:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "node",
      "args": ["/.../server/mcp_server.mjs"],
      "env": { "WEBMCP_GATEWAY_URL": "http://localhost:9000" }
    }
  }
}
```

Nếu đang local dev và muốn MCP tự spawn gateway khi gateway chưa chạy:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "node",
      "args": ["/.../server/mcp_server.mjs"],
      "env": {
        "WEBMCP_GATEWAY_URL": "http://localhost:9000",
        "WEBMCP_GATEWAY_AUTOSTART": "1"
      }
    }
  }
}
```

## 5. Luồng dùng end-to-end

1. Chạy gateway: `npm run gateway` hoặc `webmcp gateway start`.
2. Load/reload unpacked extension trong Chrome.
3. Mở client (Claude Desktop/Cursor/Claude Code) — nó tự spawn MCP server, MCP
   server kết nối gateway đang chạy.
4. Ra lệnh tự nhiên, ví dụ: "mở google.com, tìm 'webmcp', chụp màn hình."
   Client sẽ tự gọi `navigate` → `getInteractiveElements` → `dispatchClick` →
   `typeText` → `pressKey` → `screenshot`.

## 6. Troubleshooting

| Triệu chứng | Nguyên nhân & cách xử lý |
|---|---|
| Client báo server "failed"/"disconnected" | Sai đường dẫn file, hoặc Node không có trong PATH của client. Dùng đường dẫn tuyệt đối; thử `command: "/usr/local/bin/node"`. |
| MCP báo gateway không reachable | Chạy `npm run gateway` hoặc `webmcp gateway start`; chỉ bật `WEBMCP_GATEWAY_AUTOSTART=1` cho local dev. |
| Tool gọi được nhưng lỗi `extension is not connected` | Gateway đã chạy nhưng extension chưa load/connect trong Chrome. Reload unpacked extension. |
| `invalid JSON` / server crash khi handshake | Có `console.log` in ra **stdout**. Mọi log phải dùng `console.error`. |
| Không thấy tool nào | MCP server chạy nhưng `tools/list` rỗng → kiểm tra việc sinh tool từ catalog. Test lại bằng Inspector (mục 3). |
| `screenshot` trả chuỗi base64 khổng lồ | MVP nhồi vào text. Nâng cấp: trả `{ type: "image" }` (xem plan mục 4). |
| Đổi port gateway không ăn | Đặt `env.WEBMCP_GATEWAY_URL` trong config client (mục 4.4). |

## 7. Quan hệ với các cách dùng cũ

MCP server **không thay thế** gì cả — nó là lớp thứ 3 thêm vào:

- Script/agent chạy shell vẫn dùng được `curl http://localhost:7865/api` như cũ.
- Workflow runner JSON đã được archive khỏi surface chính; dùng MCP/gateway cho AI agent flow.
- MCP server chỉ thêm đường cho các MCP client cắm thẳng, không cần biết WebSocket.
