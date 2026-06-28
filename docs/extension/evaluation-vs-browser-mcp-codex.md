# Evaluation: Web-Automation-Extension vs Browser-MCP & Codex Extension

> This file only contains **analysis & evaluation**. The action plan has been split into
> [`implementation_plan.md`](implementation_plan.md).

## Overview

Comparison of architecture, features, and implementation quality across three extensions:

| Criterion | Web-Automation (Yours) | Browser-MCP | Codex |
|---|---|---|---|
| **Architecture** | Extension <-> WS Gateway <-> MCP Server (3 layers) | Extension <-> Built-in MCP (2 layers) | Extension <-> Native Messaging (2 layers) |
| **Communication** | WebSocket (ws://localhost:7865) | WebSocket (ws://localhost) | Chrome Native Messaging |
| **Source code** | Readable ES modules, not bundled | Bundled/minified (~840KB bg.js) | Bundled/minified (~145KB bg.js) |
| **MCP Protocol** | Standard `@modelcontextprotocol/sdk` | Custom implementation (Playwright-style tools) | Native Messaging (JSON-RPC) |
| **Multi-agent** | 5 agent installers (Claude, Codex, Copilot, Antigravity, Cursor) | VS Code / Cursor / Claude integration | Codex CLI only |
| **npm package** | ✅ `@gyga-browser/webmcp-browser-automation-kit` | ❌ Chrome Web Store only | ❌ Chrome Web Store only |

---

## ⭐ Evaluation Lens: Three Fundamentally Different Products

This is the key point behind every feature comparison. The three extensions are not the
same kind of product, so features in one extension cannot automatically be treated as a
"standard" the others must chase:

- **Codex extension** = consumer product, runs in the user's daily Chrome, many tabs,
  with a **human observing** -> needs tab leasing, favicon badge, tab groups, graceful
  auto-update.
- **Browser-MCP** = companion with a **human-in-the-loop** and a React popup -> needs a
  visual cursor for the observer.
- **Yours** = **MCP kit distributed through npm** (`npx ... mcp`), controlled by an
  **AI agent** over localhost WS. The browser "user" is the AI, not a human.

Therefore, most "missing" features versus Codex/Browser-MCP are actually **consumer-product
polish** and do not match the use case of an automation kit. This is the basis for removing
most of Phases 2-4 from the old plan.

---

## Strengths Of Web-Automation-Extension

### ✅ Clean, Extensible Architecture
- **Modular handler system**: Clearly split into `tab-management.js`, `high-level.js`,
  `cdp-actions.js`, `cdp-input.js`, `ai-vision.js`, `full-control.js`, `network-intercept.js`
- **Gateway pattern**: Separates transport (WS) from business logic, making it easy to
  replace the gateway with another protocol
- **Publishable npm package**: One-command install with `npx -y @gyga-browser/webmcp-browser-automation-kit mcp`

### ✅ Page-level tool registration (navigator.modelContext)
- Polyfill `navigator.modelContext` lets websites register their own tools, a unique feature
  that neither Browser-MCP nor Codex has
- Bridge architecture (ISOLATED <-> MAIN world) follows Manifest V3 well

### ✅ Network interceptor best-in-class
- Multiple concurrent patterns, event-driven waiters, ring buffer, proactive body capture:
  more production-grade than both reference extensions

### ✅ AI Vision capabilities
- `getAccessibilityTree`, `getDOMSnapshot`, `getElementBounds`, `getInteractiveElements`:
  a complete tool set for the AI to "see" web pages

### ✅ Multi-agent installer
- `install-agent.mjs` supports five runtimes (Claude, Codex, Copilot, Antigravity, Cursor),
  which is very convenient for distribution

---

## Browser-MCP Strengths (What Was Learned)

### 🏆 Accessibility Snapshot Instead Of CSS Selector — ✅ ADOPTED
ARIA snapshot + ref-based interaction is more robust than CSS selectors on SPAs. Implemented
in `aria-snapshot.js`.

### 🏆 Page Stability Detection — ✅ ADOPTED
Auto-wait for DOM stability after each action. Implemented in `page-stability.js`.

### 🏆 Visual Cursor Feedback — ❌ NOT APPLICABLE
Animated cursor overlay is for **human observers**. This AI-controlled CLI kit already has
screenshots for seeing state. Purely cosmetic.

### 🏆 Rich Popup UI (React) — 🔸 PARTIALLY APPLICABLE
A full popup is over-engineering. Only a **status** popup is needed for connection diagnostics.

### 🏆 Performance Monitoring (Sentry / Web Vitals) — ❌ NOT APPLICABLE
Consumer-product observability. Not appropriate for a local-running kit.

---

## Codex Extension Strengths (What Was Learned)

### 🏆 Native Messaging Transport — ❌ NOT APPLICABLE
Safer because it does not open a port, but it **conflicts with the core value**: npm
distribution + one-command `npx mcp`. Native hosts require OS-specific manifests and are
hard to install, breaking the biggest advantage. WS-on-localhost is the *right* choice.
Instead, harden WS (bind 127.0.0.1 + token).

### 🏆 Chrome Alarms (keepalive + reconnect) — ✅ ADOPTED
Replaced `setInterval` with `chrome.alarms` + exponential backoff reconnect.

### 🏆 CSP For Extension Pages — ✅ ADOPTED
Added `content_security_policy` to the manifest.

### 🏆 Session Management & Tab Leasing — ❌ DEFERRED
Highest effort, only solves conflicts when **multiple agents control the SAME Chrome
concurrently**, which is not yet a real scenario. Multi-agent installer != multi-agent
concurrency. Premature.

### 🏆 Favicon Badge / Tab Group Management — ❌ NOT APPLICABLE
Features for humans observing many tabs in their daily browser. That context does not exist here.

### 🏆 Update Lifecycle Management — ❌ NOT APPLICABLE
Codex auto-updates from the Web Store during end-user sessions. This kit is loaded unpacked/dev.

### 🏆 Broader Chrome API (History, Bookmarks, Downloads...) — 🔸 OPTIONAL
History/Bookmarks/TopSites is a real capability expansion: low-effort and additive. But it
adds privacy-sensitive permissions, so only do it when a concrete task requires it.

---

## Re-evaluating The Necessity Of Each Remaining Feature

| Feature (old plan) | Conclusion | Reason |
|---|---|---|
| ARIA snapshot interaction | ✅ **Done** | Closes the most important reliability gap |
| Page stability detection | ✅ **Done** | — |
| Alarm-based reconnect | ✅ **Done** | — |
| Chrome Alarms keepalive | ✅ **Done** | — |
| CSP hardening | ✅ **Done** | — |
| Popup UI | 🟢 **Should do (narrowed)** | Only connection status is needed for debuggability, not full settings |
| WS security hardening | 🟢 **Should do** | Replacement for Native Messaging: cheap, captures 80% of the security benefit |
| History / Bookmarks / TopSites | 🟡 **Optional** | Real capability expansion, but only when needed |
| Visual cursor overlay | 🔴 **Remove** | Feature for human observers; AI already has screenshots |
| Favicon badge | 🔴 **Remove** | No daily-browser user context |
| Session management / tab leasing | 🔴 **Defer** | Premature; no real multi-agent concurrency yet |
| Graceful update lifecycle | 🔴 **Remove** | No Web Store auto-update |
| Tab Groups | 🔴 **Remove** | Only useful with session management |
| Notifications | 🔴 **Remove** | Redundant; AI already responds through the MCP channel |
| Native Messaging transport | 🔴 **Remove** | Breaks the one-command npm distribution model |

---

## Conclusion

The original plan treated Codex/Browser-MCP as the "standard to catch up with." After
re-evaluation:

1. **You have caught up in the right important areas**: interaction reliability (ARIA
   snapshot, page stability, reconnect/keepalive, CSP) is done.
2. **Most of the remaining work is consumer-product feature work**, which this kit is not.
   Doing it would increase maintenance surface without serving the real user (the AI agent).
3. **Only two items are genuinely worth doing**: popup status (debuggability) and WS security
   hardening (replacement for Native Messaging).

> [!TIP]
> Your extension still has the best architecture of the three: clean, modular, readable
> source, npm-publishable. Keep that simplicity; do not add consumer-product features to
> an automation kit.
