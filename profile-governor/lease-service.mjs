import { randomBytes } from 'node:crypto';
import { computeFenceDigest, computeLeaseBindingDigest, digestLf, opaqueId, redactLease, redactResource, requestFingerprint, SCHEMAS, stableStringify, validateActionFence, validateLeaseRequest } from './contracts.mjs';
import { profileError } from './errors.mjs';
import { appendEvent, listRedactedEvents } from './events.mjs';
import { reconcileResource, assertReconciliationForAcquire } from './reconciliation.mjs';
import { applyEvidenceRecovery, buildRecoveryReceipt, computeRecoveryPlanDigest, listRecoveryReceipts } from './recovery.mjs';
import { probeLiveness } from './liveness.mjs';
import { transition } from './state-machine.mjs';

const MIN_COOLDOWN_MS = 0;
const ACTION_KIND = new Set(['click', 'type', 'scroll', 'waitForStable', 'batch', 'read', 'queryIndexedDB']);

function resolveMethod(adapter, method) {
  if (typeof adapter === 'function') return adapter;
  if (typeof adapter?.[method] === 'function') return adapter[method].bind(adapter);
  throw profileError('PROFILE_GOVERNOR_UNAVAILABLE', `Governor ${method} adapter is unavailable`);
}

function nowIso(now) { return new Date(now).toISOString(); }

function safeBinding(resolved, request) {
  if (!resolved || typeof resolved.physicalResourceId !== 'string' || resolved.physicalResourceId.length < 2 || resolved.physicalResourceId.length > 512) throw profileError('PROFILE_BINDING_STALE', 'Registry did not resolve a physical resource');
  if (resolved.bindingId !== request.bindingId || resolved.bindingRevision !== request.bindingRevision || resolved.bindingDigest !== request.bindingDigest) throw profileError('PROFILE_BINDING_STALE', 'Registry binding does not match the admission pin');
  return resolved;
}

function same(a, b) { return a === b; }

function requireActionLiveness(live) {
  if (live.externalUse) throw profileError('PROFILE_EXTERNAL_USE', 'Profile resource is in external use');
  if (live.lifecycleCode) throw profileError(live.lifecycleCode, 'Profile action lifecycle gate is active');
  if (live.summary !== 'healthy' || live.indeterminate || live.browserAlive !== true || live.extensionConnected !== true) throw profileError('PROFILE_LIVENESS_UNKNOWN', 'Composite action liveness is not healthy');
  return live;
}

export class ProfileGovernor {
  constructor({ repository, registry, registryResolver, claims, runnerClaimValidator, liveness, revokeGrants, recoveryAuthorizer, actionResolutionAuthorizer, clock = () => Date.now(), cooldownMs = MIN_COOLDOWN_MS, maxTabs = 8, maxFenceUses = 1000 } = {}) {
    if (!repository) throw new TypeError('repository is required');
    this.repository = repository;
    this.registry = registry || registryResolver;
    this.claims = claims || runnerClaimValidator;
    this.liveness = liveness;
    this.revokeGrants = revokeGrants;
    this.recoveryAuthorizer = recoveryAuthorizer;
    this.actionResolutionAuthorizer = actionResolutionAuthorizer;
    this.clock = clock;
    this.cooldownMs = Math.max(0, Math.min(cooldownMs, 600000));
    this.maxTabs = Math.max(1, Math.min(maxTabs, 8));
    this.maxFenceUses = Math.max(1, Math.min(maxFenceUses, 1000));
    this.repository.markStartupUnknown();
  }

  close() { this.repository.close?.(); }

  async _resolve(profileAlias) {
    if (typeof profileAlias !== 'string') throw profileError('PROFILE_REQUEST_INVALID', 'profileAlias is required');
    const result = await resolveMethod(this.registry, 'resolve')(profileAlias);
    if (!result || typeof result !== 'object') throw profileError('PROFILE_BINDING_STALE', 'Registry resolution is unavailable');
    if (result.physicalResourceId === undefined) return { ...result, physicalResourceId: result.resourceId ?? result.profileResourceId };
    return result;
  }

  async _claim(request) {
    if (request.ownerType === 'external') return null;
    if (!this.claims) throw profileError('PROFILE_CLAIM_REQUIRED', 'Authoritative Runner claim validator is required');
    const result = await resolveMethod(this.claims, 'validate')(request);
    if (!result || result === false || result.valid === false || result.active === false) throw profileError('PROFILE_CLAIM_INVALID', 'Runner claim is not active');
    for (const key of ['runId', 'nodeId', 'bindingId', 'bindingRevision', 'bindingDigest', 'runnerClaimDigest']) if (result[key] !== request[key]) throw profileError('PROFILE_CLAIM_INVALID', 'Runner claim facts do not match the request');
    if (!Array.isArray(result.allowedActions) || result.allowedActions.length === 0 || result.allowedActions.some((action) => !['browser-read', 'browser-write', 'browser-session-data', 'credential-fill'].includes(action))) throw profileError('PROFILE_CLAIM_INVALID', 'Runner claim action scope is not authoritative');
    return result;
  }

  async _authoritativeActions(request, resolved = undefined) {
    const binding = resolved || safeBinding(await this._resolve(request.profileAlias), request);
    if (!Array.isArray(binding.allowedActions) || binding.allowedActions.length === 0) throw profileError('PROFILE_BINDING_STALE', 'Registry action scope is not authoritative');
    const claim = await this._claim(request);
    const claimActions = request.ownerType === 'external' ? binding.allowedActions : claim.allowedActions;
    const allowedActions = [...new Set(binding.allowedActions)].filter((action) => claimActions.includes(action));
    if (request.requestedActions?.some((action) => !allowedActions.includes(action))) throw profileError('PROFILE_ACTION_DENIED', 'Requested action is outside the Registry and Runner claim intersection');
    return { binding, claim, allowedActions };
  }

