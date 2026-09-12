import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { InteractiveRuntime } from './gateway/interactive-runtime.mjs';
import { PermitStore } from './gateway/permit-store.mjs';
import { TrustedContextChannel } from './gateway/trusted-context-channel.mjs';
import { classifyTool, readGovernorActiveFence, resolveA3FenceMode, logFenceDivergence } from './gateway/verifier.mjs';
import { digestCanonical } from './gateway/trusted-context-schema.mjs';
import { GovernorRepository } from '../profile-governor/repository.mjs';
import { ProfileGovernor } from '../profile-governor/lease-service.mjs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { getCommandGroups, listCommands } = require('../catalog/command-catalog.js');
const CATALOG_COMMANDS = listCommands();
const CATALOG_METHODS = new Set(CATALOG_COMMANDS.map((command) => command.name));
const GATEWAY_LOCAL_RAW_METHODS = new Set(['list_profiles', 'set_profile_name', 'listDownloadEvents', 'clearDownloadEvents']);
const KNOWN_RAW_METHODS = new Set(
  CATALOG_COMMANDS
    .filter((command) => command.group !== 'runner' && !['batch', 'browser_batch', 'browser_raw_command'].includes(command.name))
    .map((command) => command.name)
    .filter((method) => !GATEWAY_LOCAL_RAW_METHODS.has(method))
    .filter((method) => classifyTool('browser_raw_command', { method }) !== 'browser.raw.unknown'),
);

// Preserve an explicit port of 0 so callers/tests can request an ephemeral
// listener. `||` would treat 0 as absent and silently fall back to 7865.
const configuredPort = process.env.WEBMCP_GATEWAY_PORT ?? process.env.PORT;
const PORT = Number(configuredPort == null || configuredPort === '' ? 7865 : configuredPort);
const HOST = process.env.WEBMCP_GATEWAY_HOST || '127.0.0.1';
const TOKEN = process.env.WEBMCP_GATEWAY_TOKEN || '';
const COMMAND_TIMEOUT_MS = Number(process.env.WEBMCP_GATEWAY_TIMEOUT_MS || 60000);
const KEEPALIVE_PING_MS = Number(process.env.WEBMCP_GATEWAY_PING_MS || 15000);
const MAX_DOWNLOAD_EVENTS_PER_PROFILE = Number(process.env.WEBMCP_DOWNLOAD_EVENT_LIMIT || 200);
const PROFILE_ID_BINDING_DOMAIN = 'webmcp-digest-v1:profile-id-binding';

function profileIdBindingDigest(profileId) {
  // Runner's canonicalizer JSON-encodes string primitives before applying
  // the domain label; pass the already-canonical string through the Browser
  // helper, whose string overload otherwise treats it as raw bytes.
  return digestCanonical(PROFILE_ID_BINDING_DOMAIN, JSON.stringify(profileId));
}

// The verifier accepts stable MCP/wire aliases, while the extension dispatches
// its concrete command names. Keep this translation at the post-verification
// forwarding seam so receipts and permit checks continue to use the original
// caller-visible method names.
const WIRE_TO_EXTENSION_METHOD = new Map([
  ['browser_navigate', 'navigate'],
  ['browser_click', 'click'],
  ['browser_type', 'type'],
  ['browser_scroll', 'scroll'],
  ['browser_select', 'selectOption'],
  ['browser_hover', 'hover'],
  ['browser_evaluate', 'evaluateJS'],
  ['browser_screenshot', 'screenshot'],
  ['browser_page_text', 'getPageText'],
  ['browser_aria_snapshot', 'getAriaSnapshot'],
  ['browser_element_bounds', 'getElementBounds'],
  ['browser_press', 'pressKey'],
  ['browser_close', 'closeTab'],
  ['browser_get_page_text', 'getPageText'],
  ['browser_get_aria_snapshot', 'getAriaSnapshot'],
  ['browser_get_element_bounds', 'getElementBounds'],
  ['browser_click_by_ref', 'clickByRef'],
  ['browser_type_by_ref', 'typeByRef'],
  ['browser_evaluate_js', 'evaluateJS'],
  ['browser_query_selector_all', 'querySelectorAll'],
  ['browser_wait_for_stable', 'waitForStable'],
  ['browser_press_key', 'pressKey'],
  ['browser_select_option', 'selectOption'],
  ['browser_close_tab', 'closeTab'],
  ['browser_list_download_events', 'listDownloadEvents'],
  ['browser_clear_download_events', 'clearDownloadEvents'],
  ['browser_batch', 'batch'],
  ['page.click', 'click'],
  ['page.type', 'type'],
  ['page.scroll', 'scroll'],
  ['set_profile_name', 'setProfileName'],
]);

function mapGatewayCommand(method) {
  if (typeof method !== 'string' || !method.trim()) return method;
  const trimmed = method.trim();
  const explicit = WIRE_TO_EXTENSION_METHOD.get(trimmed);
  if (explicit) return explicit;
  if (CATALOG_METHODS.has(trimmed)) return trimmed;
  if (trimmed.startsWith('browser_')) {
    const implicitCamel = trimmed.slice('browser_'.length);
    if (CATALOG_METHODS.has(implicitCamel)) return implicitCamel;
  }
  return trimmed;
}

function rawCommandMethod(params = {}) {
  const aliases = ['method', 'command', 'action']
    .map((key) => (typeof params?.[key] === 'string' ? params[key].trim() : ''))
    .filter(Boolean);
  return new Set(aliases).size === 1 ? aliases[0] : null;
}

function getKnownRawMethods() {
  return [...KNOWN_RAW_METHODS].sort();
}

function mapGatewayRequest(method, params = {}, { allowBatch = true } = {}) {
  if (!allowBatch && (method === 'batch' || method === 'browser_batch')) {
    return { method: null, params: {}, error: 'TOOL_ACTION_NOT_ALLOWED', rawMethod: method };
  }
  if (method === 'browser_raw_command') {
    const rawMethod = rawCommandMethod(params);
    if (!rawMethod || !KNOWN_RAW_METHODS.has(rawMethod)) {
      return { method: null, params: {}, error: 'TOOL_ACTION_NOT_ALLOWED', rawMethod };
    }
    const resolvedMethod = mapGatewayCommand(rawMethod);
    return {
      method: resolvedMethod,
      params: sanitizeParams(params?.params || {}),
    };
  }
  return {
    method: mapGatewayCommand(method),
    params: sanitizeParams(params || {}),
  };
}

function prepareAuthorizationParams(method, params = {}) {
  if (method === 'browser_raw_command') {
    const innerParams = params?.params && typeof params.params === 'object' && !Array.isArray(params.params)
      ? params.params
      : {};
    return {
      ...params,
      ...innerParams,
      ...(params.method !== undefined ? { method: params.method } : {}),
      ...(params.command !== undefined ? { command: params.command } : {}),
      ...(params.action !== undefined ? { action: params.action } : {}),
      ...(params.params !== undefined ? { params: params.params } : {}),
    };
  }
  if (method === 'batch' || method === 'browser_batch') {
    const key = Array.isArray(params?.actions) ? 'actions' : (Array.isArray(params?.batch) ? 'batch' : null);
    if (!key) return params;
    return {
      ...params,
      [key]: params[key].map((action) => ({
        ...action,
        params: prepareAuthorizationParams(action.method || action.tool, action.params || {}),
      })),
    };
  }
  return params;
}

function normalizeHttpOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function rawOriginScopeError(method, params = {}, outerTargetOrigin = null, permit = null) {
  if (method === 'batch' || method === 'browser_batch') {
    const actions = getBatchActions(params) || [];
    for (const action of actions) {
      const error = rawOriginScopeError(
        action.method || action.tool,
        action.params || {},
        action.targetOrigin || outerTargetOrigin,
        permit,
      );
      if (error) return error;
    }
    return null;
  }
  if (method !== 'browser_raw_command') return null;
  const inner = params?.params && typeof params.params === 'object' && !Array.isArray(params.params)
    ? params.params
    : {};
  const innerValues = ['url', 'sourceOrigin', 'targetOrigin']
    .map((key) => inner[key])
    .filter((value) => value !== undefined && value !== null && value !== '');
  if (innerValues.length === 0) return null;
  const innerOrigins = innerValues.map(normalizeHttpOrigin);
  if (innerOrigins.some((origin) => !origin) || new Set(innerOrigins).size !== 1) {
    return 'EXECUTION_PERMIT_SCOPE_DENIED';
  }
  const innerOrigin = innerOrigins[0];
  const outerValue = outerTargetOrigin || params.targetOrigin || null;
  if (outerValue) {
    const outerOrigin = normalizeHttpOrigin(outerValue);
    if (!outerOrigin || outerOrigin !== innerOrigin) return 'EXECUTION_PERMIT_SCOPE_DENIED';
  }
  if (!permit) return 'EXECUTION_PERMIT_REQUIRED';
  if (!Array.isArray(permit.origins) || !permit.origins.includes(innerOrigin)) {
    return 'EXECUTION_PERMIT_SCOPE_DENIED';
  }
  return null;
}

function getBatchActions(params) {
  if (Array.isArray(params?.actions)) return params.actions;
  if (Array.isArray(params?.batch)) return params.batch;
  return null;
}

// ── Hardening: deep stripping of permit/signature/token and physical identity before forwarding ──
const _PERMIT_LEAK_KEYS = new Set(['permit', 'executionPermit', '_permit', '_executionPermit', 'permitId', 'signature', 'permitDigest', 'token', 'claimToken', 'contextDigest', 'revocationId', 'nonce']);
const _PHYSICAL_LEAK_KEYS = new Set(['profileId', 'physicalProfileId', 'physicalPath', 'profilePath', 'executablePath', 'hostProfileId']);
function stripPermitKeysDeep(value) {
  if (Array.isArray(value)) return value.map(stripPermitKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (_PERMIT_LEAK_KEYS.has(k)) continue;
      if (_PHYSICAL_LEAK_KEYS.has(k)) continue;
      if (/(?:secret|token|cookie|credential|password|privateKey|authorization|bearer|apiKey|auth)/i.test(k)) continue;
      out[k] = stripPermitKeysDeep(v);
    }
    return out;
  }
  return value;
}
function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return params || {};
  return stripPermitKeysDeep(params);
}
function sanitizeParamsForTest(params) { return sanitizeParams(params); }

// ── A3 slice v1: in-process Governor DI bootstrap (ADR 0012 D6) ──────────
// Singleton, no daemon/socket. Constructing or reconciling touches only the
// local state file, and only when the fence mode flag activates it — without
// the flag every path below is skipped and runtime behavior is unchanged.
const GOVERNOR_STATE_ENV = 'WEBMCP_GOVERNOR_STATE';

function defaultGovernorStatePath() {
  const explicit = process.env[GOVERNOR_STATE_ENV];
  if (explicit && typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return path.join(os.homedir(), '.webmcp', 'governor-state.json');
}

export function createGatewayGovernor({ statePath = null, registry = null, claims = null, liveness = null, revokeGrants = null } = {}) {
  const repository = new GovernorRepository({ statePath: statePath || defaultGovernorStatePath() });
  const governor = new ProfileGovernor({
    repository,
    ...(registry ? { registry } : {}),
    ...(claims ? { claims } : {}),
    ...(liveness ? { liveness } : {}),
    revokeGrants: typeof revokeGrants === 'function' ? revokeGrants : async () => true,
  });
  return { governor, repository, statePath: repository.statePath };
}

let gatewayGovernorSingleton = null;

export function getGatewayGovernorSingleton(options = null) {
  if (gatewayGovernorSingleton) return gatewayGovernorSingleton;
  gatewayGovernorSingleton = createGatewayGovernor(options || {});
  return gatewayGovernorSingleton;
}

export function resetGatewayGovernorSingleton() {
  const prev = gatewayGovernorSingleton;
  gatewayGovernorSingleton = null;
  return prev;
}

// Gateway startup reconcile: every known profile is reconciled with real
// liveness so crash orphans land in quarantine (with a recovery receipt and
// a bumped epoch that invalidates pre-crash fences) instead of lingering.
export async function reconcileGatewayProfiles({ governor, aliases = [] } = {}) {
  if (!governor || typeof governor.reconcileProfile !== 'function') {
    throw new Error('Gateway reconcile requires a Governor instance.');
  }
  const results = [];
  for (const alias of aliases) {
    try {
      const resource = await governor.reconcileProfile(alias);
      results.push({ alias, ok: true, state: resource?.state ?? null, fenceEpoch: resource?.fenceEpoch ?? null });
    } catch (error) {
      results.push({ alias, ok: false, code: error?.code || 'UNKNOWN', message: error?.message || String(error) });
    }
  }
  return results;
}

// Gateway external-use detection wiring: a positive Governor external_use
// verdict becomes a typed PROFILE_EXTERNAL_USE deny instead of trusting TTL.
// Advisory in-slice — an unreadable probe reports unchecked, never a deny.
export async function checkGatewayExternalUse({ governor, profileAlias, fenceMode = null } = {}) {
  const mode = fenceMode ?? resolveA3FenceMode();
  const denyDecision = mode === 'observe' ? 'would-deny' : 'deny';
  const allowDecision = mode === 'observe' ? 'would-allow' : 'allow';
  if (!governor || typeof governor.detectExternalUse !== 'function' || !profileAlias) {
    return { decision: allowDecision, reason: null, checked: false };
  }
  const resource = await governor.detectExternalUse(profileAlias);
  if (resource?.state === 'external_use') {
    return {
      decision: denyDecision,
      reason: 'PROFILE_EXTERNAL_USE',
      checked: true,
      state: resource.state,
      fenceEpoch: resource.fenceEpoch ?? null,
    };
  }
  return { decision: allowDecision, reason: null, checked: true, state: resource?.state ?? null };
}

export function makeGovernorActiveFenceReader(governor) {
  return (profileKey) => readGovernorActiveFence(governor, profileKey);
}

function readJsonSafe(relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, relPath), 'utf8'));
  } catch {
    return null;
  }
}
const GATEWAY_VERSION = readJsonSafe('../package.json')?.version || null;
const EXTENSION_VERSION = readJsonSafe('../webmcp-extension/dist/manifest.json')?.version || null;

function tokenMatches(provided, expectedToken = TOKEN) {
  if (!expectedToken) return true;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  return req.headers['x-webmcp-token'] || '';
}

function normalizeResult(result) {
  if (!result) return result;
  try {
    const text = result?.result?.content?.[0]?.text;
    if (typeof text === 'string' && (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))) {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.error === true && parsed.message) {
        return { ...result, parsedContent: parsed, _pageToolError: { message: parsed.message } };
      }
      return { ...result, parsedContent: parsed };
    }
  } catch {
    // parse failed — return as-is
  }
  return result;
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const EXTENSION_ERROR_MESSAGE_MAX = 512;
const EXTENSION_ERROR_SECRET_PATTERN = /(?:authorization[=:]\s*(?:bearer\s+)?|bearer\s+|token[=:]\s*|secret[=:]\s*|password[=:]\s*)[^\s,;]+/giu;

