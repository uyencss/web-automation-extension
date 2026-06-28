# Implementation Plan — MCP Server Adapter For The WebMCP Gateway

> Goal: allow standard MCP clients (Claude Desktop, Cursor, Claude Code, Cline, etc.)
> to plug directly into the existing automation system **without writing WebSocket/curl code**.
> Scope: only add MCP capability. **Do not** handle auth/CORS in this pass.

## 1. Selected Architecture

Keep `gateway_server.js` as the single hub (WS server for the extension + HTTP `/api`).
Add **one separate MCP server process** as an *adapter*: it speaks the MCP protocol with
clients over **stdio** and turns each tool call into `POST http://localhost:7865/api`.

```
MCP Client (Claude Desktop / Cursor / Claude Code)
      │  MCP protocol (stdio: JSON-RPC over stdin/stdout)
      ▼
server/mcp_server.mjs   ← NEW FILE (adapter)
      │  HTTP POST /api   { method, params }
      ▼
server/gateway_server.js   ← UNCHANGED
      │  WebSocket ws://localhost:7865  (JSON-RPC 2.0)
      ▼
Chrome Extension (background.js) → CDP / navigator.modelContext
```

Why split the process instead of packing MCP into the gateway:
- The gateway does not need changes -> no regression risk for running scripts/CLI.
- The extension connects to the gateway as a **WS client**, so the gateway **must** be the
  WS server. The MCP server only needs to be the gateway's **HTTP client**: a clean,
  one-way relationship.
- The MCP server can run independently from the gateway.

## 2. Tool Design

- **Source of truth:** reuse `COMMAND_DEFINITIONS` in `catalog/command-catalog.js` to
  **generate** the tool list and JSON Schema from `requiredParams`/`optionalParams`.
  Do not hand-code 36 tools.
- **Naming:** MCP tool names should not contain dots. Map:
  - `webmcp.listTools`  → tool `webmcp_list_tools`
  - `webmcp.invokeTool` → tool `webmcp_invoke_tool`
  - Keep all other command names unchanged (`navigate`, `getInteractiveElements`, ...).
  - Skip the `runner` group (pseudo-commands `wait`/`delay`) and commands in
    `UNSUPPORTED_COMMANDS`.
- **Escape hatch:** add one `browser_raw_command` tool accepting arbitrary `{ method, params }`
  to call any gateway-supported command, including a new command not yet added to the catalog.
- **Schema:** use raw JSON Schema (default type `string`; map `x/y/width/height/...` to
  `number`, and `params/input/modifiers` to `object`/`array`). Good enough for MVP;
  refine later.

## 3. Changed Files

| File | Type | Contents |
|---|---|---|
| `server/mcp_server.mjs` | NEW | Stdio MCP server, generate tools from catalog, proxy to `/api`. |
| `server/mcp-tool-catalog.mjs` | NEW (optional) | Function that builds the MCP tool list from `command-catalog.js`. Can be folded into `mcp_server.mjs` for simplicity. |
| `server/package.json` | MODIFY | Add dependency `@modelcontextprotocol/sdk`; add script `mcp`. |
| `package.json` (root) | MODIFY | Add `mcp` script that proxies down to `server`. |
| `docs/mcp-server-plan.md` | NEW | This file. |

> ESM note: `server/package.json` is currently `"type": "commonjs"`, while
> `@modelcontextprotocol/sdk` is ESM-only. Name the file `.mjs` to force ESM without
> changing the package `type`.

## 4. Code Skeleton For `server/mcp_server.mjs`

Use the SDK low-level API (`Server` + `setRequestHandler`) to return raw JSON Schema
without needing `zod`.

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const GATEWAY = process.env.WEBMCP_GATEWAY_URL || 'http://localhost:7865';

