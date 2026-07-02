# WebMCP Chrome Launcher API Reference

Import from the package subpath:

```js
const {
  launchChrome,
  listAllProfiles,
  findProfileById,
  findChromeBinary,
  defaultExtensionPath,
} = require('@gyga-browser/webmcp-browser-automation-kit/chrome-launcher');
```

Local checkout usage:

```js
const launcher = require('./chrome-launcher');
```

## Core Functions

- `launchChrome(options)` launches Chrome with `--load-extension=<bundled dist>`.
- `listAllProfiles(options)` returns `{ managed, existing }`.
- `findProfileById(profileId, options)` returns one profile object or `null`.
- `findChromeBinary()` returns the detected Chrome/Chromium executable or `null`.
- `createManagedProfile(name, options)` creates an isolated profile under `~/.webmcp/managed-profiles`.
- `rememberManagedSession`, `hasLiveManagedSession`, `rememberGatewaySession`, and `getGatewaySession` persist process state in `sessions.json`.

## launchChrome Options

```js
await launchChrome({
  mode: 'managed',            // 'managed' or 'existing'
  newProfileName: 'agent-job',
  profile,                    // profile object from listAllProfiles/findProfileById
  extensionPath,              // default: bundled webmcp-extension/dist
  relaunch: false,            // true only after user confirms Chrome can quit
  dryRun: false,
  managedProfilesDir,
  sessionsFile,
  chromePath,
});
```

Successful result:

```json
{
  "ok": true,
  "pid": 12345,
  "chromePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "userDataDir": "/Users/me/.webmcp/managed-profiles/job",
  "profileDir": "Default",
  "mode": "managed",
  "attached": false,
  "args": ["--user-data-dir=...", "--load-extension=..."]
}
```

Existing locked profile result:

```json
{
  "ok": false,
  "needsRelaunch": true,
  "userDataDir": "...",
  "profileDir": "Default",
  "message": "Chrome is already running..."
}
```

## State Files

Default state location is `~/.webmcp/`; override with `WEBMCP_DATA_DIR`.

- `managed-profiles/` stores isolated Chrome user-data dirs.
- `sessions.json` stores live Chrome and gateway PIDs. Dead PIDs are pruned automatically with `process.kill(pid, 0)`.

## CLI Contract

`webmcp launch --gateway --json` prints one JSON object. For automation, treat `profileId` as optional until the extension WebSocket connects; if it is `null`, inspect `GET http://localhost:7865/health`.
