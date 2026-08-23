import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { poolError } from './errors.mjs';

const SCHEMA_CONFIG = 'webmcp-profile-pool-config/1';
const ALIAS_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_ALIAS_LENGTH = 64;

export function getWebmcpHome() {
  return resolve(process.env.WEBMCP_HOME || process.env.WEBMCP_DATA_DIR || resolve(homedir(), '.webmcp'));
}

export function profilePoolConfigPath() {
  if (process.env.WEBMCP_PROFILE_POOL_CONFIG) return resolve(process.env.WEBMCP_PROFILE_POOL_CONFIG);
  return resolve(getWebmcpHome(), 'profilePool.json');
}

export function profilePoolStatePath() {
  if (process.env.WEBMCP_PROFILE_POOL_STATE) return resolve(process.env.WEBMCP_PROFILE_POOL_STATE);
  return resolve(getWebmcpHome(), 'profile-pool-state.json');
}

function readJsonFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, kind: 'read' };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, kind: 'parse' };
  }
}

export function readProfilePoolConfig() {
  const path = profilePoolConfigPath();
  if (!existsSync(path)) {
    throw poolError('CONFIG_NOT_FOUND', `profile pool config is not configured; set WEBMCP_PROFILE_POOL_CONFIG or write ~/.webmcp/profilePool.json with schema ${SCHEMA_CONFIG}`);
  }
  const parsed = readJsonFile(path);
  if (!parsed.ok) {
    throw poolError(
      'CONFIG_INVALID',
      parsed.kind === 'read' ? 'profile pool config could not be read' : 'profile pool config is not valid JSON',
    );
  }
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw poolError('CONFIG_INVALID', 'profile pool config must be a JSON object');
  }
  if (parsed.data.schema !== SCHEMA_CONFIG) {
    throw poolError('CONFIG_INVALID', `profile pool config schema must be ${SCHEMA_CONFIG}`);
  }
  const aliases = parsed.data.aliases && typeof parsed.data.aliases === 'object' && !Array.isArray(parsed.data.aliases)
    ? parsed.data.aliases
    : {};
  for (const [alias, profileId] of Object.entries(aliases)) {
    if (typeof alias !== 'string' || alias.length > MAX_ALIAS_LENGTH || !ALIAS_ID.test(alias)) {
      throw poolError('CONFIG_INVALID', `profile pool alias '${alias}' must match ${ALIAS_ID} (at most ${MAX_ALIAS_LENGTH} characters)`);
    }
    if (typeof profileId !== 'string' || !profileId.trim() || profileId.length < 2 || profileId.length > 160) {
      throw poolError('CONFIG_INVALID', `profile pool alias '${alias}' has no usable physical profile id`);
    }
  }
  const aliasesByPhysicalProfile = new Map();
  for (const [alias, profileId] of Object.entries(aliases)) {
    const physicalKey = profileId.trim();
    aliasesByPhysicalProfile.set(physicalKey, [
      ...(aliasesByPhysicalProfile.get(physicalKey) || []),
      alias,
    ]);
  }
  const duplicateAliasGroups = [...aliasesByPhysicalProfile.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort());
  if (duplicateAliasGroups.length) {
    throw poolError(
      'CONFIG_INVALID',
      `profile pool config contains duplicate physical mapping for logical aliases: ${duplicateAliasGroups.map((group) => group.join(', ')).join('; ')}`,
      { duplicateAliasGroups },
    );
  }
  return { path, config: { schema: SCHEMA_CONFIG, aliases } };
}
