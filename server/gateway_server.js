const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { getCommandGroups, listCommands } = require('../catalog/command-catalog.js');

const PORT = Number(process.env.WEBMCP_GATEWAY_PORT || process.env.PORT || 7865);
// Bind to loopback by default so the local automation API is not reachable from
// the LAN. Set WEBMCP_GATEWAY_HOST=0.0.0.0 explicitly to expose it (e.g. for a
// remote agent on the same network) — you should pair that with a token.
const HOST = process.env.WEBMCP_GATEWAY_HOST || '127.0.0.1';
// Optional shared secret. When set, POST /api requires a matching
// `Authorization: Bearer <token>` (or `x-webmcp-token: <token>`) header. The
// managed app injects this into every child/agent via env; unset = open (the
// current default, safe because we now bind loopback only).
const TOKEN = process.env.WEBMCP_GATEWAY_TOKEN || '';
const COMMAND_TIMEOUT_MS = Number(process.env.WEBMCP_GATEWAY_TIMEOUT_MS || 60000);

// Version metadata surfaced on /health so a supervising app can detect drift
// between the gateway package and the bundled extension without extra IPC.
function readJsonSafe(relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, relPath), 'utf8'));
  } catch {
    return null;
  }
}
const GATEWAY_VERSION = readJsonSafe('../package.json')?.version || null;
const EXTENSION_VERSION = readJsonSafe('../webmcp-extension/dist/manifest.json')?.version || null;

// Timing-safe token comparison so a set token can't be probed by response time.
function tokenMatches(provided) {
  if (!TOKEN) return true;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return require('crypto').timingSafeEqual(a, b);
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  return req.headers['x-webmcp-token'] || '';
}
// Interval at which the gateway pings the extension. In Manifest V3, any
// inbound WebSocket message resets the service-worker idle timer (~30s).
// Pinging well under 30s keeps the extension's service worker alive so the
// connection survives even when all tabs/windows are closed.
const KEEPALIVE_PING_MS = Number(process.env.WEBMCP_GATEWAY_PING_MS || 15000);

// ── Result normalization ─────────────────────────────────────
// P1: Page WebMCP tools return results nested as:
//   result.result.content[0].text = '{"count":20,"elements":[...]}'
// Auto-parse that text into result.parsedContent so callers never need
// to unwrap manually. The original result.result is kept for compatibility.
//
// P4: If parsedContent indicates a page-tool error, mark it for HTTP 422.
function normalizeResult(result) {
  if (!result) return result;
  try {
    const text = result?.result?.content?.[0]?.text;
    if (typeof text === 'string' && (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))) {
      const parsed = JSON.parse(text);
      // P4: page tool signalled an error
      if (parsed && typeof parsed === 'object' && parsed.error === true && parsed.message) {
        return { ...result, parsedContent: parsed, _pageToolError: { message: parsed.message } };
      }
      return { ...result, parsedContent: parsed };
    }
  } catch {
    // Not JSON or parse failed — return as-is
  }
  return result;
}

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

function connectedProfileDetails() {
  const details = [];
  for (const [profileId, ws] of extensions) {
    if (ws.readyState === 1) {
      details.push({
        profileId,
        email: ws._profileEmail || '',
        name: ws._profileName || '',
        extensionVersion: ws._extensionVersion || '',
        capabilities: Array.isArray(ws._capabilities) ? ws._capabilities : [],
      });
    }
  }
  return details;
}

