# Changelog

All notable changes to `@gyga-browser/webmcp-browser-automation-kit` are documented here.

## 1.0.17 - 2026-06-30

### Changed

- The MCP server now exposes a **lean "core" tool set by default** (~45 first-class tools instead of 54) to cut per-request tool-schema tokens and reduce tool-selection ambiguity between overlapping commands. The hidden commands remain **fully callable via `browser_raw_command`**, so the change is lossless. Hidden by default: superseded/niche readers (`getPageContent`, `getAccessibilityTree`, `getDOMSnapshot`, `getInteractiveElements`, `getElementBounds`) and the CSS-selector action variants (`click`, `type`, `hover`, `selectOption`) whose `*ByRef` counterparts are already preferred.

### Added

- Added the `WEBMCP_TOOLS` environment variable to control MCP tool exposure: unset/`core` (default lean set), `full` (every supported command), or a comma/space-separated custom allowlist of gateway methods / `snake_case` tool names (`browser_raw_command` is always included). Covered by a Node unit test (`tests/unit/tool-filter.test.mjs`).

## 1.0.16 - 2026-06-29

### Added

- Added a `getPageText` command: smart "readable content" extraction in one call. It probes a priority list of semantic content containers (`article`, `main`, `[role=main]`, common `post-content`/`entry-content`/`articleBody` patterns), picks the container with the **most** text (more robust than "first selector wins", which can latch onto a tiny related-article card), normalizes whitespace/blank lines, and falls back to `<body>` for SPAs/feeds. Returns the matched `source` plus `offset`/`maxLength` pagination and a short-content guard. This closes most of the gap with Claude's `get_page_text` for "just read the page" tasks without changing WebMCP's architecture or adding permissions.
- Added a `readPage` command: one-shot "open and read" that optionally navigates to `url`, waits for load + DOM stability, then returns the same smart text — collapsing `navigate → waitForStable → getPageText` into a single tool call.
- Extracted the page-side extraction expression into a dependency-free `webmcp-extension/dist/bg/handlers/page-text-extract.js` with a Node unit test (`tests/unit/page-text-extraction.test.mjs`) covering container selection, whitespace cleanup, pagination, body fallback, and the empty-page guard.

### Changed

- Documented in the skill/tool-selection guidance that `getPageText`/`readPage` are the preferred path for reading a page as clean text, while `querySelectorAll`/`evaluateJS` remain the path for structured bulk extraction. Background: [docs/extension/20260629_getpagetext_analysis_claude_vs_webmcp.md](docs/extension/20260629_getpagetext_analysis_claude_vs_webmcp.md) (records why P2/P4/P5 were deliberately not implemented).

### Extension

- Announced the new `getPageText`/`readPage` capabilities to the gateway and bumped the extension manifest to `2.1.6`.

## 1.0.15 - 2026-06-29

### Changed

- `evaluateJS` now **auto-returns single expressions**. Your code still runs inside `(async () => { … })()`, but a single expression — `document.title`, `[...document.querySelectorAll("tr")].map(…)`, or a nested `(() => {…})()` — now resolves to its value without an explicit `return`. This removes the long-standing "I ran evaluateJS and only got `tabId` back" gotcha. Multi-statement bodies (declarations, loops, control flow) still require an explicit top-level `return`. Detection is brace/string/comment-aware, so semicolons or keywords inside nested scopes, strings, or `${…}` interpolations are not mistaken for top-level statements.
- Documented in `evaluateJS`'s catalog description and the agent skill that bulk row/table/data extraction should use `evaluateJS` / `query_selector_all` / `extract_table_data` rather than ARIA snapshots, which target interactive controls and may omit dense tabular rows, hidden tooltips, or chart/SVG internals.

### Added

- Extracted the wrapping logic into a dependency-free `webmcp-extension/dist/bg/handlers/evaluate-wrap.js` module with a Node unit test (`tests/unit/evaluate-wrap.test.mjs`, run via `npm test`) covering bare expressions, nested IIFEs, trailing semicolons, strings containing `;`, and multi-statement bodies.

### Extension

- Bumped the extension manifest to `2.1.5`.

## 1.0.14 - 2026-06-29

### Changed

- Reworked the fast ARIA snapshot to count **accessibility depth** instead of raw DOM depth: semantically empty wrapper elements no longer consume the depth budget, so `getAriaSnapshot` reaches real content on deeply nested SPAs (Facebook, Salesforce, …) at the default depth.
- Raised the default `maxDepth` from `8` to `15` for both the fast content-script path and the native CDP fallback.

### Added

- Added smart scope escalation: when `scope` is left on `auto` and a viewport-scoped fast snapshot comes back essentially empty (`nodeCount <= 1`), `getAriaSnapshot` now automatically retries once with full-document scope before falling back to the slower CDP path, reporting `escalatedFrom` when it does.
- Added an `includeText` option (with `maxTextLength`, default 200) that surfaces visible own-text from role-less containers — post bodies, captions, paragraphs — as `text "..."` lines, so the snapshot can be read like an article instead of only listing controls. Single-character fragments are dropped to avoid exploding on anti-scrape per-character timestamp spans.
- Added a `waitStable` option that lets the page settle (lazy-hydrated feeds, route changes) via the existing page-stability watcher before the snapshot is captured; pass `true` or a stability options object.
- Added a `MAX_RAW_DEPTH` recursion safety ceiling (200) to guard against stack overflow on pathologically nested wrapper markup.

