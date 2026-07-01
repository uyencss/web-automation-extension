# Gateway Multi-Profile Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single gateway process on a single port serve multiple Chrome profiles at once by routing each `/api` command to the WebSocket of the profile named in the request. Each profile is enriched with metadata (email, display name) so agents can identify profiles by human-readable labels instead of raw UUIDs.

**Architecture:** Replace the gateway's single `extensionWs` with a `Map<profileId, ws>`. Each extension generates a stable UUID, persists it in `chrome.storage.local` (isolated per Chrome profile), and sends it along with the Chrome profile's Google account email and a custom display name in the `extensionReady` handshake. The gateway registers each connection under its `profileId`, stores `profileEmail` and `profileName` on the WebSocket, routes `/api` requests by a top-level `profileId` field (falling back to the sole connection when only one is present), and reports all connected profiles with rich metadata on `/health`. The MCP server exposes `list_profiles` (returning `profileDetails` with id/email/name) and `set_profile_name` tools. The bundled MCP server / CLI helper read `WEBMCP_PROFILE_ID`, and the SKILL documents how an agent supplies `profileId`.

**Scope:** This plan touches `mcp-web-extension/` ONLY. The `workflow-dispatcher/` runner is intentionally out of scope for now; it can adopt the same top-level `profileId` body field later without any gateway change.

**Tech Stack:** Node.js (`http`, `ws`), Chrome MV3 service worker (`chrome.storage.local`, `crypto.randomUUID`), CommonJS runner modules, ES-module extension bundle.

## Global Constraints

- Node `>=18` (per `mcp-web-extension/package.json` engines) — built-in `fetch` and `crypto.randomUUID` are available; do not add dependencies.
- Only `ws` and `@modelcontextprotocol/sdk` are allowed runtime deps; do not introduce new ones.
- `webmcp-extension/dist/` IS the shipped/loaded extension source (the build script only zips it). Edit `dist/` files directly; there is no transpile step.
- Backward compatibility is mandatory: an `/api` request with **no** `profileId` must still work when exactly one profile is connected, and an extension that sends no `profileId` in its handshake must still be routable.
- All changes are inside `mcp-web-extension/` (a git repo — commit there). Do NOT modify `workflow-dispatcher/`.
- The `profileId` travels as a **top-level sibling of `params`** in the `/api` body (`{ method, params, profileId }`). The gateway strips it and never forwards it to the extension (the extension still receives only `{ jsonrpc, id, method, params }`).
- Test runner is plain `node` scripts under `mcp-web-extension/tests/unit/` wired into the `test` npm script — no test framework. New tests must follow that style (`node:assert`, exit non-zero on failure).

---

### Task 1: Extension profile-id module (stable per-profile UUID)

A small, dependency-free module that returns a stable id, generating and persisting one on first call. Also provides `getProfileInfo()` which enriches the id with the Chrome profile's Google account email (via `chrome.identity.getProfileUserInfo()`) and a custom display name (from `chrome.storage.local`). Extracted into its own file so it is unit-testable with an injected fake storage (the real `chrome.storage.local` is not available in Node).

**Files:**

- Create: `mcp-web-extension/webmcp-extension/dist/bg/profile-id.js`
- Test: `mcp-web-extension/tests/unit/profile-id.test.mjs`
- Modify: `mcp-web-extension/package.json:` (the `test` script line) — append the new test
- Modify: `mcp-web-extension/webmcp-extension/dist/manifest.json` — add `"identity"` and `"identity.email"` permissions

**Interfaces:**

- Consumes: `chrome.identity.getProfileUserInfo()` (requires `identity` + `identity.email` permissions), `chrome.storage.local` key `webmcp_profile_name`.
- Produces:
  - `getOrCreateProfileId(storage?, generateId?) -> Promise<string>` where `storage` is an object with `get(key) -> Promise<{[key]:value}>` and `set(obj) -> Promise<void>` (defaults to `chrome.storage.local`), and `generateId` defaults to `() => crypto.randomUUID()`. The persisted storage key is the string `'webmcp_profile_id'`.
  - `getProfileInfo(storage?) -> Promise<{ id: string, email: string, name: string }>` — returns the stable UUID, the signed-in Google account email (empty string if not signed in), and a display name (from `webmcp_profile_name` storage key, falling back to the email username or `Profile-<4-char-UUID>`). Task 2 imports `getProfileInfo`.

- [ ] **Step 1: Write the failing test**

Create `mcp-web-extension/tests/unit/profile-id.test.mjs`:

