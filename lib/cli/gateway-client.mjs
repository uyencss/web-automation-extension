import process from 'node:process';
import { DEFAULT_GATEWAY_URL } from './context.mjs';

export function getGatewayBaseUrl() {
  const raw = process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
}

export function getGatewayApiUrl() {
  return `${getGatewayBaseUrl()}/api`;
}

// Build request headers, attaching the gateway token when the environment
// provides one so calls succeed against a token-protected (app-managed) gateway.
export function gatewayHeaders(extra = {}) {
  const headers = { ...extra };
  const token = process.env.WEBMCP_GATEWAY_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}


export function parseJsonParams(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('params must be a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid JSON params: ${err.message}`);
  }
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `HTTP ${response.status}` };
  }

  return { response, payload };
}

export async function fetchJsonOrNull(url, options = {}) {
  try {
    return await fetchJson(url, options);
  } catch {
    return null;
  }
}


export async function printHealth({ json = false } = {}) {
  const { response, payload } = await fetchJson(`${getGatewayBaseUrl()}/health`);
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (response.ok) {
    const state = payload.extensionConnected ? 'extension connected' : 'extension not connected';
    console.log(`Gateway OK at ${payload.apiUrl || getGatewayApiUrl()} (${state})`);
  } else {
    console.error(`Gateway health failed: ${payload.error || response.status}`);
  }

  if (!response.ok || payload.error) process.exit(1);
}

export async function callGateway(method, rawParams) {
  const parsedParams = parseJsonParams(rawParams);
  const { profileId: requestProfileId, ...params } = parsedParams;
  const targetProfileId = requestProfileId || process.env.WEBMCP_PROFILE_ID || undefined;
  const body = { method, params };
  if (targetProfileId) body.profileId = targetProfileId;
  const { response, payload } = await fetchJson(getGatewayApiUrl(), {
    method: 'POST',
    headers: gatewayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });

  console.log(JSON.stringify(payload, null, 2));
  if (!response.ok || payload.error) process.exit(1);
}

// Construct and run the Gateway in the foreground. The server module only
// self-starts when it is executed directly (its guard compares process.argv[1]
// against its own filename), so the umbrella CLI has to build the instance from
// the exported factory itself. Called with no options, the factory resolves
// port/host/token from the same environment variables as direct execution.
async function startGatewayServer() {
  const { createGatewayServer, TOKEN } = await import('../../server/gateway_server.js');
  const instance = createGatewayServer();

  // listen() failures (EADDRINUSE, EACCES) arrive as 'error' events rather than
  // a rejected start(). ws forwards HTTP server errors onto the WebSocket
  // server, so listening there routes them through the CLI's stderr +
  // non-zero exit convention instead of leaving an uncaught 'error' event.
  instance.wss.on('error', (err) => {
    console.error(`Gateway server error: ${err.message}`);
    process.exit(1);
  });

  const { port, host } = await instance.start();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\nGateway stopping (${signal})...`);
    try {
      await instance.close();
    } catch (err) {
      console.error(`Gateway shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

  console.log(`WebMCP Gateway listening on http://${host}:${port}`);
  console.log(`  - Auth: ${TOKEN ? 'token required' : 'open (no token set)'}`);
  console.log(`  - Health: GET http://${host}:${port}/health`);
  console.log(`  - API: POST http://${host}:${port}/api`);
  console.log(`  - Extension WebSocket: ws://${host}:${port}`);

  // The listening socket keeps the event loop alive, so the process stays in
  // the foreground until a shutdown signal or an unrecoverable server error.
}

export async function runGateway(args) {
  const [subcommand = 'start', maybeJson] = args;
  if (subcommand === 'start') {
    await startGatewayServer();
    return;
  }

  if (subcommand === 'health') {
    await printHealth({ json: maybeJson === '--json' });
    return;
  }

  console.error(`Unknown gateway command: ${subcommand}`);
  process.exit(1);
}


export async function getGatewayHealth() {
  const result = await fetchJsonOrNull(`${getGatewayBaseUrl()}/health`);
  if (!result?.response?.ok) return null;
  return result.payload;
}
