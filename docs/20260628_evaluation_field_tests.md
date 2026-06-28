# Field Evaluation — WebMCP Extension
**Date:** 2026-06-28  
**Tested by:** Gemini Flash 3.5 (session 1) + Codex (session 2)  
**Tasks:** General browser automation / YouTube video scraping / YouTube transcript extraction

---

## Summary

WebMCP is a strong browser automation tool for AI agents operating inside a real Chrome session. Both evaluations agree on core strengths and surface a consistent set of friction points.

---

## Confirmed Strengths

| Strength | Evidence |
|---|---|
| Bypass anti-bot / Cloudflare | Works via real user Chrome session (cookies, fingerprint) — no configuration needed |
| ARIA snapshot ref-based interaction | `getAriaSnapshot` → `clickByRef`/`typeByRef` stable across SPA re-renders |
| `waitForStable` on standard pages | Correctly detects DOM quiet after navigation, form submit, route change |
| `evaluateJS` escape hatch | Handles any logic not covered by built-in tools |
| Network capture | Event-driven, proactive body fetch, ring buffer — robust for XHR/fetch interception |
| Real session data | Reads cookies/localStorage of logged-in session without re-auth |

---

## Issues Found — Session 1 (Gemini Flash 3.5)

| # | Issue | Root cause | Status |
|---|-------|-----------|--------|
| 1 | Connection lost when closing last tab | MV3 service worker killed by Chrome (~30s idle); no inbound WS traffic to reset timer | **Fixed** — gateway pings extension every 15s |
| 2 | Data truncated at 50k/100k chars, no way to page | Hard-coded `.slice()` in `getPageContent`, no `offset` param | **Fixed** — `maxLength`/`offset`/`format` added; `querySelectorAll` added |
| 3 | Calling page tool as extension command gives terse error | Router returned bare `Method not found: X` | **Fixed** — router now detects page tools and suggests `webmcp.invokeTool` |

---

## Issues Found — Session 2 (Codex / YouTube transcript task)

| # | Issue | Root cause | Status |
|---|-------|-----------|--------|
| 4 | `waitForStable` timeouts on video page | YouTube player mutates DOM continuously (timestamp tick = `characterData` every 250ms, progress bar = `style` attribute every frame) | **P0 — to implement** |
| 5 | Tool output nested JSON requires manual parse each call | Gateway returns raw `result.result.content[0].text` as string; AI must always unwrap | **P1 — to implement** |
| 6 | No stable way to read JS framework globals (ytInitialData, __NEXT_DATA__, etc.) | No `getWindowVariable` command; must use raw `evaluateJS` with no schema/size control | **P2 — to implement** |
| 7 | CSS selectors unreliable on YouTube (class names change) | No text-based element finder; ARIA snapshot is good but doesn't cover "find by visible text" | **P3 — to implement** |
| 8 | Page tool errors invisible at HTTP level (always 200) | `{ error: true }` buried in JSON body; AI sees success response before parsing | **P4 — to implement** |

---

## Pattern: YouTube-specific vs General

Issues 4–8 were surfaced on YouTube but are **framework-agnostic**:

- `waitForStable` breaks on any page with continuous DOM mutations: live chat, data dashboards, video players, real-time feeds
- Nested JSON affects every page tool call on every site
- `getWindowVariable` is useful on Next.js, Nuxt, Redux, React Query, Shopify, X/Twitter, TikTok, any SSR app
- `findByText` is useful any time class names are unstable (i.e., most modern SPAs)
- Error invisibility affects all page tool errors on all sites

---

## Evaluation Matrix

| Capability | Score | Notes |
|---|---|---|
| Connection stability | ⭐⭐⭐⭐⭐ | After gateway ping fix |
| Standard page extraction | ⭐⭐⭐⭐⭐ | ARIA + network capture combo is excellent |
| Video / live page handling | ⭐⭐⭐ | waitForStable needs tuning params |
| Data-rich SPA extraction | ⭐⭐⭐ | No window variable reader yet |
| Developer ergonomics (AI DX) | ⭐⭐⭐ | Nested JSON + silent errors need fixing |
| Anti-bot resilience | ⭐⭐⭐⭐⭐ | Best-in-class (real session) |

**Overall: 4/5 → targeting 4.5/5 after P0–P4**
