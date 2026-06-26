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
3. Agent skill: `.agents/skills/webmcp-browser-automation`
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
| `npm run health`                        | Send `ping` through the gateway to confirm extension connectivity.                  |
| `npm run call -- <method> [jsonParams]` | Call one extension command through `POST /api`.                                     |
| `npm run tools:generate`                | Rebuild the generated skill reference from runtime source files.                    |
| `npm run tools:check`                   | Fail if the generated reference is stale or capability announcements lack handlers. |

## References

- Generated source-derived reference:
  `.agents/skills/webmcp-browser-automation/references/generated-tools.md`
- Human quick reference:
  `.agents/skills/webmcp-browser-automation/references/tool-reference-card.md`
- Extension README:
  `webmcp-extension/README.md`
- Gateway client helper:
  `examples/gateway_client.js`

## Troubleshooting

| Symptom                                            | Fix                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Chrome extension is not connected to the gateway` | Start `npm run gateway`, then reload the unpacked extension.                                                  |
| `Method not found`                                 | You may be calling a page tool as a top-level command. Use `webmcp.invokeTool`.                               |
| `navigator.modelContext not found`                 | Use a normal web page, wait for load, and reload the extension/page. Chrome internal pages are not supported. |
| `Another debugger is already attached`             | Only one debugger client can attach to a tab. Use another tab or detach the conflicting extension.            |
| Generated reference is stale                       | Run `npm run tools:generate`.                                                                                 |
