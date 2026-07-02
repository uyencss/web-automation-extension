# Chrome 137+ dropped `--load-extension` — launcher compatibility

> **Status:** implemented in `@gyga-browser/webmcp-browser-automation-kit` 1.0.24 (2026-07-02).

## Problem

The launcher booted Chrome with an unpacked extension using two flags:

```
--load-extension=<dist>
--disable-features=DisableLoadExtensionCommandLineSwitch
```

`--disable-features=DisableLoadExtensionCommandLineSwitch` was the escape hatch
that kept `--load-extension` working on Chrome **M120–M136** after Google started
gating it behind a feature flag. In **Chrome M137** Google removed the switch
entirely on the Stable and Beta channels, and the escape hatch with it.

Effect on modern stable Chrome (observed on Chrome 149):

- Chrome launches and opens the requested profile.
- `--load-extension` is silently ignored — the WebMCP extension is never loaded.
- The extension service worker never runs, so it never connects to the gateway.
- `GET /health` keeps returning `extensionConnected: false`, with no error to
  explain why.

Loading the same `dist` folder manually through `chrome://extensions`
(Developer mode → **Load unpacked**) still works, because that is a persistent
developer install recorded in the profile, not the command-line switch.

## What changed

### 1. Removed the dead flag

`baseArgs()` no longer emits `--disable-features=DisableLoadExtensionCommandLineSwitch`.
It is a no-op on M137+ and misleading to keep. Launch args are now:

```
--user-data-dir=<dir>
--load-extension=<dist>
--no-first-run
--no-default-browser-check
[--profile-directory=<dir>]
```

`--load-extension` is retained: it is still honored by Chromium, Chrome for
Testing, Chrome Canary/Dev, and stable/beta Chrome older than M137, and it is
harmless (ignored) on builds that dropped it.

### 2. Detect the Chrome build and report loadability

`launchChrome()` now runs `<chrome> --version` once and classifies the build:

- `detectChromeInfo(chromePath)` → `{ raw, major, channel }`.
- `detectChromeChannel(...)` → `stable | beta | dev | canary | testing | chromium | unknown`.
- `loadExtensionSupported(info)` → `false` only for `stable`/`beta` at major
  `>= 137`; `true` for Chromium / Chrome for Testing / Canary / Dev and for
  older stable/beta. Unknown builds are not blocked.

Every successful launch result gains `chromeVersion`, `chromeMajor`,
`chromeChannel`, `extensionPath`, and `extensionLoadable`. When
`extensionLoadable` is `false`, the result also includes a `warning` and a
step-by-step `guidance` string. The `webmcp launch` CLI prints the warning to
stderr (JSON on stdout stays machine-clean).

This converts a silent failure into an actionable message.

## Remediation surfaced to the user

1. **Load unpacked once (recommended, persists per profile).** Open
   `chrome://extensions`, enable Developer mode, click **Load unpacked**, and
   select the `webmcp-extension/dist` path (`webmcp extension-path`). Chrome
   remembers it, so later `webmcp launch` runs attach with the extension already
   present.
2. **Use a compatible build.** Set `WEBMCP_CHROME_BINARY` to Chrome for Testing,
   Chrome Canary/Dev, or Chromium, where `--load-extension` still works.

## Verification

```bash
npm test   # tests/unit/chrome-launcher.test.mjs covers channel detection,
           # the M137 loadability rule, and result annotation

# On stable Chrome >= 137 the warning is surfaced (no Chrome spawned):
node bin/webmcp.mjs launch --profile-id "Chrome:Default" --dry-run --json
# -> extensionLoadable: false, warning + guidance present
```
