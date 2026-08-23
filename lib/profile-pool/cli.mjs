import process from 'node:process';
import { existsSync } from 'node:fs';
import { usageError, poolError } from './errors.mjs';
import {
  profilePoolConfigPath,
  profilePoolStatePath,
  readProfilePoolConfig,
} from './legacy-v1-config.mjs';
import {
  readStateFile,
  sleepSync,
  sweepExpired,
  withStateLock,
  writeStateFile,
} from './legacy-v1-state.mjs';
import {
  acquireLease,
  logicalLease,
  reclaimAlias,
  releaseLease,
  renewLease,
} from './legacy-v1-lease.mjs';

const SCHEMA_OUTPUT = 'webmcp-profile-pool/1';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 2 * 60 * 1000;
const WAIT_POLL_MS = 100;

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