  async _authoritativeLeaseActions(lease) {
    const result = await this._authoritativeActions(this._leaseRequest(lease));
    if (result.binding.physicalResourceId !== lease.physicalResourceId) throw profileError('PROFILE_BINDING_STALE', 'Registry resolved a different physical resource');
    return result;
  }

  async _currentBinding(lease) {
    const binding = safeBinding(await this._resolve(lease.profileAlias), this._leaseRequest(lease));
    if (binding.physicalResourceId !== lease.physicalResourceId) throw profileError('PROFILE_BINDING_STALE', 'Registry resolved a different physical resource');
    return binding;
  }

  _leaseRequest(lease) {
    return {
      schema: SCHEMAS.request, requestId: 'plr_internal-0001', ownerType: lease.ownerType, nodeId: lease.nodeId,
      runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, bindingId: lease.bindingId,
      bindingRevision: lease.bindingRevision, bindingDigest: lease.bindingDigest, profileAlias: lease.profileAlias,
      leaseMode: lease.leaseMode, requestedActions: lease.requestedActions, heartbeatIntervalMs: lease.heartbeatIntervalMs,
      leaseTtlMs: lease.leaseTtlMs, idempotencyKey: lease.idempotencyKey || 'internal-claim-check',
    };
  }

  async _live(context) { return probeLiveness(this.liveness, context); }

  async _revokeGrants(lease) {
    if (typeof this.revokeGrants !== 'function') return false;
    try { return (await this.revokeGrants(redactLease(lease))) === true; } catch { return false; }
  }

