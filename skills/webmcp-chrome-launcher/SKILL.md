---
name: webmcp-chrome-launcher
description: Launch Google Chrome or Chromium with the bundled WebMCP extension, manage isolated or existing Chrome profiles, start the WebMCP gateway, and return a connected profileId for browser automation. Use when Codex needs to bootstrap WebMCP from scratch, recover from a gateway with no extension connected, create a fresh managed browser session, list/select Chrome profiles, or safely relaunch an existing user profile with the extension loaded.
---

# WebMCP Chrome Launcher

## MCP browser transport is mandatory

Use this skill before `webmcp-browser-automation` when no
`mcp__webmcp__*` tool is available, `webmcp health --json` fails,
`extensionConnected` is false, or a fresh isolated browser is better than using
the user's current Chrome.

1. Initialize the gateway first:

```bash
webmcp gateway start
```

   If Chrome/the extension also needs bootstrapping, initialize both with an
   isolated managed Chrome profile instead:

```bash
webmcp launch --name task-name --gateway --json
```

2. Parse the JSON output. Save `profileId` when present.
3. Start or connect the WebMCP MCP adapter:

```bash
webmcp mcp
```

4. Refresh/discover the runtime's `mcp__webmcp__*` tools and verify readiness
   with the MCP `list_profiles` or `ping` tool.
5. Continue with `webmcp-browser-automation`. If more than one profile is
   connected, pass the saved `profileId` on every MCP browser tool call.

Browser actions must go through the MCP server. Do not use `curl`,
`webmcp call`, or direct gateway `POST /api` requests as the action path. If the
runtime cannot attach the MCP server dynamically, report the transport blocker;
do not silently substitute `curl` or direct HTTP action calls.

## Profile Selection

List available profiles when the user asks to use a real Chrome profile or account:

```bash
webmcp profiles list --json
```

Managed profiles are isolated WebMCP-owned user-data dirs under `~/.webmcp/managed-profiles` unless `WEBMCP_HOME` (or its back-compat alias `WEBMCP_DATA_DIR`) overrides the location. Existing profiles are read-only detections from Chrome/Chromium/Edge profile metadata.

Launch a selected profile:

```bash
webmcp launch --profile-id "Chrome:Default" --gateway --json
```

Use `--name` for a new managed profile. Use `--profile-id managed:<slug>` to reopen an existing managed profile.

## Chrome 137+ does not auto-load the extension

Stable and Beta Google Chrome removed the `--load-extension` command-line switch in **M137** (and the old `--disable-features=DisableLoadExtensionCommandLineSwitch` escape hatch no longer works). On those builds Chrome opens the profile but the WebMCP extension is not injected.

`webmcp launch` detects this. When the resolved Chrome cannot auto-load the extension, the JSON output carries:

- `"extensionLoadable": false`
- a `"warning"` and step-by-step `"guidance"` string
- `chromeVersion`, `chromeMajor`, `chromeChannel`

When you see `extensionLoadable: false` (or `/health` keeps reporting `extensionConnected: false` after a launch), do **not** keep retrying. Pick one fix:

1. **Install the published extension (recommended).** Open the launched Chrome profile and install WebMCP Tools Provider from <https://chromewebstore.google.com/detail/webmcp-tools-provider/lbodkmkjbcemodklopcfdmpjomdoapae>. It persists for that profile, so later `webmcp launch` runs attach with the extension already present.
2. **Load unpacked for local development.** Print the path with `webmcp extension-path`, then in that Chrome open `chrome://extensions` → enable Developer mode → **Load unpacked** → select the printed `dist` folder.
3. **Use a build that still honors the switch.** Point `WEBMCP_CHROME_BINARY` at Chrome for Testing, Chrome Canary/Dev, or Chromium, then launch as usual.

Chrome for Testing, Canary/Dev, and Chromium report `extensionLoadable: true` and load the extension normally.

## Relaunch Safety

Chrome only injects `--load-extension` (on builds that still support it — see above) when the user-data-dir first boots. If an existing user profile is already running, `webmcp launch --profile-id ...` returns JSON with `needsRelaunch: true` and exits with code 2.

Do not retry with `--relaunch` until the user confirms that Chrome can be quit and restarted. After confirmation:

```bash
webmcp launch --profile-id "Chrome:Default" --gateway --relaunch --json
```

## Useful Commands

Dry-run without spawning Chrome:

```bash
webmcp launch --name smoke-test --dry-run --json
```

Show the bundled extension path:

```bash
webmcp extension-path
```

Show the published extension id, Chrome Web Store URL, and local development path:

```bash
webmcp extension-info --json
```

Override locations:

```bash
WEBMCP_HOME=/tmp/webmcp webmcp launch --name test --gateway --json
# WEBMCP_DATA_DIR is still honored as a back-compat alias of WEBMCP_HOME
WEBMCP_CHROME_BINARY=/path/to/chrome webmcp launch --name test --dry-run --json
```

## Closing Chrome Instances

Close a specific Chrome profile instance (via its connected extension session or PID):

```bash
webmcp close --profile-id "Chrome:Default"
# Or using email/name matching
webmcp close hieu2906090@gmail.com
webmcp close uyencss1
```

Close all connected Chrome profile instances:

```bash
webmcp close --all
```

## Force Quit All Chrome

Terminate all Chrome processes on the machine, regardless of profile or gateway state. This first attempts a graceful close via the gateway, then force-quits any remaining Chrome processes at the OS level:

```bash
webmcp quit
webmcp quit --json
```

Use this when you need a clean slate before launching a new session, or when Chrome is unresponsive.

## API Reference

Read `references/api-reference.md` when modifying launcher code or using the Node API directly.
