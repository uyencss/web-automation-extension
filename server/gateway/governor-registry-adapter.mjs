// B1 governor registry adapter v2 — file-backed dispatcher config to Governor seams.
//
// Validation mirrors the REAL `webmcp-dispatcher-config/3` contract whose
// source of truth is `server/gateway/dispatcher-route-resolver.mjs`: every
// alias must come out of its validated route map (`buildRouteMapFromRaw`),
// which requires an enabled binding whose `profileAlias` matches, an approved
// review (`review.decision === 'approved'` with a `sha256:…` receiptDigest,
// fail closed), an enabled resource with a non-empty `profileId`, and gateway
// projection coherence (`gateways[resource.gateway].profiles[alias] ===
// resource.profileId`, no cross-gateway drift). Anything else fails closed
// with `ok:false` + reason.
//
// Resource identity mapping:
// - if `resource.physicalResourceId` is present it must match `prsc_*` and is
//   used verbatim;
// - else it is derived deterministically as `prsc_` + the first 32 hex chars
//   of `sha256(`${gateway}:${profileId}`)` (see `derivePhysicalResourceId`).
//
// Binding digest mapping:
// - if `binding.bindingDigest` is present it must match
//   `sha256:[0-9a-f]{64}` and is used verbatim;
// - else a gateway-local digest is derived as `sha256:` +
//   `sha256(`${bindingId}|${bindingRevision}|${profileAlias}|${profileResourceRef}`)`
//   (see `deriveBindingDigest`). NOTE: cross-domain equality with the Runner
//   admission digest is out of scope for the gateway; this digest is only a
//   stable local binding identity for reconcile/lease matching.
//
// Exposes a Governor-compatible registry (resolve/listAliases/status) plus a
// claims seam that never allows acquires (always PROFILE_CLAIM_REQUIRED).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildRouteMapFromRaw } from './dispatcher-route-resolver.mjs';

const EXPECTED_SCHEMA = 'webmcp-dispatcher-config/3';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const PHYSICAL_RE = /^prsc_[a-zA-Z0-9._-]{2,512}$/;
const ALLOWED = new Set(['browser-read', 'browser-write', 'browser-session-data', 'credential-fill']);
const FALLBACK_ACTIONS = ['browser-read'];

function fail(reason) {
  return { ok: false, reason: String(reason || 'invalid governor registry config') };
}

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Deterministic resource identity for v3 resources that predate the
// `physicalResourceId` field: `prsc_` + first 32 hex chars of
// sha256(`${gateway}:${profileId}`). Exported so tests seed identical facts.
export function derivePhysicalResourceId(gateway, profileId) {
  return `prsc_${sha256Hex(`${gateway}:${profileId}`).slice(0, 32)}`;
}

// Gateway-local binding identity when the binding carries no explicit
// `bindingDigest`. Exported so tests seed identical facts.
export function deriveBindingDigest({ bindingId, bindingRevision, profileAlias, profileResourceRef }) {
  return `sha256:${sha256Hex(`${bindingId}|${bindingRevision}|${profileAlias}|${profileResourceRef}`)}`;
}

function validatedAllowedActions(alias, binding) {
  let allowedActions = binding.allowedActions;
  if (allowedActions === undefined) return [...FALLBACK_ACTIONS];
  if (!Array.isArray(allowedActions) || allowedActions.length < 1 || allowedActions.length > 8) {
    return fail(`binding '${alias}' has invalid allowedActions`);
  }
  if (new Set(allowedActions).size !== allowedActions.length) {
    return fail(`binding '${alias}' has duplicate allowedActions`);
  }
  for (const action of allowedActions) {
    if (typeof action !== 'string' || !ALLOWED.has(action)) {
      return fail(`binding '${alias}' has invalid allowedActions entry`);
    }
  }
  return [...allowedActions];
}