```js
import assert from "node:assert";
import { getOrCreateProfileId } from "../../webmcp-extension/dist/bg/profile-id.js";

function makeFakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      Object.assign(data, obj);
    },
  };
}

async function run() {
  // 1. Generates and persists a new id on first call.
  const storage = makeFakeStorage();
  let generated = 0;
  const id = await getOrCreateProfileId(storage, () => {
    generated += 1;
    return "fixed-uuid";
  });
  assert.strictEqual(id, "fixed-uuid", "returns the generated id");
  assert.strictEqual(generated, 1, "generator called exactly once");
  assert.strictEqual(
    storage.data["webmcp_profile_id"],
    "fixed-uuid",
    "persists under webmcp_profile_id",
  );

  // 2. Returns the persisted id on subsequent calls without regenerating.
  const id2 = await getOrCreateProfileId(storage, () => {
    generated += 1;
    return "should-not-be-used";
  });
  assert.strictEqual(id2, "fixed-uuid", "returns persisted id");
  assert.strictEqual(generated, 1, "generator not called again");

  console.log("profile-id.test.mjs OK");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node mcp-web-extension/tests/unit/profile-id.test.mjs`
Expected: FAIL — `Cannot find module .../dist/bg/profile-id.js` (file does not exist yet).

- [ ] **Step 3: Create the module**

Create `mcp-web-extension/webmcp-extension/dist/bg/profile-id.js`:

```js
// Stable per-Chrome-profile identifier.
//
// chrome.storage.local is isolated per Chrome profile, so persisting a
// generated UUID here yields a unique, stable id per profile with zero
// per-profile configuration. The gateway uses this id to route /api commands
// to the correct browser connection when multiple profiles are connected.

const STORAGE_KEY = "webmcp_profile_id";

export async function getOrCreateProfileId(
  storage = chrome.storage.local,
  generateId = () => crypto.randomUUID(),
) {
  const existing = await storage.get(STORAGE_KEY);
  if (existing && existing[STORAGE_KEY]) {
    return existing[STORAGE_KEY];
  }
  const id = generateId();
  await storage.set({ [STORAGE_KEY]: id });
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node mcp-web-extension/tests/unit/profile-id.test.mjs`
Expected: PASS — prints `profile-id.test.mjs OK`.

- [ ] **Step 5: Wire the test into the npm test script**

In `mcp-web-extension/package.json`, change the `test` script from:

```json
"test": "node tests/unit/evaluate-wrap.test.mjs && node tests/unit/page-text-extraction.test.mjs && node tests/unit/tool-filter.test.mjs"
```

to:

```json
"test": "node tests/unit/evaluate-wrap.test.mjs && node tests/unit/page-text-extraction.test.mjs && node tests/unit/tool-filter.test.mjs && node tests/unit/profile-id.test.mjs && node tests/unit/gateway-multi-profile.test.mjs"
```

(`gateway-multi-profile.test.mjs` is created in Task 3; adding both names here now keeps this a single edit.)

- [ ] **Step 6: Commit**

```bash
git -C mcp-web-extension add webmcp-extension/dist/bg/profile-id.js tests/unit/profile-id.test.mjs package.json
git -C mcp-web-extension commit -m "feat(ext): add stable per-profile id module"
```

---

### Task 2: Extension sends profileId, email, and name in the handshake

Load (or generate) the profile id and metadata when the WebSocket opens and include them in the `extensionReady` notification so the gateway can register the connection with rich profile information.

**Files:**

- Modify: `mcp-web-extension/webmcp-extension/dist/bg/ws-client.js:1-3,25-72`

**Interfaces:**

- Consumes: `getProfileInfo()` from Task 1.
- Produces: an `extensionReady` notification whose `params` now include `profileId: <string>`, `profileEmail: <string>`, and `profileName: <string>` alongside the existing `name`, `version`, `capabilities`. Task 3's gateway reads `params.profileId`, `params.profileEmail`, `params.profileName`. Also handles `setProfileName` command inline in `ws.onmessage` to persist a custom display name and trigger reconnect.

- [ ] **Step 1: Add the import**

In `mcp-web-extension/webmcp-extension/dist/bg/ws-client.js`, change the top of the file from:

```js
import { handleIncomingMessage } from "./router.js";

const WS_URL = "ws://localhost:7865";
```

to:

```js
import { handleIncomingMessage } from "./router.js";
import { getOrCreateProfileId } from "./profile-id.js";

const WS_URL = "ws://localhost:7865";
```

- [ ] **Step 2: Send profileId in the handshake**

