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
- `detectChromeInfo(chromePath)` runs `<chrome> --version` and returns `{ raw, major, channel }` (never throws).
- `detectChromeChannel(chromePath, versionOutput)` classifies a build as `stable`, `beta`, `dev`, `canary`, `testing`, `chromium`, or `unknown`.
- `loadExtensionSupported(info)` returns whether `--load-extension` is honored for that build (see "Chrome 137+" below).

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
  "args": ["--user-data-dir=...", "--load-extension=..."],
  "chromeVersion": "Google Chrome 149.0.7827.201",
  "chromeMajor": 149,
  "chromeChannel": "stable",
  "extensionPath": "/path/to/webmcp-extension/dist",
  "extensionId": "lbodkmkjbcemodklopcfdmpjomdoapae",
  "extensionStoreUrl": "https://chromewebstore.google.com/detail/webmcp-tools-provider/lbodkmkjbcemodklopcfdmpjomdoapae",
  "extensionLoadable": false,
  "warning": "Chrome will open, but the WebMCP extension will not auto-load on this build.",
  "guidance": "Google Chrome 149... ignores the --load-extension command-line switch (removed in M137)..."
}
```

`warning` and `guidance` are present only when `extensionLoadable` is `false`. The launch args no longer include `--disable-features=DisableLoadExtensionCommandLineSwitch`; that switch was a no-op after Chrome M137 removed it.

## Chrome 137+ and `--load-extension`

Stable/Beta Google Chrome dropped the `--load-extension` command-line switch in **M137**, so the bundled extension cannot be injected at launch on those builds. `launchChrome` reports this via `extensionLoadable: false` plus a `warning`/`guidance` pair instead of failing silently.

Builds where `--load-extension` still works (`extensionLoadable: true`): **Chromium**, **Chrome for Testing**, **Chrome Canary/Dev**, and stable/beta Chrome **older than M137**.

Remediation on an affected build:

1. Install WebMCP Tools Provider from the Chrome Web Store: <https://chromewebstore.google.com/detail/webmcp-tools-provider/lbodkmkjbcemodklopcfdmpjomdoapae>. It persists for that profile.
2. For local development, load the `dist` folder once via `chrome://extensions` → Developer mode → **Load unpacked**.
3. Or set `WEBMCP_CHROME_BINARY` to a compatible build.

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

Default state location is `~/.webmcp/`; override with `WEBMCP_HOME` (or its back-compat alias `WEBMCP_DATA_DIR`). This is the shared kit home, also used by the `webmcp-workflow` CLI for `workflow-runs/`.

- `managed-profiles/` stores isolated Chrome user-data dirs.
- `sessions.json` stores live Chrome and gateway PIDs. Dead PIDs are pruned automatically with `process.kill(pid, 0)`.

## CLI Contract

`webmcp launch --gateway --json` prints one JSON object. For automation, treat `profileId` as optional until the extension WebSocket connects; if it is `null`, inspect `GET http://localhost:7865/health`.
