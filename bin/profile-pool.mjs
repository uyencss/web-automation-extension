#!/usr/bin/env node

// Machine-local profile lease broker (initiative 2026-08-runbook-concurrency-closed-loop, M3).
//
// Maps a LOGICAL profile alias (the `affinity.profile` name declared in runbook
// `concurrency.phases[]`, surfaced by the store catalog) to a physical browser
// profile id through the machine-level `profilePool` config, and leases it.
// Physical profile ids NEVER leave the config layer: every command emits only
// logical aliases, lease ids, and timestamps (handoff decision 5). This broker
// does not launch Chrome, touch browsers, or read dispatcher/store state.
//
// Crash-safety model (simplest safe option): lease state persists in a JSON
// file, and every command lazily sweeps expired leases by TTL. A crashed
// holder's lease therefore recovers automatically on expiry; `reclaim` is the
// explicit forced path when the TTL has not elapsed yet. Restarting the machine
// does not wrongfully kill live holders and needs no special code path.

import process from 'node:process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const SCHEMA_OUTPUT = 'webmcp-profile-pool/1';
const SCHEMA_CONFIG = 'webmcp-profile-pool-config/1';
const SCHEMA_STATE = 'webmcp-profile-pool-state/1';
// Same bounded logical-alias space as the store's `affinity.profile`
// (stores/webmcp-automation-store/lib/runbook-metadata.mjs).
const ALIAS_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_ALIAS_LENGTH = 64;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 2 * 60 * 1000;
const LOCK_RETRY_MS = 5000;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 10000;
const WAIT_POLL_MS = 100;

class PoolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PoolError';
    this.code = code;
    this.exitCode = code === 'USAGE_ERROR' || code === 'RECLAIM_CONFIRMATION_REQUIRED' ? 2 : 1;
    this.details = details;
  }
}

function usageError(message) {
  return new PoolError('USAGE_ERROR', message);
}

function poolError(code, message, details) {
  return new PoolError(code, message, details);
}

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

function parseFlags(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { flags, positional };
}

function intFlag(flags, name, fallback, min, max) {
  const raw = flags[name];
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw usageError(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function stringFlag(flags, name, maxLength = 128) {
  const raw = flags[name];
  if (raw === undefined || raw === true) return null;
  const value = String(raw).trim();
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw usageError(`--${name} must be a single-line string of at most ${maxLength} characters`);
  }
  return value;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function readStateFile() {
  const path = profilePoolStatePath();
  if (!existsSync(path)) {
    return { path, state: { schema: SCHEMA_STATE, leases: {} } };
  }
  const parsed = readJsonFile(path);
  if (!parsed.ok) {
    throw poolError(
      'STATE_INVALID',
      parsed.kind === 'read' ? 'profile pool state could not be read' : 'profile pool state is not valid JSON',
    );
  }
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw poolError('STATE_INVALID', 'profile pool state must be a JSON object');
  }
  const state = parsed.data;
  state.leases = state.leases && typeof state.leases === 'object' && !Array.isArray(state.leases) ? state.leases : {};
  return { path, state };
}

function writeStateFile(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    throw poolError('STATE_UNWRITABLE', 'Cannot persist profile pool state');
  }
}