In the same file, change the `ws.onopen` handler from:

```js
  ws.onopen = () => {
    isConnecting = false;
    reconnectAttempt = 0;
    clearReconnectTimer();
    console.log('[WS] ✓ Connected to', WS_URL);

    // Send a handshake notification so the server knows the extension is ready
    sendNotification('extensionReady', {
      name: 'WebMCP Tools Provider',
      version: chrome.runtime.getManifest().version,
      capabilities: [
```

to:

```js
  ws.onopen = async () => {
    isConnecting = false;
    reconnectAttempt = 0;
    clearReconnectTimer();
    console.log('[WS] ✓ Connected to', WS_URL);

    // Stable per-Chrome-profile id so the gateway can route commands to this
    // specific browser when several profiles share one gateway.
    const profileId = await getOrCreateProfileId();

    // Send a handshake notification so the server knows the extension is ready
    sendNotification('extensionReady', {
      name: 'WebMCP Tools Provider',
      version: chrome.runtime.getManifest().version,
      profileId,
      capabilities: [
```

Leave the rest of the `capabilities` array and the closing `});` exactly as-is.

- [ ] **Step 3: Sanity-check that the bundle still parses**

Run: `node --input-type=module -e "import('./mcp-web-extension/webmcp-extension/dist/bg/profile-id.js').then(m => console.log(typeof m.getOrCreateProfileId))"`
Expected: prints `function` (confirms the new module resolves; `ws-client.js` itself can't run under Node because it references `chrome`/`WebSocket`, so this verifies only its new dependency).

- [ ] **Step 4: Commit**

```bash
git -C mcp-web-extension add webmcp-extension/dist/bg/ws-client.js
git -C mcp-web-extension commit -m "feat(ext): send profileId in extensionReady handshake"
```

---

### Task 3: Gateway routes by profileId (extensionWs → Map)

Replace the single connection with a `Map<profileId, ws>`, register connections from the handshake, route `/api` by `profileId`, report connected profiles on `/health`, and on disconnect fail only the requests that were in flight on that connection.

**Files:**

- Modify: `mcp-web-extension/server/gateway_server.js:38-45` (state + helpers), `:77-88` (`/health`), `:96-141` (`/api` handler), `:150-224` (connection handler)
- Test: `mcp-web-extension/tests/unit/gateway-multi-profile.test.mjs`

**Interfaces:**

- Consumes: `extensionReady` handshake with `params.profileId`, `params.profileEmail`, `params.profileName` (Task 2); `/api` body shape `{ method, params, profileId }` (Task 4 supplies `profileId`).
- Produces:
  - `/health` JSON now includes `profiles: string[]`, `profileDetails: Array<{ profileId, email, name }>`, and `profileCount: number`; `extensionConnected` stays a boolean (`profiles.length > 0`).
  - `/api` routing contract: with a connected, matching `profileId` → routes to it; with no `profileId` and exactly one connection → routes to it; no `profileId` with >1 connection → HTTP 400; unknown/disconnected `profileId` → HTTP 404; zero connections → HTTP 503.

- [ ] **Step 1: Write the failing integration test**

Create `mcp-web-extension/tests/unit/gateway-multi-profile.test.mjs`:

```js
import assert from "node:assert";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gatewayPath = join(__dirname, "../../server/gateway_server.js");
const PORT = 7899;
const BASE = `http://localhost:${PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A fake extension: identifies with profileId, then echoes back which profile
// answered each forwarded command. Ignores gateway ping/keepalive notifications.
function makeFakeExtension(profileId, label) {
  const sock = new WebSocket(`ws://localhost:${PORT}`);
  sock.on("open", () => {
    sock.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extensionReady",
        params: { name: "fake", version: "0", profileId },
      }),
    );
  });
  sock.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method) return; // notification (ping/heartbeat) — ignore
    if ("id" in msg) {
      sock.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { echoedBy: label, method: msg.method },
        }),
      );
    }
  });
  return sock;
}

async function getHealth() {
  const r = await fetch(`${BASE}/health`);
  return r.json();
}

