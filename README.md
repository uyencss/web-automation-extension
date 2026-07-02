# WebMCP Browser Automation Kit

Reusable kit for AI agents that need to operate Chrome through a local browser
extension.

The kit has three layers:

1. Runtime extension: `webmcp-extension/dist`
   - Chrome unpacked extension.
   - Injects `register-tools.js` into pages.
   - Exposes background commands for tabs, CDP input, screenshots, cookies,
     storage, viewport control, console capture, fast ARIA snapshots, and
     WebMCP page-tool bridging.
2. Gateway server: `server/gateway_server.js`
   - WebSocket endpoint for the extension at `ws://localhost:7865`.
   - HTTP endpoint for agents/scripts at `POST http://localhost:7865/api`.
   - Health endpoint at `GET http://localhost:7865/health`.
3. MCP server adapter: `server/mcp_server.mjs`
   - Stdio MCP server for Claude Desktop, Cursor, Claude Code, Cline, and
     other MCP clients.
   - Generates MCP tools from `catalog/command-catalog.js`.
   - Proxies each tool call to the gateway HTTP API.
4. Package CLI: `bin/webmcp.mjs`
   - Exposes `webmcp mcp`, `webmcp gateway start`, `webmcp launch`,
     `webmcp profiles list`, `webmcp health`, and `webmcp call`.
   - Exposes an optional `webmcp workflow` bridge when
     `@gyga-browser/webmcp-workflow` is installed separately.
   - Supports npm/npx-style MCP configs without absolute repo paths through the
     released npm package.
5. Chrome launcher: `chrome-launcher/`
   - Finds Chrome/Chromium, launches managed or existing profiles with the
     bundled extension, persists session state under `~/.webmcp` (override with
     `WEBMCP_HOME`, or its back-compat alias `WEBMCP_DATA_DIR`), and can start
     the gateway for a full bootstrap flow.
6. Agent skills: `skills/webmcp-browser-automation` and `skills/webmcp-chrome-launcher`
   - Tells agents to health-check, choose a tab, call `webmcp.listTools`, invoke
     page tools through `webmcp.invokeTool`, parse nested MCP results, and verify
     each browser action.
   - Tells agents how to launch Chrome, select profiles, and safely handle
     relaunches for already-running user profiles.

`catalog/command-catalog.js` is used by the MCP adapter to generate tool schemas.

## Quick Start

For normal use, you do not need to clone this repository. Run the published npm
package with `npx` and configure your MCP client to start the same package.

Launch a managed Chrome profile with the bundled extension and gateway:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit launch --name agent-session --gateway --json
```

The final JSON includes `userDataDir`, `gatewayUrl`, and, once the extension
connects, `profileId`. Use that `profileId` for multi-profile gateway calls.

> **Chrome 137+ note.** Stable and Beta Google Chrome removed the
> `--load-extension` command-line switch in **M137**, so on those builds Chrome
> opens but the extension is not injected. `webmcp launch` detects this and
> returns `"extensionLoadable": false` with a `warning`/`guidance` message
> instead of failing silently. When you see it, either load the extension once
> via `chrome://extensions` (Developer mode → **Load unpacked** → the path from
> `extension-path`), which persists for that profile, or point
> `WEBMCP_CHROME_BINARY` at Chrome for Testing, Chrome Canary/Dev, or Chromium,
> where `--load-extension` still works.

List managed and detected user profiles:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit profiles list --json
```

Launch an existing profile only after selecting its id. If Chrome is already
running, the command returns `needsRelaunch: true`; ask the user before retrying
with `--relaunch`.

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit launch --profile-id "Chrome:Default" --gateway --json
```

Manual fallback: print the unpacked extension path:

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

Capture page console output around an automation step:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit call startConsoleCapture '{"tabId":123}'
npx -y @gyga-browser/webmcp-browser-automation-kit call evaluateJS '{"tabId":123,"code":"console.log(\"hello\"); console.error(\"fail\")"}'
npx -y @gyga-browser/webmcp-browser-automation-kit call readConsoleMessages '{"tabId":123,"level":"error"}'
npx -y @gyga-browser/webmcp-browser-automation-kit call stopConsoleCapture '{"tabId":123}'
```

Invoke a page-registered WebMCP tool:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit call webmcp.invokeTool \
  '{"tabId":123,"toolName":"get_page_metadata","input":{"include_headings":true}}'
```

Read the visible page structure with compact persistent refs:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit call getAriaSnapshot \
  '{"tabId":123,"scope":"viewport","maxNodes":120,"maxChars":12000}'
