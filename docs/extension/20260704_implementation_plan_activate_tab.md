# Activate Tab Command — Implementation Plan

Date: 2026-07-04

## Goal

Add a single first-class command that brings an already-open Chrome tab to the
foreground (active + window focused), and expose it consistently across the
extension handler, capability handshake, command catalog, generated reference,
and skill docs.

Ship exactly one command name — `activateTab` — not three synonyms.

## Motivation

Before this change there was no way to bring an existing background tab to the
front. Existing tab commands cover a different need:

- `navigate` updates a tab's URL but does not set `active: true`; the tab stays
  in the background.
- `newTab` focuses only newly created tabs.
- `getActiveTab` / `listTabs` are read-only.

Most automation targets tabs by `tabId` via `resolveTabId`, so it does **not**
need the tab focused. The one case that does need real foreground focus is
visibility/focus-sensitive pages (Cloudflare challenge, Facebook), which throttle
background timers, pause `requestAnimationFrame`, and gate rendering/anti-bot
checks on `document.visibilityState` and window focus. `activateTab` covers that
gap by focusing the owning window and marking the tab active.

## Scope Decision: One Command, No Aliases

The initial dirty draft added three identical commands — `activateTab`,
`selectTab`, `focusTab` — all delegating to the same body. Per the project
simplicity guideline (no configurability/synonyms that were not requested), we
collapse to a single canonical command:

- Keep: `activateTab` (already the name used in `SKILL.md` and the primary MCP
  tool surface).
- Drop: `selectTab`, `focusTab`.

The handler body is single-use after consolidation, so it is inlined into the
`activateTab` handler rather than kept as a separate helper function.

## Command Contract

- Method: `activateTab`
- Params: `{ tabId }` (required). Falls back to `resolveTabId` semantics when
  omitted, but callers should pass an explicit `tabId` from `listTabs`.
- Behavior: focus the tab's window (`chrome.windows.update(windowId, { focused:
  true })`), then `chrome.tabs.update(tabId, { active: true })`.
- Returns: `{ tabId, url, title, active, windowId }`.
- Group: `tabs`.

## Files To Change (consolidation)

1. `webmcp-extension/dist/bg/handlers/tab-management.js`
   - Keep `activateTab` handler; inline the activation body into it.
   - Remove `selectTab` and `focusTab` handlers and the standalone
     `activateResolvedTab` helper.
2. `catalog/command-catalog.js`
   - Keep the `activateTab` catalog entry; remove `selectTab` and `focusTab`.
3. `scripts/generate-tool-reference.js`
   - Keep the `activateTab: '{ tabId }'` param hint; remove `selectTab` and
     `focusTab` hints.
4. `webmcp-extension/dist/bg/ws-client.js`
   - Capability announcement lists `activateTab` only (drop `selectTab`,
     `focusTab`).
5. `skills/webmcp-browser-automation/SKILL.md`
   - Update tab-selection step: `listTabs` → pick `tabId` → `activateTab`.
     Remove the "(aliases: selectTab, focusTab)" note.
6. `skills/webmcp-browser-automation/references/generated-tools.md`
   - Regenerate via `npm run tools:generate` (counts 53 → 54, not 56).

## Related Changes Left As-Is (not part of the 3→1 consolidation)

These dirty edits support verifying that a connected profile actually advertises
`activateTab`, and are kept unchanged:

- `bin/webmcp.mjs` — lift `profileId` to a top-level field on `/api` calls and
  add the `WEBMCP_PROFILE_ID` env fallback.
- `server/gateway_server.js` — expose per-profile `extensionVersion` and
  `capabilities` in `/health` `profileDetails`.
- `tests/unit/gateway-multi-profile.test.mjs` — assert per-profile version and
  capabilities (`activateTab`) surface in `/health`.

## Verification

1. `npm run tools:generate` → regenerates `generated-tools.md`; git diff shows
   `activateTab` present, `selectTab`/`focusTab` absent, command count 54.
2. `npm run tools:check` → passes (generated reference in sync).
3. `npm test` → all unit suites pass, including
   `gateway-multi-profile.test.mjs`.
4. Grep check: no remaining `selectTab` / `focusTab` references in source,
   catalog, capability list, or skill docs.
