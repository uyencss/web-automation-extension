export class PermitStore {
  constructor() {
    this.seenNonce = new Map(); // nonce -> expiresAt
    this.revoked = new Set(); // revocationId
    this.budget = new Map(); // permitId -> {maxCalls, used}
  }

  isReplay(nonce, nowMs) {
    this.gc(nowMs);
    return this.seenNonce.has(nonce);
  }

  markSeen(nonce, expiresAt) {
    const exp = Date.parse(expiresAt);
    this.seenNonce.set(nonce, Number.isNaN(exp) ? Date.now() + 60000 : exp);
  }

  gc(nowMs = Date.now()) {
    for (const [nonce, exp] of this.seenNonce) if (exp < nowMs) this.seenNonce.delete(nonce);
  }

  revoke(revocationId) {
    if (revocationId) this.revoked.add(revocationId);
  }

  isRevoked(revocationId, permitId) {
    return this.revoked.has(revocationId) || this.revoked.has(permitId);
  }

  // E5: explicit in-memory only, no persistence
  revokeBoth(permitId, revocationId) {
    if (permitId) this.revoked.add(permitId);
    if (revocationId) this.revoked.add(revocationId);
  }

  reserveBudget(permit) {
    const key = permit.permitId;
    let entry = this.budget.get(key);
    if (!entry) {
      entry = { maxCalls: permit.budget?.maxCalls ?? Infinity, used: 0 };
      this.budget.set(key, entry);
    }
    if (entry.used >= entry.maxCalls) return false;
    entry.used += 1;
    return true;
  }

  // For testing concurrent reservation
  tryReserve(permit) {
    return this.reserveBudget(permit);
  }

  reset() {
    this.seenNonce.clear();
    this.revoked.clear();
    this.budget.clear();
  }
}
