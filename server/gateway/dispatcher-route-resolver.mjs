import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function getWebmcpHome() {
  return path.resolve(process.env.WEBMCP_HOME || process.env.WEBMCP_DATA_DIR || path.join(os.homedir(), '.webmcp'));
}

export function resolveDispatcherConfigPath() {
  const explicit = process.env.WEBMCP_DISPATCHER_CONFIG || process.env.WEBMCP_CONFIG || null;
  if (explicit && typeof explicit === 'string' && explicit.trim()) {
    const trimmed = explicit.trim();
    if (path.isAbsolute(trimmed)) return trimmed;
    return path.resolve(process.cwd(), trimmed);
  }
  return path.join(getWebmcpHome(), 'dispatcher.config.json');
}

export function buildRouteMapFromRaw(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
  if (raw.schema !== 'webmcp-dispatcher-config/3') return new Map();
  const gateways = raw.gateways;
  const profileResources = raw.profileResources;
  const profileBindings = raw.profileBindings;
  if (!gateways || typeof gateways !== 'object' || Array.isArray(gateways)) return new Map();
  if (!profileResources || typeof profileResources !== 'object' || Array.isArray(profileResources)) return new Map();
  if (!profileBindings || typeof profileBindings !== 'object' || Array.isArray(profileBindings)) return new Map();

  const map = new Map();
  for (const [alias, binding] of Object.entries(profileBindings)) {
    if (typeof alias !== 'string' || !alias.trim()) continue;
    const trimmedAlias = alias.trim();
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) continue;
    if (binding.status !== 'enabled') continue;
    if (binding.profileAlias !== trimmedAlias) continue;
    // Fail closed for enabled binding unless review approved with valid sha256 digest
    const review = binding.review;
    if (!review || typeof review !== 'object' || Array.isArray(review)) continue;
    if (review.decision !== 'approved') continue;
    const receiptDigest = review.receiptDigest;
    if (typeof receiptDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(receiptDigest)) continue;
    const resourceRef = binding.profileResourceRef;
    if (typeof resourceRef !== 'string' || !resourceRef.trim()) continue;
    const resource = profileResources[resourceRef];
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    if (resource.status !== 'enabled') continue;
    const physicalId = resource.profileId;
    if (typeof physicalId !== 'string' || !physicalId.trim()) continue;
    const trimmedPhysical = physicalId.trim();
    const gatewayName = resource.gateway;
    if (typeof gatewayName !== 'string' || !gatewayName.trim()) continue;
    const gateway = gateways[gatewayName];
    if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) continue;
    const profiles = gateway.profiles;
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) continue;
    if (!Object.prototype.hasOwnProperty.call(profiles, trimmedAlias)) continue;
    if (profiles[trimmedAlias] !== trimmedPhysical) continue;
    let drift = false;
    for (const [gwName, gw] of Object.entries(gateways)) {
      if (gwName === gatewayName) continue;
      if (gw && typeof gw === 'object' && gw.profiles && Object.prototype.hasOwnProperty.call(gw.profiles, trimmedAlias)) {
        drift = true;
        break;
      }
    }
    if (drift) continue;
    map.set(trimmedAlias, trimmedPhysical);
  }
  return map;
}

export function loadDispatcherRouteMap() {
  const configPath = resolveDispatcherConfigPath();
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const raw = JSON.parse(text);
    return buildRouteMapFromRaw(raw);
  } catch {
    return new Map();
  }
}
