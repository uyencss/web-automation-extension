'use strict';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:7865/api';

function gatewayUrl() {
  return process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL;
}

// Same transport as scripts/webmcp-call.js: POST { method, params } to the
// gateway. This is the only way to reach getCookies/setCookie/executeCDP,
// which are hidden from the default minimal MCP surface (plan §1).
async function gatewayCall(method, params = {}, options = {}) {
  const requestBody = { method, params };
  if (options.profileId) requestBody.profileId = options.profileId;
  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.WEBMCP_GATEWAY_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(gatewayUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `Gateway returned HTTP ${response.status}` };
  }
  if (!response.ok || payload.error) {
    throw new Error(`gateway ${method} failed: ${payload.error || `HTTP ${response.status}`}`);
  }
  return payload.result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveProfileId(argvProfileId) {
  return argvProfileId || process.env.WEBMCP_PROFILE_ID || undefined;
}

// getCookies records carry { domain, name, value, path, expires, httpOnly,
// secure, sameSite, session, size } from CDP Network.getCookies.
function cookieDomainMatches(cookieDomain, hostname) {
  const domain = String(cookieDomain).replace(/^\./, '');
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function cookieIsValid(cookie, nowSeconds = Date.now() / 1000) {
  return cookie.session === true || !cookie.expires || cookie.expires > nowSeconds;
}

function findCookie(cookies, hostname, name) {
  return (cookies || []).find(
    (c) => c.name === name && cookieDomainMatches(c.domain, hostname) && cookieIsValid(c),
  );
}

// getCookies must target the tab that loaded the challenge page: the extension
// reads cookies for the current page (tabId param), not the whole profile.
async function readCookies(tabId, gateway) {
  const result = await gatewayCall('getCookies', { tabId }, gateway);
  return (result && result.cookies) || [];
}

async function findClearance(tabId, hostname, gateway) {
  const cookies = await readCookies(tabId, gateway);
  return { cookies, clearance: findCookie(cookies, hostname, 'cf_clearance') };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    args[key] = next !== undefined && !next.startsWith('--') ? next : 'true';
    if (next !== undefined && !next.startsWith('--')) i += 1;
  }
  return args;
}

module.exports = {
  gatewayCall,
  sleep,
  resolveProfileId,
  cookieDomainMatches,
  cookieIsValid,
  findCookie,
  readCookies,
  findClearance,
  parseArgs,
};
