# Implementation Plan — MCP Server Adapter cho WebMCP Gateway

> Mục tiêu: cho phép các MCP client chuẩn (Claude Desktop, Cursor, Claude Code, Cline...)
> cắm thẳng vào hệ thống automation hiện có, **không phải tự viết code WebSocket/curl**.
> Phạm vi: chỉ thêm khả năng MCP. **Không** xử lý auth/CORS trong đợt này.

## 1. Kiến trúc chọn

Giữ nguyên `gateway_server.js` làm hub duy nhất (WS server cho extension + HTTP `/api`).
Thêm **một process MCP server riêng** đóng vai trò *adapter*: nói giao thức MCP với
client qua **stdio**, và chuyển mỗi tool call thành `POST http://localhost:7865/api`.

```
MCP Client (Claude Desktop / Cursor / Claude Code)
      │  MCP protocol (stdio: JSON-RPC over stdin/stdout)
      ▼
server/mcp_server.mjs   ← FILE MỚI (adapter)
      │  HTTP POST /api   { method, params }
      ▼
server/gateway_server.js   ← GIỮ NGUYÊN
      │  WebSocket ws://localhost:7865  (JSON-RPC 2.0)
      ▼
Chrome Extension (background.js) → CDP / navigator.modelContext
```

Lý do tách process thay vì nhồi MCP vào gateway:
- Gateway không phải sửa gì → không rủi ro hồi quy cho runner/scripts đang chạy.
- Extension kết nối tới gateway như **WS client**, nên gateway **bắt buộc** là WS server.
  MCP server chỉ cần là **HTTP client** của gateway — quan hệ sạch, một chiều.
- Có thể chạy/không chạy MCP server độc lập với gateway.

## 2. Thiết kế tool

- **Nguồn sự thật:** tái dùng `COMMAND_DEFINITIONS` trong
  [runner/command-catalog.js](../runner/command-catalog.js) để **tự sinh** danh sách tool
  + JSON Schema từ `requiredParams`/`optionalParams`. Không hard-code 36 tool bằng tay.
- **Đặt tên:** MCP tool name không nên chứa dấu chấm. Map:
  - `webmcp.listTools`  → tool `webmcp_list_tools`
  - `webmcp.invokeTool` → tool `webmcp_invoke_tool`
  - các command còn lại giữ nguyên tên (`navigate`, `getInteractiveElements`, ...).
  - Bỏ qua nhóm `runner` (pseudo-command `wait`/`delay`) và các lệnh trong
    `UNSUPPORTED_COMMANDS`.
- **Escape hatch:** thêm 1 tool `browser_raw_command` nhận `{ method, params }` tùy ý
  để gọi bất kỳ command nào gateway hỗ trợ (kể cả command mới chưa kịp thêm vào catalog).
- **Schema:** dùng JSON Schema thô (kiểu mặc định `string`, riêng `x/y/width/height/...`
  để `number`, `params/input/modifiers` để `object`/`array`). Đủ tốt cho MVP; tinh chỉnh sau.

## 3. Các file thay đổi

| File | Loại | Nội dung |
|---|---|---|
| `server/mcp_server.mjs` | MỚI | Stdio MCP server, sinh tool từ catalog, proxy sang `/api`. |
| `server/mcp-tool-catalog.mjs` | MỚI (tùy chọn) | Hàm build danh sách tool MCP từ `command-catalog.js`. Có thể gộp luôn vào `mcp_server.mjs` cho gọn. |
| `server/package.json` | SỬA | Thêm dep `@modelcontextprotocol/sdk`; thêm script `mcp`. |
| `package.json` (root) | SỬA | Thêm script `mcp` proxy xuống `server`. |
| `docs/mcp-server-plan.md` | MỚI | File này. |

> Lưu ý ESM: `server/package.json` đang `"type": "commonjs"`, còn `@modelcontextprotocol/sdk`
> là ESM-only. Vì vậy đặt tên file `.mjs` để ép ESM, không cần đổi `type` của package.

## 4. Khung code `server/mcp_server.mjs`

Dùng API low-level của SDK (`Server` + `setRequestHandler`) để trả JSON Schema thô,
khỏi cần `zod`.

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const GATEWAY = process.env.WEBMCP_GATEWAY_URL || 'http://localhost:7865';

// --- 4.1 Build tool list from catalog ---------------------------------
// import { COMMAND_DEFINITIONS } from '../runner/command-catalog.js' (chuyển sang export)
// hoặc copy bảng tối thiểu. Mỗi tool:
//   { name, description, inputSchema, _method } (_method = JSON-RPC method gốc)
const NUMERIC = new Set(['x','y','fromX','fromY','steps','width','height',
  'deltaX','deltaY','timeout','depth','clickCount','deviceScaleFactor']);
const OBJECT  = new Set(['params','input']);
const ARRAY   = new Set(['modifiers']);

