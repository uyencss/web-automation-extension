# Compatibility Audit — WebMCP Tools Provider vs Codex Extension v1.1.5

## Data Flow

```
┌─────────────────┐    nativeMessaging     ┌─────────────────┐    chrome.debugger     ┌──────────────────┐
│  Codex Host App  │ ◀──────────────────── │  Codex Extension │ ─────────────────────▶ │  Page (your tab) │
│  (local server)  │ ──────────────────── │  (background.js) │ ◀───────────────────── │                  │
│                  │                       │                  │    CDP Runtime.evaluate│                  │
│  AI Model calls  │   webmcp_list_tools   │  Bridges via     │    reads/calls         │  navigator       │
│  webmcp tool ────┼──────────────────────▶│  chrome.debugger │───────────────────────▶│  .modelContext   │
│                  │                       │  .sendCommand()  │                        │  .tools          │
│  ◀── result ─────┼──────────────────────┤  ◀── result ─────┼────────────────────────│  .invokeTool()   │
└─────────────────┘                       └─────────────────┘                        └──────────────────┘
```

**Key finding:** The Codex extension does NOT read `navigator.modelContext` directly. It sends the command to the **Codex Host App** (via native messaging). The host app uses CDP `Runtime.evaluate` (via `chrome.debugger`) to evaluate JavaScript **in the page's MAIN world**.

This confirms that our `"world": "MAIN"` approach is correct.

## Schema Compatibility

### Tool Definition Schema

| Field | Our Extension | Codex Expects | Status |
|-------|--------------|---------------|--------|
| `name` | `t.name` | `z.string()` | ✅ Match |
| `title` | `t.title` | `z.string().optional()` | ✅ Match |
| `description` | `t.description` | `z.string().optional()` | ✅ Match |
| `input_schema` | `t.inputSchema \|\| t.input_schema` | `z.any()` | ✅ Match |
| `annotations` | `t.annotations` | `z.object({readOnlyHint, untrustedContentHint})` | ✅ Match |
| `origin` | `location.origin` | `z.string().optional()` | ✅ Match |
| `pageUrl` | `location.href` | `z.string().optional()` | ✅ Match |

### List Tools Command ✅
```javascript
// Codex evaluates via CDP:
navigator.modelContext.tools  // → array of tool descriptors
```
Our polyfill exposes `navigator.modelContext.tools` as a getter → Compatible

### Invoke Tool Command ✅
```javascript
// Codex evaluates via CDP:
navigator.modelContext.invokeTool("tool_name", input)
```
Our polyfill exposes `navigator.modelContext.invokeTool(name, input)` → Compatible

### Response Format ✅
```javascript
// Codex expects:
{ result: z.any() }  // any JSON is accepted
```
Our tools return `{ content: [{ type: "text", text: "..." }] }` → passes `z.any()` validation

### Annotations Schema ✅
```javascript
{
  readOnlyHint: z.boolean().optional(),
  untrustedContentHint: z.boolean().optional(),
}
```

## Capability Scope

| Capability ID | Scope | Our Extension? | Notes |
|---|---|---|---|
| `webmcp` | Tab-scoped | ✅ **YES** | This is what we target |
| `pageAssets` | Tab-scoped | ❌ No (internal) | Lists/bundles page assets |
| `visibility` | Browser-scoped | ❌ No (internal) | Show/hide browser |
| `viewport` | Browser-scoped | ❌ No (internal) | Set viewport dimensions |

Only `webmcp` is designed for third-party tool registration.

## Content Script Injection Timing ✅

Our extension uses `"run_at": "document_start"` → tools are registered before the page finishes loading.

## Summary

| Check | Result |
|-------|--------|
| Polyfill location (`MAIN` world) | ✅ Correct |
| Tool descriptor schema | ✅ All fields match |
| `navigator.modelContext.tools` getter | ✅ Returns array |
| `navigator.modelContext.invokeTool(name, input)` | ✅ Async function |
| Response format (MCP content array) | ✅ Passes `z.any()` |
| Annotations schema | ✅ Match |
| Injection timing (`document_start`) | ✅ Early enough |
| Scope (only targets `webmcp`) | ✅ Correct |
| Non-native browsers (polyfill guard) | ✅ Has guard |

**Verdict: Fully compatible with Codex v1.1.5.**
