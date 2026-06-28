# Implementation Plan — pageFetch + Shadow DOM Piercing
**Date:** 2026-06-28
**Origin:** Friction hit during the YouTube transcript field test (session with Codex/Opus).
Two generic limitations surfaced repeatedly:
1. Had to hand-write `evaluateJS` + `fetch()` every time to call an in-page API with the real session.
2. `findByText` / `getInteractiveElements` returned `bounds: 0,0` for elements inside Shadow DOM (YouTube menus).

Both fixes are **framework-agnostic** — not YouTube-specific.

---

## Feature 1 — `pageFetch`

### Problem
To read an in-page API response with the user's real cookies/session, the only option today is raw `evaluateJS` with a manual `fetch()`, manual header extraction, manual size handling, and no error contract. This is repeated boilerplate and a silent-failure source.

### Solution
A first-class `pageFetch` command that runs `fetch()` **inside the page (MAIN world)** so it inherits cookies, origin, and credentials, then returns a structured, size-bounded result.

### Params
| Param | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | Absolute or relative URL (relative resolves against page origin) |
| `method` | string | `"GET"` | HTTP method |
| `headers` | object | `{}` | Request headers |
| `body` | string | `null` | Request body (stringify JSON yourself, or pass a string) |
| `responseType` | string | `"auto"` | `"text"` \| `"json"` \| `"base64"` \| `"auto"` (auto picks from content-type) |
| `credentials` | string | `"include"` | `"include"` \| `"same-origin"` \| `"omit"` |
| `maxLength` | number | `100000` | Max chars (text/json) or bytes-as-base64 to return |
| `offset` | number | `0` | Offset for pagination of large bodies |

### Returns
```json
{
  "ok": true, "status": 200, "statusText": "",
  "responseType": "json", "contentType": "application/json",
  "headers": { ... },
  "totalLength": 1234, "offset": 0, "returnedLength": 1234,
  "truncated": false, "nextOffset": null,
  "json": { ... },        // present when responseType resolves to json and full body fit
  "body": "..."           // present otherwise (text or base64 chunk)
}
```
On failure (network/CORS/JS error): `{ "error": true, "message": "..." }` — which the gateway (P4) surfaces as HTTP 422.

### File
`webmcp-extension/dist/bg/handlers/high-level.js` (group `page`).

### Notes / limits
- Runs with page CSP and CORS rules — a cross-origin call still obeys the page's CORS. The win is **same-origin in-page APIs with full session** (the common case), not bypassing CORS.
- Binary responses come back base64 (`responseType: "base64"`), paginated by byte offset.

---

## Feature 2 — Shadow DOM piercing

### Problem
`document.querySelectorAll` and `TreeWalker` do not cross shadow boundaries. On Web-Component-heavy sites (YouTube/Polymer, most design systems) elements live inside open shadow roots, so `findByText`, `querySelectorAll`, `getInteractiveElements`, and `getElementBounds` miss them or return zero bounds.

### Solution
A shared injected helper that walks **open** shadow roots, exposed to the four DOM-reading handlers via a new `pierceShadow` param.

New file `webmcp-extension/dist/bg/handlers/dom-helpers.js` exporting a JS-source string `DOM_DEEP_HELPERS` with:
- `__webmcpQueryDeep(selector, root)` — querySelectorAll across open shadow roots, de-duplicated.
- `__webmcpWalkTextDeep(root, visit)` — TreeWalker text walk that recurses into open shadow roots.

The string is interpolated into each handler's evaluate expression.

### Affected handlers + param
| Handler | New param | Default |
|---|---|---|
| `querySelectorAll` | `pierceShadow` | `true` |
| `findByText` | `pierceShadow` | `true` |
| `getInteractiveElements` | `pierceShadow` | `true` |
| `getElementBounds` | `pierceShadow` | `true` |

Default `true` because piercing only **adds** shadow-root matches; light-DOM results are unchanged. Pass `pierceShadow: false` to restore strict light-DOM behavior.

### Files
- `webmcp-extension/dist/bg/handlers/dom-helpers.js` (new)
- `webmcp-extension/dist/bg/handlers/high-level.js` (querySelectorAll, findByText)
- `webmcp-extension/dist/bg/handlers/ai-vision.js` (getInteractiveElements, getElementBounds)

### Hard limit (documented, not fixable)
**Closed** shadow roots (`attachShadow({mode:'closed'})`) expose `el.shadowRoot === null` and cannot be traversed from page JS by anyone. Piercing covers open shadow roots only.

---

## Shared / housekeeping
- `webmcp-extension/dist/bg/ws-client.js` — advertise `pageFetch` in capabilities.
- `catalog/command-catalog.js` — add `pageFetch`; add `pierceShadow` to the four handlers' optionalParams.
- Regenerate `skills/.../references/generated-tools.md` via `npm run tools:generate`.
- Rebuild extension zip via `npm run build:extension`.

## Implementation order
1. `dom-helpers.js` (shared)
2. `high-level.js` — pageFetch + pierceShadow on querySelectorAll/findByText
3. `ai-vision.js` — pierceShadow on getInteractiveElements/getElementBounds
4. catalog + ws-client + regenerate + rebuild
5. syntax check, commit

## Acceptance criteria
| Feature | Test |
|---|---|
| pageFetch (json) | `pageFetch { url: "/youtubei/...", method:"POST", body:"{...}" }` returns `json` with full body when same-origin |
| pageFetch (binary) | `pageFetch { url: "<img>", responseType:"base64" }` returns base64 with byteLength |
| pageFetch (error) | bad URL returns `{error:true}` → gateway HTTP 422 |
| pierceShadow | `findByText { text:"Transcript" }` on a shadow-DOM menu returns element with non-zero centerX/centerY |
| backward compat | `querySelectorAll { selector, pierceShadow:false }` matches old light-DOM-only result |
