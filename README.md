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
   - Supports npm/npx-style MCP configs without absolute repo paths through the
     released npm package.
5. Agent skill: `skills/webmcp-browser-automation`
   - Tells agents to health-check, choose a tab, call `webmcp.listTools`, invoke
     page tools through `webmcp.invokeTool`, parse nested MCP results, and verify
     each browser action.

`runner/command-catalog.js` is used by the MCP adapter to generate tool schemas.

## Quick Start

For normal use, you do not need to clone this repository. Run the published npm
package with `npx` and configure your MCP client to start the same package.

Print the unpacked extension path:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit extension-path
```

Load the extension in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select the path printed by `extension-path`.

Start the gateway:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit gateway start
```

In another terminal, verify the extension is connected:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit health --json
```

Call any extension command:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit call getActiveTab
npx -y @gyga-browser/webmcp-browser-automation-kit call newTab '{"url":"https://example.com"}'
npx -y @gyga-browser/webmcp-browser-automation-kit call webmcp.listTools '{"tabId":123}'
```

Invoke a page-registered WebMCP tool:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit call webmcp.invokeTool \
  '{"tabId":123,"toolName":"get_page_metadata","input":{"include_headings":true}}'
```

## MCP Server

The MCP server lets MCP clients call the same browser commands without writing
gateway HTTP requests by hand. Best-practice installs keep the gateway lifecycle
explicit: start the gateway once, then let one or more MCP clients connect to it.

### Published Package

Use this MCP server name: `webmcp`. Codex exposes that as the shorter tool
namespace `mcp__webmcp`.

For any MCP client that accepts JSON config:

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

Start the gateway separately before using MCP tools:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit gateway start
```

Claude Code can register the published package directly:

```bash
claude mcp add webmcp -- npx -y @gyga-browser/webmcp-browser-automation-kit mcp
```

Codex config example:

```toml
[mcp_servers.webmcp]
command = "npx"
args = ["-y", "@gyga-browser/webmcp-browser-automation-kit", "mcp"]
```

Cursor and Claude Desktop use the same `mcpServers.webmcp` JSON block above.

### Local Checkout

Clone this repo only if you want to modify the extension, gateway, MCP adapter,
or skill. Replace `/path/to/web-automation-extension` with your own checkout
path in every command and config snippet below.

```bash
git clone https://github.com/uyencss/web-automation-extension.git /path/to/web-automation-extension
cd /path/to/web-automation-extension
npm run setup
```

Load or reload the unpacked extension from:

```text
/path/to/web-automation-extension/webmcp-extension/dist
```

Start the local gateway:

```bash
npm run gateway
```

For local development only, set `WEBMCP_GATEWAY_AUTOSTART=1` if you want
`server/mcp_server.mjs` to spawn `server/gateway_server.js` when no local
gateway is listening. `WEBMCP_NO_AUTOSTART=1` still forces autostart off.

For a local MCP config, point the client at your checkout:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "node",
      "args": [
        "/path/to/web-automation-extension/server/mcp_server.mjs"
      ]
    }
  }
}
```

Claude Code local registration:

```bash
claude mcp add webmcp -- node /path/to/web-automation-extension/server/mcp_server.mjs
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

Most users should install MCP with the published package config shown above. The
client will download the package with `npx`, start the MCP adapter, and proxy
tool calls to the gateway you already started.

If you also want the bundled agent skill copied into a local AI runtime, use a
local checkout and run the installer in `npx` mode. This copies
`skills/webmcp-browser-automation` into providers that support file-based
skills, while writing MCP config that still points at the published package:

```bash
cd /path/to/web-automation-extension
WEBMCP_INSTALL_MODE=npx npm run install:codex
WEBMCP_INSTALL_MODE=npx npm run install:claude
```

Other supported installer targets:

```bash
WEBMCP_INSTALL_MODE=npx npm run install:cursor
WEBMCP_INSTALL_MODE=npx npm run install:copilot
WEBMCP_INSTALL_MODE=npx npm run install:antigravity
```

To print or apply all supported targets:

```bash
WEBMCP_INSTALL_MODE=npx npm run install:agent
```

For local development, omit `WEBMCP_INSTALL_MODE=npx`; the installer then writes
config that points at your checkout's absolute `server/mcp_server.mjs` path:

```bash
cd /path/to/web-automation-extension
npm run install:codex
```

For Claude Code it copies the skill to `~/.claude/skills` and runs
`claude mcp add -s user`; for Codex it copies the skill to `~/.codex/skills` and
appends `[mcp_servers.webmcp]` to `~/.codex/config.toml` if absent.
Clients without file-based skills (Copilot, Antigravity, Cursor) get only the
global MCP configuration written or printed.

## Package Commands

Use the published package commands with `npx`:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit mcp
npx -y @gyga-browser/webmcp-browser-automation-kit gateway start
npx -y @gyga-browser/webmcp-browser-automation-kit gateway health --json
npx -y @gyga-browser/webmcp-browser-automation-kit call ping
npx -y @gyga-browser/webmcp-browser-automation-kit extension-path
```

After global install or `npm link`, the same commands are available as:

```bash
webmcp mcp
webmcp gateway start
webmcp gateway health --json
webmcp call ping
webmcp extension-path
```

Inside a local checkout, use the npm script wrapper:

```bash
npm run cli -- -h
npm run cli -- health --json
```

While developing this checkout, expose the `webmcp` command on your PATH with:

```bash
npm run link:local
webmcp -h
```

## Agent Usage Contract

- Call `ping` first. If it fails, start
  `npx -y @gyga-browser/webmcp-browser-automation-kit gateway start` and reload
  the unpacked extension. In a local checkout, `npm run gateway` is equivalent.
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
| Gateway is not reachable from MCP                   | Start `npx -y @gyga-browser/webmcp-browser-automation-kit gateway start`, or `npm run gateway` inside a local checkout. For dev autostart set `WEBMCP_GATEWAY_AUTOSTART=1`. |
| `Chrome extension is not connected to the gateway` | Gateway is up but no extension is attached: load/reload the unpacked extension. |
| `Method not found`                                 | You may be calling a page tool as a top-level command. Use `webmcp.invokeTool`.                               |
| `navigator.modelContext not found`                 | Use a normal web page, wait for load, and reload the extension/page. Chrome internal pages are not supported. |
| `Another debugger is already attached`             | Only one debugger client can attach to a tab. Use another tab or detach the conflicting extension.            |
| Generated reference is stale                       | Run `npm run tools:generate`.                                                                                 |
