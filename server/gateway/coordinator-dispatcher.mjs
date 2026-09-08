/**
 * Coordinator-owned bridge for the small WebMCP surface that a managed
 * worker may request through the AI CLI's inherited broker.
 *
 * The returned adapter is intentionally a runtime object, not a JSON
 * descriptor. The signed permit, gateway token, logical profile route and
 * target origin are captured by the coordinator and are never supplied by a
 * worker request or returned in the result.
 */

export const COORDINATOR_DISPATCHER_SCHEMA = 'webmcp-coordinator-dispatcher/1';
export const COORDINATOR_DISPATCHER_IMPLEMENTATION = 'coordinator-owned-webmcp-v1';
// Shared only inside the coordinator process. It is not part of the JSON
// dispatcher descriptor or the inherited worker broker protocol.
export const COORDINATOR_DISPATCHER_MARKER = Symbol.for('webmcp.coordinator-dispatcher.marker/1');
export const COORDINATOR_DISPATCH_REQUEST_SCHEMA = 'webmcp-coordinator-dispatch-request/1';
export const COORDINATOR_DISPATCHER_TOOLS = Object.freeze([
  'webmcp.invokeTool',
  'webmcp.listTools',
]);

const REQUEST_FIELDS = new Set(['schema', 'tool', 'input', 'dispatchId', 'taskId', 'fenceEpoch']);
const TOOL_FIELDS = Object.freeze({
  'webmcp.listTools': new Set(['tabId']),
  'webmcp.invokeTool': new Set(['toolName', 'input', 'frame', 'tabId']),
});
const PAGE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const AUTHORITY_KEY = /(?:permit|claim|private.?key|token|credential|secret|password|api.?key|cookie|authorization|auth)/i;
const PHYSICAL_ID_KEY = /^(?:profileId|physicalProfileId|physicalPath|profilePath|hostProfileId)$/;
const SHELL_INPUT_KEY = /(?:shell|command|cmd|exec|executable|argv|argument)/i;
const NETWORK_INPUT_KEY = /(?:url|uri|endpoint|host|origin|network|socket|port|domain|proxy|remote)/i;
const AUTHORITY_VALUE = /(?:bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{15,}|-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----)/i;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;
const MAX_NESTING = 32;
const MAX_NODES = 4096;
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:7865';

export const COORDINATOR_DISPATCHER_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'COORDINATOR_DISPATCH_REQUEST_INVALID',
  AUTHORITY_MISSING: 'COORDINATOR_DISPATCH_AUTHORITY_MISSING',
  GATEWAY_UNAVAILABLE: 'COORDINATOR_DISPATCH_GATEWAY_UNAVAILABLE',
  GATEWAY_DENIED: 'COORDINATOR_DISPATCH_GATEWAY_DENIED',
  RESULT_INVALID: 'COORDINATOR_DISPATCH_RESULT_INVALID',
});

export class CoordinatorDispatcherError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoordinatorDispatcherError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CoordinatorDispatcherError(code, message);
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value, label, maxBytes = MAX_STRING_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, `${label} must be a bounded non-empty string`);
  }
  if (value.includes('\0') || /[\u0001-\u001f\u007f]/.test(value)) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, `${label} contains unsupported control characters`);
  }
  return value;
}

function normalizeGatewayUrl(value) {
  const raw = boundedString(value, 'gatewayUrl', 2048).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'gatewayUrl must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'gatewayUrl must be an absolute HTTP(S) URL without credentials');
  }
  return parsed.toString().replace(/\/$/, '');
}

function normalizeOrigin(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, `${label} must be an HTTP(S) origin`);
  }
  let raw;
  try {
    raw = boundedString(value, label, 512);
  } catch {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, `${label} must be an HTTP(S) origin`);
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, `${label} must be an HTTP(S) origin`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== raw) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, `${label} must be an HTTP(S) origin`);
  }
  return parsed.origin;
}

