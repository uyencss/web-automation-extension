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
4. Package CLI: `bin/webmcp.mjs`
   - Exposes `webmcp mcp`, `webmcp gateway start`, `webmcp health`, and
     `webmcp call`.
   - Supports npm/npx-style MCP configs without absolute repo paths after the
     package is published.
5. Agent skill: `skills/webmcp-browser-automation`
   - Tells agents to health-check, choose a tab, call `webmcp.listTools`, invoke
     page tools through `webmcp.invokeTool`, parse nested MCP results, and verify
     each browser action.

`runner/command-catalog.js` is used by the MCP adapter to generate tool schemas.

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
gateway HTTP requests by hand. Best-practice installs keep the gateway lifecycle
explicit: start the gateway once, then let one or more MCP clients connect to it.

Install dependencies once. This installs both the gateway dependency and
`@modelcontextprotocol/sdk` under `server/`:

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension
npm run setup
```

Start the gateway before using the MCP server:

```bash
npm run gateway
```

For local development only, set `WEBMCP_GATEWAY_AUTOSTART=1` if you want
`server/mcp_server.mjs` to spawn `server/gateway_server.js` when no local
gateway is listening. `WEBMCP_NO_AUTOSTART=1` still forces autostart off.

Load or reload the unpacked extension from
`/Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/webmcp-extension/dist`.
The gateway must show the extension is connected before MCP tool calls can
control Chrome. This Chrome-side load is the only manual step for the MCP flow.

Most MCP clients spawn the stdio server for you. For local development, use this
command in the client configuration:

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

After publishing this package to npm, prefer the portable `npx -y` form:

```json
{
  "mcpServers": {
    "webmcp-browser": {
      "command": "npx",
      "args": ["-y", "webmcp-browser-automation-kit", "mcp"]
    }
  }
}
```

Claude Code can install it directly:

```bash
claude mcp add webmcp-browser -- node /Users/ttcenter/Desktop/VIBE_CODE/web-automation-extension/server/mcp_server.mjs
```

After npm publish:

```bash
claude mcp add webmcp-browser -- npx -y webmcp-browser-automation-kit mcp
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
the MCP server globally for the chosen client. By default it uses the local
absolute path to `server/mcp_server.mjs`, which is best while developing this
checkout. After publishing the package to npm, run with
`WEBMCP_INSTALL_MODE=npx` to generate `npx -y webmcp-browser-automation-kit mcp`
configs instead:

```bash
WEBMCP_INSTALL_MODE=npx npm run install:codex
```

For Claude Code it copies the skill to `~/.claude/skills` and runs
`claude mcp add -s user`; for Codex it copies the skill to `~/.codex/skills` and
appends `[mcp_servers.webmcp-browser]` to `~/.codex/config.toml` if absent.
Clients without file-based skills (Copilot, Antigravity, Cursor) get only the
global MCP configuration written or printed.

## Package Commands

These commands are available locally with `npm run cli -- ...`, after global
install as `webmcp ...`, and through MCP configs with
`npx -y webmcp-browser-automation-kit ...`:

```bash
webmcp mcp
webmcp gateway start
webmcp gateway health --json
webmcp call ping
webmcp extension-path
```

While developing this checkout, expose the `webmcp` command on your PATH with:

```bash
npm run link:local
webmcp -h
```

Without linking or publishing, use the npm script wrapper:

```bash
npm run cli -- -h
npm run cli -- health --json
```

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
| `npm run cli -- <command>`              | Run the package CLI from this checkout.                                             |
| `npm run link:local`                    | Link this checkout globally so `webmcp ...` works from any shell.                   |
| `npm run pack:dry-run`                  | Show the files that would be published to npm.                                      |
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
| Gateway is not reachable from MCP                   | Start `npm run gateway` or `webmcp gateway start`. For dev autostart set `WEBMCP_GATEWAY_AUTOSTART=1`. |
| `Chrome extension is not connected to the gateway` | Gateway is up but no extension is attached: load/reload the unpacked extension. |
| `Method not found`                                 | You may be calling a page tool as a top-level command. Use `webmcp.invokeTool`.                               |
| `navigator.modelContext not found`                 | Use a normal web page, wait for load, and reload the extension/page. Chrome internal pages are not supported. |
| `Another debugger is already attached`             | Only one debugger client can attach to a tab. Use another tab or detach the conflicting extension.            |
| Generated reference is stale                       | Run `npm run tools:generate`.                                                                                 |
