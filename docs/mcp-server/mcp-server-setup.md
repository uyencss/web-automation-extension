# Guide — Run & Set Up The MCP Server (WebMCP Browser)

> This file explains how to run the MCP server after it has been implemented according to
> [mcp-server-plan.md](./mcp-server-plan.md). The MCP server lets Claude Desktop,
> Cursor, Claude Code, and similar clients control a real signed-in Chrome browser through
> the extension.

## 0. Runtime Model — Three Things Must Run Together

```
[1] Chrome + loaded extension   →  connects to  →  [2] Gateway (ws://localhost:7865)
                                                        ▲ HTTP /api
[3] MCP server (stdio)  ────────────────────────────────┘
        ▲ stdio
   MCP client (Claude Desktop / Cursor / Claude Code)
```

- **[1] and [2]** must always be running, as they do today.
- **[3]** is usually **spawned by the MCP client**; you do NOT run it manually. You only
  declare the command that starts it in the client config file.

## 1. One-Time Setup — Install With One Command Per Runtime

If you only want to use the released npm package, configure the MCP client with:

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

And run the gateway through the released package:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit gateway start
```

The commands below are for local development from this checkout.

Each command below runs `npm run setup` (installing deps including the MCP SDK), **then**
installs the skill and writes/prints the MCP config for the selected runtime. At the end,
it always prints a reminder to run the gateway first.

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension

npm run install:claude        # Claude Code  — copy skill -> ~/.claude/skills + `claude mcp add -s user`
npm run install:codex         # Codex        — copy skill -> ~/.codex/skills + add MCP to ~/.codex/config.toml
npm run install:copilot       # GitHub Copilot (VS Code) — print global MCP snippet to paste
npm run install:antigravity   # Antigravity  — print MCP snippet to paste
npm run install:cursor        # Cursor       — write ~/.cursor/mcp.json (global)
npm run install:agent         # (no target) print config for ALL runtimes
```

Or install deps manually and configure the client yourself later:

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension
npm run setup                       # install server deps (including @modelcontextprotocol/sdk)
```

Load extension: `chrome://extensions` -> Developer mode -> Load unpacked -> choose
`webmcp-extension/dist`.

## 2. Run The Hub (Gateway) — Always Required

```bash
npm run gateway
```

Expected log: `Extension is ready ... capabilities registered`. Keep this terminal running.

## 3. Test The MCP Server Before Attaching A Client

```bash
npx @modelcontextprotocol/inspector node server/mcp_server.mjs
```

Open the Inspector UI -> **Tools** tab -> click `ping` -> `{ "ok": true }` means the MCP
server is OK. This step is optional but useful for isolating errors.

## 4. Configure Each Client

Local dev uses the absolute path to the server:
`/Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/server/mcp_server.mjs`

For the released npm package, use the portable form:

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

Fastest path:

```bash
claude mcp add webmcp -- node /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/server/mcp_server.mjs
```

Check: `claude mcp list` -> you should see `webmcp`. In a Claude Code session, ask
"list open tabs" to test it.

### 4.2 Cursor

Edit `~/.cursor/mcp.json` (or `.cursor/mcp.json` in the project):

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

Restart Cursor -> Settings -> MCP -> the server should be "connected" with the tool list.

### 4.3 Claude Desktop

Edit the config file:
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

Quit Claude Desktop completely (Cmd+Q), then reopen it -> the tool icon shows the browser tools.

### 4.4 Customize With Environment Variables (Optional)

If the gateway runs on another port:

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

If you are in local development and want MCP to spawn the gateway when it is not running:

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

## 5. End-To-End Usage Flow

1. Run the gateway: `npm run gateway` or `webmcp gateway start`.
2. Load/reload the unpacked extension in Chrome.
3. Open the client (Claude Desktop/Cursor/Claude Code). It spawns the MCP server, and the
   MCP server connects to the running gateway.
4. Give a natural-language command, for example: "open google.com, search for 'webmcp',
   take a screenshot." The client will call `navigate` -> `getInteractiveElements` ->
   `dispatchClick` -> `typeText` -> `pressKey` -> `screenshot`.

## 6. Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Client reports server "failed"/"disconnected" | Wrong file path, or Node is not in the client's PATH. Use an absolute path; try `command: "/usr/local/bin/node"`. |
| MCP reports gateway is unreachable | Run `npm run gateway` or `webmcp gateway start`; only enable `WEBMCP_GATEWAY_AUTOSTART=1` for local dev. |
| Tool is callable but returns `extension is not connected` | Gateway is running, but the extension is not loaded/connected in Chrome. Reload the unpacked extension. |
| `invalid JSON` / server crash during handshake | A `console.log` printed to **stdout**. All logs must use `console.error`. |
| No tools are visible | MCP server is running but `tools/list` is empty -> check tool generation from the catalog. Test again with Inspector (section 3). |
| `screenshot` returns a huge base64 string | MVP puts it into text. Upgrade path: return `{ type: "image" }` (see plan section 4). |
| Gateway port change does not apply | Set `env.WEBMCP_GATEWAY_URL` in the client config (section 4.4). |

## 7. Relationship To Previous Usage Modes

The MCP server **does not replace** anything; it is an added third layer:

- Shell-based scripts/agents can still use `curl http://localhost:7865/api` as before.
- Workflow runner JSON has been archived from the main surface; use MCP/gateway for AI agent flows.
- The MCP server only adds a direct integration path for MCP clients without requiring WebSocket knowledge.