function validateSafeJson(value, path = 'value', seen = new Set(), depth = 0, state = { count: 0 }) {
  if (depth > MAX_NESTING || ++state.count > MAX_NODES) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'coordinator dispatcher payload exceeds the structural bound');
  }
  if (value === null || value === undefined || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, `${path} must contain JSON data`);
    return;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES || value.includes('\0') || AUTHORITY_VALUE.test(value)) {
      fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, `${path} contains prohibited material`);
    }
    return;
  }
  if (typeof value !== 'object' || (!isPlainObject(value) && !Array.isArray(value))) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, `${path} must contain JSON data`);
  }
  if (seen.has(value)) fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'coordinator dispatcher payload is cyclic');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateSafeJson(entry, `${path}[${index}]`, seen, depth + 1, state));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (
        AUTHORITY_KEY.test(key)
        || PHYSICAL_ID_KEY.test(key)
        || SHELL_INPUT_KEY.test(key)
        || NETWORK_INPUT_KEY.test(key)
        || key === 'receipt'
      ) {
        fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, `${path}.${key} is not worker data`);
      }
      validateSafeJson(entry, `${path}.${key}`, seen, depth + 1, state);
    }
  }
  seen.delete(value);
}

function cloneJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]));
}

function validateToolInput(tool, input) {
  const fields = TOOL_FIELDS[tool];
  if (!fields) fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, `unsupported coordinator tool ${tool}`);
  if (!isPlainObject(input)) fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'coordinator tool input must be an object');
  const unknown = Object.keys(input).filter((key) => !fields.has(key));
  if (unknown.length > 0) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, `coordinator tool input has unknown field(s): ${unknown.sort().join(', ')}`);
  }
  if (input.tabId !== undefined && (!Number.isInteger(input.tabId) || input.tabId < 0 || input.tabId > 2 ** 31 - 1)) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'tabId must be a bounded integer');
  }
  if (tool === 'webmcp.invokeTool') {
    if (typeof input.toolName !== 'string' || !PAGE_TOOL_NAME.test(input.toolName)) {
      fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'webmcp.invokeTool requires a bounded page toolName');
    }
    if (input.input !== undefined && !isPlainObject(input.input)) {
      fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'webmcp.invokeTool input must be an object');
    }
    if (input.frame !== undefined && (typeof input.frame !== 'string' || input.frame.length > 256)) {
      fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'webmcp.invokeTool frame must be a bounded string');
    }
  }
  validateSafeJson(input, 'request.input');
}

function validateRequest(request) {
  if (!isPlainObject(request) || request.schema !== COORDINATOR_DISPATCH_REQUEST_SCHEMA) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'coordinator dispatch request schema mismatch');
  }
  const unknown = Object.keys(request).filter((key) => !REQUEST_FIELDS.has(key));
  if (unknown.length > 0) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, `coordinator dispatch request has unknown field(s): ${unknown.sort().join(', ')}`);
  }
  if (!COORDINATOR_DISPATCHER_TOOLS.includes(request.tool)) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'coordinator dispatch tool is not allow-listed');
  }
  boundedString(request.dispatchId, 'dispatchId', 256);
  boundedString(request.taskId, 'taskId', 256);
  if (!Number.isInteger(request.fenceEpoch) || request.fenceEpoch < 0) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST, 'fenceEpoch must be a non-negative integer');
  }
  validateToolInput(request.tool, request.input);
}

function validatePermit(permit) {
  if (!isPlainObject(permit)) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, 'coordinator dispatcher requires a signed execution permit');
  }
  return permit;
}

function normalizeProfileAlias(value) {
  if (value === null || value === undefined || value === '') return null;
  const alias = boundedString(value, 'profileAlias', 256);
  if (!SAFE_IDENTIFIER.test(alias)) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, 'profileAlias must be a logical route identifier');
  }
  return alias;
}

