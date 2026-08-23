import { randomBytes } from 'node:crypto';
import { poolError } from './errors.mjs';
import { sweepExpired } from './legacy-v1-state.mjs';

export function acquireLease(config, state, { alias, tab, ttlMs, idempotencyKey, holder }) {
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

export function renewLease(state, leaseId, ttlMs) {
  const now = Date.now();
  sweepExpired(state, now);
  const lease = state.leases[leaseId];
  if (!lease) throw poolError('LEASE_NOT_FOUND', `Lease ${leaseId} was not found or already expired`);
  lease.expiresAt = new Date(now + ttlMs).toISOString();
  return lease;
}

export function releaseLease(state, leaseId) {
  sweepExpired(state, Date.now());
  if (!state.leases[leaseId]) return { released: false, note: 'no active lease with that id (idempotent no-op)' };
  delete state.leases[leaseId];
  return { released: true, leaseId };
}

export function reclaimAlias(state, alias, confirmed) {
  sweepExpired(state, Date.now());
  const held = Object.values(state.leases).filter((lease) => lease.alias === alias);
  if (!held.length) return { reclaimed: [], released: 0 };
  if (!confirmed) {
    throw poolError('RECLAIM_CONFIRMATION_REQUIRED', `Profile alias '${alias}' is held by ${held.length} lease(s); reclaiming drops them early. Re-run with --yes to confirm`, { alias, held: held.length });
  }
  for (const lease of held) delete state.leases[lease.leaseId];
  return { reclaimed: held.map((lease) => lease.leaseId), released: held.length, warning: 'forced reclaim: holders may still be running; their leases were dropped before TTL expiry' };
}

export function logicalLease(lease) {
  return {
    leaseId: lease.leaseId,
    alias: lease.alias,
    tab: lease.tab,
    holder: lease.holder,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
  };
}
