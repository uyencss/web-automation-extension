/**
 * PermitStore — server-side ledger for E4/E5 gateway verification.
 * Tracks replay nonces, revocation, and budget consumption.
 * All budget reservations are atomic; no partial mutation on deny.
 * Expiry is checked before GC to prevent post-expiry replay reopening.
 */
const MAX_REVOKED_ENTRIES = 10000;
const MARK_SEEN_GC_SKEW_MS = 1000;

export class PermitStore {
  constructor() {
    this.seenNonce = new Map(); // nonce -> expiresAt (ms)
    this.revoked = new Set(); // revocationId or permitId (FIFO capped)
    this.budget = new Map(); // permitId -> { maxCalls, used, expiresAt? }
    this._queue = Promise.resolve();
  }

  // Non-mutating replay check — does NOT trigger GC
  // GC is only performed on successful consume or explicit call
  isReplay(nonce, nowMs) {
    return this.seenNonce.has(nonce);
  }

  markSeen(nonce, expiresAt, nowMs = Date.now()) {
    this.gc(nowMs, MARK_SEEN_GC_SKEW_MS);
    const exp = Date.parse(expiresAt);
    const ttl = Number.isNaN(exp) ? nowMs + 60000 : exp;
    this.seenNonce.set(nonce, ttl);
  }

  gc(nowMs = Date.now(), skewMs = 0) {
    const cutoff = nowMs - skewMs;
    for (const [nonce, exp] of this.seenNonce) {
      if (exp < cutoff) this.seenNonce.delete(nonce);
    }
    for (const [permitId, entry] of this.budget) {
      if (Number.isFinite(entry?.expiresAt) && entry.expiresAt < cutoff) {
        this.budget.delete(permitId);
      }
    }
  }

  _addRevoked(id) {
    if (!id) return;
    this.revoked.add(id);
    while (this.revoked.size > MAX_REVOKED_ENTRIES) {
      this.revoked.delete(this.revoked.values().next().value);
    }
  }

  revoke(revocationId) {
    this._addRevoked(revocationId);
  }

  isRevoked(revocationId, permitId) {
    return (revocationId && this.revoked.has(revocationId)) || (permitId && this.revoked.has(permitId));
  }

  revokeBoth(permitId, revocationId) {
    this._addRevoked(permitId);
    this._addRevoked(revocationId);
  }

  /**
   * Atomic ledger reservation — replay + budget in one indivisible step.
   * Checks replay and budget, then reserves budget and marks replay only on success.
   * No partial mutation on deny. For permits without maxCalls, still enforces replay.
   * Expiry is checked BEFORE GC to avoid deleting a nonce and reopening it.
   * @param {object} permit
   * @param {number} count — number of calls to reserve (batch atomic)
   * @param {number} nowMs — current time for GC and expiry handling
   * @returns {{ok:boolean, reason?:string}}
   */
  tryConsume(permit, count = 1, nowMs = Date.now()) {
    const nonce = permit?.nonce;
    if (!nonce) return { ok: false, reason: 'EXECUTION_PERMIT_REQUIRED' };
    const exp = Date.parse(permit?.expiresAt);
    if (!Number.isNaN(exp) && nowMs > exp) {
      return { ok: false, reason: 'EXECUTION_PERMIT_EXPIRED' };
    }
    this.gc(nowMs);
    if (this.seenNonce.has(nonce)) return { ok: false, reason: 'EXECUTION_PERMIT_REVOKED' };
    const maxCalls = permit?.budget?.maxCalls;
    if (maxCalls !== undefined && maxCalls !== null) {
      const key = permit.permitId;
      if (!key) return { ok: false, reason: 'EXECUTION_PERMIT_REQUIRED' };
      let entry = this.budget.get(key);
      const used = entry ? entry.used : 0;
      const ceiling = entry ? Math.min(entry.maxCalls, maxCalls) : maxCalls;
      if (used + count > ceiling) return { ok: false, reason: 'EXECUTION_BUDGET_EXHAUSTED' };
      if (!entry) {
        entry = { maxCalls, used: 0, ...(!Number.isNaN(exp) ? { expiresAt: exp } : {}) };
        this.budget.set(key, entry);
      } else {
        if (maxCalls !== entry.maxCalls) entry.maxCalls = Math.min(entry.maxCalls, maxCalls);
        if (entry.expiresAt === undefined && !Number.isNaN(exp)) entry.expiresAt = exp;
      }
      entry.used += count;
    }
    const ttl = Number.isNaN(exp) ? nowMs + 60000 : exp;
    this.seenNonce.set(nonce, ttl);
    return { ok: true };
  }

  /**
   * Async atomic consume with promise-chain lock for concurrent callers.
   */
  async tryConsumeAtomic(permit, count = 1, nowMs = Date.now()) {
    const prev = this._queue;
    let release;
    this._queue = new Promise((r) => { release = r; });
    await prev;
    try {
      return this.tryConsume(permit, count, nowMs);
    } finally {
      release();
    }
  }

  // Legacy budget-only paths for direct store tests
  reserveBudget(permit, count = 1) {
    const key = permit.permitId;
    if (!key) return false;
    const maxCalls = permit.budget?.maxCalls;
    if (maxCalls === undefined || maxCalls === null) return true;
    const exp = Date.parse(permit?.expiresAt);
    let entry = this.budget.get(key);
    if (!entry) {
      entry = { maxCalls, used: 0, ...(!Number.isNaN(exp) ? { expiresAt: exp } : {}) };
      this.budget.set(key, entry);
    } else {
      if (maxCalls !== entry.maxCalls) entry.maxCalls = Math.min(entry.maxCalls, maxCalls);
      if (entry.expiresAt === undefined && !Number.isNaN(exp)) entry.expiresAt = exp;
    }
    if (entry.used + count > entry.maxCalls) return false;
    entry.used += count;
    return true;
  }

  tryReserve(permit, count = 1) {
    return this.reserveBudget(permit, count);
  }

  async reserveBudgetAtomic(permit, count = 1) {
    const prev = this._queue;
    let release;
    this._queue = new Promise((r) => { release = r; });
    await prev;
    try { return this.reserveBudget(permit, count); } finally { release(); }
  }

  async tryReserveAtomic(permit, count = 1) {
    return this.reserveBudgetAtomic(permit, count);
  }

  /**
   * Check if budget would allow count without mutating.
   */
  wouldExhaust(permit, count = 1) {
    const key = permit.permitId;
    const maxCalls = permit.budget?.maxCalls;
    if (maxCalls === undefined || maxCalls === null) return false;
    const entry = this.budget.get(key);
    const used = entry ? entry.used : 0;
    const ceiling = entry ? Math.min(entry.maxCalls, maxCalls) : maxCalls;
    return used + count > ceiling;
  }

  getBudgetUsage(permitId) {
    const entry = this.budget.get(permitId);
    return entry ? { ...entry } : null;
  }

  reset() {
    this.seenNonce.clear();
    this.revoked.clear();
    this.budget.clear();
    this._queue = Promise.resolve();
  }
}
