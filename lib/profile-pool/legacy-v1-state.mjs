import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { poolError } from './errors.mjs';
import { profilePoolStatePath } from './legacy-v1-config.mjs';

const SCHEMA_STATE = 'webmcp-profile-pool-state/1';
const LOCK_RETRY_MS = 5000;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 10000;

export function sleepSync(ms) {
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

export function readStateFile() {
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
  if (parsed.data.schema !== SCHEMA_STATE) {
    throw poolError('STATE_INVALID', `profile pool state schema must be ${SCHEMA_STATE}`);
  }
  const state = parsed.data;
  state.leases = state.leases && typeof state.leases === 'object' && !Array.isArray(state.leases) ? state.leases : {};
  return { path, state };
}

export function writeStateFile(path, state) {
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
export function withStateLock(statePath, fn) {
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
        throw poolError('STATE_BUSY', 'Profile pool state is locked by another broker call; retry after the current broker operation completes');
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

export function sweepExpired(state, now) {
  const removed = [];
  for (const [leaseId, lease] of Object.entries(state.leases)) {
    const expiresAt = typeof lease?.expiresAt === 'string' ? Date.parse(lease.expiresAt) : NaN;
    if (!Number.isNaN(expiresAt) && expiresAt <= now) removed.push(leaseId);
  }
  for (const leaseId of removed) delete state.leases[leaseId];
  return removed;
}