// --- 4.1 Build tool list from catalog ---------------------------------
// import { COMMAND_DEFINITIONS } from '../catalog/command-catalog.js'
// or copy the minimal table. Each tool:
//   { name, description, inputSchema, _method } (_method = original JSON-RPC method)
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
  if (!('tabId' in props)) props.tabId = { type: 'number' }; // most commands accept tabId
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
  { name: 'webmcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = BY_NAME.get(req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const args = req.params.arguments || {};

  const method = tool._method ?? args.method;       // raw command uses args.method
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
// Do NOT console.log to stdout; stdio is the MCP channel. Use console.error for logs.
console.error(`[mcp] webmcp MCP server ready, gateway=${GATEWAY}`);
```

Items to handle in the real implementation:
1. Change `catalog/command-catalog.js` to **export** `COMMAND_DEFINITIONS`/`COMMAND_GROUPS`
   (currently internal `const`s), or create a minimal copy in `mcp-tool-catalog.mjs`.
   The runner file is CommonJS and MCP is ESM; if importing directly, consider
   `module.exports` + dynamic `import()` or copying the table. The safest MVP path:
   **copy** the table into `mcp-tool-catalog.mjs`, then unify the source later.
2. `screenshot` returns a large base64 PNG -> consider returning
   `{ type: 'image', data, mimeType }` instead of stuffing it into text (post-MVP improvement).
3. `webmcp_invoke_tool`: state in the description that the real result is in
   `result.result.content[0].text`, matching the note in SKILL.md.

## 4b. Gateway-First — Ensure The AI Knows The Gateway Must Run First

The MCP server is **useless if the gateway is not running / the extension is not connected**.
Use four layers so the AI never "forgets":

1. **Auto-start gateway (optional, enabled by default).** When the MCP server starts, call
   `GET /health`; if it cannot connect, `spawn` the gateway as a detached child process:
   ```js
   import { spawn } from 'node:child_process';
   async function ensureGateway() {
     try { await fetch(`${GATEWAY}/health`); return; } catch {}
     if (process.env.WEBMCP_AUTOSTART_GATEWAY === '0') return;
     const child = spawn('node', [join(__dirname, 'gateway_server.js')],
       { detached: true, stdio: 'ignore' });
     child.unref();
     // poll /health for a few seconds until ready
   }
   ```
   Note: this can only start the gateway; it **cannot** open Chrome/load the extension for the
   user. That part still requires the user.

2. **Tool `browser_status` / `ensure_ready`.** Return a clear status so the AI calls it first:
   ```jsonc
   // call GET /health, then map the result:
   { "gatewayRunning": true, "extensionConnected": false,
     "hint": "Open Chrome with webmcp-extension/dist loaded; the extension auto-connects in ~3s." }
   ```

3. **Every tool error returns an actionable message**, not a raw technical error:
   ```js
   async function callGateway(method, params) {
     let res;
     try {
       res = await fetch(`${GATEWAY}/api`, { method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ method, params: params || {} }) });
     } catch {
       throw new Error('Gateway is not running. Run `npm run gateway` and try again.');
     }
     const json = await res.json();
     if (res.status === 503)                    // extension not connected yet
       throw new Error('Extension is not connected. Open Chrome with webmcp-extension/dist loaded (auto-connect ~3s).');
     if (!res.ok) throw new Error(json.error || `Gateway HTTP ${res.status}`);
     return json.result;
   }
   ```

4. **Server description + SKILL.md state the order clearly.** Server instructions (the
   `instructions` field when creating `Server`) should say: *"Before using any tool, call
   `browser_status`. If the gateway/extension is not ready, stop and ask the user to run
   `npm run gateway` + open Chrome."* SKILL.md already has a health-check step in the Run
   Loop; keep it and point it to `ping`/`browser_status`.

## 5. Dependencies & Scripts

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

Root `package.json` — common commands to install deps (including the MCP SDK) + skill + MCP
for each runtime. Each `install:*` runs `setup` first, then `scripts/install-agent.mjs`:

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

Installer for each runtime: copy the skill from `skills/<name>` into the runtime's global
skill directory (Claude Code `~/.claude/skills/`; Codex `~/.codex/skills/`;
Copilot/Antigravity/Cursor do not support file-based skills, so use SKILL.md), write the
global MCP config automatically where safe (`claude mcp add -s user`, append
`~/.codex/config.toml`, write `~/.cursor/mcp.json` if absent), print a snippet for shared
config (VS Code user settings), and always print a reminder to run the gateway first.

The section below is the original root `package.json` script config:
```jsonc
"scripts": {
  "mcp": "npm --prefix server run mcp"
}
```

Install: `npm --prefix server install`.

## 6. Implementation Steps (In Order)

1. `npm --prefix server install @modelcontextprotocol/sdk`.
2. Create `server/mcp-tool-catalog.mjs` (copy the command table + `buildTool` helper).
3. Create `server/mcp_server.mjs` based on the section 4 skeleton.
4. Add `mcp` scripts in `server/package.json` and root.
5. Test manually with MCP Inspector (section 7): verify `tools/list` returns ~35 tools and
   try calling `ping`, `getActiveTab`, `getInteractiveElements`.
6. Configure one real client (Claude Code / Cursor) and run end-to-end.
7. Update `SKILL.md` + README: add a "Use Through MCP Server" section.

## 7. Quick Test (No Real Client Required)

Anthropic's MCP Inspector runs independently:

```bash
# Terminal 1: extension hub
npm run gateway          # (make sure the extension is connected in Chrome)

# Terminal 2: inspect MCP server
npx @modelcontextprotocol/inspector node server/mcp_server.mjs
```

Inspector opens a web UI -> **Tools** tab -> tool list is visible -> click `ping` -> expect
`{ "ok": true }`.

## 8. Risks / Notes

- **stdout is the MCP channel**: all logs must go to `console.error`; printing to stdout
  breaks the protocol and clients report "invalid JSON".
- The MCP server **auto-starts the gateway** at startup if no process is listening on the
  configured port (detached spawn, survives MCP restarts) and reuses an existing gateway
  when present. Set `WEBMCP_NO_AUTOSTART=1` to disable this and run `npm run gateway`
  manually. If `/api` still errors, the message should distinguish "gateway unreachable"
  from "extension not connected".
- Extension events (`tabUpdated`, etc.) are **not** forwarded through MCP in the MVP; tools
  are request/response. If needed, add MCP notifications/resources later.
- One extension = one connection, the gateway's current limit, remains true. The MCP server
  is only the Nth HTTP client, so it does not make this worse.
```
