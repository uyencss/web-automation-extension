# Chrome Web Store Submission Guide

Everything needed to publish `webmcp-extension` to the Chrome Web Store. The
build step and licensing are already done in this repo; the items below are the
manual dashboard steps only you can complete (they require your Google account).

## 1. Build the upload package

```bash
npm run build:extension
```

Produces `webmcp-extension/build/webmcp-extension-v<version>.zip` containing only
the runtime files (internal `docs/` notes are excluded). Re-run after bumping
`webmcp-extension/dist/manifest.json` `version`.

## 2. One-time account setup

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Pay the one-time **$5 USD** developer registration fee.
3. Accept the developer agreement.

## 3. Create the item and upload

1. Click **Add new item** and upload the zip from step 1.
2. Fill in the store listing (draft copy below).
3. Complete the **Privacy** tab (justifications below) — this is mandatory and
   is the most common cause of rejection for an extension like this.
4. Submit for review. First review typically takes a few business days; the
   `debugger` permission usually draws extra scrutiny.

## 4. Store listing copy (draft)

**Name:** WebMCP Tools Provider

**Summary (132 char max):**
> Control your browser from AI agents via a local bridge. Exposes page tools
> through WebMCP and runs automation commands locally.

**Detailed description:**
> WebMCP Tools Provider turns Chrome into a controllable automation surface for
> local AI agents and the Model Context Protocol (MCP).
>
> It connects to a local gateway over WebSocket (localhost only) and lets your
> own tools and agents:
> - Read page content, ARIA snapshots, and interactive elements
> - Click, type, scroll, and fill forms
> - Manage tabs and capture screenshots
> - Inspect cookies, storage, and network activity
> - Invoke page-defined tools registered via navigator.modelContext (WebMCP)
>
> All communication stays on your machine — the extension only talks to a
> gateway you run on localhost. Nothing is sent to any third-party server.
>
> This extension is intended for developers building browser automation with
> MCP-compatible agents (Claude, Cursor, Codex, and others).

**Category:** Developer Tools

**Language:** English

## 5. Privacy tab — required justifications

Single purpose statement:
> Expose the current browser to a local, user-run automation gateway so AI
> agents can read and operate web pages on the user's behalf.

Per-permission justification (paste into each field):

| Permission | Justification |
| --- | --- |
| `debugger` | Used to perform reliable input (clicks, keystrokes), capture screenshots, and intercept network activity via the Chrome DevTools Protocol — capabilities the standard extension APIs cannot provide for automation. |
| `<all_urls>` host access | The extension is a general-purpose automation tool; the user directs it at whichever site they are automating, so access cannot be limited to a fixed list. |
| `scripting` | Injects the content-script bridge and the page-tool registration script so pages can expose WebMCP tools. |
| `tabs` | Lists, creates, switches, and closes tabs as part of automation commands. |
| `activeTab` | Operates on the tab the user is currently driving. |
| `storage` | Persists local extension settings and connection state. |
| `downloads` | Saves files/screenshots produced by automation to the user's machine. |
| `alarms` | Keeps the background service worker / gateway connection alive. |

Data usage disclosures (check on the form):
- **Does NOT** collect or transmit user data to remote servers.
- All network traffic is to `localhost` / `127.0.0.1` only (see manifest CSP).
- No analytics, no ads, no remote code.

> If you do not host a public privacy policy, a short page stating "This
> extension communicates only with a local gateway on the user's own machine
> and collects no personal data" satisfies the requirement. Link it in the
> Privacy tab.

## 6. Assets you still need to provide

The dashboard requires images you must create yourself:

- **Icon:** already included (128×128 in the zip). ✅
- **Screenshots:** at least one, 1280×800 or 640×400 PNG/JPEG. Show the
  extension working with an agent (e.g. a terminal driving the browser).
- **Small promo tile (optional):** 440×280.

## 7. After approval

- Bump `version` in `webmcp-extension/dist/manifest.json` for each update,
  re-run `npm run build:extension`, and upload the new zip.
- The store version (`2.1.0`) is independent of the npm package version
  (`1.0.7`); keep them moving on their own tracks.