  async _establishRevocationBarrier(lease, { reasonCode = 'PROFILE_CLAIM_INVALID', grantRevokeStatus = 'pending', livenessSummary = 'unknown', now = this.clock() } = {}) {
    const revoked = grantRevokeStatus === 'revoked' || (grantRevokeStatus === 'pending' && await this._revokeGrants(lease));
    this.repository.transact((state) => {
      const current = state.leases[lease.leaseId];
      const resource = current && state.resources[current.physicalResourceId];
      if (!current || !resource || resource.currentLeaseId !== current.leaseId) return;
      const priorEpoch = resource.fenceEpoch;
      if (resource.state !== 'quarantined') transition(resource, 'quarantined', reasonCode, nowIso(now));
      resource.fenceEpoch = priorEpoch + 1;
      resource.needsReconciliation = true;
      resource.livenessSummary = livenessSummary;
      current.state = 'quarantined';
      current.fenceEpoch = resource.fenceEpoch;
      current.leaseBindingDigest = computeLeaseBindingDigest({ claimDigest: current.runnerClaimDigest, bindingDigest: current.bindingDigest, physicalResourceId: current.physicalResourceId, fenceEpoch: current.fenceEpoch });
      current.fences = {};
      current.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId: current.leaseId, bindingDigest: current.bindingDigest, fenceEpoch: current.fenceEpoch, reasonCode });
      resource.recoveryPlanDigest = current.recoveryPlanDigest;
      appendEvent(state, { leaseId: current.leaseId, profileAlias: current.profileAlias, state: 'quarantined', stateReasonCode: reasonCode, fenceEpoch: current.fenceEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: nowIso(now), leaseBindingDigest: current.leaseBindingDigest, livenessSummary, grantRevokeStatus: revoked ? 'revoked' : 'failed' });
    });
    return revoked;
  }

  async _persistLifecycleState(lease, error) {
    const targets = { PROFILE_AUTH_REQUIRED: 'auth_required', PROFILE_CHALLENGE_REQUIRED: 'challenge', PROFILE_RATE_LIMITED: 'rate_limited' };
    const target = targets[error.code];
    if (!target) throw error;
    this.repository.transact((state) => {
      const current = state.leases[lease.leaseId];
      const resource = current && state.resources[current.physicalResourceId];
      if (!current || !resource || resource.currentLeaseId !== current.leaseId) throw profileError('PROFILE_FENCE_STALE', 'Lifecycle transition lost its current lease');
      if (!['leased', 'active', target].includes(current.state) || !['leased', 'active', target].includes(resource.state)) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Lifecycle transition requires a current lease');
      transition(current, target, error.code, nowIso(this.clock()));
      transition(resource, target, error.code, nowIso(this.clock()));
      resource.needsReconciliation = true;
      appendEvent(state, { leaseId: current.leaseId, profileAlias: current.profileAlias, state: target, stateReasonCode: error.code, fenceEpoch: current.fenceEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: nowIso(this.clock()), leaseBindingDigest: current.leaseBindingDigest, livenessSummary: resource.livenessSummary, grantRevokeStatus: 'none' });
    });
  }

  async _barrierOnFailure(lease, error, options = {}) {
    if (['PROFILE_AUTH_REQUIRED', 'PROFILE_CHALLENGE_REQUIRED', 'PROFILE_RATE_LIMITED'].includes(error?.code)) {
      await this._persistLifecycleState(lease, error);
      throw error;
    }
    if (['PROFILE_CLAIM_INVALID', 'PROFILE_BINDING_STALE', 'PROFILE_EXTERNAL_USE', 'PROFILE_LIVENESS_UNKNOWN', 'PROFILE_AUTH_REQUIRED', 'PROFILE_CHALLENGE_REQUIRED', 'PROFILE_RATE_LIMITED', 'PROFILE_GOVERNOR_UNAVAILABLE'].includes(error?.code)) {
      const revoked = await this._establishRevocationBarrier(lease, options);
      if (!revoked && options.requireRevocation !== false) throw profileError('PROFILE_DEPENDENT_GRANT_REVOKE_FAILED', 'Dependent grant revocation did not complete');
    }
    throw error;
  }

  _findResource(state, physicalResourceId) { return state.resources[physicalResourceId]; }

  async reconcileProfile(profileAlias) {
    const resolved = await this._resolve(profileAlias);
    const liveness = await this._live({ profileAlias, physicalResourceId: resolved.physicalResourceId });
    return this.repository.transact((state) => {
      let resource = this._findResource(state, resolved.physicalResourceId);
      if (!resource) {
        resource = {
          profileAlias, physicalResourceId: resolved.physicalResourceId, aliases: [profileAlias], state: 'unknown',
          stateReasonCode: 'RECOVERY_HOST_RESTART', fenceEpoch: 0, currentLeaseId: null,
          needsReconciliation: true, livenessSummary: 'unknown', cooldownUntil: null,
        };
        state.resources[resolved.physicalResourceId] = resource;
      } else if (!resource.aliases.includes(profileAlias)) resource.aliases.push(profileAlias);
      const lease = resource.currentLeaseId ? state.leases[resource.currentLeaseId] : null;
      reconcileResource(resource, { liveness, hasCurrentLease: Boolean(lease), now: nowIso(this.clock()) });
      if (lease && liveness.summary === 'failed' && resource.state !== 'quarantined') {
        transition(resource, 'quarantined', 'PROFILE_RECLAIM_UNSAFE', nowIso(this.clock()));
        resource.needsReconciliation = true;
        resource.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId: lease.leaseId, bindingDigest: lease.bindingDigest, fenceEpoch: resource.fenceEpoch, reasonCode: 'PROFILE_RECLAIM_UNSAFE' });
        lease.recoveryPlanDigest = resource.recoveryPlanDigest;
      }
      return redactResource(resource);
    });
  }

  async reconcileAll() {
    const state = this.repository.read();
    const aliases = Object.values(state.resources).flatMap((resource) => resource.aliases || [resource.profileAlias]);
    return Promise.all(aliases.map((alias) => this.reconcileProfile(alias)));
  }

  async acquire(input, { authenticatedLocalCapability = false } = {}) {
    const request = validateLeaseRequest(input);
    if (request.ownerType === 'external' && !authenticatedLocalCapability) throw profileError('PROFILE_IPC_AUTH', 'Authenticated local capability is required for external ownership');
    const resolved = safeBinding(await this._resolve(request.profileAlias), request);
    const { allowedActions: allowed } = await this._authoritativeActions(request, resolved);
    if (request.ownerType === 'automation') {
      let live;
      try { live = await this._live({ profileAlias: request.profileAlias, physicalResourceId: resolved.physicalResourceId }); requireActionLiveness(live); } catch (error) {
        this.repository.transact((state) => {
          const resource = this._findResource(state, resolved.physicalResourceId);
          if (resource && resource.state !== 'unknown' && resource.state !== 'quarantined') transition(resource, error.code === 'PROFILE_EXTERNAL_USE' ? 'external_use' : 'unknown', error.code, nowIso(this.clock()));
          if (resource) { resource.needsReconciliation = true; resource.livenessSummary = live?.summary || 'unknown'; }
        });
        throw error;
      }
    }
    const fingerprint = requestFingerprint(request);
    const now = this.clock();
    return this.repository.transact((state) => {
      const resource = this._findResource(state, resolved.physicalResourceId);
      const current = resource?.currentLeaseId ? state.leases[resource.currentLeaseId] : null;
      if (current) {
        if (resource.state === 'unknown' || resource.state === 'quarantined') assertReconciliationForAcquire(resource);
        if (current.ownerType === 'external') throw profileError('PROFILE_EXTERNAL_USE', 'Profile resource is in external use');
        if (current.fingerprint === fingerprint && current.state === 'leased' && current.ownerType === request.ownerType) return redactLease(current);
        throw profileError('PROFILE_LEASE_CONFLICT', 'Physical profile resource is already leased');
      }
      assertReconciliationForAcquire(resource);
      const epoch = resource.fenceEpoch + 1;
      const leaseId = opaqueId('lease');
      const lease = {
        leaseId, physicalResourceId: resolved.physicalResourceId, profileAlias: request.profileAlias,
        bindingId: request.bindingId, bindingRevision: request.bindingRevision, bindingDigest: request.bindingDigest,
        runId: request.runId, runnerClaimDigest: request.runnerClaimDigest, leaseMode: request.leaseMode,
        fenceEpoch: epoch, leaseBindingDigest: computeLeaseBindingDigest({ claimDigest: request.runnerClaimDigest, bindingDigest: request.bindingDigest, physicalResourceId: resolved.physicalResourceId, fenceEpoch: epoch }),
        state: request.ownerType === 'external' ? 'external_use' : 'leased', issuedAt: nowIso(now),
        expiresAt: nowIso(now + (request.leaseTtlMs || 120000)), heartbeatIntervalMs: request.heartbeatIntervalMs || 30000,
        leaseTtlMs: request.leaseTtlMs || 120000, nodeId: request.nodeId, ownerType: request.ownerType,
        idempotencyKey: request.idempotencyKey, fingerprint, requestedActions: [...request.requestedActions],
        allowedActions: [...allowed], tabs: {}, maxTabs: this.maxTabs, actionUses: 0, actionJournal: [], fences: {},
      };
      state.leases[leaseId] = lease;
      resource.currentLeaseId = leaseId;
      resource.fenceEpoch = epoch;
      resource.state = lease.state;
      resource.stateReasonCode = lease.state === 'external_use' ? 'PROFILE_EXTERNAL_USE' : undefined;
      resource.needsReconciliation = false;
      resource.livenessSummary = 'healthy';
      appendEvent(state, { leaseId, profileAlias: lease.profileAlias, state: lease.state, stateReasonCode: lease.state === 'external_use' ? 'PROFILE_EXTERNAL_USE' : 'PROFILE_RELEASE', fenceEpoch: epoch, bindingDigest: lease.bindingDigest, bindingId: lease.bindingId, runId: lease.runId, timestamp: lease.issuedAt, leaseBindingDigest: lease.leaseBindingDigest, livenessSummary: 'healthy', grantRevokeStatus: 'none' });
      return redactLease(lease);
    });
  }

  async openTab({ leaseId, runId } = {}) {
    if (typeof leaseId !== 'string' || typeof runId !== 'string') throw profileError('PROFILE_REQUEST_INVALID', 'leaseId and runId are required');
    return this.repository.transact((state) => {
      const lease = state.leases[leaseId];
      if (!lease || state.resources[lease.physicalResourceId]?.currentLeaseId !== leaseId) throw profileError('PROFILE_LEASE_NOT_FOUND', 'Governor lease is not current');
      if (lease.runId !== runId) throw profileError('PROFILE_TAB_NOT_OWNED', 'Tab belongs to a different run');
      if (Object.keys(lease.tabs).length >= lease.maxTabs) throw profileError('PROFILE_TAB_LIMIT', 'Lease tab limit is exhausted');
      const tabHandle = `tab_${randomBytes(10).toString('hex')}`;
      lease.tabs[tabHandle] = { runId, createdAt: nowIso(this.clock()) };
      return { tabHandle, leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch };
    });
  }

  _assertLeaseFacts(state, input, { claimRequired = false } = {}) {
    const lease = state.leases[input?.leaseId];
    const resource = lease && state.resources[lease.physicalResourceId];
    if (!lease || resource?.currentLeaseId !== lease.leaseId) throw profileError('PROFILE_LEASE_NOT_FOUND', 'Governor lease is not current');
    if (input.fenceEpoch !== lease.fenceEpoch || input.leaseBindingDigest !== lease.leaseBindingDigest) throw profileError('PROFILE_FENCE_STALE', 'Fence epoch or lease binding is stale');
    if (input.bindingId !== undefined && input.bindingId !== lease.bindingId) throw profileError('PROFILE_BINDING_STALE', 'Binding identity is stale');
    if (input.bindingDigest !== undefined && input.bindingDigest !== lease.bindingDigest) throw profileError('PROFILE_BINDING_STALE', 'Binding digest is stale');
    if (input.runId !== undefined && input.runId !== lease.runId) throw profileError('PROFILE_CLAIM_INVALID', 'Runner claim run is stale');
    if (input.runnerClaimDigest !== undefined && input.runnerClaimDigest !== lease.runnerClaimDigest) throw profileError('PROFILE_CLAIM_INVALID', 'Runner claim digest is stale');
    if (claimRequired && lease.ownerType === 'automation' && input.runId && input.runId !== lease.runId) throw profileError('PROFILE_CLAIM_INVALID', 'Runner claim run is stale');
    return lease;
  }

  async heartbeat(input = {}) {
    const now = input.now ?? this.clock();
    const state = this.repository.read();
    const lease = this._assertLeaseFacts(state, input, { claimRequired: true });
    try { await this._authoritativeLeaseActions(lease); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code }); }
    let live;
    try { live = await this._live({ leaseId: lease.leaseId, profileAlias: lease.profileAlias }); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code || 'PROFILE_LIVENESS_UNKNOWN' }); }
    if (now >= Date.parse(lease.expiresAt)) {
      this.repository.transact((next) => {
        const current = next.leases[lease.leaseId];
        if (current && next.resources[current.physicalResourceId]?.currentLeaseId === current.leaseId) {
          const resource = next.resources[current.physicalResourceId];
          transition(resource, live.externalUse ? 'external_use' : 'unknown', 'PROFILE_LEASE_EXPIRED', nowIso(now));
          resource.needsReconciliation = true;
          resource.livenessSummary = live.summary;
        }
      });
      throw profileError('PROFILE_LEASE_EXPIRED', 'Lease TTL expired; reconciliation is required');
    }
    try { requireActionLiveness(live); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code, livenessSummary: live.summary }); }
    return this.repository.transact((next) => {
      const current = this._assertLeaseFacts(next, input, { claimRequired: true });
      current.expiresAt = nowIso(now + current.leaseTtlMs);
      current.heartbeatCount = (current.heartbeatCount || 0) + 1;
      appendEvent(next, { leaseId: current.leaseId, profileAlias: current.profileAlias, state: current.state, stateReasonCode: 'HEARTBEAT_OK', fenceEpoch: current.fenceEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: nowIso(now), leaseBindingDigest: current.leaseBindingDigest, counts: { heartbeats: current.heartbeatCount }, livenessSummary: 'healthy', grantRevokeStatus: 'none' });
      return redactLease(current);
    });
  }

  renew(input) { return this.heartbeat(input); }

  async release(input = {}) {
    const state = this.repository.read();
    const lease = state.leases[input.leaseId];
    if (!lease || state.resources[lease.physicalResourceId]?.currentLeaseId !== lease.leaseId) return { released: false };
    if (input.fenceEpoch !== lease.fenceEpoch || input.leaseBindingDigest !== lease.leaseBindingDigest) return { released: false };
    const unresolved = lease.actionJournal?.find((entry) => ['prepared', 'dispatched', 'indeterminate'].includes(entry.outcome));
    let bindingError;
    try { await this._currentBinding(lease); } catch (error) { bindingError = error; }
    let live;
    let livenessError;
    try { live = await this._live({ leaseId: lease.leaseId, profileAlias: lease.profileAlias }); } catch (error) { livenessError = error; }
    let claimError;
    if (lease.ownerType === 'automation') {
      try { await this._claim(this._leaseRequest(lease)); } catch (error) { claimError = error; }
    }
    if (unresolved) {
      const revoked = await this._revokeGrants(lease);
      await this._establishRevocationBarrier(lease, { reasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', grantRevokeStatus: revoked ? 'revoked' : 'failed', livenessSummary: live?.summary || 'unknown' });
      if (!revoked) throw profileError('PROFILE_DEPENDENT_GRANT_REVOKE_FAILED', 'Dependent grant revocation did not complete');
      if (bindingError) throw bindingError;
      if (claimError) throw claimError;
      if (livenessError) throw livenessError;
      try { requireActionLiveness(live); } catch (error) { throw error; }
      throw profileError('PROFILE_OUTWARD_EFFECT_INDETERMINATE', 'Unresolved action effect requires trusted resolution');
    }
    const revoked = await this._revokeGrants(lease);
    if (!revoked) {
      await this._establishRevocationBarrier(lease, { reasonCode: 'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED', grantRevokeStatus: 'failed', livenessSummary: live?.summary || 'unknown' });
      throw profileError('PROFILE_DEPENDENT_GRANT_REVOKE_FAILED', 'Dependent grant revocation did not complete');
    }
    if (bindingError) { await this._establishRevocationBarrier(lease, { reasonCode: bindingError.code, grantRevokeStatus: 'revoked' }); throw bindingError; }
    if (claimError) { await this._establishRevocationBarrier(lease, { reasonCode: claimError.code, grantRevokeStatus: 'revoked' }); throw claimError; }
    if (livenessError) { await this._establishRevocationBarrier(lease, { reasonCode: livenessError.code || 'PROFILE_LIVENESS_UNKNOWN', grantRevokeStatus: 'revoked' }); throw livenessError; }
    try { requireActionLiveness(live); } catch (error) { await this._establishRevocationBarrier(lease, { reasonCode: error.code, grantRevokeStatus: 'revoked', livenessSummary: live.summary }); throw error; }
    return this.repository.transact((next) => {
      const current = next.leases[lease.leaseId];
      if (!current) return { released: false };
      const resource = next.resources[current.physicalResourceId];
      if (!resource || resource.currentLeaseId !== current.leaseId || current.fenceEpoch !== input.fenceEpoch || current.leaseBindingDigest !== input.leaseBindingDigest) return { released: false };
      current.state = 'cooldown';
      current.releasedAt = nowIso(this.clock());
      resource.currentLeaseId = null;
      resource.state = 'cooldown';
      resource.stateReasonCode = 'PROFILE_RELEASE';
      resource.cooldownUntil = nowIso(this.clock() + this.cooldownMs);
      resource.needsReconciliation = true;
      appendEvent(next, { leaseId: current.leaseId, profileAlias: current.profileAlias, state: 'cooldown', stateReasonCode: 'PROFILE_RELEASE', fenceEpoch: current.fenceEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: current.releasedAt, leaseBindingDigest: current.leaseBindingDigest, livenessSummary: 'unknown', grantRevokeStatus: 'revoked' });
      return { released: true, leaseId: current.leaseId, state: 'cooldown' };
    });
  }

  _fenceScope(input, tabHandle, profileAlias) {
    const scope = { profileAlias: profileAlias || input.profileAlias, actions: [input.action] };
    if (tabHandle !== undefined) scope.tabHandle = tabHandle;
    return scope;
  }

  async createFence(input = {}) {
    if (!input || typeof input !== 'object' || !input.leaseId || !input.action) throw profileError('PROFILE_FENCE_REQUIRED', 'A current action fence is required');
    if (input.purpose !== undefined && (typeof input.purpose !== 'string' || !/^[a-z0-9-]{2,64}$/.test(input.purpose))) throw profileError('PROFILE_REQUEST_INVALID', 'Fence purpose is invalid');
    const state = this.repository.read();
    const lease = this._assertLeaseFacts(state, input, { claimRequired: true });
    let allowedActions;
    try { ({ allowedActions } = await this._authoritativeLeaseActions(lease)); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code }); }
    const resource = state.resources[lease.physicalResourceId];
    if (input.runId !== lease.runId || input.bindingId !== lease.bindingId) throw profileError('PROFILE_FENCE_STALE', 'Fence scope is stale');
    if (!['leased', 'active'].includes(resource.state)) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Profile resource requires reconciliation');
    if (Date.parse(lease.expiresAt) <= this.clock()) throw profileError('PROFILE_LEASE_EXPIRED', 'Lease TTL expired; reconciliation is required');
    if (!lease.requestedActions.includes(input.action) || !lease.allowedActions.includes(input.action) || !allowedActions.includes(input.action)) throw profileError('PROFILE_ACTION_DENIED', 'Action is outside the admitted scope');
    if (input.tabHandle !== undefined && (!lease.tabs[input.tabHandle] || lease.tabs[input.tabHandle].runId !== lease.runId)) throw profileError('PROFILE_TAB_NOT_OWNED', 'Tab is not owned by the lease');
    let live;
    try { live = await this._live({ leaseId: lease.leaseId, profileAlias: lease.profileAlias }); requireActionLiveness(live); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code, livenessSummary: live?.summary }); }
    const now = this.clock();
    return this.repository.transact((next) => {
      const current = this._assertLeaseFacts(next, input, { claimRequired: true });
      const currentResource = next.resources[current.physicalResourceId];
      if (!['leased', 'active'].includes(currentResource.state)) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Profile resource requires reconciliation');
      if (Date.parse(current.expiresAt) <= now) throw profileError('PROFILE_LEASE_EXPIRED', 'Lease TTL expired; reconciliation is required');
      if (current.actionUses >= this.maxFenceUses) throw profileError('PROFILE_FENCE_STALE', 'Fence use limit is exhausted');
      if (current.state === 'leased') {
        transition(current, 'active', 'PROFILE_RELEASE', nowIso(now));
        transition(currentResource, 'active', 'PROFILE_RELEASE', nowIso(now));
      }
      current.actionUses += 1;
      const scope = this._fenceScope(input, input.tabHandle, current.profileAlias);
      const issuedAt = nowIso(now);
      const ttlMs = Math.min(current.leaseTtlMs, 300000);
      const expiresAt = nowIso(now + ttlMs);
      const proof = { schema: SCHEMAS.fence, fenceId: opaqueId('fence'), leaseId: current.leaseId, fenceEpoch: current.fenceEpoch, leaseBindingDigest: current.leaseBindingDigest, runId: current.runId, bindingId: current.bindingId, purpose: input.purpose || 'browser-action', scope, ttlMs, maxUses: this.maxFenceUses, issuedAt, expiresAt };
      proof.fenceDigest = computeFenceDigest({ ...proof });
      if (ACTION_KIND.has(input.actionKind)) proof.actionKind = input.actionKind;
      current.fences = current.fences || {};
      current.fences[proof.fenceId] = { proof: { ...proof }, uses: 0 };
      appendEvent(next, { leaseId: current.leaseId, profileAlias: current.profileAlias, state: 'active', stateReasonCode: 'HEARTBEAT_OK', fenceEpoch: current.fenceEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: issuedAt, leaseBindingDigest: current.leaseBindingDigest, counts: { actions: current.actionUses }, livenessSummary: 'healthy', grantRevokeStatus: 'none' });
      return proof;
    });
  }

  async authorizeFence(proof) {
    if (!proof) throw profileError('PROFILE_FENCE_REQUIRED', 'A current action fence is required');
    validateActionFence(proof);
    const state = this.repository.read();
    const lease = this._assertLeaseFacts(state, proof);
    let allowedActions;
    try { ({ allowedActions } = await this._authoritativeLeaseActions(lease)); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code }); }
    const resource = state.resources[lease.physicalResourceId];
    if (!['leased', 'active'].includes(resource.state)) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Profile resource requires reconciliation');
    if (proof.runId !== lease.runId || proof.bindingId !== lease.bindingId || proof.scope?.profileAlias !== lease.profileAlias) throw profileError('PROFILE_FENCE_STALE', 'Fence scope is stale');
    if (!Array.isArray(proof.scope?.actions) || proof.scope.actions.some((action) => !lease.requestedActions.includes(action) || !lease.allowedActions.includes(action) || !allowedActions.includes(action))) throw profileError('PROFILE_ACTION_DENIED', 'Fence action is outside the admitted scope');
    if (proof.scope.tabHandle !== undefined && (!lease.tabs[proof.scope.tabHandle] || lease.tabs[proof.scope.tabHandle].runId !== lease.runId)) throw profileError('PROFILE_TAB_NOT_OWNED', 'Fence tab is not owned by the lease');
    if (Date.parse(proof.expiresAt) <= this.clock()) throw profileError('PROFILE_FENCE_STALE', 'Fence has expired');
    const issued = lease.fences?.[proof.fenceId];
    if (!issued || stableStringify(issued.proof) !== stableStringify(proof)) throw profileError('PROFILE_FENCE_STALE', 'Fence facts are not the issued authoritative proof');
    const expectedDigest = computeFenceDigest({ ...proof });
    if (proof.fenceDigest !== expectedDigest) throw profileError('PROFILE_FENCE_INVALID', 'Fence digest is invalid');
    let live;
    try { live = await this._live({ leaseId: lease.leaseId, profileAlias: lease.profileAlias }); requireActionLiveness(live); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code, livenessSummary: live?.summary }); }
    return this.repository.transact((next) => {
      const current = this._assertLeaseFacts(next, proof);
      const currentResource = next.resources[current.physicalResourceId];
      if (!['leased', 'active'].includes(currentResource.state)) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Profile resource requires reconciliation');
      const authoritative = current.fences?.[proof.fenceId];
      if (!authoritative || stableStringify(authoritative.proof) !== stableStringify(proof)) throw profileError('PROFILE_FENCE_STALE', 'Fence facts are not the issued authoritative proof');
      if (Date.parse(current.expiresAt) <= this.clock() || Date.parse(proof.expiresAt) <= this.clock()) throw profileError('PROFILE_FENCE_STALE', 'Fence or lease has expired');
      if (authoritative.uses >= authoritative.proof.maxUses) throw profileError('PROFILE_FENCE_STALE', 'Fence use limit is exhausted');
      authoritative.uses += 1;
      return { authorized: true, actionDispatch: 'local-authority-approved' };
    });
  }

  async recordAction(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw profileError('PROFILE_REQUEST_INVALID', 'Action journal input is invalid');
    const allowedFields = new Set(['leaseId', 'actionId', 'outcome', 'fenceId', 'fenceEpoch', 'leaseBindingDigest', 'bindingId', 'bindingDigest', 'runId', 'runnerClaimDigest', 'resolution', 'actionKind']);
    const unknown = Object.keys(input).find((key) => !allowedFields.has(key));
    if (unknown) throw profileError('PROFILE_REQUEST_INVALID', `unknown action journal field: ${unknown}`);
    const { leaseId, actionId, outcome, fenceId, fenceEpoch, leaseBindingDigest, bindingId, bindingDigest, runId, runnerClaimDigest, resolution, actionKind } = input;
    const digest = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
    if (typeof leaseId !== 'string' || !/^lease_[0-9a-f]{16}$/.test(leaseId) || typeof actionId !== 'string' || !/^[a-z0-9_-]{4,80}$/.test(actionId) || !['prepared', 'dispatched', 'confirmed', 'failed-known', 'indeterminate'].includes(outcome) || typeof fenceId !== 'string' || !/^fence_[0-9a-f]{16}$/.test(fenceId) || !Number.isInteger(fenceEpoch) || fenceEpoch < 1 || fenceEpoch > 2 ** 31 - 1 || !digest(leaseBindingDigest) || typeof bindingId !== 'string' || !/^pb_[a-z0-9-]+$/.test(bindingId) || !digest(bindingDigest) || typeof runId !== 'string' || !/^run_[a-z0-9-]{8,96}$/.test(runId) || !digest(runnerClaimDigest) || (actionKind !== undefined && !ACTION_KIND.has(actionKind)) || (resolution !== undefined && (!resolution || typeof resolution !== 'object' || Array.isArray(resolution) || resolution.kind !== 'trusted-revocation'))) throw profileError('PROFILE_REQUEST_INVALID', 'Action journal input is invalid');
    const before = this.repository.read();
    const lease = this._assertLeaseFacts(before, { leaseId, fenceEpoch, leaseBindingDigest, bindingId, bindingDigest, runId, runnerClaimDigest });
    if (bindingDigest !== lease.bindingDigest) throw profileError('PROFILE_BINDING_STALE', 'Action binding is stale');
    const existing = lease.actionJournal?.find((entry) => entry.actionId === actionId);
    const issued = lease.fences?.[fenceId];
    const trustedResolution = ['prepared', 'dispatched', 'indeterminate'].includes(existing?.outcome) && resolution?.kind === 'trusted-revocation';
    if (trustedResolution) {
      if (existing.fenceId !== fenceId) throw profileError('PROFILE_FENCE_STALE', 'Resolution fence does not match the indeterminate action');
    } else if (!issued || issued.uses < 1 || issued.proof.fenceEpoch !== fenceEpoch || issued.proof.leaseBindingDigest !== leaseBindingDigest) {
      throw profileError('PROFILE_FENCE_STALE', 'Action fence is not currently issued');
    }
    try { await this._authoritativeLeaseActions(lease); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code }); }
    const nextOutcomes = { prepared: new Set(['dispatched']), dispatched: new Set(['confirmed', 'failed-known', 'indeterminate']), indeterminate: new Set(['failed-known']) };
    if (existing && existing.outcome !== outcome && !trustedResolution && !nextOutcomes[existing.outcome]?.has(outcome)) throw profileError('PROFILE_TRANSITION_INVALID', 'Action journal outcome order is invalid');
    if (!existing && outcome !== 'prepared') throw profileError('PROFILE_TRANSITION_INVALID', 'Action journal must begin prepared');
    let revokeStatus = 'none';
    if (outcome === 'indeterminate') {
      revokeStatus = (await this._revokeGrants(lease)) ? 'revoked' : 'failed';
    } else if (trustedResolution) {
      if (typeof this.actionResolutionAuthorizer !== 'function') throw profileError('PROFILE_RECLAIM_UNSAFE', 'Unresolved action requires trusted resolution');
      const trusted = await this.actionResolutionAuthorizer({ leaseId, actionId, outcome, fenceId, fenceEpoch, leaseBindingDigest, bindingId, bindingDigest, runId, runnerClaimDigest, capability: resolution.capability });
      if (!trusted || trusted.authorized !== true) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Trusted action resolution was not authorized');
      if (!(await this._revokeGrants(lease))) throw profileError('PROFILE_DEPENDENT_GRANT_REVOKE_FAILED', 'Dependent grant revocation did not complete');
      revokeStatus = 'revoked';
    }
    return this.repository.transact((state) => {
      const current = this._assertLeaseFacts(state, { leaseId, fenceEpoch, leaseBindingDigest, bindingId, bindingDigest, runId, runnerClaimDigest });
      if (bindingDigest !== current.bindingDigest) throw profileError('PROFILE_BINDING_STALE', 'Action binding is stale');
      const resource = state.resources[current.physicalResourceId];
      const prior = current.actionJournal?.find((entry) => entry.actionId === actionId);
      current.actionJournal = (current.actionJournal || []).filter((entry) => entry.actionId !== actionId);
      current.actionJournal.push({ actionId, fenceId, outcome, at: nowIso(this.clock()), actionKind: typeof actionKind === 'string' ? actionKind : undefined });
      if (current.actionJournal.length > 64) current.actionJournal.shift();
      if (outcome !== 'indeterminate') return { leaseId, actionId, outcome };
      const priorState = resource.state;
      const priorEpoch = resource.fenceEpoch;
      const newEpoch = priorEpoch + 1;
      transition(resource, 'quarantined', 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', nowIso(this.clock()));
      resource.fenceEpoch = newEpoch;
      resource.needsReconciliation = true;
      resource.livenessSummary = 'unknown';
      current.state = 'quarantined';
      current.fenceEpoch = newEpoch;
      current.leaseBindingDigest = computeLeaseBindingDigest({ claimDigest: current.runnerClaimDigest, bindingDigest: current.bindingDigest, physicalResourceId: current.physicalResourceId, fenceEpoch: newEpoch });
      current.fences = {};
      current.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId, bindingDigest: current.bindingDigest, fenceEpoch: newEpoch, reasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE' });
      resource.recoveryPlanDigest = current.recoveryPlanDigest;
      const receipt = buildRecoveryReceipt({
        leaseId, profileAlias: current.profileAlias, bindingId: current.bindingId, bindingRevision: current.bindingRevision,
        bindingDigest: current.bindingDigest, runId: current.runId, priorState, newState: 'quarantined', priorFenceEpoch: priorEpoch,
        newFenceEpoch: newEpoch, reasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', lastActionOutcome: 'indeterminate',
        dependentGrantRevokeStatus: revokeStatus, probeOutcomes: { governorHealth: 'healthy', runnerClaim: 'unknown', browserAlive: true, extensionConnected: true, dependentGrantsRevoked: revokeStatus === 'revoked' },
        authorityKind: 'governor-automatic', createdAt: nowIso(this.clock()),
      });
      state.receipts.push(receipt);
      if (state.receipts.length > 128) state.receipts.splice(0, state.receipts.length - 128);
      appendEvent(state, { leaseId, profileAlias: current.profileAlias, state: 'quarantined', stateReasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', fenceEpoch: newEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: nowIso(this.clock()), leaseBindingDigest: current.leaseBindingDigest, livenessSummary: 'unknown', grantRevokeStatus: revokeStatus });
      return receipt;
    });
  }

  async recover(profileAlias, options = {}) {
    if (options?.authenticatedLocalCapability !== true || typeof this.recoveryAuthorizer !== 'function') throw profileError('PROFILE_IPC_AUTH', 'Trusted recovery authorization is required');
    const resolved = await this._resolve(profileAlias);
    const state = this.repository.read();
    const resource = state.resources[resolved.physicalResourceId];
    const leaseId = resource?.currentLeaseId;
    if (!leaseId) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery requires a durable current lease');
    const lease = state.leases[leaseId];
    if (lease.actionJournal?.some((entry) => entry.outcome === 'indeterminate')) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery requires durable resolution of indeterminate actions');
    await this._currentBinding(lease);
    const trusted = await this.recoveryAuthorizer({ profileAlias, physicalResourceId: resolved.physicalResourceId, leaseId, state: resource.state, fenceEpoch: resource.fenceEpoch, bindingDigest: lease.bindingDigest, recoveryPlanDigest: resource.recoveryPlanDigest, indeterminateResolved: !lease.actionJournal?.some((entry) => entry.outcome === 'indeterminate'), capability: options.capability });
    if (!trusted || trusted.authorized !== true || !trusted.evidence) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Trusted recovery evidence is insufficient');
    if (!(await this._revokeGrants(lease))) throw profileError('PROFILE_DEPENDENT_GRANT_REVOKE_FAILED', 'Dependent grant revocation did not complete');
    return applyEvidenceRecovery(this.repository, { physicalResourceId: resolved.physicalResourceId, leaseId, evidence: trusted.evidence, trustedAuthorization: true, reasonCode: 'RECOVERY_OPERATOR_RECONCILE', now: nowIso(this.clock()) });
  }

  async detectExternalUse(profileAlias) {
    const resolved = await this._resolve(profileAlias);
    const live = await this._live({ profileAlias, physicalResourceId: resolved.physicalResourceId });
    return this.repository.transact((state) => {
      const resource = state.resources[resolved.physicalResourceId];
      if (!resource) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Profile requires initial reconciliation');
      if (live.externalUse && !resource.currentLeaseId) {
        transition(resource, 'external_use', 'PROFILE_EXTERNAL_USE', nowIso(this.clock()));
        resource.needsReconciliation = true;
      }
      return redactResource(resource);
    });
  }

  async transition(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw profileError('PROFILE_REQUEST_INVALID', 'Governor transition input is invalid');
    const allowedFields = new Set(['leaseId', 'fenceEpoch', 'leaseBindingDigest', 'bindingId', 'bindingDigest', 'runId', 'runnerClaimDigest', 'to', 'reasonCode']);
    if (Object.keys(input).some((key) => !allowedFields.has(key))) throw profileError('PROFILE_REQUEST_INVALID', 'Governor transition input contains an unknown field');
    const reasons = { auth_required: 'PROFILE_AUTH_REQUIRED', challenge: 'PROFILE_CHALLENGE_REQUIRED', rate_limited: 'PROFILE_RATE_LIMITED' };
    if (!reasons[input.to] || input.reasonCode !== reasons[input.to]) throw profileError('PROFILE_REQUEST_INVALID', 'Governor transition target is invalid');
    const state = this.repository.read();
    const lease = this._assertLeaseFacts(state, input, { claimRequired: true });
    try { await this._authoritativeLeaseActions(lease); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code }); }
    return this.repository.transact((next) => {
      const current = this._assertLeaseFacts(next, input, { claimRequired: true });
      const resource = next.resources[current.physicalResourceId];
      if (!['leased', 'active'].includes(current.state) || resource.currentLeaseId !== current.leaseId) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Governor transition requires an active lease');
      transition(current, input.to, input.reasonCode, nowIso(this.clock()));
      transition(resource, input.to, input.reasonCode, nowIso(this.clock()));
      resource.needsReconciliation = true;
      appendEvent(next, { leaseId: current.leaseId, profileAlias: current.profileAlias, state: input.to, stateReasonCode: input.reasonCode, fenceEpoch: current.fenceEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: nowIso(this.clock()), leaseBindingDigest: current.leaseBindingDigest, livenessSummary: resource.livenessSummary, grantRevokeStatus: 'none' });
      return redactResource(resource);
    });
  }

  async externalRelease(input) { return this.release(input); }

  async getResourceProjection(profileAlias) {
    const resolved = await this._resolve(profileAlias);
    const resource = this.repository.read().resources[resolved.physicalResourceId];
    if (!resource) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Profile resource has not been reconciled');
    return redactResource(resource);
  }

  listEvents() { return listRedactedEvents(this.repository.read()); }
  listRecoveryReceipts() { return listRecoveryReceipts(this.repository.read()); }
}

export { buildRecoveryReceipt, digestLf };

export const GovernorLeaseService = ProfileGovernor;
export const createProfileGovernor = (options) => new ProfileGovernor(options);