function propType(p) {
  if (NUMERIC.has(p)) return { type: 'number' };
  if (OBJECT.has(p))  return { type: 'object' };
  if (ARRAY.has(p))   return { type: 'array' };
  if (p === 'mobile' || p === 'fullPage' || p === 'interestingOnly' ||
      p === 'computedStyles') return { type: 'boolean' };
  return { type: 'string' };
}

function buildTool(method, def) {
  const required = def.requiredParams || [];
  const optional = def.optionalParams || [];
  const props = {};
  for (const p of [...required, ...optional]) props[p] = propType(p);
  if (!('tabId' in props)) props.tabId = { type: 'number' }; // hầu hết command nhận tabId
  return {
    name: method.replace('.', '_'),
    _method: method,
    description: `${def.label || method} (gateway command "${method}")`,
    inputSchema: { type: 'object', properties: props, required },
  };
}

const TOOLS = COMMAND_DEFINITIONS
  .filter(([, d]) => d.group !== 'runner')
  .map(([m, d]) => buildTool(m, d));

// escape hatch
TOOLS.push({
  name: 'browser_raw_command',
  _method: null,
  description: 'Send any raw gateway command. Use when a command is not exposed as its own tool.',
  inputSchema: {
    type: 'object',
    properties: { method: { type: 'string' }, params: { type: 'object' } },
    required: ['method'],
  },
});

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

// --- 4.2 Gateway call -------------------------------------------------
async function callGateway(method, params) {
  const res = await fetch(`${GATEWAY}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: params || {} }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Gateway HTTP ${res.status}`);
  return json.result;
}