async function readGatewayPayload(response) {
  let raw;
  try {
    raw = await response.text();
  } catch {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.GATEWAY_UNAVAILABLE, 'coordinator gateway response could not be read');
  }
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.GATEWAY_UNAVAILABLE, 'coordinator gateway response was not JSON');
  }
  if (!response.ok || payload?.error) {
    return {
      ok: false,
      error: payload?.error || 'coordinator gateway denied the mediated request',
      receipt: payload?.receipt ?? null,
      receipts: Array.isArray(payload?.receipts) ? payload.receipts : null,
    };
  }
  if (!Object.hasOwn(payload, 'result')) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.RESULT_INVALID, 'coordinator gateway returned no result');
  }
  return {
    ok: true,
    result: payload.result,
    receipt: payload.receipt ?? null,
    receipts: Array.isArray(payload.receipts) ? payload.receipts : null,
  };
}

function sanitizeResult(result) {
  try {
    validateSafeJson(result, 'gateway.result');
  } catch {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.RESULT_INVALID, 'coordinator gateway result failed safe validation');
  }
  const encoded = JSON.stringify(result ?? null);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES) {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.RESULT_INVALID, 'coordinator gateway result exceeds the bounded result limit');
  }
  return cloneJson(result ?? null);
}

function projectListToolsResult(result) {
  if (!isPlainObject(result) || !Array.isArray(result.tools)) return result;
  const tools = result.tools
    .filter((entry) => isPlainObject(entry) && typeof entry.name === 'string' && PAGE_TOOL_NAME.test(entry.name))
    .map((entry) => ({ name: entry.name }));
  return Object.freeze({
    ...(Number.isInteger(result.tabId) ? { tabId: result.tabId } : {}),
    tools,
  });
}

function projectMetadataResult(result) {
  if (!isPlainObject(result)) return result;
  const nested = isPlainObject(result.result) ? result.result : null;
  return Object.freeze({
    ...(Number.isInteger(result.tabId) ? { tabId: result.tabId } : {}),
    ...(nested ? {
      result: {
        ...(typeof nested.title === 'string' ? { title: nested.title } : {}),
      },
    } : {}),
  });
}

