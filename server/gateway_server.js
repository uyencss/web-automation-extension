const http = require('http');
const { WebSocketServer } = require('ws');
const { getCommandGroups, listCommands } = require('../catalog/command-catalog.js');

const PORT = Number(process.env.WEBMCP_GATEWAY_PORT || process.env.PORT || 7865);
const COMMAND_TIMEOUT_MS = Number(process.env.WEBMCP_GATEWAY_TIMEOUT_MS || 60000);
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
let extensionWs = null;
let nextId = 1;
const pendingHttpRequests = new Map();

function isExtensionConnected() {
  return extensionWs && extensionWs.readyState === 1;
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
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

  if (req.method === 'POST' && req.url === '/api') {
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

      const { method, params } = requestPayload;
      if (!method) {
        return writeJson(res, 400, { error: 'Missing "method" in request' });
      }

      if (!isExtensionConnected()) {
        return writeJson(res, 503, { error: 'Chrome extension is not connected to the gateway' });
      }

      // Assign a unique JSON-RPC ID
      const rpcId = nextId++;
      const extensionPayload = {
        jsonrpc: '2.0',
        id: rpcId,
        method,
        params: params || {}
      };

      // Set up a timeout for this request
      const timeoutTimer = setTimeout(() => {
        const pending = pendingHttpRequests.get(rpcId);
        if (pending) {
          pendingHttpRequests.delete(rpcId);
          writeJson(
            pending.res,
            504,
            { error: `Command '${method}' timed out after ${COMMAND_TIMEOUT_MS}ms` }
          );
        }
      }, COMMAND_TIMEOUT_MS);

      // Store the pending HTTP response
      pendingHttpRequests.set(rpcId, { res, timeoutTimer, method });

      // Forward to the extension via WebSocket
      extensionWs.send(JSON.stringify(extensionPayload));
      console.log(`[Gateway] Forwarded command to Extension: ID=${rpcId} | Method=${method}`);
    });
  } else {
    writeJson(res, 404, { error: 'Not Found. Exposes GET /health and POST /api for automation.' });
  }
});

// ── WebSocket Server (for Chrome Extension) ─────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  extensionWs = ws;
  console.log(`[Gateway] Chrome Extension connected from ${req.socket.remoteAddress}`);

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
        console.log(`[Gateway] Extension is ready: ${params.name} v${params.version}`);
      } else if (method === 'heartbeat' || method === 'pong') {
        // Silent keep-alive traffic
      } else {
        console.log(`[Gateway] Event from Extension: ${method}`, params);
      }
    }
  });

  ws.on('close', () => {
    console.log('[Gateway] Chrome Extension disconnected');
    clearInterval(keepAliveTimer);
    extensionWs = null;

    // Fail all currently pending HTTP requests
    for (const [rpcId, pending] of pendingHttpRequests) {
      clearTimeout(pending.timeoutTimer);
      writeJson(pending.res, 502, { error: 'Chrome extension disconnected during command execution' });
    }
    pendingHttpRequests.clear();
  });
});

// Start Gateway Server
server.listen(PORT, () => {
  console.log('='.repeat(70));
  console.log(`  WebMCP Automation Gateway Server is running!`);
  console.log(`  - Extension WebSocket Endpoint: ws://localhost:${PORT}`);
  console.log(`  - Health Endpoint: GET http://localhost:${PORT}/health`);
  console.log(`  - HTTP API Endpoint for Agents/Scripts: POST http://localhost:${PORT}/api`);
  console.log(`  - Command Timeout: ${COMMAND_TIMEOUT_MS}ms`);
  console.log('='.repeat(70));
  console.log('Load/reload the Extension in Chrome to connect.');
});
