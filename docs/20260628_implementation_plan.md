# Implementation Plan — Web-Automation-Extension

> The analysis and comparison of the three extensions has been split into
> [`extension/evaluation-vs-browser-mcp-codex.md`](extension/evaluation-vs-browser-mcp-codex.md).
> This file only contains the **action plan**.

## Guiding Principles

This product is an **automation kit distributed through npm**, controlled by an
**AI agent** over localhost WebSocket. It is NOT a human-in-the-loop browser
companion. Every feature must answer: _"Does this help an AI agent control the
browser, or is it only polish for a human observer?"_ Keep the architecture
minimal, modular, and readable.

---

## ✅ Phase 1 — Interaction Reliability (DONE)

Implemented (commit not yet pushed). This closes the most important reliability
gap with Browser-MCP / Codex.

| Item                                                                                                              | File                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ARIA snapshot + ref-based interaction (`getAriaSnapshot`, `clickByRef`, `typeByRef`, `hoverByRef`, `selectByRef`) | `webmcp-extension/dist/bg/handlers/aria-snapshot.js`                    |
| Page stability + auto-wait after `click`/`type` (`waitForStable`)                                                 | `webmcp-extension/dist/bg/handlers/page-stability.js`, `high-level.js`  |
| Alarm-based reconnect + exponential backoff                                                                       | `webmcp-extension/dist/bg/ws-client.js`                                 |
| Chrome Alarms keepalive (replaces `setInterval`)                                                                  | `webmcp-extension/dist/background.js`                                   |
| CSP hardening (`content_security_policy`)                                                                         | `webmcp-extension/dist/manifest.json`                                   |
| Updated catalog + skill docs                                                                                      | `catalog/command-catalog.js`, `server/mcp-tool-catalog.mjs`, `skills/…` |

**Remaining for Phase 1:** verify + commit (see [Verification](#verification)).

---

## 🟢 Phase 2 — Two Items Actually Worth Doing

### 2.1 Popup Status (Connection Diagnostics Only)

**Problem:** When the gateway is disconnected, the user has no signal for diagnostics.

**Scope — intentionally minimal (NO settings/command log):**

- Show: Gateway `✓/✗`, WS state (connecting / connected / reconnecting), current active tab,
  and the latest reconnect attempt count.
- Read-only. Get state from the background via `chrome.runtime.sendMessage`.

**Files:**

- `webmcp-extension/dist/popup/popup.html` — static markup (CSP-compliant: no inline script)
- `webmcp-extension/dist/popup/popup.js` — query state, render
- `webmcp-extension/dist/manifest.json` — add `"action": { "default_popup": "popup/popup.html" }`
- `webmcp-extension/dist/background.js` — add a `getStatus` message handler returning
  `{ wsState, gatewayUrl, activeTabId, reconnectAttempt }`

**Acceptance:** Open the popup while the gateway is off -> it shows `✗`; start the gateway -> it
switches to `✓` within a few seconds.

### 2.2 WS Security Hardening (Replacement for Native Messaging)

**Problem:** WS binds to `ws://localhost:7865` with no auth, so any local process can connect.

**Scope:**

- Gateway server **binds to `127.0.0.1`** (not ambiguous `0.0.0.0`/`localhost`).
- **Shared token** in the handshake: the gateway generates a token on startup and writes it
  to a file (for example, `~/.webmcp/token`); the extension reads the token (through
  popup/storage or config) and sends it when connecting; the gateway rejects connections
  without the correct token.
- Origin check: reject WS upgrades from unexpected origins (DNS rebinding protection).

**Files:**

- `server/mcp_server.mjs` (and the corresponding gateway file) — bind 127.0.0.1, token generation + verification, origin check
- `webmcp-extension/dist/bg/ws-client.js` — send the token in the handshake/first message
- Setup docs: describe how the extension obtains the token

**Acceptance:** Connection without a token -> rejected; connection with the correct token -> works normally.

> [!NOTE]
> This is the Native Messaging alternative: much cheaper, preserves the one-command
> `npx … mcp` distribution model, and captures ~80% of the security benefit.

---

## 🟡 Phase 3 — Optional (Only When There Is a Concrete Need)

### 3.1 History / Bookmarks / TopSites

This is a real capability expansion (AI searches for "last week's article"), low-effort,
additive, and does not touch the architecture. **But** it adds privacy-sensitive permissions.

-> Only implement when a task requires browsing context. When doing it:

- Permissions: `"history"`, `"bookmarks"`, `"topSites"`
- Handlers: `searchHistory`, `getBookmarks`, `getTopSites`
- Update `command-catalog.js` + skill docs

---

## ❌ Removed From The Plan (Does Not Fit The Product)

Kept here so these do not get proposed again; reactivate only if the product context changes.

| Feature                          | Reactivation condition (if any)                             |
| -------------------------------- | ----------------------------------------------------------- |
| Visual cursor overlay            | If a human-in-the-loop / demo mode is added                 |
| Favicon badge                    | Same as above                                               |
| Session management / tab leasing | When **multiple agents control the same Chrome concurrently** |
| Graceful update lifecycle        | If distributed through Chrome Web Store with auto-update    |
| Tab Groups                       | Alongside session management                                |
| Notifications                    | No — redundant with the MCP channel                         |
| Native Messaging transport       | No — replaced by WS hardening                               |

---

## Verification

### Automated

```bash
node server/mcp_server.mjs &      # MCP server starts successfully
npm run health                    # gateway health
npm run tools:check               # tool catalog sync
```

### Manual (Phase 1 — Run Before Commit)

- Load the extension into Chrome and verify it connects to the gateway.
- `getAriaSnapshot` on one SPA + one static page -> valid ref IDs exist.
- `clickByRef` / `typeByRef` using the ref just captured -> interacts with the correct element.
- Page stability: click an element that loads dynamic content -> the next action waits for DOM stability.
- Reconnect: restart the gateway -> the extension reconnects automatically (exponential backoff, no spam).
- Keepalive: leave idle for > 60s -> the service worker does not die and heartbeat keeps running.

### Manual (Phase 2)

- Popup reflects the correct state when the gateway is turned on/off.
- WS rejects missing/wrong-token connections and accepts the correct token.

---

## Priority Summary

| Priority | Work                                                               | Status                    | Effort  |
| ------- | ------------------------------------------------------------------ | ------------------------- | ------- |
| ✅      | Phase 1 — reliability (ARIA, stability, reconnect, keepalive, CSP) | Done, needs verify + commit | —     |
| 🟢 P1   | Popup status                                                       | Not done                  | Low     |
| 🟢 P1   | WS security hardening                                              | Not done                  | Low–Med |
| 🟡 P2   | History/Bookmarks/TopSites                                         | Optional                  | Low     |
| ❌      | Rest of the old plan                                               | Removed / deferred        | —       |
