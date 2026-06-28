# Implementation Plan — P0–P4 Improvements
**Date:** 2026-06-28  
**Based on:** Field evaluation from Gemini Flash 3.5 + Codex sessions  
**Reference:** `docs/20260628_evaluation_field_tests.md`

---

## P0 — `waitForStable` tuning params

**Problem:** Any page with continuous DOM mutations (video player, live chat, real-time dashboard) causes timeout because `maxMutations=2` is breached every 150ms poll.

**Root cause:** Observer watches `document.documentElement` with `characterData: true`. YouTube timestamp tick emits `characterData` every 250ms; progress bar emits `style` attribute changes every frame.

**Solution:** Add three optional params — all backward compatible (defaults preserve current behavior):

| Param | Type | Default | Effect |
|---|---|---|---|
| `watchSelector` | string | `null` (=document) | Only observe a specific subtree |
| `ignoreSelectors` | string[] | `[]` | Exclude matching elements from mutation counting |
| `ignoreCharacterData` | boolean | `false` | Don't count text node changes |

**File:** `webmcp-extension/dist/bg/handlers/page-stability.js`

**Usage example (video page):**
```json
{ "method": "waitForStable", "params": { "watchSelector": "#contents", "ignoreCharacterData": true, "minStableMs": 600 } }
```

---

## P1 — Auto-unwrap nested JSON at gateway

**Problem:** Every page tool response is wrapped:
```
HTTP response → result → result → content[0].text → "{\"count\":20,...}"
```
AI must parse manually every time, silently fails if it forgets.

**Solution:** In `gateway_server.js`, after receiving the extension response, check if `result.result.content[0].text` is valid JSON and if so, add `result.parsedContent` with the parsed value. Original `result.result` stays untouched for backward compatibility.

**File:** `server/gateway_server.js`

**After:**
```json
{ "result": { "tabId": 64, "parsedContent": { "count": 20, "elements": [...] }, "result": { ... } } }
```

---

## P2 — `getWindowVariable` command

**Problem:** No way to read `window.ytInitialData`, `window.__NEXT_DATA__`, `window.__NUXT__`, etc. without raw `evaluateJS` with no schema, size, or error control.

**This is the #1 data extraction shortcut on modern SPAs** — virtually every SSR/hydrated app injects its server-fetched data into a window variable.

Known variables by platform:
- YouTube: `ytInitialData`, `ytcfg`
- Next.js: `__NEXT_DATA__`
- Nuxt.js: `__NUXT__`
- Redux: `__REDUX_STATE__`, `__PRELOADED_STATE__`
- React Query: `__REACT_QUERY_STATE__`
- Apollo GraphQL: `__APOLLO_STATE__`
- Remix: `__remixContext`
- Shopify: `Shopify`, `ShopifyAnalytics`
- Twitter/X, TikTok: `__INITIAL_STATE__`

**Params:**
| Param | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Dot-notation path: `"ytInitialData.contents"`, `"__NEXT_DATA__.props.pageProps"` |
| `maxLength` | number | 50000 | Max JSON chars to return |
| `offset` | number | 0 | Char offset for pagination |

**Returns:**
```json
{ "found": true, "value": {...}, "totalLength": 12000, "truncated": false, "nextOffset": null }
```

**File:** `webmcp-extension/dist/bg/handlers/high-level.js`

---

## P3 — `findByText` command

**Problem:** CSS class names on modern SPAs (YouTube, React, Next.js) change per build. No way to find elements by visible text without writing `evaluateJS` TreeWalker boilerplate each time.

**Params:**
| Param | Type | Default | Description |
|---|---|---|---|
| `text` | string | required | Text to search for |
| `exact` | boolean | `false` | Exact match vs contains |
| `selector` | string | `"*"` | Limit search to elements matching this CSS selector |
| `maxResults` | number | 10 | Max elements to return |

**Returns:** Same schema as `getInteractiveElements` — includes `bounds.centerX/Y` for direct use with `dispatchClick`.

**File:** `webmcp-extension/dist/bg/handlers/high-level.js`

---

## P4 — Page tool errors → HTTP 422 + errorType

**Problem:** When a page tool returns `{ "error": true, "message": "..." }`, the gateway sends HTTP 200. The AI sees a success response; the error is buried inside JSON that must be parsed first.

**Solution:** In `gateway_server.js`, after auto-unwrapping (P1), check if `parsedContent.error === true` and map to HTTP 422 with:
```json
{ "error": "...", "errorType": "pageToolError", "raw": { ... } }
```

This makes errors visible at the transport level — no parse step required to detect failure.

**File:** `server/gateway_server.js`

---

## Implementation Order

1. **P0** (page-stability.js) — standalone, no dependencies
2. **P1 + P4** (gateway_server.js) — both in same file, implement together
3. **P2 + P3** (high-level.js + catalog) — both new handlers, implement together
4. Rebuild extension zip, run `tools:generate`, commit

---

## Acceptance Criteria

| Feature | Test |
|---|---|
| P0 | `waitForStable` on YouTube watch page with `ignoreCharacterData: true` returns `stable: true` in < 2s |
| P1 | Page tool response has `parsedContent` key with parsed object (not string) |
| P2 | `getWindowVariable { path: "__NEXT_DATA__" }` on a Next.js site returns hydrated page props |
| P3 | `findByText { text: "Subscribe" }` returns element with valid centerX/Y bounds |
| P4 | `query_selector_all` with bad selector returns HTTP 422, not HTTP 200 |