```

Fast ARIA snapshots run in the content script by default, filter to the
viewport, redact sensitive form values, keep refs stable across repeated reads,
inline native select options, and fall back to the native CDP Accessibility tree
when needed. Use refs like `r1` or iframe refs like `f3r1` with `clickByRef`,
`typeByRef`, `hoverByRef`, and `selectByRef`.

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

#### Choosing how many tools are exposed (`WEBMCP_TOOLS`)

By default the MCP server exposes a lean **"minimal" set** (~26 tools) covering
the common loop — tabs, smart page reads, ARIA ref-based interaction, a
coordinate-click fallback (`getElementBounds` → `dispatchClick`), waits, and
screenshots — to keep the per-request tool schema small and reduce tool-selection
ambiguity. Lower-frequency commands (cookies/storage, windows/viewport, console
capture, low-level input, raw CDP, `pageFetch`, `listFrames`, diagnostics, and
superseded commands like `getPageContent` or the CSS-selector variants
`click`/`type`/`hover`/`selectOption`) are hidden from the first-class list but
**remain fully callable** via `browser_raw_command`, so nothing is lost.

Set the `WEBMCP_TOOLS` environment variable to change this:

| Value | Effect |
|---|---|
| _unset_ or `minimal` | Leanest set (~26 tools, default). Hidden tools still reachable via `browser_raw_command`. |
| `core` | Broader lean set (~46 tools): only the superseded/CSS-variant commands are hidden. |
| `full` | Expose every supported command as its own MCP tool. |
| `getAriaSnapshot,clickByRef,evaluateJS` | Custom allowlist (comma/space separated gateway methods or `snake_case` tool names). `browser_raw_command` is always included. |

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "npx",
      "args": ["-y", "@gyga-browser/webmcp-browser-automation-kit", "mcp"],
      "env": { "WEBMCP_TOOLS": "full" }
    }
  }
}
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
local checkout and run the installer. The installer defaults to the published
package for MCP (`npx -y @gyga-browser/webmcp-browser-automation-kit mcp`) while
copying `skills/webmcp-browser-automation` into providers that support
file-based skills:

```bash
cd /path/to/web-automation-extension
npm run install:codex
npm run install:claude
```

Other supported installer targets:

```bash
npm run install:cursor
npm run install:copilot
npm run install:antigravity
```

To print or apply all supported targets:

```bash
npm run install:agent
```

For local development, set `WEBMCP_INSTALL_MODE=local`; the installer then
writes config that points at your checkout's absolute `server/mcp_server.mjs`
path:

```bash
cd /path/to/web-automation-extension
WEBMCP_INSTALL_MODE=local npm run install:codex
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

Inside this monorepo checkout, workflow runner commands are available through
the same `webmcp` CLI:

```bash
node bin/webmcp.mjs workflow validate ../webmcp-workflow-cli/tests/fixtures/minimal-workflow.json
node bin/webmcp.mjs workflow dry-run ../webmcp-workflow-cli/tests/fixtures/example-title-workflow.json --json
node bin/webmcp.mjs workflow run minimal --config ../webmcp-workflow-cli/tests/fixtures/dispatcher.config.json --profile personal
```

This package does not install the workflow runner. For published npm workflow
usage, install the independent workflow package in the same project/global
context, or include both packages in an `npx` invocation:

```bash
npx -y -p @gyga-browser/webmcp-browser-automation-kit -p @gyga-browser/webmcp-workflow webmcp workflow --help
npx -y @gyga-browser/webmcp-workflow run workflow.json
```

After global install or `npm link`, the same commands are available as:

```bash
webmcp mcp
webmcp gateway start
webmcp gateway health --json
webmcp call ping
webmcp workflow doctor
webmcp workflow run minimal --config ../webmcp-workflow-cli/tests/fixtures/dispatcher.config.json --profile personal
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
- Prefer `getAriaSnapshot` for page structure. It defaults to the fast
  content-script snapshot with compact persistent refs, viewport filtering,
  option rendering, and `maxChars` protection.
- Call `webmcp.listTools` before using any page tool.
- Call page tools only through `webmcp.invokeTool` with `params.toolName`.
- Parse nested MCP text from `response.result.result.content[0].text` when using
  the HTTP gateway.
- After each action, verify with a wait, query, screenshot, or another
  `getAriaSnapshot` (`getInteractiveElements` works too but is hidden on the
  default minimal surface — reach it via `browser_raw_command` or `WEBMCP_TOOLS=core`).

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

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 uyencss.
