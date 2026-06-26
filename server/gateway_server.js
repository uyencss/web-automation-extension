const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 7865;

// ── State ────────────────────────────────────────────────────
let extensionWs = null;
let nextId = 1;
const pendingHttpRequests = new Map();

// ── HTTP Server ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS Headers to allow scripts/agents to query from anywhere
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
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
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON request payload' }));
      }

      const { method, params } = requestPayload;
      if (!method) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing "method" in request' }));
      }

      if (!extensionWs || extensionWs.readyState !== 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Chrome extension is not connected to the gateway' }));
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
          pending.res.writeHead(504, { 'Content-Type': 'application/json' });
          pending.res.end(JSON.stringify({ error: `Command '${method}' timed out after 60s` }));
        }
      }, 60000);

      // Store the pending HTTP response
      pendingHttpRequests.set(rpcId, { res, timeoutTimer, method });

      // Forward to the extension via WebSocket
      extensionWs.send(JSON.stringify(extensionPayload));
      console.log(`[Gateway] Forwarded command to Extension: ID=${rpcId} | Method=${method}`);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found. Exposes POST /api for automation.' }));
  }
});

// ── WebSocket Server (for Chrome Extension) ─────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  extensionWs = ws;
  console.log(`[Gateway] Chrome Extension connected from ${req.socket.remoteAddress}`);

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
          pending.res.writeHead(500, { 'Content-Type': 'application/json' });
          pending.res.end(JSON.stringify({ error: msg.error?.message || 'Execution error' }));
        } else {
          console.log(`[Gateway] Success response received for ID=${msg.id}`);
          pending.res.writeHead(200, { 'Content-Type': 'application/json' });
          pending.res.end(JSON.stringify({ result: msg.result }));
        }
      }
      return;
    }

    // Handle notifications or state changes from the extension (optional logs)
    if ('method' in msg) {
      const { method, params = {} } = msg;
      if (method === 'extensionReady') {
        console.log(`[Gateway] Extension is ready: ${params.name} v${params.version}`);
      } else if (method === 'heartbeat') {
        // Silent heartbeat
      } else {
        console.log(`[Gateway] Event from Extension: ${method}`, params);
      }
    }
  });

  ws.on('close', () => {
    console.log('[Gateway] Chrome Extension disconnected');
    extensionWs = null;

    // Fail all currently pending HTTP requests
    for (const [rpcId, pending] of pendingHttpRequests) {
      clearTimeout(pending.timeoutTimer);
      pending.res.writeHead(502, { 'Content-Type': 'application/json' });
      pending.res.end(JSON.stringify({ error: 'Chrome extension disconnected during command execution' }));
    }
    pendingHttpRequests.clear();
  });
});

// Start Gateway Server
server.listen(PORT, () => {
  console.log('='.repeat(70));
  console.log(`  WebMCP Automation Gateway Server is running!`);
  console.log(`  - Extension WebSocket Endpoint: ws://localhost:${PORT}`);
  console.log(`  - HTTP API Endpoint for Agents/Scripts: POST http://localhost:${PORT}/api`);
  console.log('='.repeat(70));
  console.log('Load/reload the Extension in Chrome to connect.');
});
