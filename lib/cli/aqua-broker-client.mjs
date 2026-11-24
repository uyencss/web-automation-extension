import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { getGatewayBaseUrl, gatewayHeaders, fetchJson } from './gateway-client.mjs';

export function isMacSshOrNonAqua(env = process.env, { platform = process.platform, execFileSyncFn = execFileSync } = {}) {
  if (platform !== 'darwin') return false;
  if (env?.SSH_CONNECTION || env?.SSH_CLIENT || env?.SSH_TTY) return true;
  try {
    const out = execFileSyncFn('/bin/launchctl', ['managername'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out || '').trim() !== 'Aqua';
  } catch {
    return true;
  }
}

export async function getAquaServiceStatus({ gatewayUrl, timeoutMs = 3000 } = {}) {
  const baseUrl = (gatewayUrl || getGatewayBaseUrl()).replace(/\/+$/, '');
  try {
    const { response, payload } = await fetchJson(`${baseUrl}/api/aqua/status`, {
      method: 'GET',
      headers: gatewayHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        reachable: true,
        status: response.status,
        code: payload?.code || payload?.error || 'ERR_MACOS_AQUA_SERVICE_UNAVAILABLE',
        message: payload?.message || payload?.error || `HTTP ${response.status}`,
      };
    }
    return { reachable: true, ...payload };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      code: 'ERR_MACOS_AQUA_SERVICE_UNAVAILABLE',
      message: `Authorized WebMCP Aqua Gateway is unreachable at ${baseUrl}/api/aqua/status (${err?.message || err}). Ensure io.webmcp-gateway is running in the macOS Aqua session.`,
    };
  }
}

export async function callAquaBroker(endpoint, body = null, { gatewayUrl, timeoutMs = 45000, method } = {}) {
  const baseUrl = (gatewayUrl || getGatewayBaseUrl()).replace(/\/+$/, '');
  const cleanEndpoint = String(endpoint || '').replace(/^\/+/, '');
  const url = `${baseUrl}/api/aqua/${cleanEndpoint}`;
  const httpMethod = method || (body === null || body === undefined ? 'GET' : 'POST');

  let response;
  let payload;
  try {
    const res = await fetchJson(url, {
      method: httpMethod,
      headers: gatewayHeaders(httpMethod === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...(httpMethod === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    response = res.response;
    payload = res.payload;
  } catch (err) {
    const e = new Error(
      `ERR_MACOS_AQUA_SERVICE_UNAVAILABLE: SSH/non-Aqua process cannot touch macOS Keychain or Chrome directly, ` +
      `and authorized Aqua Gateway at ${baseUrl} did not respond (${err?.message || err}). ` +
      'Start/unlock the Aqua GUI session and verify `launchctl kickstart -k gui/$(id -u)/io.webmcp-gateway` inside Aqua.'
    );
    e.code = 'ERR_MACOS_AQUA_SERVICE_UNAVAILABLE';
    e.gatewayUrl = baseUrl;
    throw e;
  }

  if (!response.ok || payload?.ok === false) {
    const code = payload?.code || payload?.error || (response.status === 503 ? 'ERR_MACOS_AQUA_SERVICE_UNAVAILABLE' : 'ERR_MACOS_AQUA_CALL_FAILED');
    const e = new Error(payload?.message || payload?.error || `Aqua Gateway returned HTTP ${response.status} (${code})`);
    e.code = code;
    e.status = response.status;
    e.payload = payload;
    e.details = payload?.details;
    throw e;
  }

  return payload;
}