// Serializes concurrent broker calls on the same state file with an atomic
// lock directory (mkdir is atomic on POSIX). Stale locks (holder crashed
// mid-write) are stolen after LOCK_STALE_MS so the broker cannot wedge.
function withStateLock(statePath, fn) {
  const lockDir = `${statePath}.lock`;
  const deadline = Date.now() + LOCK_RETRY_MS;
  let staleStolen = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw poolError('STATE_UNWRITABLE', 'Cannot create profile pool state lock');
      let stale = false;
      try {
        stale = Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue;
      }
      if (stale && !staleStolen) {
        staleStolen = true;
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* fall through to wait */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw poolError('STATE_BUSY', `Profile pool state is locked by another broker call (${lockDir}); retry or remove the stale lock`);
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function sweepExpired(state, now) {
  const removed = [];
  for (const [leaseId, lease] of Object.entries(state.leases)) {
    const expiresAt = typeof lease?.expiresAt === 'string' ? Date.parse(lease.expiresAt) : NaN;
    if (!Number.isNaN(expiresAt) && expiresAt <= now) removed.push(leaseId);
  }
  for (const leaseId of removed) delete state.leases[leaseId];
  return removed;
}

function acquireLease(config, state, { alias, tab, ttlMs, idempotencyKey, holder }) {
  const now = Date.now();
  sweepExpired(state, now);
  const existing = Object.values(state.leases).filter((lease) => lease.alias === alias);
  const reused = idempotencyKey ? existing.find((lease) => lease.idempotencyKey === idempotencyKey) : null;
  if (reused) {
    return { lease: reused, reused: true };
  }
  const conflict = existing.length > 0 && (tab === 'own' || existing.some((lease) => lease.tab === 'own'));
  if (conflict) {
    throw poolError('CONFLICT', `Profile alias '${alias}' is already leased; retry with --timeout-ms to wait, or use a shared tab or a different alias`, { alias, tab });
  }
  const leaseId = `lease_${randomBytes(8).toString('hex')}`;
  const lease = {
    leaseId,
    alias,
    tab,
    holder,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    idempotencyKey,
  };
  state.leases[leaseId] = lease;
  return { lease, reused: false };
}

function renewLease(state, leaseId, ttlMs) {
  const now = Date.now();
  sweepExpired(state, now);
  const lease = state.leases[leaseId];
  if (!lease) throw poolError('LEASE_NOT_FOUND', `Lease ${leaseId} was not found or already expired`);
  lease.expiresAt = new Date(now + ttlMs).toISOString();
  return lease;
}

function releaseLease(state, leaseId) {
  sweepExpired(state, Date.now());
  if (!state.leases[leaseId]) return { released: false, note: 'no active lease with that id (idempotent no-op)' };
  delete state.leases[leaseId];
  return { released: true, leaseId };
}

function reclaimAlias(state, alias, confirmed) {
  sweepExpired(state, Date.now());
  const held = Object.values(state.leases).filter((lease) => lease.alias === alias);
  if (!held.length) return { reclaimed: [], released: 0 };
  if (!confirmed) {
    throw poolError('RECLAIM_CONFIRMATION_REQUIRED', `Profile alias '${alias}' is held by ${held.length} lease(s); reclaiming drops them early. Re-run with --yes to confirm`, { alias, held: held.length });
  }
  for (const lease of held) delete state.leases[lease.leaseId];
  return { reclaimed: held.map((lease) => lease.leaseId), released: held.length, warning: 'forced reclaim: holders may still be running; their leases were dropped before TTL expiry' };
}

function logicalLease(lease) {
  return {
    leaseId: lease.leaseId,
    alias: lease.alias,
    tab: lease.tab,
    holder: lease.holder,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
  };
}

function printHelp() {
  console.log(`WebMCP Profile Pool (machine-local lease broker)

Usage:
  webmcp profile-pool acquire <alias> [--tab own|shared] [--ttl-ms N] [--timeout-ms N] [--idempotency-key K] [--holder H] [--json]
  webmcp profile-pool renew <leaseId> [--ttl-ms N] [--json]
  webmcp profile-pool release <leaseId> [--json]
  webmcp profile-pool list [--json]
  webmcp profile-pool status [--json]
  webmcp profile-pool reclaim <alias> --yes [--json]
  webmcp profile-pool doctor [--for profile-pool] [--json]

Aliases come from the machine-level profile pool config (WEBMCP_PROFILE_POOL_CONFIG,
default ~/.webmcp/profilePool.json). Physical profile ids stay in that config;
all broker output is logical.
`);
}

async function cmdAcquire(rest) {
  const { flags, positional } = parseFlags(rest);
  const alias = positional[0];
  if (!alias) throw usageError('acquire requires a profile alias');
  const tab = flags.tab || 'own';
  if (tab !== 'own' && tab !== 'shared') throw usageError('--tab must be own (exclusive) or shared (co-usable)');
  const ttlMs = intFlag(flags, 'ttl-ms', DEFAULT_TTL_MS, 1, 7 * 24 * 60 * 60 * 1000);
  const timeoutMs = intFlag(flags, 'timeout-ms', 0, 0, 10 * 60 * 1000);
  const idempotencyKey = stringFlag(flags, 'idempotency-key');
  const holder = stringFlag(flags, 'holder');
  const { config } = readProfilePoolConfig();
  if (!Object.hasOwn(config.aliases, alias)) {
    throw poolError('UNKNOWN_ALIAS', `Profile alias '${alias}' is not declared in the profile pool config`);
  }
  const startedAt = Date.now();
  for (;;) {
    let granted;
    try {
      granted = withStateLock(profilePoolStatePath(), () => {
        const { path, state } = readStateFile();
        const outcome = acquireLease(config, state, { alias, tab, ttlMs, idempotencyKey, holder });
        writeStateFile(path, state);
        return outcome;
      });
    } catch (error) {
      if (error.code !== 'CONFLICT') throw error;
      if (!timeoutMs) throw error;
      if (Date.now() - startedAt >= timeoutMs) {
        throw poolError('EXHAUSTED', `Profile alias '${alias}' stayed leased for ${timeoutMs}ms; pool exhausted, branch should wait and retry`, { alias, tab, waitedMs: Date.now() - startedAt });
      }
      sleepSync(Math.min(WAIT_POLL_MS, Math.max(1, timeoutMs - (Date.now() - startedAt))));
      continue;
    }
    return { ...logicalLease(granted.lease), ttlMs, reused: granted.reused, waitedMs: Date.now() - startedAt };
  }
}

function cmdRenew(rest) {
  const { flags, positional } = parseFlags(rest);
  const leaseId = positional[0];
  if (!leaseId) throw usageError('renew requires a lease id');
  const ttlMs = intFlag(flags, 'ttl-ms', DEFAULT_HEARTBEAT_MS, 1, 7 * 24 * 60 * 60 * 1000);
  return withStateLock(profilePoolStatePath(), () => {
    const { path, state } = readStateFile();
    const lease = renewLease(state, leaseId, ttlMs);
    writeStateFile(path, state);
    return { ...logicalLease(lease), ttlMs };
  });
}

function cmdRelease(rest) {
  const { positional } = parseFlags(rest);
  const leaseId = positional[0];
  if (!leaseId) throw usageError('release requires a lease id');
  return withStateLock(profilePoolStatePath(), () => {
    const { path, state } = readStateFile();
    const result = releaseLease(state, leaseId);
    writeStateFile(path, state);
    return result;
  });
}

function cmdList() {
  return withStateLock(profilePoolStatePath(), () => {
    const { path, state } = readStateFile();
    const removed = sweepExpired(state, Date.now());
    if (removed.length) writeStateFile(path, state);
    return { leases: Object.values(state.leases).map(logicalLease) };
  });
}

function cmdStatus() {
  return withStateLock(profilePoolStatePath(), () => {
    const { path, state } = readStateFile();
    const { config } = readProfilePoolConfig();
    const removed = sweepExpired(state, Date.now());
    if (removed.length) writeStateFile(path, state);
    const aliases = Object.keys(config.aliases).sort();
    const byAlias = aliases.map((alias) => {
      const leases = Object.values(state.leases)
        .filter((lease) => lease.alias === alias)
        .map(logicalLease);
      return { alias, state: leases.length ? 'leased' : 'free', leases };
    });
    return { aliases: byAlias };
  });
}

function cmdReclaim(rest) {
  const { flags, positional } = parseFlags(rest);
  const alias = positional[0];
  if (!alias) throw usageError('reclaim requires a profile alias');
  return withStateLock(profilePoolStatePath(), () => {
    const { config } = readProfilePoolConfig();
    if (!Object.hasOwn(config.aliases, alias)) {
      throw poolError('UNKNOWN_ALIAS', `Profile alias '${alias}' is not declared in the profile pool config`);
    }
    const { path, state } = readStateFile();
    const result = reclaimAlias(state, alias, Boolean(flags.yes));
    writeStateFile(path, state);
    return result;
  });
}

function cmdDoctor(rest) {
  const { flags } = parseFlags(rest);
  if (flags.for && flags.for !== 'profile-pool') {
    throw usageError(`--for <tool> must be 'profile-pool' for this seam`);
  }

  const configPath = profilePoolConfigPath();
  const statePath = profilePoolStatePath();
  const config = { present: existsSync(configPath) };
  if (config.present) {
    try {
      const { config: loaded } = readProfilePoolConfig();
      const byProfile = new Map();
      for (const [alias, profileId] of Object.entries(loaded.aliases)) {
        const key = profileId.trim();
        byProfile.set(key, [...(byProfile.get(key) || []), alias]);
      }
      config.ok = true;
      config.schema = loaded.schema;
      config.aliasCount = Object.keys(loaded.aliases).length;
      config.duplicateAliasCount = [...byProfile.values()].reduce((sum, aliases) => sum + (aliases.length > 1 ? aliases.length : 0), 0);
    } catch (error) {
      config.ok = false;
      config.error = error.message;
      if (Array.isArray(error.details?.duplicateAliasGroups)) {
        config.blockingIssue = 'DUPLICATE_PHYSICAL_MAPPING';
        config.duplicateAliasCount = error.details.duplicateAliasGroups
          .reduce((count, group) => count + group.length, 0);
        config.duplicateAliasGroups = error.details.duplicateAliasGroups;
      }
    }
  }

  const state = { present: existsSync(statePath) };
  let expiredCount = 0;
  if (state.present) {
    try {
      const { state: loaded } = readStateFile();
      const now = Date.now();
      for (const lease of Object.values(loaded.leases)) {
        const expiresAt = typeof lease?.expiresAt === 'string' ? Date.parse(lease.expiresAt) : NaN;
        if (!Number.isNaN(expiresAt) && expiresAt <= now) expiredCount += 1;
      }
      state.ok = true;
      state.schema = loaded.schema;
      state.leaseCount = Object.keys(loaded.leases).length;
    } catch (error) {
      state.ok = false;
      state.error = error.message;
    }
  }

  return {
    config,
    state: { ...state, expiredCount },
    ok: Boolean(config.ok && state.present && state.ok),
    next: config.ok && !state.present
      ? 'State file appears on first acquire; nothing to do.'
      : 'Write ~/.webmcp/profilePool.json with schema webmcp-profile-pool-config/1 and an aliases map before acquiring.',
  };
}

function errorEnvelope(error) {
  return {
    ok: false,
    schema: SCHEMA_OUTPUT,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || String(error),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

function successEnvelope(command, data) {
  return {
    ok: true,
    schema: SCHEMA_OUTPUT,
    command,
    data,
    meta: { generatedAt: new Date().toISOString() },
  };
}

export async function runProfilePool(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printHelp();
    return subcommand ? 0 : 2;
  }

  const wantsJson = rest.includes('--json');
  try {
    let command;
    let data;
    if (subcommand === 'acquire') { command = 'profile-pool.acquire'; data = await cmdAcquire(rest); }
    else if (subcommand === 'renew') { command = 'profile-pool.renew'; data = cmdRenew(rest); }
    else if (subcommand === 'release') { command = 'profile-pool.release'; data = cmdRelease(rest); }
    else if (subcommand === 'list') { command = 'profile-pool.list'; data = cmdList(); }
    else if (subcommand === 'status') { command = 'profile-pool.status'; data = cmdStatus(); }
    else if (subcommand === 'reclaim') { command = 'profile-pool.reclaim'; data = cmdReclaim(rest); }
    else if (subcommand === 'doctor') { command = 'profile-pool.doctor'; data = cmdDoctor(rest); }
    else throw usageError(`Unknown profile-pool command: ${subcommand}`);

    if (wantsJson) console.log(JSON.stringify(successEnvelope(command, data), null, 2));
    else if (subcommand === 'doctor') printDoctorText(data);
    else if (subcommand === 'acquire') console.log(`Acquired ${data.alias} (${data.tab}) lease ${data.leaseId} until ${data.expiresAt}${data.reused ? ' [reused]' : ''}${data.waitedMs ? ` [waited ${data.waitedMs}ms]` : ''}`);
    else if (subcommand === 'renew') console.log(`Renewed ${data.leaseId} until ${data.expiresAt}`);
    else if (subcommand === 'release') console.log(data.released ? `Released ${data.leaseId}` : `Nothing to release: ${data.note}`);
    else if (subcommand === 'list') {
      if (!data.leases.length) console.log('(no leases)');
      for (const lease of data.leases) console.log(`${lease.leaseId}  ${lease.alias}  ${lease.tab}  until ${lease.expiresAt}${lease.holder ? `  holder=${lease.holder}` : ''}`);
    }
    else if (subcommand === 'status') {
      for (const entry of data.aliases) {
        console.log(`${entry.alias}: ${entry.state}${entry.leases.length ? ` (${entry.leases.map((lease) => lease.leaseId).join(', ')})` : ''}`);
      }
    }
    else if (subcommand === 'reclaim') {
      if (data.released) console.log(data.warning);
      console.log(`Reclaimed ${data.released} lease(s) on ${args[1]}: ${data.reclaimed.join(', ')}`);
    }
    return subcommand === 'doctor' ? (data.ok ? 0 : 1) : 0;
  } catch (error) {
    const envelope = errorEnvelope(error);
    if (wantsJson) console.log(JSON.stringify(envelope, null, 2));
    else process.stderr.write(`${envelope.error.code}: ${envelope.error.message}\n`);
    return error.exitCode || 1;
  }
}

function printDoctorText(doctor) {
  console.log(`WebMCP profile pool doctor: ${doctor.ok ? 'OK' : 'NOT READY'}`);
  console.log(`  Config: ${doctor.config.ok ? `${doctor.config.aliasCount} aliases` : doctor.config.present ? doctor.config.error : 'missing'}`);
  if (doctor.config.ok && doctor.config.duplicateAliasCount) {
    console.log(`  WARNING: ${doctor.config.duplicateAliasCount} aliases map to a shared physical profile`);
  }
  console.log(`  State: ${doctor.state.ok ? `${doctor.state.leaseCount} leases (${doctor.state.expiredCount} expired)` : doctor.state.present ? doctor.state.error : 'absent (created on first acquire)'}`);
}
