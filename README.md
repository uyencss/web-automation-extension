# WebMCP Browser Automation Kit

Reusable kit for AI agents that need to operate Chrome through a local browser
extension.

The kit has three layers:

1. Runtime extension: `webmcp-extension/dist`
   - Chrome unpacked extension.
   - Injects `register-tools.js` into pages.
   - Exposes background commands for tabs, CDP input, screenshots, cookies,
     storage, viewport control, and WebMCP page-tool bridging.
2. Gateway server: `server/gateway_server.js`
   - WebSocket endpoint for the extension at `ws://localhost:7865`.
   - HTTP endpoint for agents/scripts at `POST http://localhost:7865/api`.
   - Health endpoint at `GET http://localhost:7865/health`.
3. MCP server adapter: `server/mcp_server.mjs`
   - Stdio MCP server for Claude Desktop, Cursor, Claude Code, Cline, and
     other MCP clients.
   - Generates MCP tools from `runner/command-catalog.js`.
   - Proxies each tool call to the gateway HTTP API.
4. Agent skill: `skills/webmcp-browser-automation`
   - Tells agents to health-check, choose a tab, call `webmcp.listTools`, invoke
     page tools through `webmcp.invokeTool`, parse nested MCP results, and verify
     each browser action.

`runner/` is not required for the kit quickstart and is intentionally left out
of these setup commands.

## Quick Start

Install gateway dependencies once:

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension
npm run setup
```

Load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load unpacked extension from:
   `/Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/webmcp-extension/dist`

Start the gateway:

```bash
npm run gateway
```

In another terminal, verify the extension is connected:

```bash
npm run health
```

Call any extension command:

```bash
npm run call -- getActiveTab
npm run call -- newTab '{"url":"https://example.com"}'
npm run call -- webmcp.listTools '{"tabId":123}'
```

Invoke a page-registered WebMCP tool:

```bash
npm run call -- webmcp.invokeTool \
  '{"tabId":123,"toolName":"get_page_metadata","input":{"include_headings":true}}'
```

## MCP Server

The MCP server lets MCP clients call the same browser commands without writing
gateway HTTP requests by hand.

Install dependencies once. This installs both the gateway dependency and
`@modelcontextprotocol/sdk` under `server/`:

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension
npm run setup
```

You do not need to start the gateway by hand for the MCP flow: on startup
`server/mcp_server.mjs` auto-starts the gateway if one is not already listening
on the configured port (a detached process that survives MCP restarts), and
reuses an existing gateway when present. Set `WEBMCP_NO_AUTOSTART=1` to opt out
and run `npm run gateway` yourself (still needed for direct script/curl usage
that does not go through the MCP server).

Load or reload the unpacked extension from
`/Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/webmcp-extension/dist`.
The gateway must show the extension is connected before MCP tool calls can
control Chrome. This Chrome-side load is the only manual step for the MCP flow.

Most MCP clients spawn the stdio server for you. Use this command in the client
configuration:

```bash
node /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/server/mcp_server.mjs
```

For clients that support JSON config, use:

```json
{
  "mcpServers": {
    "webmcp-browser": {
      "command": "node",
      "args": [
        "/Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/server/mcp_server.mjs"
      ]
    }
  }
}
```

Claude Code can install it directly:

```bash
claude mcp add webmcp-browser -- node /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/server/mcp_server.mjs
```

To run the MCP server manually from this repo:

```bash
npm run mcp
```

For a local smoke test with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node server/mcp_server.mjs
```

Open the Inspector UI, choose Tools, and call `ping`. A successful result means
the MCP server, gateway, and extension are wired together.

See `docs/mcp-server/mcp-server-setup.md` for Claude Code, Cursor, and Claude
Desktop configuration examples.

## Installing Into AI Clients

The skill source lives under `skills/webmcp-browser-automation`.
`scripts/install-agent.mjs` uses that path as the source and installs **globally
per provider** (not into this project): it copies the skill into each runtime's
global skill directory (`~/.claude/skills`, `~/.codex/skills`) and registers the
MCP server in each runtime's global config.

Use the installer scripts to install the MCP config and, where supported, copy
the skill:

```bash
npm run install:claude
npm run install:codex
npm run install:cursor
npm run install:copilot
npm run install:antigravity
```

To print or apply all supported targets:

```bash
npm run install:agent
```

The installer always runs `npm run setup` first, then registers
`server/mcp_server.mjs` globally for the chosen client. For Claude Code it copies
the skill to `~/.claude/skills` and runs `claude mcp add -s user`; for Codex it
copies the skill to `~/.codex/skills` and appends `[mcp_servers.webmcp-browser]`
to `~/.codex/config.toml` if absent. Clients without file-based skills (Copilot,
Antigravity, Cursor) get only the global MCP configuration written or printed.

## Agent Usage Contract

- Call `ping` first. If it fails, start `npm run gateway` and reload the
  unpacked extension.
- Use `getActiveTab`, `newTab`, or `navigate` to select the target tab.
- Call `webmcp.listTools` before using any page tool.
- Call page tools only through `webmcp.invokeTool` with `params.toolName`.
- Parse nested MCP text from `response.result.result.content[0].text` when using
  the HTTP gateway.
- After each action, verify with a wait, query, screenshot, accessibility tree,
  or `getInteractiveElements`.

## Scripts

| Command                                 | Purpose                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run setup`                         | Install gateway dependencies under `server/`.                                       |
| `npm run gateway`                       | Start the HTTP/WebSocket gateway.                                                   |
| `npm run mcp`                           | Start the stdio MCP adapter for clients that launch it manually.                    |
| `npm run install:agent`                 | Run the multi-client installer helper.                                              |
| `npm run install:claude`                | Copy skill to `~/.claude/skills` and register MCP server (user scope).              |
| `npm run install:codex`                 | Copy skill to `~/.codex/skills` and add MCP to `~/.codex/config.toml`.              |
| `npm run install:cursor`                | Write global `~/.cursor/mcp.json` if absent.                                        |
| `npm run health`                        | Send `ping` through the gateway to confirm extension connectivity.                  |
| `npm run call -- <method> [jsonParams]` | Call one extension command through `POST /api`.                                     |
| `npm run tools:generate`                | Rebuild the generated skill reference from runtime source files.                    |
| `npm run tools:check`                   | Fail if the generated reference is stale or capability announcements lack handlers. |

## References

- Generated source-derived reference:
  `skills/webmcp-browser-automation/references/generated-tools.md`
- Human quick reference:
  `skills/webmcp-browser-automation/references/tool-reference-card.md`
- Extension README:
  `webmcp-extension/README.md`

## Troubleshooting

| Symptom                                            | Fix                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Chrome extension is not connected to the gateway` | Gateway is up but no extension is attached: load/reload the unpacked extension. (Via MCP the gateway auto-starts; for direct script/curl usage run `npm run gateway`.) |
| `Method not found`                                 | You may be calling a page tool as a top-level command. Use `webmcp.invokeTool`.                               |
| `navigator.modelContext not found`                 | Use a normal web page, wait for load, and reload the extension/page. Chrome internal pages are not supported. |
| `Another debugger is already attached`             | Only one debugger client can attach to a tab. Use another tab or detach the conflicting extension.            |
| Generated reference is stale                       | Run `npm run tools:generate`.                                                                                 |