function brandCoordinatorDispatcher(dispatch) {
  const marker = Object.freeze({
    owner: 'coordinator',
    schema: COORDINATOR_DISPATCHER_SCHEMA,
    implementation: COORDINATOR_DISPATCHER_IMPLEMENTATION,
    dispatch,
  });
  Object.defineProperty(dispatch, COORDINATOR_DISPATCHER_MARKER, {
    value: marker,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(dispatch);
}

/**
 * Build the runtime callback passed to the AI CLI supervisor. The callback
 * owns all browser authority and performs the gateway POST itself; the worker
 * only supplies a typed allow-listed WebMCP tool request over the inherited
 * broker channel.
 */
export function createCoordinatorDispatcher({
  gatewayUrl = process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL,
  permitProvider,
  profileAlias = null,
  profileAliasProvider = null,
  targetOrigin = null,
  targetOriginProvider = null,
  gatewayToken = process.env.WEBMCP_GATEWAY_TOKEN || '',
  gatewayTokenProvider = null,
  receiptHandler = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedGatewayUrl = normalizeGatewayUrl(gatewayUrl);
  if (typeof fetchImpl !== 'function') {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.GATEWAY_UNAVAILABLE, 'coordinator dispatcher requires fetch');
  }
  if (typeof permitProvider !== 'function') {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, 'coordinator dispatcher requires permitProvider');
  }
  if (profileAliasProvider !== null && typeof profileAliasProvider !== 'function') {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, 'profileAliasProvider must be a function');
  }
  if (targetOriginProvider !== null && typeof targetOriginProvider !== 'function') {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, 'targetOriginProvider must be a function');
  }
  if (gatewayTokenProvider !== null && typeof gatewayTokenProvider !== 'function') {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, 'gatewayTokenProvider must be a function');
  }
  if (receiptHandler !== null && typeof receiptHandler !== 'function') {
    fail(COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING, 'receiptHandler must be a function');
  }
  const staticProfileAlias = normalizeProfileAlias(profileAlias);
  const staticTargetOrigin = targetOrigin === null || targetOrigin === undefined
    ? null
    : normalizeOrigin(targetOrigin, 'targetOrigin');
  if (gatewayToken !== undefined && gatewayToken !== null && gatewayToken !== '') {
    boundedString(String(gatewayToken), 'gatewayToken', 4096);
  }

  const dispatch = async (request) => {
    validateRequest(request);
    const permit = validatePermit(await permitProvider(request));
    let receiptHandled = false;
    const notifyFailure = async (error) => {
      if (!receiptHandler || receiptHandled) return;
      receiptHandled = true;
      try {
        await receiptHandler({
          request,
          permit,
          result: null,
          receipt: null,
          receipts: null,
          ok: false,
          error: error?.code || 'COORDINATOR_DISPATCH_FAILED',
        });
      } catch {
        // Preserve the original dispatch failure; the owner remains fail-closed.
      }
    };
    try {
      const resolvedProfileAlias = normalizeProfileAlias(
        profileAliasProvider ? await profileAliasProvider({ request, permit }) : staticProfileAlias || permit.profileAlias || null,
      );
      const resolvedTargetOrigin = normalizeOrigin(
        targetOriginProvider
          ? await targetOriginProvider({ request, permit })
          : staticTargetOrigin,
        'targetOrigin',
      );
      const forwardedParams = {
        ...cloneJson(request.input),
        targetOrigin: resolvedTargetOrigin,
      };
      const token = gatewayTokenProvider
        ? await gatewayTokenProvider({ request })
        : gatewayToken;
      if (token !== undefined && token !== null && token !== '') boundedString(String(token), 'gatewayToken', 4096);
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${String(token)}`;
      let response;
      try {
        response = await fetchImpl(`${normalizedGatewayUrl}/api`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            method: request.tool,
            params: forwardedParams,
            ...(resolvedProfileAlias ? { profileId: resolvedProfileAlias } : {}),
            permit,
            targetOrigin: resolvedTargetOrigin,
          }),
        });
      } catch {
        fail(COORDINATOR_DISPATCHER_ERROR_CODES.GATEWAY_UNAVAILABLE, 'coordinator gateway request failed');
      }
      const gatewayPayload = await readGatewayPayload(response);
      const safeResult = gatewayPayload.ok
        ? sanitizeResult(request.tool === 'webmcp.listTools'
          ? projectListToolsResult(gatewayPayload.result)
          : request.tool === 'webmcp.invokeTool' && request.input?.toolName === 'get_page_metadata'
            ? projectMetadataResult(gatewayPayload.result)
            : gatewayPayload.result)
        : null;
      if (receiptHandler) {
        if (gatewayPayload.ok && !gatewayPayload.receipt) {
          fail(COORDINATOR_DISPATCHER_ERROR_CODES.RESULT_INVALID, 'coordinator gateway returned no execution receipt');
        }
        receiptHandled = true;
        try {
          await receiptHandler({
            request,
            permit,
            result: safeResult,
            receipt: gatewayPayload.receipt,
            receipts: gatewayPayload.receipts,
            ok: gatewayPayload.ok,
            error: gatewayPayload.error || null,
          });
        } catch (error) {
          if (error instanceof CoordinatorDispatcherError) throw error;
          fail(COORDINATOR_DISPATCHER_ERROR_CODES.RESULT_INVALID, 'coordinator receipt handler rejected the Gateway receipt');
        }
      }
      if (!gatewayPayload.ok) {
        fail(COORDINATOR_DISPATCHER_ERROR_CODES.GATEWAY_DENIED, 'coordinator gateway denied the mediated request');
      }
      return safeResult;
    } catch (error) {
      await notifyFailure(error);
      throw error;
    }
  };
  const brandedDispatch = brandCoordinatorDispatcher(dispatch);

  return Object.freeze({
    schema: COORDINATOR_DISPATCHER_SCHEMA,
    implementation: COORDINATOR_DISPATCHER_IMPLEMENTATION,
    allowedTools: COORDINATOR_DISPATCHER_TOOLS,
    dispatch: brandedDispatch,
  });
}