function sanitizeExtensionError(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const safe = {};
  if (Number.isSafeInteger(error.code)) safe.code = error.code;
  if (typeof error.message === 'string') {
    const message = error.message
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(EXTENSION_ERROR_SECRET_PATTERN, '[redacted]')
      .slice(0, EXTENSION_ERROR_MESSAGE_MAX)
      .trim();
    if (message) safe.message = message;
  }
  return Object.keys(safe).length > 0 ? safe : null;
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

function boundedLimit(value, fallback = 100, max = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function downloadOrigin(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
}

function deriveTargetOriginForMethod(method, params, explicitTargetOrigin) {
  if (typeof explicitTargetOrigin === 'string' && explicitTargetOrigin) {
    try {
      const u = new URL(explicitTargetOrigin);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === explicitTargetOrigin) return u.origin;
      if (u.origin) return u.origin;
    } catch {}
  }
  if (params && typeof params === 'object') {
    for (const key of ['targetOrigin', 'url', 'sourceOrigin']) {
      const v = params[key];
      if (typeof v === 'string' && v) {
        try {
          const u = new URL(v);
          if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
        } catch {}
      }
    }
  }
  return null;
}

function createGatewayServer({
  port = PORT,
  host = HOST,
  token = TOKEN,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
  keepalivePingMs = KEEPALIVE_PING_MS,
  interactiveRuntime = null,
  socketPath = process.env.WEBMCP_TRUSTED_CONTEXT_SOCKET || null,
  publicKey = process.env.WEBMCP_RUNNER_PUBLIC_KEY || process.env.WEBMCP_GATEWAY_PUBLIC_KEY || null,
  keyId = process.env.WEBMCP_RUNNER_KEY_ID || null,
  expectedPhase = null,
  interactiveMode = null,
  allowTestSeams = false,
  _testSeam = false,
  physicalRouteMap = null,
  routeMap = null,
  aliasToPhysicalMap = null,
} = {}) {
  const extensions = new Map();
  const pendingConnections = new Set();
  const pendingHttpRequests = new Map();
  const downloadEventsByProfile = new Map();
  const keepAliveTimers = new Set();
  let nextId = 1;

  const isTestEnv = process.env.NODE_ENV === 'test';
  const isTestContract = isTestEnv && process.env.WEBMCP_ALLOW_TEST_SEAMS === '1';
  const isTestSeamAllowed = isTestContract && Boolean(allowTestSeams || _testSeam);

  if (interactiveRuntime && !isTestSeamAllowed) {
    throw new Error('Passing custom interactiveRuntime is not permitted in production construction');
  }

  const injectedRouteMap = physicalRouteMap || routeMap || aliasToPhysicalMap || null;
  if (injectedRouteMap !== null && injectedRouteMap !== undefined && !isTestSeamAllowed) {
    throw new Error('Passing custom physicalRouteMap is not permitted in production construction');
  }

  const pinnedPublicKey = process.env.WEBMCP_RUNNER_PUBLIC_KEY || process.env.WEBMCP_GATEWAY_PUBLIC_KEY || null;
  const pinnedKeyId = process.env.WEBMCP_RUNNER_KEY_ID || null;
  const pinnedSocketPath = process.env.WEBMCP_TRUSTED_CONTEXT_SOCKET || null;

  if (!isTestSeamAllowed) {
    if (publicKey && publicKey !== pinnedPublicKey) {
      throw new Error('Passing custom publicKey is not permitted in production construction');
    }
    if (keyId && keyId !== pinnedKeyId) {
      throw new Error('Passing custom keyId is not permitted in production construction');
    }
    if (socketPath && socketPath !== pinnedSocketPath) {
      throw new Error('Passing custom socketPath is not permitted in production construction');
    }
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const hasInteractiveConfig = Boolean(
    publicKey ||
    socketPath ||
    process.env.WEBMCP_RUNNER_PUBLIC_KEY ||
    process.env.WEBMCP_GATEWAY_PUBLIC_KEY ||
    process.env.WEBMCP_TRUSTED_CONTEXT_SOCKET ||
    process.env.WEBMCP_GATEWAY_INTERACTIVE === '1' ||
    process.env.WEBMCP_INTERACTIVE_MODE ||
    isProduction
  );

  const defaultMode = hasInteractiveConfig ? 'enforce' : 'off';
  let effectiveMode = interactiveMode || process.env.WEBMCP_INTERACTIVE_MODE || defaultMode;

  if (effectiveMode === 'observe' && !isTestSeamAllowed) {
    throw new Error(`Interactive mode 'observe' is only allowed through explicit test seams and cannot be selected by production`);
  }

  if (effectiveMode !== 'enforce') {
    if (isProduction && !isTestSeamAllowed) {
      throw new Error(`Interactive mode '${effectiveMode}' cannot be selected by production caller`);
    }
  }

  const runtimeFenceMode = resolveA3FenceMode({ argv: process.argv.slice(2) });

  // A3 in-process Governor (ADR 0012 D6): built only under the fence mode
  // flag; otherwise null and every wired path below stays dormant. Liveness
  // is real gateway state — extension connectivity observed here, not a stub.
  let gatewayGovernor = null;
  if (runtimeFenceMode !== 'off') {
    try {
      gatewayGovernor = getGatewayGovernorSingleton({
        liveness: async () => {
          const linked = connectedProfileIds().length > 0;
          return {
            governor: 'healthy', registry: 'healthy', runnerClaim: 'active',
            browserAlive: linked, extensionConnected: linked,
          };
        },
      }).governor;
    } catch {
      gatewayGovernor = null;
    }
  }

  const runtime =
    (isTestSeamAllowed && interactiveRuntime) ||
    new InteractiveRuntime({
      publicKey: !isTestSeamAllowed ? pinnedPublicKey : publicKey,
      keyId: !isTestSeamAllowed ? pinnedKeyId : keyId,
      expectedPhase,
      socketPath: !isTestSeamAllowed ? pinnedSocketPath : socketPath,
      mode: effectiveMode,
      allowTestSeams: isTestSeamAllowed,
      _testSeam: isTestSeamAllowed,
      physicalRouteMap: isTestSeamAllowed && injectedRouteMap ? injectedRouteMap : null,
      governor: gatewayGovernor,
      fenceMode: runtimeFenceMode,
      getActiveFence: gatewayGovernor ? makeGovernorActiveFenceReader(gatewayGovernor) : null,
    });

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

  function resolveTarget(profileId, logicalHints = null, trustedPhysicalIds = null) {
    const ids = connectedProfileIds();
    if (ids.length === 0) {
      return { error: 'Chrome extension is not connected to the gateway', status: 503 };
    }
    if (profileId) {
      // Interactive physical-routing gate: a request-level physical ID is valid only when the
      // in-memory route map contains that exact physical value for an explicit logical identity
      // hint derived from the trusted context/permit. Do not accept merely because
      // extensions.get(profileId) exists. Missing/invalid map fails closed for interactive.
      const isInteractive = runtime.mode !== 'off' || (logicalHints && logicalHints.size > 0);
      if (isInteractive && logicalHints && logicalHints.size > 0) {
        // Legacy signed contexts may bind a physical profile directly. That
        // identity is trusted only when it came from the context itself; it
        // must never be inferred from a request or treated as a logical alias.
        if (trustedPhysicalIds?.has(profileId)) {
          const wsTrusted = extensions.get(profileId);
          if (wsTrusted && wsTrusted.readyState === 1) return { ws: wsTrusted, profileId };
          return { error: `No connected Chrome profile with profileId='${profileId}'`, status: 404 };
        }
        const isLogicalHint = logicalHints.has(profileId);
        if (!isLogicalHint) {
          let allowed = false;
          if (runtime && runtime.physicalRouteMap) {
            for (const hint of logicalHints) {
              const mapped = runtime.physicalRouteMap.get(hint);
              if (mapped && mapped === profileId) { allowed = true; break; }
            }
          }
          if (!allowed) {
            return { error: `No connected Chrome profile with profileId='${profileId}'`, status: 404 };
          }
          const wsPhys = extensions.get(profileId);
          if (wsPhys && wsPhys.readyState === 1) return { ws: wsPhys, profileId };
          return { error: `No connected Chrome profile with profileId='${profileId}'`, status: 404 };
        }
        // Logical alias hint: resolve via physical map first
        if (runtime && runtime.physicalRouteMap) {
          const mappedPhysical = runtime.physicalRouteMap.get(profileId);
          if (mappedPhysical) {
            const wsMapped = extensions.get(mappedPhysical);
            if (wsMapped && wsMapped.readyState === 1) return { ws: wsMapped, profileId: mappedPhysical };
          }
        }
        // A logical alias is usable only when the construction-owned route
        // map resolves it to a connected physical profile. Direct lookup of a
        // same-named extension is not an authority proof.
        return { error: `No connected Chrome profile with profileId='${profileId}'`, status: 404 };
      }
      // Non-interactive / legacy path: preserve direct lookup + logical->physical fallback
      let ws = extensions.get(profileId);
      if (ws && ws.readyState === 1) {
        return { ws, profileId };
      }
      if (runtime && runtime.physicalRouteMap) {
        const mappedPhysical = runtime.physicalRouteMap.get(profileId);
        if (mappedPhysical) {
          ws = extensions.get(mappedPhysical);
          if (ws && ws.readyState === 1) return { ws, profileId: mappedPhysical };
        }
      }
      return { error: `No connected Chrome profile with profileId='${profileId}'`, status: 404 };
    }
    if (ids.length === 1) {
      const singleId = ids[0];
      return { ws: extensions.get(singleId), profileId: singleId };
    }
    return {
      error: `Multiple Chrome profiles are connected (${ids.join(', ')}). Specify "profileId" in the request body.`,
      status: 400,
    };
  }

  function resolveEffectiveTargetForTrusted(logicalAlias) {
    if (!logicalAlias) return resolveTarget(logicalAlias);
    // Prefer physical mapping for trusted routing when multiple profiles
    if (runtime && runtime.physicalRouteMap) {
      const physical = runtime.physicalRouteMap.get(logicalAlias);
      if (physical) {
        const direct = extensions.get(physical);
        if (direct && direct.readyState === 1) return { ws: direct, profileId: physical };
      }
    }
    return resolveTarget(logicalAlias);
  }

  function recordDownloadEvent(profileId, type, params = {}) {
    if (!profileId) return;
    const events = downloadEventsByProfile.get(profileId) || [];
    events.push({
      schema: 'webmcp-download-event/1',
      type,
      observedAt: new Date().toISOString(),
      profileId,
      id: params.id ?? null,
      url: params.url || null,
      sourceOrigin: downloadOrigin(params.url),
      filename: params.filename || null,
      mimeType: params.mime || params.mimeType || null,
      fileSize: Number.isFinite(Number(params.fileSize)) ? Number(params.fileSize) : null,
      state: params.state || null,
      error: params.error || null,
    });
    while (events.length > MAX_DOWNLOAD_EVENTS_PER_PROFILE) events.shift();
    downloadEventsByProfile.set(profileId, events);
  }

  function listDownloadEvents(profileId, params = {}) {
    const since = typeof params.since === 'string' ? params.since : null;
    const limit = boundedLimit(params.limit);
    const entries = profileId
      ? (downloadEventsByProfile.get(profileId) || [])
      : [...downloadEventsByProfile.values()].flat();
    const filtered = since
      ? entries.filter((event) => event.observedAt > since)
      : entries;
    return {
      schema: 'webmcp-download-events/1',
      profileId: profileId || null,
      count: filtered.slice(-limit).length,
      events: filtered.slice(-limit),
    };
  }

  function clearDownloadEvents(profileId) {
    if (profileId) {
      const cleared = (downloadEventsByProfile.get(profileId) || []).length;
      downloadEventsByProfile.set(profileId, []);
      return { schema: 'webmcp-download-events-cleared/1', profileId, cleared };
    }
    const cleared = [...downloadEventsByProfile.values()].reduce((sum, events) => sum + events.length, 0);
    downloadEventsByProfile.clear();
    return { schema: 'webmcp-download-events-cleared/1', profileId: null, cleared };
  }

  // ── HTTP Server ──────────────────────────────────────────────
  const server = http.createServer((req, res) => {
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
      const activeCtx = runtime.getCurrentContext();
      const boundPort = server.address()?.port || port;
      const isAuthenticated = !token || tokenMatches(extractToken(req), token);

      const healthPayload = {
        ok: true,
        schema: 'webmcp-browser-gateway-health/1',
        extensionConnected: profiles.length > 0,
        profiles,
        profileDetails,
        profileCount: profiles.length,
        port: boundPort,
        wsUrl: `ws://localhost:${boundPort}`,
        apiUrl: `http://localhost:${boundPort}/api`,
        timeoutMs: commandTimeoutMs,
        gatewayVersion: GATEWAY_VERSION,
        extensionVersion: EXTENSION_VERSION,
        authRequired: Boolean(token),
        commands: listGatewayCommands(),
        commandGroups: getGatewayCommandGroups(),
        interactive: {
          enabled: Boolean(runtime),
          mode: runtime.mode,
          hasContext: Boolean(activeCtx),
        },
      };

      if (isAuthenticated && runtime.getContextSummary) {
        healthPayload.interactive.contextSummary = runtime.getContextSummary();
      }

      return writeJson(res, 200, healthPayload);
    }

    if (req.method === 'POST' && req.url === '/api') {
      if (!tokenMatches(extractToken(req), token)) {
        return writeJson(res, 401, { error: 'Unauthorized: missing or invalid gateway token' });
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        let requestPayload;
        try {
          requestPayload = JSON.parse(body);
        } catch {
          return writeJson(res, 400, { error: 'Invalid JSON request payload' });
        }

        const { method, params, profileId, permit, targetOrigin } = requestPayload;
        const durablePermit = permit?.schema === 'webmcp-durable-execution-permit/1';
        if (!method) {
          return writeJson(res, 400, { error: 'Missing "method" in request' });
        }

        const mappedRequest = mapGatewayRequest(method, params || {});
        const isDownloadMethod = ['listDownloadEvents', 'clearDownloadEvents'].includes(mappedRequest.method);

        // Trusted signed context controls physical routing when multiple profiles are connected.
        // Request-supplied profile must not select an attacker profile. Single-profile case remains
        // compatible but fail-closed via verification (403) rather than routing 404, as covered by tests.
        const trustedProfileId = durablePermit ? null : (runtime.getCurrentContext()?.profileId || null);
        const hasTrusted = Boolean(trustedProfileId && runtime.mode !== 'off');
        let profileForResolve = profileId;
        if (hasTrusted && connectedProfileIds().length > 1) {
          profileForResolve = trustedProfileId;
        }

        // First resolve target to obtain effective profile ID
        let ws = null;
        let resolvedPhysicalProfileId = null;
        let effectiveProfileId = profileId || params?.profileId || null;
        if (hasTrusted && connectedProfileIds().length > 1) effectiveProfileId = trustedProfileId;

        // Derive only logical identity hints from trusted context/permit. A
        // physical profile ID is never a logical-route hint and must not make
        // a direct extension lookup authoritative.
        const ctxForHints = runtime.getCurrentContext();
        const logicalHints = new Set();
        const trustedPhysicalIds = new Set();
        if (ctxForHints?.profileAlias && typeof ctxForHints.profileAlias === 'string') logicalHints.add(ctxForHints.profileAlias);
        if (!durablePermit && ctxForHints?.profileId && typeof ctxForHints.profileId === 'string') trustedPhysicalIds.add(ctxForHints.profileId);
        if (permit?.profileAlias && typeof permit.profileAlias === 'string') logicalHints.add(permit.profileAlias);

        if (!isDownloadMethod) {
          const target = resolveTarget(profileForResolve, logicalHints, trustedPhysicalIds);
          if (target.error) {
            // Create blocked receipt for no-target case
            let blockedReceipt = null;
            const isInteractive = runtime.mode !== 'off' || Boolean(permit);
            if (isInteractive) {
              try {
                const ctx = runtime.getCurrentContext();
                const derivedOrigin = deriveTargetOriginForMethod(method, params || {}, targetOrigin);
                blockedReceipt = runtime.createBlockedReceipt({
                  permit,
                  context: ctx,
                  method,
                  params: params || {},
                  targetOrigin: derivedOrigin,
                  reason: 'NO_TARGET',
                  sequence: 1,
                });
              } catch {
                blockedReceipt = null;
              }
              // For interactive physical routing mismatch, fail closed with typed deny rather than 404
              try {
                const check = await runtime.enforceRequestAsync({
                  method,
                  params: params || {},
                  profileId: effectiveProfileId,
                  permit,
                  targetOrigin,
                  now: new Date(),
                });
                if (check.decision === 'deny' && check.reason === 'EXECUTION_PROFILE_MISMATCH') {
                  return writeJson(res, 403, {
                    error: check.reason,
                    decision: check.decision,
                    reason: check.reason,
                    actionClass: check.actionClass,
                    receipt: check.receipt,
                  });
                }
              } catch {}
            }
            return writeJson(res, target.status, { error: target.error, receipt: blockedReceipt });
          }
          ws = target.ws;
          resolvedPhysicalProfileId = target.profileId;
          if (hasTrusted && connectedProfileIds().length > 1) {
            effectiveProfileId = trustedProfileId;
          } else {
            effectiveProfileId = profileId || target.profileId || ws._profileId;
          }
        } else {
          const ids = connectedProfileIds();
          if (!effectiveProfileId && hasTrusted && trustedProfileId) {
            effectiveProfileId = trustedProfileId;
          }
          if (!effectiveProfileId && ids.length === 1) {
            effectiveProfileId = ids[0];
          }
          if (hasTrusted && ids.length > 1) {
            effectiveProfileId = trustedProfileId;
          }
        }

        if (durablePermit && permit?.profileIdDigest && resolvedPhysicalProfileId
          && profileIdBindingDigest(resolvedPhysicalProfileId) !== permit.profileIdDigest) {
          return writeJson(res, 403, {
            error: 'EXECUTION_PROFILE_BINDING_MISMATCH',
            decision: 'deny',
            reason: 'EXECUTION_PROFILE_BINDING_MISMATCH',
          });
        }

        // Interactive Server-side Verification
        const isInteractive = runtime.mode !== 'off' || Boolean(permit);
        let executionReceipt = null;
        let enforcement = null;
        // A3 physical fence: surface Governor external-use detection as a
        // typed PROFILE_EXTERNAL_USE deny instead of trusting TTL. Advisory
        // in-slice: only a positive external_use verdict denies; probe
        // failures log (redacted) and continue without denying.
        if (gatewayGovernor && runtimeFenceMode !== 'off' && !isDownloadMethod && isInteractive) {
          const fenceAlias = permit?.profileAlias || runtime.getCurrentContext()?.profileAlias || null;
          if (fenceAlias) {
            try {
              const externalUse = await checkGatewayExternalUse({
                governor: gatewayGovernor,
                profileAlias: fenceAlias,
                fenceMode: runtimeFenceMode,
              });
              if (externalUse.reason === 'PROFILE_EXTERNAL_USE') {
                if (externalUse.decision === 'would-deny') {
                  // S6d Fix C: fence-observe means "log divergence, do not
                  // deny" — continue the request. Only the enforce `deny`
                  // below blocks with a typed receipt.
                  logFenceDivergence(runtime.verifier?.divergenceSink, {
                    profileKey: fenceAlias,
                    leaseId: null,
                    fenceEpoch: externalUse.fenceEpoch ?? null,
                    correlationId: permit?.runId ?? permit?.permitId ?? null,
                    decision: externalUse.decision,
                    reason: 'PROFILE_EXTERNAL_USE',
                  });
                  console.log(`[Gateway] External-use observe pass-through: decision=would-deny reason=PROFILE_EXTERNAL_USE (divergence logged, continuing)`);
                } else {
                  const blockedReceipt = runtime.createBlockedReceipt({
                    permit,
                    context: runtime.getCurrentContext(),
                    method,
                    params: params || {},
                    targetOrigin,
                    reason: 'PROFILE_EXTERNAL_USE',
                    sequence: 1,
                  });
                  console.log(`[Gateway] External-use deny: decision=${externalUse.decision} reason=PROFILE_EXTERNAL_USE`);
                  return writeJson(res, 403, {
                    error: 'PROFILE_EXTERNAL_USE',
                    decision: externalUse.decision,
                    reason: 'PROFILE_EXTERNAL_USE',
                    receipt: blockedReceipt,
                  });
                }
              }
            } catch (error) {
              console.log(`[Gateway] External-use probe skipped for profile=[redacted] (${error?.code || 'UNKNOWN'})`);
            }
          }
        }
        const rawOriginError = isInteractive
          ? rawOriginScopeError(method, params || {}, targetOrigin, permit)
          : null;
        if (rawOriginError) {
          const isBatch = method === 'batch' || method === 'browser_batch';
          const batchActions = isBatch ? getBatchActions(params) : null;
          const ctx = runtime.getCurrentContext();
          if (isBatch && Array.isArray(batchActions) && batchActions.length > 0) {
            const blocked = runtime.createBatchBlockedReceipts({
              permit,
              context: ctx,
              actions: batchActions.map((a) => ({ method: a.method || a.tool, params: a.params || {}, targetOrigin: a.targetOrigin })),
              reason: rawOriginError,
            });
            return writeJson(res, 403, {
              error: rawOriginError,
              decision: 'deny',
              reason: rawOriginError,
              receipt: blocked.aggregate,
              receipts: blocked.children,
            });
          }
          const blockedReceipt = runtime.createBlockedReceipt({
            permit,
            context: ctx,
            method,
            params: params || {},
            targetOrigin,
            reason: rawOriginError,
            sequence: 1,
          });
          return writeJson(res, 403, {
            error: rawOriginError,
            decision: 'deny',
            reason: rawOriginError,
            receipt: blockedReceipt,
          });
        }

        if (isInteractive) {
          enforcement = await runtime.enforceRequestAsync({
            method,
            params: params || {},
            verificationParams: prepareAuthorizationParams(method, params || {}),
            profileId: effectiveProfileId,
            permit,
            targetOrigin,
            now: new Date(),
          });

          executionReceipt = enforcement.receipt;

          // A3 fence-observe pass-through (ADR 0012 D5): a fence-layer
          // would-deny means "log divergence, do not deny" — the divergence
          // is already recorded, so fall through to forwarding instead of
          // blocking. Permit-layer would-deny keeps blocking (unchanged).
          const fenceObservePassThrough = enforcement.decision === 'would-deny'
            && enforcement.fenceLayer === true;
          if (fenceObservePassThrough) {
            console.log(`[Gateway] Fence observe pass-through: reason=${enforcement.reason} actionClass=${enforcement.actionClass} (divergence logged, forwarding)`);
          }

          // Handle batch denied with zero-forward: create blocked child receipts
          const isBatch = method === 'batch' || method === 'browser_batch';
          const batchActions = isBatch ? getBatchActions(params) : null;
          if ((enforcement.decision === 'deny' || enforcement.decision === 'would-deny') && !fenceObservePassThrough) {
            if (isBatch && Array.isArray(batchActions) && batchActions.length > 0) {
              const ctx = runtime.getCurrentContext();
              const blocked = runtime.createBatchBlockedReceipts({
                permit,
                context: ctx,
                actions: batchActions.map((a) => ({ method: a.method || a.tool, params: a.params || {}, targetOrigin: a.targetOrigin })),
                reason: enforcement.reason || 'EXECUTION_PERMIT_SCOPE_DENIED',
              });
              console.log(`[Gateway] Batch denied: reason=${enforcement.reason} actionClass=${enforcement.actionClass} decision=${enforcement.decision}`);
              return writeJson(res, 403, {
                error: enforcement.reason,
                decision: enforcement.decision,
                reason: enforcement.reason,
                actionClass: enforcement.actionClass,
                receipt: blocked.aggregate,
                receipts: blocked.children,
              });
            }
            console.log(`[Gateway] Request denied: reason=${enforcement.reason} actionClass=${enforcement.actionClass} decision=${enforcement.decision}`);
            // A3 physical fence audit: fence-layer denies carry their typed
            // code end-to-end (PROFILE_FENCE_REQUIRED when the proof is
            // absent, PROFILE_FENCE_STALE when it is no longer current).
            if (enforcement.reason === 'PROFILE_FENCE_REQUIRED' || enforcement.reason === 'PROFILE_FENCE_STALE') {
              console.log(`[Gateway] Physical fence deny: reason=${enforcement.reason} decision=${enforcement.decision} actionClass=${enforcement.actionClass}`);
            }
            return writeJson(res, 403, {
              error: enforcement.reason,
              decision: enforcement.decision,
              reason: enforcement.reason,
              actionClass: enforcement.actionClass,
              receipt: enforcement.receipt,
            });
          }
        }

        if (isDownloadMethod) {
          const downloadMethod = mappedRequest.method;
          if (!effectiveProfileId) {
            const blockedReceipt = runtime.createBlockedReceipt({
              permit,
              context: runtime.getCurrentContext(),
              method,
              params: params || {},
              targetOrigin,
              reason: 'PROFILE_REQUIRED',
              sequence: 1,
            });
            return writeJson(res, 400, {
              error: 'PROFILE_REQUIRED',
              decision: 'deny',
              reason: 'PROFILE_REQUIRED',
              receipt: blockedReceipt,
            });
          }
          if (downloadMethod === 'listDownloadEvents') {
            const result = listDownloadEvents(effectiveProfileId, params || {});
            if (isInteractive) {
              const ctx = runtime.getCurrentContext();
              const derivedOrigin = deriveTargetOriginForMethod(method, params || {}, targetOrigin);
              const finalReceipt = runtime.createAppliedReceipt({
                permit,
                context: ctx,
                method,
                params: params || {},
                targetOrigin: derivedOrigin,
                result,
                sequence: 1,
              });
              return writeJson(res, 200, { result, receipt: finalReceipt });
            }
            return writeJson(res, 200, { result });
          }
          if (downloadMethod === 'clearDownloadEvents') {
            const result = clearDownloadEvents(effectiveProfileId);
            if (isInteractive) {
              const ctx = runtime.getCurrentContext();
              const derivedOrigin = deriveTargetOriginForMethod(method, params || {}, targetOrigin);
              const finalReceipt = runtime.createAppliedReceipt({
                permit,
                context: ctx,
                method,
                params: params || {},
                targetOrigin: derivedOrigin,
                result,
                sequence: 1,
              });
              return writeJson(res, 200, { result, receipt: finalReceipt });
            }
            return writeJson(res, 200, { result });
          }
        }

        // Hardening: enforce trusted routing for actual forwarding when multiple profiles (single-profile compatibility preserved)
        if (hasTrusted && connectedProfileIds().length > 1) {
          const trustedTarget = resolveEffectiveTargetForTrusted(trustedProfileId);
          if (!trustedTarget.error) {
            ws = trustedTarget.ws;
            effectiveProfileId = trustedProfileId;
          } else {
            let blockedReceipt = null;
            try {
              const ctx = runtime.getCurrentContext();
              const derivedOrigin = deriveTargetOriginForMethod(method, params || {}, targetOrigin);
              blockedReceipt = runtime.createBlockedReceipt({
                permit,
                context: ctx,
                method,
                params: params || {},
                targetOrigin: derivedOrigin,
                reason: 'NO_TARGET',
                sequence: 1,
              });
            } catch {
              blockedReceipt = null;
            }
            return writeJson(res, trustedTarget.status, { error: trustedTarget.error, receipt: blockedReceipt });
          }
        }

        if (mappedRequest.error) {
          const blockedReceipt = runtime.createBlockedReceipt({
            permit,
            context: runtime.getCurrentContext(),
            method,
            params: params || {},
            targetOrigin: targetOrigin || deriveTargetOriginForMethod(method, params || {}, null),
            reason: mappedRequest.error,
            sequence: 1,
          });
          return writeJson(res, 403, {
            error: mappedRequest.error,
            decision: 'deny',
            reason: mappedRequest.error,
            receipt: blockedReceipt,
          });
        }
        let forwardedParams = mappedRequest.params;
        if (method === 'batch' || method === 'browser_batch') {
          const rawActions = Array.isArray(params?.actions) ? params.actions : (Array.isArray(params?.batch) ? params.batch : []);
          const canonicalActions = [];
          let childMappingError = null;
          for (const act of rawActions) {
            const childRequest = mapGatewayRequest(act.method || act.tool, act.params || {}, { allowBatch: false });
            if (childRequest.error) {
              childMappingError = childRequest.error;
              break;
            }
            canonicalActions.push({ method: childRequest.method, params: childRequest.params });
          }
          if (childMappingError) {
            const blocked = runtime.createBatchBlockedReceipts({
              permit,
              context: runtime.getCurrentContext(),
              actions: rawActions.map((act) => ({ method: act.method || act.tool, params: act.params || {}, targetOrigin: act.targetOrigin })),
              reason: childMappingError,
            });
            return writeJson(res, 403, {
              error: childMappingError,
              decision: 'deny',
              reason: childMappingError,
              receipt: blocked.aggregate,
              receipts: blocked.children,
            });
          }
          forwardedParams = {
            ...sanitizeParams(params || {}),
            ...(Array.isArray(params?.actions) ? { actions: canonicalActions } : {}),
            ...(Array.isArray(params?.batch) ? { batch: canonicalActions } : {}),
          };
        }

        const rpcId = nextId++;
        const extensionPayload = {
          jsonrpc: '2.0',
          id: rpcId,
          method: mappedRequest.method,
          params: forwardedParams,
        };

        const batchItems = method === 'batch' || method === 'browser_batch'
          ? (Array.isArray(params?.actions) ? params.actions : params?.batch)
          : null;
        const actionCount = Array.isArray(batchItems) ? Math.max(batchItems.length, 1) : 1;
        const effectiveTimeout = Math.min(commandTimeoutMs * actionCount, 300_000);

        const timeoutTimer = setTimeout(() => {
          const pending = pendingHttpRequests.get(rpcId);
          if (pending) {
            pendingHttpRequests.delete(rpcId);
            let finalReceipt = null;
            const isBatch = pending.method === 'batch' || pending.method === 'browser_batch';
            const batchActions = isBatch ? getBatchActions(pending.params) : null;
            if (isBatch && Array.isArray(batchActions)) {
              const finalReceipts = [];
              for (let i = 0; i < batchActions.length; i++) {
                const act = batchActions[i];
                const r = runtime.createIndeterminateReceipt({
                  permit: pending.permit,
                  context: pending.context,
                  method: act.method || act.tool,
                  params: act.params || {},
                  targetOrigin: act.targetOrigin || deriveTargetOriginForMethod(act.method || act.tool, act.params || {}, null),
                  sequence: i + 1,
                  reason: 'GATEWAY_TIMEOUT',
                });
                finalReceipts.push(r);
              }
              const agg = runtime.createIndeterminateReceipt({
                permit: pending.permit,
                context: pending.context,
                method: 'batch',
                params: { count: batchActions.length },
                targetOrigin: finalReceipts[0]?.targetOrigin || null,
                sequence: 1,
                reason: 'GATEWAY_TIMEOUT',
                children: finalReceipts,
              });
              writeJson(pending.res, 504, {
                error: 'GATEWAY_TIMEOUT',
                receipt: agg,
                receipts: finalReceipts,
              });
              return;
            }
            finalReceipt = runtime.createIndeterminateReceipt({
              permit: pending.permit,
              context: pending.context,
              method: pending.method,
              params: pending.params || {},
              targetOrigin: pending.targetOrigin || deriveTargetOriginForMethod(pending.method, pending.params || {}, null),
              sequence: 1,
              reason: 'GATEWAY_TIMEOUT',
            });
            writeJson(pending.res, 504, {
              error: 'GATEWAY_TIMEOUT',
              receipt: finalReceipt,
            });
          }
        }, effectiveTimeout);

        pendingHttpRequests.set(rpcId, {
          res,
          timeoutTimer,
          method,
          params: params || {},
          permit,
          context: runtime.getCurrentContext(),
          targetOrigin: targetOrigin || deriveTargetOriginForMethod(method, params || {}, null),
          ws,
          receipt: executionReceipt,
          forwardedParams,
        });

        ws.send(JSON.stringify(extensionPayload));
        console.log(`[Gateway] Forwarded command: ID=${rpcId} | Method=${method}`);
      });
    } else if (req.method === 'POST' && req.url === '/interactive/receipts/verify') {
      if (!tokenMatches(extractToken(req), token)) {
        return writeJson(res, 401, { error: 'Unauthorized: missing or invalid gateway token' });
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return writeJson(res, 400, { error: 'Invalid JSON' });
        }
        const receipts = payload?.receipts;
        if (!Array.isArray(receipts) || receipts.length === 0) {
          return writeJson(res, 400, { error: 'Malformed request: receipts array required' });
        }
        // Validate each receipt has required fields without echoing raw
        for (const r of receipts) {
          if (!r || typeof r !== 'object' || typeof r.receiptId !== 'string' || typeof r.receiptDigest !== 'string' || typeof r.actionDigest !== 'string') {
            return writeJson(res, 400, { error: 'Malformed receipt' });
          }
        }
        const result = runtime.verifyReceipts(receipts);
        if (!result.ok) {
          return writeJson(res, 403, { error: 'Receipt verification failed', reason: result.reason });
        }
        return writeJson(res, 200, { ok: true, verified: true });
      });
    } else if (req.method === 'POST' && req.url === '/interactive/revoke') {
      if (!tokenMatches(extractToken(req), token)) {
        return writeJson(res, 401, { error: 'Unauthorized: missing or invalid gateway token' });
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return writeJson(res, 400, { error: 'Invalid JSON' });
        }
        const permitId = payload?.permitId;
        const revocationId = payload?.revocationId;
        if ((!permitId || typeof permitId !== 'string') && (!revocationId || typeof revocationId !== 'string')) {
          return writeJson(res, 400, { error: 'Malformed request: permitId or revocationId required' });
        }
        if (permitId && typeof permitId !== 'string') {
          return writeJson(res, 400, { error: 'Malformed permitId' });
        }
        if (revocationId && typeof revocationId !== 'string') {
          return writeJson(res, 400, { error: 'Malformed revocationId' });
        }
        const result = runtime.revokePermit({ permitId, revocationId });
        return writeJson(res, 200, { ok: true, revoked: result.revoked });
      });
    } else {
      writeJson(res, 404, { error: 'Not Found. Exposes GET /health and POST /api for automation.' });
    }
  });
  const activeHttpSockets = new Set();
  server.on('connection', (socket) => {
    activeHttpSockets.add(socket);
    socket.once('close', () => activeHttpSockets.delete(socket));
  });

  // ── WebSocket Server ─────────────────────────────────────────
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    pendingConnections.add(ws);
    ws._profileId = null;
    console.log(`[Gateway] Chrome Extension connected from ${req.socket.remoteAddress} (awaiting handshake)`);

    const keepAliveTimer = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: { ts: Date.now() } }));
      }
    }, keepalivePingMs);
    keepAliveTimers.add(keepAliveTimer);

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if ('id' in msg && !('method' in msg)) {
        const pending = pendingHttpRequests.get(msg.id);
        if (pending) {
          pendingHttpRequests.delete(msg.id);
          clearTimeout(pending.timeoutTimer);

          const isBatch = pending.method === 'batch' || pending.method === 'browser_batch';
          const ctx = pending.context;
          const permit = pending.permit;
          const batchActions = isBatch ? getBatchActions(pending.params) : null;

          if ('error' in msg) {
            const extensionError = sanitizeExtensionError(msg.error);
            console.log(
              `[Gateway] Error response received for ID=${msg.id}`
              + (extensionError?.code !== undefined ? ` code=${extensionError.code}` : '')
              + (extensionError?.message ? ` message=${extensionError.message}` : ''),
            );
            let finalReceipt = null;
            let receipts = null;
            if (isBatch && Array.isArray(batchActions)) {
              receipts = [];
              for (let i = 0; i < batchActions.length; i++) {
                const act = batchActions[i];
                const r = runtime.createFailedReceipt({
                  permit,
                  context: ctx,
                  method: act.method || act.tool,
                  params: act.params || {},
                  targetOrigin: act.targetOrigin || deriveTargetOriginForMethod(act.method || act.tool, act.params || {}, null),
                  result: msg.error,
                  sequence: i + 1,
                  reason: 'EXECUTION_FAILED',
                });
                receipts.push(r);
              }
              const agg = runtime.createFailedReceipt({
                permit,
                context: ctx,
                method: 'batch',
                params: { count: batchActions.length },
                targetOrigin: receipts[0]?.targetOrigin || null,
                result: msg.error,
                sequence: 1,
                reason: 'EXECUTION_FAILED',
                children: receipts,
              });
              writeJson(pending.res, 500, {
                error: 'EXECUTION_FAILED',
                ...(extensionError ? { extensionError } : {}),
                receipt: agg,
                receipts,
              });
              return;
            }
            finalReceipt = runtime.createFailedReceipt({
              permit,
              context: ctx,
              method: pending.method,
              params: pending.params || {},
              targetOrigin: pending.targetOrigin,
              result: msg.error,
              sequence: 1,
              reason: 'EXECUTION_FAILED',
            });
            writeJson(pending.res, 500, {
              error: 'EXECUTION_FAILED',
              ...(extensionError ? { extensionError } : {}),
              receipt: finalReceipt,
            });
          } else {
            console.log(`[Gateway] Success response received for ID=${msg.id}`);
            const normalized = normalizeResult(msg.result) || {};
            if (normalized._pageToolError) {
              const { _pageToolError } = normalized;
              console.log(`[Gateway] Page tool error for ID=${msg.id}`);
              let finalReceipt = null;
              let receipts = null;
              if (isBatch && Array.isArray(batchActions)) {
                receipts = [];
                for (let i = 0; i < batchActions.length; i++) {
                  const act = batchActions[i];
                  const r = runtime.createFailedReceipt({
                    permit,
                    context: ctx,
                    method: act.method || act.tool,
                    params: act.params || {},
                    targetOrigin: act.targetOrigin || deriveTargetOriginForMethod(act.method || act.tool, act.params || {}, null),
                    result: _pageToolError,
                    sequence: i + 1,
                    reason: 'PAGE_TOOL_ERROR',
                  });
                  receipts.push(r);
                }
                const agg = runtime.createFailedReceipt({
                  permit,
                  context: ctx,
                  method: 'batch',
                  params: { count: batchActions.length },
                  targetOrigin: receipts[0]?.targetOrigin || null,
                  result: _pageToolError,
                  sequence: 1,
                  reason: 'PAGE_TOOL_ERROR',
                  children: receipts,
                });
                writeJson(pending.res, 422, {
                  error: 'PAGE_TOOL_ERROR',
                  errorType: 'PAGE_TOOL_ERROR',
                  receipt: agg,
                  receipts,
                });
                return;
              }
              finalReceipt = runtime.createFailedReceipt({
                permit,
                context: ctx,
                method: pending.method,
                params: pending.params || {},
                targetOrigin: pending.targetOrigin,
                result: _pageToolError,
                sequence: 1,
                reason: 'PAGE_TOOL_ERROR',
              });
              writeJson(pending.res, 422, {
                error: 'PAGE_TOOL_ERROR',
                errorType: 'PAGE_TOOL_ERROR',
                receipt: finalReceipt,
              });
            } else {
              // Success applied
              if (isBatch && Array.isArray(batchActions)) {
                const actions = batchActions;
                const forwardedBatchActions = getBatchActions(pending.forwardedParams) || [];
                const resultsArray = Array.isArray(normalized?.results) ? normalized.results : null;
                const successCountValid = normalized?.success === true
                  || (Number.isInteger(normalized?.success) && normalized.success === actions.length);
                const hasBatchFailure =
                  !successCountValid ||
                  normalized?.errors !== 0 ||
                  !Array.isArray(resultsArray) ||
                  resultsArray.length !== actions.length ||
                  forwardedBatchActions.length !== actions.length ||
                  resultsArray.some((child, index) => (
                    !child ||
                    child.ok !== true ||
                    child.index !== index ||
                    child.method !== forwardedBatchActions[index]?.method
                  ));
                if (hasBatchFailure) {
                  const batchRes = runtime.createBatchResultReceipts({
                    permit,
                    context: ctx,
                    actions: actions.map((a, index) => ({
                      method: a.method || a.tool,
                      forwardedMethod: forwardedBatchActions[index]?.method,
                      params: a.params || {},
                      targetOrigin: a.targetOrigin,
                    })),
                    results: resultsArray,
                  });
                  writeJson(pending.res, 500, {
                    error: 'EXECUTION_FAILED',
                    errorType: 'EXECUTION_FAILED',
                    result: normalized,
                    receipt: batchRes.aggregate,
                    receipts: batchRes.children,
                  });
                  return;
                }
                const batchRes = runtime.createBatchAppliedReceipts({
                  permit,
                  context: ctx,
                  actions: actions.map((a) => ({ method: a.method || a.tool, params: a.params || {}, targetOrigin: a.targetOrigin })),
                  results: resultsArray,
                });
                writeJson(pending.res, 200, {
                  result: normalized,
                  receipt: batchRes.aggregate,
                  receipts: batchRes.children,
                });
                return;
              }
              const finalReceipt = runtime.createAppliedReceipt({
                permit,
                context: ctx,
                method: pending.method,
                params: pending.params || {},
                targetOrigin: pending.targetOrigin,
                result: normalized,
                sequence: 1,
              });
              writeJson(pending.res, 200, {
                result: normalized,
                receipt: finalReceipt,
              });
            }
          }
        }
        return;
      }

      if ('method' in msg) {
        const { method, params = {} } = msg;
        if (method === 'extensionReady') {
          const profId = params.profileId || `anon-${req.socket.remoteAddress}-${Date.now()}`;
          ws._profileId = profId;
          ws._profileEmail = params.profileEmail || '';
          ws._profileName = params.profileName || '';
          ws._extensionVersion = params.version || '';
          ws._capabilities = Array.isArray(params.capabilities) ? params.capabilities : [];
          pendingConnections.delete(ws);

          const existing = extensions.get(profId);
          if (existing && existing !== ws) {
            try { existing.close(); } catch { /* already closed */ }
          }
          extensions.set(profId, ws);
          let logProfile = '[redacted]';
          if (runtime && runtime.physicalRouteMap) {
            for (const [alias, phys] of runtime.physicalRouteMap.entries()) {
              if (phys === profId) { logProfile = alias; break; }
            }
          }
          console.log(`[Gateway] Extension ready: ${params.name} v${params.version} | profile=${logProfile} | email=${ws._profileEmail} | name=${ws._profileName}`);
        } else if (method === 'heartbeat' || method === 'pong') {
          // Silent keep-alive traffic
        } else if (method === 'downloadStarted' || method === 'downloadChanged') {
          recordDownloadEvent(ws._profileId, method, params);
        } else {
          console.log(`[Gateway] Event from Extension: ${method}`, params);
        }
      }
    });

    ws.on('close', () => {
      clearInterval(keepAliveTimer);
      keepAliveTimers.delete(keepAliveTimer);
      pendingConnections.delete(ws);
      if (ws._profileId && extensions.get(ws._profileId) === ws) {
        extensions.delete(ws._profileId);
      }
      let logProfile = '[redacted]';
      if (runtime && runtime.physicalRouteMap && ws._profileId) {
        for (const [alias, phys] of runtime.physicalRouteMap.entries()) {
          if (phys === ws._profileId) { logProfile = alias; break; }
        }
      }
      console.log(`[Gateway] Chrome Extension disconnected | profile=${logProfile}`);

      for (const [rpcId, pending] of pendingHttpRequests) {
        if (pending.ws === ws) {
          clearTimeout(pending.timeoutTimer);
          pendingHttpRequests.delete(rpcId);
          const isBatch = pending.method === 'batch' || pending.method === 'browser_batch';
          const batchActions = isBatch ? getBatchActions(pending.params) : null;
          if (isBatch && Array.isArray(batchActions)) {
            const receipts = [];
            for (let i = 0; i < batchActions.length; i++) {
              const act = batchActions[i];
              const r = runtime.createIndeterminateReceipt({
                permit: pending.permit,
                context: pending.context,
                method: act.method || act.tool,
                params: act.params || {},
                targetOrigin: act.targetOrigin || deriveTargetOriginForMethod(act.method || act.tool, act.params || {}, null),
                sequence: i + 1,
                reason: 'EXTENSION_DISCONNECT',
              });
              receipts.push(r);
            }
            const agg = runtime.createIndeterminateReceipt({
              permit: pending.permit,
              context: pending.context,
              method: 'batch',
              params: { count: batchActions.length },
              targetOrigin: receipts[0]?.targetOrigin || null,
              sequence: 1,
              reason: 'EXTENSION_DISCONNECT',
              children: receipts,
            });
            writeJson(pending.res, 502, {
              error: 'Chrome extension disconnected during command execution',
              receipt: agg,
              receipts,
            });
          } else {
            const finalReceipt = runtime.createIndeterminateReceipt({
              permit: pending.permit,
              context: pending.context,
              method: pending.method,
              params: pending.params || {},
              targetOrigin: pending.targetOrigin,
              sequence: 1,
              reason: 'EXTENSION_DISCONNECT',
            });
            writeJson(pending.res, 502, {
              error: 'Chrome extension disconnected during command execution',
              receipt: finalReceipt,
            });
          }
        }
      }
    });
  });

  async function start() {
    await runtime.start();
    // A3 gateway bootstrap reconcile (S3 seam): under the fence mode flag,
    // reconcile every known profile with real liveness so crash orphans are
    // quarantined (recovery receipt + bumped epoch) before serving traffic.
    if (gatewayGovernor && runtimeFenceMode !== 'off') {
      try {
        const aliases = runtime.physicalRouteMap ? [...runtime.physicalRouteMap.keys()] : [];
        const reconciled = await reconcileGatewayProfiles({ governor: gatewayGovernor, aliases });
        const settled = reconciled.filter((r) => r.ok && (r.state === 'quarantined' || r.state === 'external_use'));
        if (settled.length) {
          console.log(`[Gateway] Governor reconcile settled ${settled.length} profile(s) at bootstrap (quarantine/external_use)`);
        }
        const failed = reconciled.filter((r) => !r.ok);
        for (const f of failed) {
          console.log(`[Gateway] Governor reconcile skipped profile=[redacted] (${f.code || 'UNKNOWN'})`);
        }
      } catch (error) {
        console.log(`[Gateway] Governor bootstrap reconcile skipped (${error?.code || error?.message || 'UNKNOWN'})`);
      }
    }
    await new Promise((resolve) => {
      server.listen(port, host, () => {
        resolve();
      });
    });
    const boundPort = server.address()?.port || port;
    return { server, wss, runtime, port: boundPort, host };
  }

  async function close() {
    for (const timer of keepAliveTimers) {
      clearInterval(timer);
    }
    keepAliveTimers.clear();

    for (const ws of extensions.values()) {
      try { ws.terminate(); } catch {}
    }
    for (const ws of pendingConnections) {
      try { ws.terminate(); } catch {}
    }

    await runtime.stop();

    await new Promise((resolve) => {
      wss.close(() => {
        // `server.close()` stops accepting new connections but can wait for
        // HTTP keep-alive sockets indefinitely. A foreground CLI must be able
        // to finish SIGTERM shutdown even when a health/API client kept its
        // socket open.
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        } else if (typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections();
        } else {
          for (const socket of activeHttpSockets) socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      });
    });
  }

  return {
    server,
    wss,
    runtime,
    start,
    close,
    resolveTarget,
    connectedProfileIds,
    governor: gatewayGovernor,
    fenceMode: runtimeFenceMode,
  };
}