// Resolve which extension WebSocket should receive a command.
// Returns { ws } on success or { error, status } on failure.
function resolveTarget(profileId) {
  const ids = connectedProfileIds();
  if (ids.length === 0) {
    return { error: 'Chrome extension is not connected to the gateway', status: 503 };
  }
  if (profileId) {
    const ws = extensions.get(profileId);
    if (!ws || ws.readyState !== 1) {
      return { error: `No connected Chrome profile with profileId='${profileId}'`, status: 404 };
    }
    return { ws };
  }
  // No profileId specified: unambiguous only when exactly one profile is connected.
  if (ids.length === 1) {
    return { ws: extensions.get(ids[0]) };
  }
  return {
    error: `Multiple Chrome profiles are connected (${ids.join(', ')}). Specify "profileId" in the request body.`,
    status: 400,
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function listGatewayCommands() {
  return listCommands().filter((command) => command.group !== 'runner');
}

function getGatewayCommandGroups() {
  return getCommandGroups()
    .filter((group) => group.id !== 'runner')
    .map((group) => ({
      ...group,
      commands: group.commands.filter((command) => command.group !== 'runner'),
    }));
}

// ── HTTP Server ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS Headers to allow scripts/agents to query from anywhere
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-webmcp-token');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    const profiles = connectedProfileIds();
    const profileDetails = connectedProfileDetails();
    return writeJson(res, 200, {
      ok: true,
      extensionConnected: profiles.length > 0,
      profiles,
      profileDetails,
      profileCount: profiles.length,
      port: PORT,
      wsUrl: `ws://localhost:${PORT}`,
      apiUrl: `http://localhost:${PORT}/api`,
      timeoutMs: COMMAND_TIMEOUT_MS,
      gatewayVersion: GATEWAY_VERSION,
      extensionVersion: EXTENSION_VERSION,
      authRequired: Boolean(TOKEN),
      commands: listGatewayCommands(),
      commandGroups: getGatewayCommandGroups(),
    });
  }

  if (req.method === 'POST' && req.url === '/api') {
    if (!tokenMatches(extractToken(req))) {
      return writeJson(res, 401, { error: 'Unauthorized: missing or invalid gateway token' });
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      let requestPayload;
      try {
        requestPayload = JSON.parse(body);
      } catch (err) {
        return writeJson(res, 400, { error: 'Invalid JSON request payload' });
      }

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
        jsonrpc: '2.0',
        id: rpcId,
        method,
        params: params || {}
      };

      // Set up a timeout for this request. Batch runs several commands
      // sequentially → longer, proportional timeout (hard-capped at 300s).
      const actionCount =
        method === 'batch' && Array.isArray(params?.actions) ? params.actions.length : 1;
      const effectiveTimeout = Math.min(COMMAND_TIMEOUT_MS * actionCount, 300_000);
      const timeoutTimer = setTimeout(() => {
        const pending = pendingHttpRequests.get(rpcId);
        if (pending) {
          pendingHttpRequests.delete(rpcId);
          writeJson(
            pending.res,
            504,
            { error: `Command '${method}' timed out after ${effectiveTimeout}ms` }
          );
        }
      }, effectiveTimeout);

      // Store the pending HTTP response, tagged with the target connection so
      // we can fail it precisely if that connection drops.
      pendingHttpRequests.set(rpcId, { res, timeoutTimer, method, ws });

      // Forward to the chosen extension via WebSocket
      ws.send(JSON.stringify(extensionPayload));
      console.log(`[Gateway] Forwarded command: ID=${rpcId} | Method=${method} | profile=${profileId || '(single)'}`);
    });
  } else {
    writeJson(res, 404, { error: 'Not Found. Exposes GET /health and POST /api for automation.' });
  }
});