export function buildGovernorRegistryFromConfig(raw) {
  if (!isPlainObject(raw)) return fail('config must be an object');
  if (raw.schema !== EXPECTED_SCHEMA) return fail(`unsupported schema (expected ${EXPECTED_SCHEMA})`);
  if (!isPlainObject(raw.gateways)) return fail('gateways must be an object');
  if (!isPlainObject(raw.profileBindings)) return fail('profileBindings must be an object');
  if (!isPlainObject(raw.profileResources)) return fail('profileResources must be an object');
  // The route map is the authority: it enforces the approved-review,
  // enabled-resource, non-empty-profileId and gateway-projection-coherence
  // rules exactly as the production dispatcher does. Only aliases that
  // survive it may become registry facts.
  const routeMap = buildRouteMapFromRaw(raw);
  if (routeMap.size === 0) return fail('no validated dispatcher routes (check approved reviews, enabled status and gateway projection)');
  const aliases = {};
  for (const alias of routeMap.keys()) {
    const binding = raw.profileBindings[alias];
    if (!isPlainObject(binding)) return fail(`binding '${alias}' must be an object`);
    const ref = binding.profileResourceRef;
    if (typeof ref !== 'string' || !ref.trim()) return fail(`binding '${alias}' has an invalid profileResourceRef`);
    const resource = raw.profileResources[ref];
    if (!isPlainObject(resource)) return fail(`binding '${alias}' references missing resource '${ref}'`);
    if (typeof binding.bindingId !== 'string' || !binding.bindingId.trim()) {
      return fail(`binding '${alias}' has a malformed bindingId`);
    }
    if (!Number.isInteger(binding.bindingRevision) || binding.bindingRevision < 1) {
      return fail(`binding '${alias}' has an invalid bindingRevision`);
    }
    let physicalResourceId;
    if (resource.physicalResourceId !== undefined) {
      if (typeof resource.physicalResourceId !== 'string' || !PHYSICAL_RE.test(resource.physicalResourceId)) {
        return fail(`resource '${ref}' has a malformed physicalResourceId`);
      }
      physicalResourceId = resource.physicalResourceId;
    } else {
      physicalResourceId = derivePhysicalResourceId(resource.gateway, resource.profileId.trim());
    }
    let bindingDigest;
    if (binding.bindingDigest !== undefined) {
      if (typeof binding.bindingDigest !== 'string' || !DIGEST_RE.test(binding.bindingDigest)) {
        return fail(`binding '${alias}' has a malformed bindingDigest`);
      }
      bindingDigest = binding.bindingDigest;
    } else {
      bindingDigest = deriveBindingDigest({
        bindingId: binding.bindingId,
        bindingRevision: binding.bindingRevision,
        profileAlias: alias,
        profileResourceRef: ref,
      });
    }
    const allowedActions = validatedAllowedActions(alias, binding);
    if (allowedActions?.ok === false) return allowedActions;
    aliases[alias] = {
      physicalResourceId,
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      bindingDigest,
      allowedActions,
    };
  }
  if (Object.keys(aliases).length === 0) return fail('no enabled profile bindings');
  return { ok: true, aliases, listAliases: () => Object.keys(aliases) };
}

function resolveConfigPath(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const fromEnv = process.env.WEBMCP_DISPATCHER_CONFIG;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return null;
}

export function loadGovernorRegistry(options = {}) {
  const opts = typeof options === 'string' ? { configPath: options } : (options || {});
  const configPath = resolveConfigPath(opts.configPath);
  if (!configPath) return fail('governor registry config path is unavailable (set WEBMCP_DISPATCHER_CONFIG)');
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    return { ok: false, reason: `governor registry config is unreadable (${error?.code || error?.message || 'UNKNOWN'})` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `governor registry config is not valid JSON (${error?.message || 'parse error'})` };
  }
  const built = buildGovernorRegistryFromConfig(raw);
  if (!built?.ok) return { ok: false, reason: built?.reason || 'invalid governor registry config', configPath };
  return { ok: true, aliases: built.aliases, listAliases: built.listAliases, configPath };
}

export function createGovernorRegistryAdapter(options = {}) {
  const opts = typeof options === 'string' ? { configPath: options } : (options || {});
  const loaded = loadGovernorRegistry({ configPath: opts.configPath });
  const ok = loaded?.ok === true;
  const aliases = ok ? loaded.aliases : {};
  const reason = ok ? null : (loaded?.reason || 'governor registry is unavailable');
  const keys = () => Object.keys(aliases);
  return {
    listAliases: () => keys(),
    status: () => (ok ? { ok: true } : { ok: false, reason }),
    resolve: async (alias) => {
      if (!ok) throw typedError('PROFILE_REGISTRY_UNAVAILABLE', `governor registry is unavailable (${reason})`);
      const entry = typeof alias === 'string' ? aliases[alias] : undefined;
      if (!entry) throw typedError('PROFILE_REGISTRY_UNAVAILABLE', `profile alias '${String(alias)}' is not in the governor registry`);
      return {
        physicalResourceId: entry.physicalResourceId,
        bindingId: entry.bindingId,
        bindingRevision: entry.bindingRevision,
        bindingDigest: entry.bindingDigest,
        allowedActions: [...entry.allowedActions],
      };
    },
    claims: {
      validate: async () => {
        throw typedError('PROFILE_CLAIM_REQUIRED', 'acquires via the governor registry are claim-gated');
      },
    },
    close: () => {},
  };
}