export {
  createGatewayServer,
  PORT,
  HOST,
  TOKEN,
  sanitizeParams,
  sanitizeParamsForTest,
  mapGatewayCommand,
  mapGatewayRequest,
  rawOriginScopeError,
  getKnownRawMethods,
};

export default createGatewayServer;

// Start Gateway Server if run directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const instance = createGatewayServer();
  instance.start().then(({ port, host }) => {
    console.log('='.repeat(70));
    console.log(`  WebMCP Automation Gateway Server is running!`);
    console.log(`  - Bind Host: ${host}${host === '0.0.0.0' ? ' (exposed to LAN)' : ' (loopback only)'}`);
    console.log(`  - Gateway v${GATEWAY_VERSION || '?'} | Extension v${EXTENSION_VERSION || '?'}`);
    console.log(`  - Auth: ${TOKEN ? 'token required' : 'open (no token set)'}`);
    console.log(`  - Extension WebSocket Endpoint: ws://${host}:${port}`);
    console.log(`  - Health Endpoint: GET http://${host}:${port}/health`);
    console.log(`  - HTTP API Endpoint for Agents/Scripts: POST http://${host}:${port}/api`);
    console.log(`  - Command Timeout: ${COMMAND_TIMEOUT_MS}ms`);
    console.log('='.repeat(70));
    console.log('Load/reload the Extension in Chrome to connect.');
  });
}