### Fixed

- Fixed the "empty `main`" symptom where heavily wrapped pages returned only a handful of header/navigation refs under the default snapshot configuration.

## 1.0.13 - 2026-06-29

### Added

- Added a fast content-script ARIA snapshot path for `getAriaSnapshot`, with automatic fallback to the native CDP Accessibility tree.
- Added viewport-first snapshot filtering, output node caps, explicit `maxChars` protection, and snapshot size metadata for token-bounded page reads.
- Added persistent content-script refs backed by `WeakMap`/`WeakRef`, TTL pruning, and compact frame-aware refs such as `ref=r1` and `ref=f3r1`.
- Added inline native `<select>` option rendering with `includeOptions` and `maxOptions` controls.
- Added broader sensitive form value redaction for password, OTP, token, card, CVV/CVC, API key, and related field hints.
- Added detailed implementation plans for the fast ARIA snapshot architecture and final output polish.

### Changed

- Updated `clickByRef`, `typeByRef`, `hoverByRef`, and `selectByRef` to route fast refs through in-page content-script actions while preserving the CDP path for native refs.
- Updated command catalog, generated skill references, root README, extension README, and packaged docs for the new ARIA snapshot parameters.
- Bumped the npm package to `1.0.13` and the unpacked extension manifest to `2.1.3`.

### Fixed

- Prevented large ARIA snapshots from silently flooding model context by returning a structured `SNAPSHOT_TOO_LARGE` error when `maxChars` is exceeded.

## 1.0.12 - 2026-06-29

### Added

- Added extension-level console capture commands: `startConsoleCapture`, `readConsoleMessages`, `clearConsoleMessages`, and `stopConsoleCapture`.
- Added CDP Runtime event buffering for `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`, with per-tab ring buffers and detach cleanup.
- Added console capture command metadata to the MCP/command catalog and gateway `/health` discovery payload.

### Changed

- Updated package and extension READMEs with console capture examples and refreshed capability counts.
- Bumped the npm package to `1.0.12` and the unpacked extension manifest to `2.1.2`.

## 1.0.11 - 2026-06-28

### Added

- Added iframe discovery with `listFrames`, including CDP frame IDs, Chrome frame IDs when available, frame names, URLs, and parent relationships.
- Added frame targeting for core background commands, WebMCP bridge commands, observation commands, and coordinate input commands.
- Added nested iframe fixture pages for live extension verification.

### Changed

- Upgraded page-tool iframe forwarding to support selector objects, nested `frame_path`, configurable timeouts, and response-source validation.
- Regenerated the command catalog and WebMCP skill references for frame-aware commands.
- Rebuilt the Chrome extension zip for version `2.1.1`.

### Fixed

- Fixed `fill_form_field` so its declared `frame_selector` support actually forwards into the target iframe.
- Fixed the catalog mismatch for `selectOption`.

## 1.0.10 - 2026-06-28

### Added

- Added `pageFetch` to run `fetch()` inside the page context, inheriting the active page origin, cookies, and session. Responses are structured, size-bounded, and support `auto`, `text`, `json`, and `base64` modes. (`b4ddf0f`)
- Added shared deep DOM helpers for open Shadow DOM traversal. (`b4ddf0f`)
- Added `pierceShadow` support for `querySelectorAll`, `findByText`, `getInteractiveElements`, and `getElementBounds`, enabled by default. (`b4ddf0f`)
- Added implementation notes and acceptance criteria for page fetch and Shadow DOM piercing. (`b4ddf0f`)

### Changed

- Improved the gateway/router experience for unknown methods by returning actionable tool hints instead of a bare method-not-found response. (`004f7b0`)
- Improved page stability behavior for dynamic pages based on field evaluation against Gemini and Codex browser sessions. (`004f7b0`, `74702d6`)
- Regenerated the MCP command catalog and WebMCP skill references for the new capabilities. (`b4ddf0f`, `004f7b0`)

### Fixed

- Fixed field-evaluation stability issues found in browser automation workflows. (`74702d6`)
- Mapped structured page-tool validation failures to clearer gateway errors. (`004f7b0`)

## 1.0.9 - 2026-06-28

### Changed

- Bumped the package version to `1.0.9`. (`ebc4930`)
- Translated documentation to English. (`f8dbed7`)

## 1.0.8 - 2026-06-28

### Added

- Added the MIT license, package metadata, and npm packaging scripts. (`9aedc6b`)
- Added Chrome Web Store submission documentation and store screenshot assets. (`9aedc6b`)

### Changed

- Prepared the package for public npm release as `@gyga-browser/webmcp-browser-automation-kit`. (`9aedc6b`)

## 1.0.7 - 2026-06-28

### Added

- Added ARIA snapshot, ref-based interaction, and page stability auto-wait handlers. (`7cd24f9`)

### Changed

- Refocused the kit around the MCP command catalog. (`8ef0394`)

## Earlier versions

- See git history for changes before `1.0.7`.