// ── WebSocket Server (for Chrome Extension) ─────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  pendingConnections.add(ws);
  ws._profileId = null;
  console.log(`[Gateway] Chrome Extension connected from ${req.socket.remoteAddress} (awaiting handshake)`);

  // ── Keep the MV3 service worker alive ──────────────────────
  // Send a lightweight ping notification on an interval. The extension does
  // not need to reply — the mere act of receiving a message resets Chrome's
  // service-worker idle timer, keeping the WebSocket connection alive.
  const keepAliveTimer = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: { ts: Date.now() } }));
    }
  }, KEEPALIVE_PING_MS);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // It's a response to a command we forwarded
    if ('id' in msg && !('method' in msg)) {
      const pending = pendingHttpRequests.get(msg.id);
      if (pending) {
        pendingHttpRequests.delete(msg.id);
        clearTimeout(pending.timeoutTimer);

        if ('error' in msg) {
          console.log(`[Gateway] Error response received for ID=${msg.id}:`, msg.error);
          writeJson(pending.res, 500, { error: msg.error?.message || 'Execution error' });
        } else {
          console.log(`[Gateway] Success response received for ID=${msg.id}`);
          // P1: auto-unwrap nested page-tool JSON so callers get parsedContent directly
          // P4: surface page-tool errors at HTTP level (422) instead of burying in 200 body
          const normalized = normalizeResult(msg.result);
          if (normalized._pageToolError) {
            const { _pageToolError, ...rest } = normalized;
            console.log(`[Gateway] Page tool error for ID=${msg.id}: ${_pageToolError.message}`);
            writeJson(pending.res, 422, { error: _pageToolError.message, errorType: 'pageToolError', raw: rest });
          } else {
            writeJson(pending.res, 200, { result: normalized });
          }
        }
      }
      return;
    }

    // Handle notifications or state changes from the extension (optional logs)
    if ('method' in msg) {
      const { method, params = {} } = msg;
      if (method === 'extensionReady') {
        // Fall back to a synthetic id so a profileId-less (older) extension is
        // still routable as a single connection.
        const profileId = params.profileId || `anon-${req.socket.remoteAddress}-${Date.now()}`;
        ws._profileId = profileId;
        ws._profileEmail = params.profileEmail || '';
        ws._profileName = params.profileName || '';
        ws._extensionVersion = params.version || '';
        ws._capabilities = Array.isArray(params.capabilities) ? params.capabilities : [];
        pendingConnections.delete(ws);
        // Replace any stale connection registered under the same profile.
        const existing = extensions.get(profileId);
        if (existing && existing !== ws) {
          try { existing.close(); } catch { /* already closed */ }
        }
        extensions.set(profileId, ws);
        console.log(`[Gateway] Extension ready: ${params.name} v${params.version} | profile=${profileId} | email=${ws._profileEmail} | name=${ws._profileName}`);
      } else if (method === 'heartbeat' || method === 'pong') {
        // Silent keep-alive traffic
      } else {
        console.log(`[Gateway] Event from Extension: ${method}`, params);
      }
    }
  });

  ws.on('close', () => {
    clearInterval(keepAliveTimer);
    pendingConnections.delete(ws);
    if (ws._profileId && extensions.get(ws._profileId) === ws) {
      extensions.delete(ws._profileId);
    }
    console.log(`[Gateway] Chrome Extension disconnected | profile=${ws._profileId || '(unidentified)'}`);

    // Fail only the pending requests that were routed to THIS connection.
    for (const [rpcId, pending] of pendingHttpRequests) {
      if (pending.ws === ws) {
        clearTimeout(pending.timeoutTimer);
        pendingHttpRequests.delete(rpcId);
        writeJson(pending.res, 502, { error: 'Chrome extension disconnected during command execution' });
      }
    }
  });
});

// Start Gateway Server
server.listen(PORT, HOST, () => {
  console.log('='.repeat(70));
  console.log(`  WebMCP Automation Gateway Server is running!`);
  console.log(`  - Bind Host: ${HOST}${HOST === '0.0.0.0' ? ' (exposed to LAN)' : ' (loopback only)'}`);
  console.log(`  - Gateway v${GATEWAY_VERSION || '?'} | Extension v${EXTENSION_VERSION || '?'}`);
  console.log(`  - Auth: ${TOKEN ? 'token required' : 'open (no token set)'}`);
  console.log(`  - Extension WebSocket Endpoint: ws://${HOST}:${PORT}`);
  console.log(`  - Health Endpoint: GET http://${HOST}:${PORT}/health`);
  console.log(`  - HTTP API Endpoint for Agents/Scripts: POST http://${HOST}:${PORT}/api`);
  console.log(`  - Command Timeout: ${COMMAND_TIMEOUT_MS}ms`);
  console.log('='.repeat(70));
  console.log('Load/reload the Extension in Chrome to connect.');
});