async function callApi(bodyObj) {
  const r = await fetch(`${BASE}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
  return { status: r.status, json: await r.json() };
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // gateway not up yet
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function run() {
  const gateway = spawn(process.execPath, [gatewayPath], {
    env: {
      ...process.env,
      WEBMCP_GATEWAY_PORT: String(PORT),
      WEBMCP_GATEWAY_PING_MS: "500",
    },
    stdio: "ignore",
  });

  let a;
  let b;
  try {
    await waitFor(
      async () => (await getHealth()).ok === true,
      "gateway /health up",
    );

    a = makeFakeExtension("profile-A", "A");
    b = makeFakeExtension("profile-B", "B");

    await waitFor(async () => {
      const h = await getHealth();
      return Array.isArray(h.profiles) && h.profiles.length === 2;
    }, "both profiles registered");

    const health = await getHealth();
    assert.ok(health.profiles.includes("profile-A"), "health lists profile-A");
    assert.ok(health.profiles.includes("profile-B"), "health lists profile-B");
    assert.strictEqual(health.profileCount, 2, "profileCount is 2");
    assert.strictEqual(
      health.extensionConnected,
      true,
      "extensionConnected true",
    );

    const toA = await callApi({
      method: "ping",
      params: {},
      profileId: "profile-A",
    });
    assert.strictEqual(toA.status, 200, "routed-to-A status 200");
    assert.strictEqual(toA.json.result.echoedBy, "A", "profile-A answered");

    const toB = await callApi({
      method: "ping",
      params: {},
      profileId: "profile-B",
    });
    assert.strictEqual(toB.status, 200, "routed-to-B status 200");
    assert.strictEqual(toB.json.result.echoedBy, "B", "profile-B answered");

    const ambiguous = await callApi({ method: "ping", params: {} });
    assert.strictEqual(
      ambiguous.status,
      400,
      "no profileId with 2 connected → 400",
    );

    const unknown = await callApi({
      method: "ping",
      params: {},
      profileId: "nope",
    });
    assert.strictEqual(unknown.status, 404, "unknown profileId → 404");

    console.log("gateway-multi-profile.test.mjs OK");
  } finally {
    if (a) a.close();
    if (b) b.close();
    gateway.kill("SIGKILL");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node mcp-web-extension/tests/unit/gateway-multi-profile.test.mjs`
Expected: FAIL — current gateway overwrites the single `extensionWs`, exposes no `profiles` array on `/health`, and ignores `profileId`. The `waitFor(... profiles.length === 2)` will time out (`/health` has no `profiles` field), throwing "Timed out waiting for: both profiles registered".

- [ ] **Step 3: Replace gateway state and add routing helpers**

In `mcp-web-extension/server/gateway_server.js`, replace the State block (lines 38-45):

```js
// ── State ────────────────────────────────────────────────────
let extensionWs = null;
let nextId = 1;
const pendingHttpRequests = new Map();

function isExtensionConnected() {
  return extensionWs && extensionWs.readyState === 1;
}
```

with:

```js
// ── State ────────────────────────────────────────────────────
// Map<profileId, ws> of identified extension connections. A connection is
// registered once it sends an `extensionReady` handshake carrying its
// profileId, and removed on close. Multiple Chrome profiles can connect
// concurrently to this one gateway.
const extensions = new Map();
// Connections that have opened but not yet identified themselves. Tracked only
// so keep-alive timers/cleanup behave before the handshake arrives.
const pendingConnections = new Set();
let nextId = 1;
// rpcId -> { res, timeoutTimer, method, ws }
const pendingHttpRequests = new Map();

function connectedProfileIds() {
  const ids = [];
  for (const [profileId, ws] of extensions) {
    if (ws.readyState === 1) ids.push(profileId);
  }
  return ids;
}

// Resolve which extension WebSocket should receive a command.
// Returns { ws } on success or { error, status } on failure.
function resolveTarget(profileId) {
  const ids = connectedProfileIds();
  if (ids.length === 0) {
    return {
      error: "Chrome extension is not connected to the gateway",
      status: 503,
    };
  }
  if (profileId) {
    const ws = extensions.get(profileId);
    if (!ws || ws.readyState !== 1) {
      return {
        error: `No connected Chrome profile with profileId='${profileId}'`,
        status: 404,
      };
    }
    return { ws };
  }
  // No profileId specified: unambiguous only when exactly one profile is connected.
  if (ids.length === 1) {
    return { ws: extensions.get(ids[0]) };
  }
  return {
    error: `Multiple Chrome profiles are connected (${ids.join(", ")}). Specify "profileId" in the request body.`,
    status: 400,
  };
}
```

- [ ] **Step 4: Update the `/health` response**

In the same file, replace the `/health` handler body (lines 77-88):

```js
if (req.method === "GET" && req.url === "/health") {
  return writeJson(res, 200, {
    ok: true,
    extensionConnected: Boolean(isExtensionConnected()),
    port: PORT,
    wsUrl: `ws://localhost:${PORT}`,
    apiUrl: `http://localhost:${PORT}/api`,
    timeoutMs: COMMAND_TIMEOUT_MS,
    commands: listGatewayCommands(),
    commandGroups: getGatewayCommandGroups(),
  });
}
```

with:

```js
if (req.method === "GET" && req.url === "/health") {
  const profiles = connectedProfileIds();
  return writeJson(res, 200, {
    ok: true,
    extensionConnected: profiles.length > 0,
    profiles,
    profileCount: profiles.length,
    port: PORT,
    wsUrl: `ws://localhost:${PORT}`,
    apiUrl: `http://localhost:${PORT}/api`,
    timeoutMs: COMMAND_TIMEOUT_MS,
    commands: listGatewayCommands(),
    commandGroups: getGatewayCommandGroups(),
  });
}
```

- [ ] **Step 5: Route the `/api` handler by profileId**

In the same file, replace the body of the `req.on('end', ...)` callback (lines 96-141), from `const { method, params } = requestPayload;` through the forwarding `console.log`, with:

```js
const { method, params, profileId } = requestPayload;
if (!method) {
  return writeJson(res, 400, { error: 'Missing "method" in request' });
}