// --- 4.3 MCP server ---------------------------------------------------
const server = new Server(
  { name: 'webmcp-browser', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = BY_NAME.get(req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const args = req.params.arguments || {};

  const method = tool._method ?? args.method;       // raw command dùng args.method
  const params = tool._method ? args : (args.params || {});

  try {
    const result = await callGateway(method, params);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err.message || err) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// KHÔNG console.log ra stdout — stdio đang là kênh MCP. Dùng console.error nếu cần log.
console.error(`[mcp] webmcp-browser MCP server ready, gateway=${GATEWAY}`);
```

Điểm cần làm khi code thật:
1. Đổi `runner/command-catalog.js` để **export** `COMMAND_DEFINITIONS`/`COMMAND_GROUPS`
   (hiện đang là `const` nội bộ) — hoặc tạo một bản copy tối thiểu trong `mcp-tool-catalog.mjs`.
   File runner là CommonJS, MCP là ESM → nếu import trực tiếp, cân nhắc dùng
   `module.exports` + dynamic `import()` hoặc copy bảng. Cách an toàn nhất cho MVP: **copy**
   bảng vào `mcp-tool-catalog.mjs`, sau này thống nhất một nguồn.
2. `screenshot` trả base64 PNG lớn → cân nhắc trả `{ type: 'image', data, mimeType }` thay vì
   nhồi vào text (cải tiến sau MVP).
3. `webmcp_invoke_tool`: nhắc trong description rằng kết quả thật nằm ở
   `result.result.content[0].text` (giống ghi chú trong SKILL.md).

## 4b. Gateway-first — đảm bảo AI luôn biết phải chạy gateway trước

MCP server **vô dụng nếu gateway chưa chạy / extension chưa connect**. Dùng 4 lớp để AI
không bao giờ "quên":

1. **Tự khởi động gateway (tùy chọn, mặc định bật).** Khi MCP server start, gọi
   `GET /health`; nếu không kết nối được thì `spawn` gateway như child process detached:
   ```js
   import { spawn } from 'node:child_process';
   async function ensureGateway() {
     try { await fetch(`${GATEWAY}/health`); return; } catch {}
     if (process.env.WEBMCP_AUTOSTART_GATEWAY === '0') return;
     const child = spawn('node', [join(__dirname, 'gateway_server.js')],
       { detached: true, stdio: 'ignore' });
     child.unref();
     // poll /health vài giây cho tới khi sẵn sàng
   }
   ```
   Lưu ý: việc này chỉ bật được gateway, **không** mở Chrome/extension hộ — phần đó vẫn cần user.

2. **Tool `browser_status` / `ensure_ready`.** Trả trạng thái rõ ràng để AI tự gọi đầu tiên:
   ```jsonc
   // gọi GET /health rồi map ra:
   { "gatewayRunning": true, "extensionConnected": false,
     "hint": "Mở Chrome đã load webmcp-extension/dist; extension tự connect trong ~3s." }
   ```

3. **Mọi tool lỗi đều trả message hành động được**, không phải lỗi kỹ thuật trần:
   ```js
   async function callGateway(method, params) {
     let res;
     try {
       res = await fetch(`${GATEWAY}/api`, { method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ method, params: params || {} }) });
     } catch {
       throw new Error('Gateway chưa chạy. Chạy `npm run gateway` rồi thử lại.');
     }
     const json = await res.json();
     if (res.status === 503)                    // extension chưa connect
       throw new Error('Extension chưa kết nối. Mở Chrome đã load webmcp-extension/dist (auto-connect ~3s).');
     if (!res.ok) throw new Error(json.error || `Gateway HTTP ${res.status}`);
     return json.result;
   }
   ```

4. **Description của server + SKILL.md nói rõ thứ tự.** Server instructions (field
   `instructions` khi khởi tạo `Server`) ghi: *"Trước khi dùng bất kỳ tool nào, gọi
   `browser_status`. Nếu gateway/extension chưa sẵn sàng, dừng và yêu cầu user chạy
   `npm run gateway` + mở Chrome."* SKILL.md đã có bước health-check ở Run Loop — giữ và
   trỏ về tool `ping`/`browser_status`.

## 5. Phụ thuộc & scripts

`server/package.json`:
```jsonc
{
  "dependencies": {
    "ws": "^8.21.0",
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "scripts": {
    "gateway": "node gateway_server.js",
    "mcp": "node mcp_server.mjs"
  }
}
```

Root `package.json` — lệnh chung cài deps (gồm MCP SDK) + skill + MCP cho từng runtime.
Mỗi `install:*` chạy `setup` trước rồi tới installer `scripts/install-agent.mjs`:

```jsonc
"scripts": {
  "install:agent":       "npm run setup && node scripts/install-agent.mjs",
  "install:claude":      "npm run setup && node scripts/install-agent.mjs claude",
  "install:codex":       "npm run setup && node scripts/install-agent.mjs codex",
  "install:copilot":     "npm run setup && node scripts/install-agent.mjs copilot",
  "install:antigravity": "npm run setup && node scripts/install-agent.mjs antigravity",
  "install:cursor":      "npm run setup && node scripts/install-agent.mjs cursor"
}
```

Installer cho mỗi runtime: copy skill từ `skills/<name>` vào skill-dir global của runtime
(Claude Code `~/.claude/skills/`; Codex `~/.codex/skills/`; Copilot/Antigravity/Cursor
không file-skill → dùng SKILL.md), tự ghi MCP config global chỗ an toàn (`claude mcp add -s user`,
append `~/.codex/config.toml`, ghi `~/.cursor/mcp.json` nếu chưa có), in snippet cho config
dùng chung (VS Code user settings), và luôn in reminder phải chạy gateway trước.

Phần dưới là cấu hình script gốc của `server/package.json`:
```jsonc
"scripts": {
  "mcp": "npm --prefix server run mcp"
}
```

Cài: `npm --prefix server install`.

## 6. Các bước thực thi (theo thứ tự)

1. `npm --prefix server install @modelcontextprotocol/sdk`.
2. Tạo `server/mcp-tool-catalog.mjs` (copy bảng command + helper `buildTool`).
3. Tạo `server/mcp_server.mjs` theo khung mục 4.
4. Thêm scripts `mcp` ở `server/package.json` và root.
5. Test thủ công bằng MCP Inspector (mục 7) — verify `tools/list` ra ~35 tool và
   gọi thử `ping`, `getActiveTab`, `getInteractiveElements`.
6. Cấu hình một client thật (Claude Code / Cursor) và chạy end-to-end.
7. Cập nhật `SKILL.md` + README: thêm mục "Dùng qua MCP server".

## 7. Test nhanh (không cần client thật)

MCP Inspector của Anthropic chạy độc lập:

```bash
# Terminal 1: extension hub
npm run gateway          # (đảm bảo extension trong Chrome đã connect)

# Terminal 2: soi MCP server
npx @modelcontextprotocol/inspector node server/mcp_server.mjs
```

Inspector mở UI web → tab **Tools** → thấy danh sách tool → bấm `ping` → kỳ vọng `{ "ok": true }`.

## 8. Rủi ro / lưu ý

- **stdout là kênh MCP** — mọi log phải đi `console.error`, nếu in ra stdout sẽ làm hỏng
  giao thức (client báo "invalid JSON").
- MCP server **tự khởi động gateway** lúc startup nếu chưa có process nào nghe ở port
  cấu hình (spawn detached, sống độc lập qua các lần MCP restart) và tái dùng gateway
  sẵn có. Đặt `WEBMCP_NO_AUTOSTART=1` để tắt và tự chạy `npm run gateway`. Nếu `/api`
  vẫn lỗi, message gợi ý phân biệt "gateway chưa tới được" với "extension chưa connect".
- Event từ extension (`tabUpdated`...) **không** chuyển qua MCP trong MVP — tool là
  request/response. Nếu cần, bổ sung sau bằng MCP notifications/resources.
- Một extension = một connection (giới hạn hiện có của gateway) vẫn còn; MCP server
  chỉ là client thứ N gọi HTTP nên không làm tệ hơn.
```
