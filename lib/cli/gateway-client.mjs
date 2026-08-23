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

export async function runGateway(args) {
  const [subcommand = 'start', maybeJson] = args;
  if (subcommand === 'start') {
    await import('../../server/gateway_server.js');
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