const target = resolveTarget(profileId);
if (target.error) {
  return writeJson(res, target.status, { error: target.error });
}
const ws = target.ws;

// Assign a unique JSON-RPC ID
const rpcId = nextId++;
const extensionPayload = {
  jsonrpc: "2.0",
  id: rpcId,
  method,
  params: params || {},
};

// Set up a timeout for this request
const timeoutTimer = setTimeout(() => {
  const pending = pendingHttpRequests.get(rpcId);
  if (pending) {
    pendingHttpRequests.delete(rpcId);
    writeJson(pending.res, 504, {
      error: `Command '${method}' timed out after ${COMMAND_TIMEOUT_MS}ms`,
    });
  }
}, COMMAND_TIMEOUT_MS);

// Store the pending HTTP response, tagged with the target connection so
// we can fail it precisely if that connection drops.
pendingHttpRequests.set(rpcId, { res, timeoutTimer, method, ws });

// Forward to the chosen extension via WebSocket
ws.send(JSON.stringify(extensionPayload));
console.log(
  `[Gateway] Forwarded command: ID=${rpcId} | Method=${method} | profile=${profileId || "(single)"}`,
);
```

- [ ] **Step 6: Register connections from the handshake and clean up per-connection**

In the same file, replace the entire `wss.on('connection', ...)` handler (lines 150-224). Change the opening from:

```js
wss.on('connection', (ws, req) => {
  extensionWs = ws;
  console.log(`[Gateway] Chrome Extension connected from ${req.socket.remoteAddress}`);
```

to:

```js
wss.on('connection', (ws, req) => {
  pendingConnections.add(ws);
  ws._profileId = null;
  console.log(`[Gateway] Chrome Extension connected from ${req.socket.remoteAddress} (awaiting handshake)`);
```

Then, in the same handler, replace the `extensionReady` branch from:

```js
      if (method === 'extensionReady') {
        console.log(`[Gateway] Extension is ready: ${params.name} v${params.version}`);
      } else if (method === 'heartbeat' || method === 'pong') {
```

to:

```js
      if (method === 'extensionReady') {
        // Fall back to a synthetic id so a profileId-less (older) extension is
        // still routable as a single connection.
        const profileId = params.profileId || `anon-${req.socket.remoteAddress}-${Date.now()}`;
        ws._profileId = profileId;
        pendingConnections.delete(ws);
        // Replace any stale connection registered under the same profile.
        const existing = extensions.get(profileId);
        if (existing && existing !== ws) {
          try { existing.close(); } catch { /* already closed */ }
        }
        extensions.set(profileId, ws);
        console.log(`[Gateway] Extension ready: ${params.name} v${params.version} | profile=${profileId}`);
      } else if (method === 'heartbeat' || method === 'pong') {
```

Finally, replace the `ws.on('close', ...)` handler from:

```js
ws.on("close", () => {
  console.log("[Gateway] Chrome Extension disconnected");
  clearInterval(keepAliveTimer);
  extensionWs = null;

  // Fail all currently pending HTTP requests
  for (const [rpcId, pending] of pendingHttpRequests) {
    clearTimeout(pending.timeoutTimer);
    writeJson(pending.res, 502, {
      error: "Chrome extension disconnected during command execution",
    });
  }
  pendingHttpRequests.clear();
});
```

to:

```js
ws.on("close", () => {
  clearInterval(keepAliveTimer);
  pendingConnections.delete(ws);
  if (ws._profileId && extensions.get(ws._profileId) === ws) {
    extensions.delete(ws._profileId);
  }
  console.log(
    `[Gateway] Chrome Extension disconnected | profile=${ws._profileId || "(unidentified)"}`,
  );

  // Fail only the pending requests that were routed to THIS connection.
  for (const [rpcId, pending] of pendingHttpRequests) {
    if (pending.ws === ws) {
      clearTimeout(pending.timeoutTimer);
      pendingHttpRequests.delete(rpcId);
      writeJson(pending.res, 502, {
        error: "Chrome extension disconnected during command execution",
      });
    }
  }
});
```

- [ ] **Step 7: Run the integration test to verify it passes**

Run: `node mcp-web-extension/tests/unit/gateway-multi-profile.test.mjs`
Expected: PASS — prints `gateway-multi-profile.test.mjs OK`.

- [ ] **Step 8: Run the full extension test suite for regressions**

Run: `cd mcp-web-extension && npm test`
Expected: all five test scripts pass (the three originals plus `profile-id` and `gateway-multi-profile`).

- [ ] **Step 9: Commit**

```bash
git -C mcp-web-extension add server/gateway_server.js tests/unit/gateway-multi-profile.test.mjs
git -C mcp-web-extension commit -m "feat(gateway): route /api by profileId via Map of connections"
```

---

### Task 4: profileId support for the MCP server and CLI helper

`mcp_server.mjs` (the MCP entry point) and `scripts/webmcp-call.js` (the `npm run call` helper) also POST to `/api`. Give them an env-driven `profileId` so they work against a multi-profile gateway without changing call sites. These live in the `mcp-web-extension` git repo.

**Files:**

- Modify: `mcp-web-extension/server/mcp_server.mjs:16-17,110-115`
- Modify: `mcp-web-extension/scripts/webmcp-call.js:5-6,44-50`

**Interfaces:**

- Consumes: gateway `/api` routing contract (Task 3).
- Produces: both clients read `process.env.WEBMCP_PROFILE_ID` and, when set, add a top-level `profileId` to the POST body. No new exported symbols.

- [ ] **Step 1: Add profileId to mcp_server callGateway**

In `mcp-web-extension/server/mcp_server.mjs`, just after the existing `const gatewayUrl = ...` line (line 17), add:

```js
const profileId = process.env.WEBMCP_PROFILE_ID || undefined;
```

Then change `callGateway` from:

```js
async function callGateway(method, params) {
  const response = await fetch(`${gatewayUrl}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: params || {} }),
  });
```

to:

```js
async function callGateway(method, params) {
  const body = { method, params: params || {} };
  if (profileId) body.profileId = profileId;
  const response = await fetch(`${gatewayUrl}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
```

- [ ] **Step 2: Add profileId to the CLI helper**

In `mcp-web-extension/scripts/webmcp-call.js`, just after the existing `const gatewayUrl = ...` line (line 6), add:

```js
const profileId = process.env.WEBMCP_PROFILE_ID || undefined;
```

Then change the fetch in `main()` (around line 44) from:

```js
const params = parseJsonParams(rawParams);
const response = await fetch(gatewayUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ method, params }),
});
```

to:

```js
const params = parseJsonParams(rawParams);
const requestBody = { method, params };
if (profileId) requestBody.profileId = profileId;
const response = await fetch(gatewayUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(requestBody),
});
```

- [ ] **Step 3: Verify both files parse**

Run: `node --check mcp-web-extension/server/mcp_server.mjs && node --check mcp-web-extension/scripts/webmcp-call.js && echo "syntax OK"`
Expected: prints `syntax OK`.

- [ ] **Step 4: Manual smoke (optional, needs a running gateway + connected extension)**

Run: `cd mcp-web-extension && WEBMCP_PROFILE_ID=<a-connected-profile-id> npm run health`
Expected: the `ping` succeeds and is routed to that profile. Discover valid ids first via `curl -s localhost:7865/health | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).profiles))"`.

- [ ] **Step 5: Commit**

```bash
git -C mcp-web-extension add server/mcp_server.mjs scripts/webmcp-call.js
git -C mcp-web-extension commit -m "feat: forward WEBMCP_PROFILE_ID from mcp server and CLI helper"
```

---

### Task 5: Document profileId routing in the SKILL

Teach the agent that drives the gateway how to target a profile: discover connected profiles via `/health`, and pass a top-level `profileId` on every `/api` call when more than one profile is connected. Without this, an agent hitting a multi-profile gateway gets HTTP 400 and has no idea why.

**Files:**

- Modify: `mcp-web-extension/skills/webmcp-browser-automation/SKILL.md` (the "First Choice Transport" section — add a "Targeting a profile" subsection after the _Request shape_ block; and the "Mandatory Run Loop" step 1)

**Interfaces:**

- Consumes: gateway `/health` (`profiles`, `profileCount`) and `/api` routing contract from Task 3.
- Produces: documentation only — no code. After this task, the SKILL contains the strings `profileId`, `profileCount`, and a multi-profile routing-rules list.

- [ ] **Step 1: Add the "Targeting a profile" subsection**

In `mcp-web-extension/skills/webmcp-browser-automation/SKILL.md`, find the _Request shape_ block in the "First Choice Transport" section:

````markdown
Request shape:

```json
{ "method": "getActiveTab", "params": {} }
```
````

`````

Immediately **after** that block (before the *Response shape* block), insert:

````markdown
### Targeting a profile (multi-profile gateways)

One gateway can serve several Chrome profiles at once — one WebSocket per
profile. Each profile self-identifies with a stable `profileId` (a UUID it
persists in its own `chrome.storage.local`). To route a call to a specific
profile, add a **top-level** `profileId` field to the request body — a sibling
of `params`, **not** inside it:

```json
{ "method": "getActiveTab", "params": {}, "profileId": "a1b2c3d4-..." }
`````

Routing rules enforced by the gateway:

- **Exactly one profile connected** — `profileId` is optional; the call routes
  to that single profile.
- **Two or more profiles connected** — `profileId` is **required**. Omitting it
  returns HTTP 400 listing the connected ids.
- **Unknown / disconnected `profileId`** — HTTP 404.
- **No profile connected** — HTTP 503.

Discover the currently connected profiles with `GET /health`:

```bash
curl -sS http://localhost:7865/health
```

```json
{
  "ok": true,
  "extensionConnected": true,
  "profiles": ["a1b2c3d4-...", "e5f6a7b8-..."],
  "profileDetails": [
    {
      "profileId": "a1b2c3d4-...",
      "email": "user@gmail.com",
      "name": "Personal"
    },
    { "profileId": "e5f6a7b8-...", "email": "work@company.com", "name": "Work" }
  ],
  "profileCount": 2
}
```

Use `profileDetails` to identify profiles by email or display name. Pick a
`profileId` from `profileDetails` and pass it on **every** subsequent `/api`
call for that browser. Over a direct WebSocket connection you are already bound
to one profile's socket, so no `profileId` is needed there.

````

- [ ] **Step 2: Update the Mandatory Run Loop health check**

In the same file, find step 1 of the "Mandatory Run Loop":

```markdown
1. Health check: call `ping`. If the gateway is unreachable, start
   `npm run gateway` or `webmcp gateway start`. If the gateway is up but
   the extension is not connected, reload the unpacked extension from
   `webmcp-extension/dist`.
```

Replace it with:

```markdown
1. Health check: call `GET /health` (or `ping`). If the gateway is
   unreachable, start `npm run gateway` or `webmcp gateway start`. If the
   gateway is up but no extension is connected (`profileCount` is 0), reload
   the unpacked extension from `webmcp-extension/dist`. **If `profileCount`
   is greater than 1, pick a `profileId` from `health.profiles` and include
   it as a top-level field on every `/api` call** (see *Targeting a profile*).
```

- [ ] **Step 3: Verify the new content is present and consistent**

Run: `grep -n "Targeting a profile\|profileCount\|\"profileId\"" mcp-web-extension/skills/webmcp-browser-automation/SKILL.md`
Expected: matches for the new subsection heading, `profileCount` (in both the JSON example and the run-loop step), and the `profileId` JSON example — confirming both edits landed.

- [ ] **Step 4: Commit**

```bash
git -C mcp-web-extension add skills/webmcp-browser-automation/SKILL.md
git -C mcp-web-extension commit -m "docs(skill): document profileId routing for multi-profile gateways"
```

---

### Task 6: Profile metadata — email, display name, and MCP tools

Enrich each profile with human-readable metadata so agents can identify profiles by name or email instead of raw UUIDs. Add `getProfileInfo()` to the extension, expose `profileDetails` on `/health`, register `list_profiles` and `set_profile_name` as first-class MCP tools via the command catalog, and handle the `setProfileName` command in the extension.

**Files:**
- Modify: `mcp-web-extension/webmcp-extension/dist/manifest.json` — add `"identity"` and `"identity.email"` permissions
- Modify: `mcp-web-extension/webmcp-extension/dist/bg/profile-id.js` — add `getProfileInfo()` export
- Modify: `mcp-web-extension/webmcp-extension/dist/bg/ws-client.js` — import `getProfileInfo` instead of `getOrCreateProfileId`, send `profileEmail`/`profileName` in handshake, handle `setProfileName` command in `onmessage`
- Modify: `mcp-web-extension/server/gateway_server.js` — add `connectedProfileDetails()` helper, expose `profileDetails` on `/health`, store `_profileEmail`/`_profileName` on WebSocket from handshake
- Modify: `mcp-web-extension/catalog/command-catalog.js` — add `browser_raw_command`, `list_profiles`, `set_profile_name` definitions
- Modify: `mcp-web-extension/server/mcp-tool-catalog.mjs` — remove hardcoded pushes (now auto-generated from catalog)
- Modify: `mcp-web-extension/server/mcp_server.mjs` — handle `list_profiles` (query `/health` → return `profileDetails`), map `set_profile_name` → `setProfileName`, map `browser_raw_command` → extract inner `method`/`params`

**Interfaces:**
- `getProfileInfo(storage?) -> Promise<{ id, email, name }>` — uses `chrome.identity.getProfileUserInfo()` (requires `identity` + `identity.email` permissions) for email, reads `webmcp_profile_name` from `chrome.storage.local` for custom display name.
- `extensionReady` handshake params now include `profileEmail` and `profileName`.
- `/health` JSON now includes `profileDetails: Array<{ profileId, email, name }>`.
- MCP tool `list_profiles` returns `{ profiles: [{ profileId, email, name }, ...], profileCount }` — agents use this to discover and select profiles by human-readable labels.
- MCP tool `set_profile_name` accepts `{ name, profileId? }` — persists the name in the target extension's `chrome.storage.local` and triggers a reconnect so the gateway picks up the new name immediately.
- `setProfileName` command handled directly in `ws-client.js` `onmessage` — writes `webmcp_profile_name` to storage, sends success response, then closes WebSocket to trigger reconnect with updated handshake.

**Key implementation details:**
- `chrome.identity.getProfileUserInfo()` requires both `"identity"` and `"identity.email"` permissions in `manifest.json`. Without `"identity.email"`, Chrome silently returns an empty email string.
- The API must be called **without** the `{ privilege: 'enabled' }` argument for wider compatibility (works even when Chrome Sync is disabled).
- `list_profiles` and `set_profile_name` are defined in `catalog/command-catalog.js` alongside all other commands, then auto-generated into MCP tool schemas by `mcp-tool-catalog.mjs`. This follows the single-source-of-truth pattern.
- `browser_raw_command` is always included regardless of `WEBMCP_TOOLS` filter setting (escape hatch).

- [x] **Implemented and verified** — `list_profiles` returns full metadata:

```json
{
  "profiles": [
    { "profileId": "b6a7b273-...", "email": "hieu2906090@gmail.com", "name": "Personal" },
    { "profileId": "05475d86-...", "email": "hieu.mbf3@gmail.com", "name": "Work" }
  ],
  "profileCount": 2
}
```

---

## Notes for the implementer

- **Why a Map and not N gateway processes:** one process / one port multiplexes connections, so nobody needs a per-profile port and the hardcoded `ws://localhost:7865` in `ws-client.js:3` is no longer a blocker. The control plane discovers live profiles from a single `/health`.
- **profileId placement:** always a top-level sibling of `params` in the `/api` body. The gateway strips it before forwarding; the extension contract (`{ jsonrpc, id, method, params }`) is unchanged, so no extension handler needs touching beyond the handshake.
- **Backward compatibility is tested:** Task 3's integration test keeps single-connection behavior (no `profileId` + one profile → routed) and the `anon-...` handshake fallback keeps a profileId-less extension routable.
- **Concurrency limit unchanged:** `nextId` is process-global so JSON-RPC ids stay unique across profiles; a response on any socket still matches its pending request by id. Per-connection cleanup on `close` fails only that socket's in-flight requests.
- **Profile metadata enrichment (Task 6):** the `identity.email` permission is critical — without it `chrome.identity.getProfileUserInfo()` returns empty strings silently. The `set_profile_name` tool provides a reliable labeling mechanism even when profiles are not signed into Google accounts.
````
