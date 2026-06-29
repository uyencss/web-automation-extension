# Changelog

All notable changes to `@gyga-browser/webmcp-browser-automation-kit` are documented here.

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
