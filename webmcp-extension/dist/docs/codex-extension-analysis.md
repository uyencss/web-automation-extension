# Codex Extension Analysis

> Analysis of the OpenAI Codex browser extension (`hehggadaopoacecdllhhajmbjkdcmajg` v1.1.5)
> to understand its architecture and how it communicates with AI models for browser automation.

## Overview

The Codex extension is an RPA/AI controller that acts as a **bridge** between a local Codex host application and the Chrome browser. It uses the Chrome DevTools Protocol (CDP) to execute commands and employs spring physics with bezier curves for "human-like" cursor movement.

## Extension Structure

```
1.1.5_0/
├── manifest.json               # Manifest V3 config
├── background.js               # Main logic: transport, CDP bridge, capabilities
├── content-scripts/
│   └── codex.js                # Visual cursor, agent UI overlays
├── chunks/
│   └── popup-CTe__03-.js       # Popup UI (side panel)
├── icons/                      # Extension icons
├── _metadata/                  # Chrome Web Store metadata
└── rules.json                  # Declarative net request rules
```

## Key Permissions

From `manifest.json`:
- `debugger` — Full Chrome DevTools Protocol access
- `nativeMessaging` — Communication with local Codex host app
- `tabs`, `scripting` — Tab management and script injection
- `storage`, `sessions` — State persistence
- `downloads`, `history`, `bookmarks` — Browser data access

## Communication Architecture

```
┌─────────────────┐   Native Messaging    ┌─────────────────┐   chrome.debugger    ┌──────────────┐
│  Codex Host App  │ ◀════════════════════ │ Codex Extension  │ ═══════════════════▶ │  Browser Tab │
│  (local server)  │ ════════════════════▶ │ (background.js)  │ ◀═══════════════════ │  (web page)  │
│                  │   JSON-RPC 2.0        │                  │   CDP Protocol       │              │
│  AI Model ──────▶│                       │  Command Router  │                      │  DOM / JS    │
│  ◀── results ───│                       │  CDP Bridge      │                      │  execution   │
└─────────────────┘                       └─────────────────┘                      └──────────────┘
```

### Transport Layer

- **Protocol**: JSON-RPC 2.0
- **Connection**: `chrome.runtime.connectNative("com.openai.codexextension")`
- **Message format**:
  ```json
  // Request (Host → Extension)
  { "jsonrpc": "2.0", "id": 1, "method": "methodName", "params": {...} }

  // Response (Extension → Host)
  { "jsonrpc": "2.0", "id": 1, "result": {...} }

  // Notification (Extension → Host, no response expected)
  { "jsonrpc": "2.0", "method": "onCDPEvent", "params": {...} }
  ```

### Request/Response Flow

1. Host app sends JSON-RPC request via `port.postMessage()`
2. Extension receives in `onMessage` listener
3. Extension dispatches to registered handler via `registerRequestHandlerObject()`
4. Handler executes (e.g., CDP command via `chrome.debugger.sendCommand()`)
5. Result sent back as JSON-RPC response

## Four Capabilities (Tools)

The extension exposes exactly **4 capabilities** to the AI model:

### 1. `webmcp` (Tab-scoped)
**Description**: *"List and invoke page-defined WebMCP tools registered through navigator.modelContext in the active tab."*

**Commands**:
| Command | Input Schema | Output Schema |
|---------|-------------|---------------|
| `webmcp_list_tools` | `{ browser_id, tab_id }` | `{ tools: [{ name, title?, description?, input_schema, annotations?, origin?, pageUrl? }] }` |
| `webmcp_invoke_tool` | `{ browser_id, tab_id, tool_name, input, timeout_ms? }` | `{ result: any }` |

**Tool Schema** (Zod validation):
```javascript
// Each tool in the tools array:
{
  name: z.string(),                           // required
  title: z.string().optional(),               // optional
  description: z.string().optional(),         // optional
  input_schema: z.any(),                      // required (any JSON)
  annotations: z.object({                     // optional
    readOnlyHint: z.boolean().optional(),
    untrustedContentHint: z.boolean().optional(),
  }).optional(),
  origin: z.string().optional(),              // optional
  pageUrl: z.string().optional(),             // optional
}
```

**How it works**:
1. AI calls `webmcp_list_tools` → extension sends to host → host evaluates `navigator.modelContext.tools` via CDP `Runtime.evaluate` in the page
2. AI calls `webmcp_invoke_tool` → host evaluates `navigator.modelContext.invokeTool(name, input)` in the page
3. Results flow back through the transport

### 2. `pageAssets` (Tab-scoped)
**Description**: *"List assets already observed in the current page state and bundle selected assets into a temporary local artifact."*

**Commands**:
| Command | Description |
|---------|-------------|
| `tab_page_assets_list` | List observed page assets (fonts, images, scripts, stylesheets, videos) |
| `tab_page_assets_bundle` | Bundle selected assets into a local artifact |

**Asset types**: `font`, `image`, `script`, `stylesheet`, `video`, `other`

### 3. `visibility` (Browser-scoped)
**Description**: *"Use to show or hide the browser to the user, and to determine the browser's current visibility. Keep browser work in the background unless the user asks to see it or live viewing is useful."*

**Commands**:
| Command | Description |
|---------|-------------|
| `browser_visibility_get` | Check if browser is currently visible |
| `browser_visibility_set` | Show or hide the browser window |

### 4. `viewport` (Browser-scoped)
**Description**: *"Controls an explicit browser viewport override for responsive or device-size testing. Use it when a task calls for specific dimensions or breakpoint validation; otherwise leave it unset so the browser uses its normal 1280×720 viewport."*

**Commands**:
| Command | Description |
|---------|-------------|
| `browser_viewport_set` | Set custom viewport dimensions |
| `browser_viewport_reset` | Reset to default 1280×720 |

## CDP Usage

The extension uses Chrome DevTools Protocol v1.3 via `chrome.debugger`:

```javascript
// Attach to a tab
chrome.debugger.attach({ tabId }, "1.3");

// Send CDP commands
chrome.debugger.sendCommand({ tabId }, method, commandParams);

// Forward CDP events to the host app
chrome.debugger.onEvent.addListener((source, method, params) => {
  sendNotification("onCDPEvent", { source, method, params });
});
```

CDP commands are sent with a configurable timeout (default varies by command).

## Content Script (codex.js)

The `codex.js` content script provides:
- **Visual cursor** — animated cursor that mimics human mouse movement using spring physics
- **Agent overlays** — visual indicators showing what the agent is looking at/interacting with
- **CONTENT_PING** — heartbeat mechanism so background.js knows the content script is alive

Injection method:
```javascript
chrome.scripting.executeScript({
  files: ["content-scripts/codex.js"],
  injectImmediately: true,
  target: { tabId }
});
```

## Key Findings for Building Compatible Extensions

1. **WebMCP is the only capability designed for third-party tool registration** — the other 3 are internal to Codex
2. **Tools must be on `navigator.modelContext`** in the page's MAIN world — Codex reads them via CDP `Runtime.evaluate`
3. **Tool descriptors must match the Zod schema** — especially `input_schema` (not `inputSchema`)
4. **Tool results can be any JSON** — the response schema is `z.any()`
5. **JSON-RPC 2.0 is the wire protocol** — both for native messaging and for internal RPC
