/**
 * PermitStore — server-side ledger for E4/E5 gateway verification.
 * Tracks replay nonces, revocation, and budget consumption.
 * All budget reservations are atomic; no partial mutation on deny.
 * Expiry is checked before GC to prevent post-expiry replay reopening.
 */
export class PermitStore {
  constructor() {
    this.seenNonce = new Map(); // nonce -> expiresAt (ms)
    this.revoked = new Set(); // revocationId or permitId
    this.budget = new Map(); // permitId -> { maxCalls, used }
    this._queue = Promise.resolve();
  }

  // Non-mutating replay check — does NOT trigger GC
  // GC is only performed on successful consume or explicit call
  isReplay(nonce, nowMs) {
    return this.seenNonce.has(nonce);
  }

  markSeen(nonce, expiresAt) {
    const exp = Date.parse(expiresAt);
    const ttl = Number.isNaN(exp) ? Date.now() + 60000 : exp;
    this.seenNonce.set(nonce, ttl);
  }

  gc(nowMs = Date.now()) {
    for (const [nonce, exp] of this.seenNonce) {
      if (exp < nowMs) this.seenNonce.delete(nonce);
    }
  }

  revoke(revocationId) {
    if (revocationId) this.revoked.add(revocationId);
  }

  isRevoked(revocationId, permitId) {
    return (revocationId && this.revoked.has(revocationId)) || (permitId && this.revoked.has(permitId));
  }

  revokeBoth(permitId, revocationId) {
    if (permitId) this.revoked.add(permitId);
    if (revocationId) this.revoked.add(revocationId);
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
        entry = { maxCalls, used: 0 };
        this.budget.set(key, entry);
      } else if (maxCalls !== entry.maxCalls) {
        entry.maxCalls = Math.min(entry.maxCalls, maxCalls);
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
    let entry = this.budget.get(key);
    if (!entry) {
      entry = { maxCalls, used: 0 };
      this.budget.set(key, entry);
    } else if (maxCalls !== entry.maxCalls) {
      entry.maxCalls = Math.min(entry.maxCalls, maxCalls);
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
