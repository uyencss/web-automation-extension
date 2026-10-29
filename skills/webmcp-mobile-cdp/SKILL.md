---
name: webmcp-mobile-cdp
description: Zero-Extension Android Chrome CDP Automation (webmcp-mobile-cdp). Direct browser control on real Android devices (Xiaomi 13 reup-xm13, Note10) over ADB CDP port forwarding. Supports all 67+ WebMCP catalog commands, ARIA Snapshot R1/f1r2 tokens, file uploads, cookies, and connects to WebMCP Gateway (:7865) as a real mobile browser profile.
metadata:
  version: "1.0.0"
  requires:
    bins:
      - webmcp
      - adb
---

# WebMCP Zero-Extension Android Chrome CDP Automation (`webmcp-mobile-cdp`)

Drive real Google Chrome on Android devices (**Xiaomi 13 `reup-xm13`**, **Samsung Note10**, or any USB/TCP ADB target) **without needing any Chrome extensions installed**.

On Android, Chrome does NOT support desktop `.crx` extensions. `webmcp-mobile-cdp` bridges this gap by communicating directly with Chrome's native Chrome DevTools Protocol (CDP) over a dynamic ADB port-forward (`localabstract:chrome_devtools_remote`), executing `aria-snapshot.js` inside an isolated V8 execution context (`Page.createIsolatedWorld`), and mapping all 67+ WebMCP catalog commands onto native touch/CDP primitives.

---

## 1. Module Architecture & Source Paths

The implementation lives inside `@gyga-browser/webmcp-browser-automation-kit`:
`packages/webmcp-browser-kit/webmcp-mobile-cdp/`

| File | Purpose | LOC |
| :--- | :--- | :--- |
| **`session.mjs`** | ADB port forwarding (`tcp:0 -> localabstract:chrome_devtools_remote`), `/json/version` discovery, single Browser WebSocket connection, Target attach/detach lifecycle with auto-recovery. | ~107 |
| **`aria.mjs`** | `Page.createIsolatedWorld` cache per frame, evaluation of `aria-snapshot.js` without `chrome.runtime`, iframe bounding-box offset normalization (`f1r2`). | ~75 |
| **`primitives.mjs`** | High-level action primitives: `tap` (`Input.synthesizeTapGesture`), `scroll` (`Input.synthesizeScrollGesture`), `type` (CDP KeyEvents + submit), `screenshot`, `uploadFile` (ADB push + `DOM.setFileInputFiles`). | ~115 |
| **`catalog-map.mjs`** | Complete registry mapping all **67+ WebMCP catalog commands** (`newTab`, `listTabs`, `clickByRef`, `typeByRef`, `getAriaSnapshot`, `evaluateJS`, `querySelectorAll`, `cookies`, `waitForSelector`...) to mobile implementations. | ~185 |
| **`dispatch.mjs`** | Command dispatcher supporting single commands, sequential `batch` with `onError` control, and `connectGateway` bridge to WebMCP Gateway (`:7865`). | ~63 |

---

## 2. Direct Node API Usage

```javascript
import { createMobileSession } from './webmcp-mobile-cdp/session.mjs';
import { dispatchCommand, connectGateway } from './webmcp-mobile-cdp/dispatch.mjs';

// 1. Initialize mobile session (finds device, forwards port, connects browser WS)
const session = await createMobileSession({
  serial: '100.118.203.105:5555' // Xiaomi 13 Tailscale IP or leave undefined for auto-detect
}).init();

// 2. Open a new tab (dispatches Target.createTarget over Browser WS - Rule E2)
const tab = await dispatchCommand(session, 'newTab', { url: 'https://example.com' });

// 3. Capture ARIA snapshot (returns markdown tree with R1, R2... tokens)
const snap = await dispatchCommand(session, 'getAriaSnapshot', { tabId: tab.targetId });
console.log('Snapshot:', snap.snapshot);

// 4. Tap an element by ref (Rule E3: synthesized touch tap at element center)
await dispatchCommand(session, 'clickByRef', { tabId: tab.targetId, ref: 'R1' });

// 5. Type text with Vietnamese diacritics and submit
await dispatchCommand(session, 'typeByRef', {
  tabId: tab.targetId,
  ref: 'R2',
  text: 'Xin chào Việt Nam 🇻🇳',
  submit: true
});

// 6. Close session (closes WS and cleans up ADB port forwarding)
await session.close();
```

---

## 3. Connecting to WebMCP Gateway (`:7865`) as a Real Profile

To allow any agent or workflow that talks to the WebMCP Gateway (or uses native MCP tools `mcp_webmcp_*`) to drive the Android phone seamlessly:

```javascript
import { createMobileSession } from './webmcp-mobile-cdp/session.mjs';
import { connectGateway } from './webmcp-mobile-cdp/dispatch.mjs';

const session = await createMobileSession({ serial: '100.118.203.105:5555' }).init();

// Connects to gateway WebSocket and registers capabilities
const ws = connectGateway(session, {
  gatewayUrl: 'ws://127.0.0.1:7865',
  profileId: 'mobile-xm13',
  profileName: 'Xiaomi 13 Chrome Mobile'
});

console.log('Mobile Chrome is now registered as profile "mobile-xm13" on WebMCP Gateway!');
```

Once connected, all standard WebMCP tools (`getAriaSnapshot`, `clickByRef`, `typeByRef`, `navigate`, etc.) targeting profile `mobile-xm13` automatically execute on the Android device!

---

## 4. The 6 Empirical Rules (`E1`–`E6`) on Android Chrome CDP

Through rigorous empirical testing on Xiaomi 13 (`reup-xm13`, Android 13 HyperOS) and Samsung Note10, Chrome for Android enforces 6 specific behaviors:

### `E1`: Single Browser WS (`/devtools/browser`) with `flatten: true`
- Chrome Android does NOT expose stable per-tab HTTP endpoints or individual WebSocket URLs for background targets.
- **Rule**: Connect to `webSocketDebuggerUrl` from `http://127.0.0.1:<port>/json/version`. Then send:
  ```json
  {"id": 1, "method": "Target.setAutoAttach", "params": {"autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true}}
  ```
- All page targets are multiplexed over this single WebSocket using CDP `sessionId`.

### `E2`: Zero Calls to `PUT /json/new`
- Chrome Android drops, blocks, or returns HTTP 500 when receiving `PUT /json/new`.
- **Rule**: Always create new tabs via CDP command:
  ```json
  {"id": 2, "method": "Target.createTarget", "params": {"url": "https://example.com"}}
  ```
- Codebase maintains invariant: **0 occurrences of `/json/new`**.

### `E3`: `Input.synthesizeTapGesture` for `clickByRef` / `dispatchClick`
- Synthesized mouse clicks (`Input.dispatchMouseEvent`) frequently fail on mobile touch viewports or get ignored by mobile touch event handlers.
- **Rule**: Resolve the bounding box center `(x, y)` in CSS pixels and call:
  ```json
  {"id": 3, "sessionId": sid, "method": "Input.synthesizeTapGesture", "params": {"x": centerX, "y": centerY, "duration": 50, "tapCount": 1}}
  ```

### `E4`: `Input.synthesizeScrollGesture` with `{ exact: true }`
- Mouse wheel scrolls (`Input.dispatchMouseEvent` with `mouseWheel`) cause layout snapping or fail on mobile overflow containers.
- **Rule**: Use native touch swipe gesture synthesis:
  ```json
  {"id": 4, "sessionId": sid, "method": "Input.synthesizeScrollGesture", "params": {"x": startX, "y": startY, "xDistance": -deltaX, "yDistance": -deltaY, "speed": 800, "preventFling": true}}
  ```

### `E5`: `Page.createIsolatedWorld` Loading `aria-snapshot.js`
- `aria-snapshot.js` in desktop extensions relies on extension content scripts. On Android Chrome, extensions cannot run.
- **Rule**: Create an isolated JavaScript execution realm:
  ```json
  {"id": 5, "sessionId": sid, "method": "Page.createIsolatedWorld", "params": {"frameId": frameId, "worldName": "webmcp-isolated-aria"}}
  ```
- Execute `aria-snapshot.js` inside this isolated context without polluting the host page's `window` object or tripping CSP security boundaries.

### `E6`: `uploadFile` via `/data/local/tmp/webmcp-*` + `DOM.setFileInputFiles`
- Mobile Chrome cannot access macOS/host filesystem paths (e.g. `/Users/.../file.png`).
- **Rule**: The primitive pushes the local file to the Android device via ADB:
  ```bash
  adb -s <serial> push <localPath> /data/local/tmp/webmcp-<hash>-<filename>
  ```
- Then invokes CDP `DOM.setFileInputFiles` referencing the device path `/data/local/tmp/...`.

---

## 5. CLI Usage & Verification

### Using CLI Top-Level Routes
```bash
# Check device & Chrome CDP status
webmcp mobile-cdp status

# Or via mobile subcommand
webmcp mobile cdp status

# Connect device to Gateway
webmcp mobile-cdp connect --serial 100.118.203.105:5555 --profile-id mobile-xm13

# Execute a catalog command directly
webmcp mobile-cdp call listTabs
webmcp mobile-cdp call newTab '{"url":"https://google.com"}'
```

### Running Automated Tests
```bash
# 1. Run unit test suite (validates E1-E6, LOC <= 500, zero /json/new, isolated world)
node --test packages/webmcp-browser-kit/tests/mobile-cdp/mobile-cdp-primitives.test.mjs

# 2. Run live E2E test on Xiaomi 13 (reup-xm13)
node packages/webmcp-browser-kit/tests/mobile-cdp/live-xm13-e2e.mjs
```

---

## 6. Decision Routing: Mobile Web vs Native App

| Target Environment | Technology | Tool Surface | Reference Document |
| :--- | :--- | :--- | :--- |
| **Web pages inside Chrome Android** | `webmcp-mobile-cdp` (ADB CDP WebSocket) | `webmcp mobile-cdp ...` or `webmcp mobile cdp ...` | This document (`webmcp-mobile-cdp/REFERENCE.md`) |
| **Native Android Apps** (Facebook app, Zalo, TikTok, Settings) | `webmcp-adb-kit` (A11y Tree `@e1`, `@e2`) | `webmcp adb snap`, `tap`, `type` | `references/webmcp-adb-automation/REFERENCE.md` |
