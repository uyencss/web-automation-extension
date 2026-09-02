import { randomBytes } from 'node:crypto';
import { computeFenceDigest, computeLeaseBindingDigest, digestLf, opaqueId, redactLease, redactResource, requestFingerprint, SCHEMAS, stableStringify, validateActionFence, validateActionRecordInput, validateCreateFenceInput, validateLeaseControlInput, validateLeaseRequest, validateOpenTabInput, validateTransitionInput } from './contracts.mjs';
import { profileError } from './errors.mjs';
import { appendEvent, EVENT_REASONS, listRedactedEvents } from './events.mjs';
import { reconcileResource, assertReconciliationForAcquire } from './reconciliation.mjs';
import { applyEvidenceRecovery, assertSafeExternalRecoveryEvidence, assertSafeRecoveryEvidence, buildRecoveryReceipt, computeExternalRecoveryEvidenceDigest, computeRecoveryPlanDigest, listRecoveryReceipts } from './recovery.mjs';
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

function validateProfileAlias(profileAlias) {
  if (typeof profileAlias !== 'string' || profileAlias.length < 2 || profileAlias.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profileAlias)) throw profileError('PROFILE_REQUEST_INVALID', 'profileAlias is invalid');
  return profileAlias;
}

function eventReason(reasonCode) {
  if (EVENT_REASONS.has(reasonCode)) return reasonCode;
  if (['PROFILE_CLAIM_INVALID', 'PROFILE_BINDING_STALE'].includes(reasonCode)) return 'PROFILE_LEASE_REVOKED';
  if (reasonCode === 'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED') return 'PROFILE_RECLAIM_UNSAFE';
  return 'LIVENESS_UNKNOWN';
}

function safeBinding(resolved, request) {
  if (!resolved || typeof resolved.physicalResourceId !== 'string' || resolved.physicalResourceId.length < 2 || resolved.physicalResourceId.length > 512) throw profileError('PROFILE_BINDING_STALE', 'Registry did not resolve a physical resource');
  if (resolved.bindingId !== request.bindingId || resolved.bindingRevision !== request.bindingRevision || resolved.bindingDigest !== request.bindingDigest) throw profileError('PROFILE_BINDING_STALE', 'Registry binding does not match the admission pin');
  return resolved;
}

function requireActionLiveness(live) {
  if (live.externalUse) throw profileError('PROFILE_EXTERNAL_USE', 'Profile resource is in external use');
  if (live.lifecycleCode) throw profileError(live.lifecycleCode, 'Profile action lifecycle gate is active');
  if (live.summary !== 'healthy' || live.indeterminate || live.browserAlive !== true || live.extensionConnected !== true) throw profileError('PROFILE_LIVENESS_UNKNOWN', 'Composite action liveness is not healthy');
  return live;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertAuthorizerResult(result, allowedKeys, label = 'Authorization result', code = 'PROFILE_RECLAIM_UNSAFE') {
  if (!isPlainObject(result)) {
    throw profileError(code, `${label} must be a plain object`);
  }
  const unknown = Object.keys(result).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw profileError(code, `${label} contains an unknown field`);
  }
  if (result.authorized !== true) {
    throw profileError(code, `${label} was not granted`);
  }
  return result;
}

function isExternalRecoveryResource(resource, lease) {
  return resource?.state === 'external_use' || resource?.recoverySubjectKind === 'unregistered-external' || resource?.recoverySubjectKind === 'registered-external' || lease?.ownerType === 'external';
}

function assertExternalRecoveryBlocked(resource, lease) {
  if (isExternalRecoveryResource(resource, lease)) throw profileError('PROFILE_RECLAIM_UNSAFE', 'External-use resource cannot be released or reclaimed through the ordinary lifecycle');
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
    validateProfileAlias(profileAlias);
    const result = await resolveMethod(this.registry, 'resolve')(profileAlias);
    if (!result || typeof result !== 'object') throw profileError('PROFILE_BINDING_STALE', 'Registry resolution is unavailable');
    const resolved = result.physicalResourceId === undefined ? { ...result, physicalResourceId: result.resourceId ?? result.profileResourceId } : result;
    if (typeof resolved.physicalResourceId !== 'string' || !/^prsc_[a-zA-Z0-9._-]{2,512}$/.test(resolved.physicalResourceId) || typeof resolved.bindingId !== 'string' || !/^pb_[a-z0-9-]+$/.test(resolved.bindingId) || !Number.isInteger(resolved.bindingRevision) || resolved.bindingRevision < 1 || typeof resolved.bindingDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(resolved.bindingDigest) || !Array.isArray(resolved.allowedActions) || resolved.allowedActions.length < 1 || resolved.allowedActions.some((action) => !['browser-read', 'browser-write', 'browser-session-data', 'credential-fill'].includes(action))) throw profileError('PROFILE_BINDING_STALE', 'Registry resolution is not authoritative');
    return resolved;
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

  async _establishRevocationBarrier(lease, { reasonCode = 'PROFILE_CLAIM_INVALID', grantRevokeStatus = 'pending', livenessSummary = 'unknown' } = {}) {
    const isExt = lease?.ownerType === 'external';
    const revoked = isExt || grantRevokeStatus === 'revoked' || (grantRevokeStatus === 'pending' && await this._revokeGrants(lease));
    this.repository.transact((state) => {
      const current = state.leases[lease.leaseId];
      const resource = current && state.resources[current.physicalResourceId];
      if (!current || !resource || resource.currentLeaseId !== current.leaseId) return;
      if (isExternalRecoveryResource(resource, current)) {
        resource.needsReconciliation = true;
        resource.livenessSummary = livenessSummary;
        return;
      }
      const mutationNow = this.clock();
      const mutationNowIso = nowIso(mutationNow);
      const priorEpoch = resource.fenceEpoch;
      if (resource.state !== 'quarantined') transition(resource, 'quarantined', reasonCode, mutationNowIso);
      resource.fenceEpoch = priorEpoch + 1;
      resource.needsReconciliation = true;
      resource.livenessSummary = livenessSummary;
      current.state = 'quarantined';
      current.fenceEpoch = resource.fenceEpoch;
      current.leaseBindingDigest = computeLeaseBindingDigest({ claimDigest: current.runnerClaimDigest, bindingDigest: current.bindingDigest, physicalResourceId: current.physicalResourceId, fenceEpoch: current.fenceEpoch, profileAlias: current.profileAlias });
      current.fences = {};
      current.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId: current.leaseId, bindingDigest: current.bindingDigest, fenceEpoch: current.fenceEpoch, reasonCode });
      resource.recoveryPlanDigest = current.recoveryPlanDigest;
      appendEvent(state, { leaseId: current.leaseId, profileAlias: current.profileAlias, state: 'quarantined', stateReasonCode: eventReason(reasonCode), fenceEpoch: current.fenceEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: mutationNowIso, leaseBindingDigest: current.leaseBindingDigest, livenessSummary, grantRevokeStatus: revoked ? 'revoked' : 'failed' });
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

  _prepareExternalRecovery(resource, resolved, state) {
    if (!resource || resource.state !== 'external_use') return;
    const currentLease = resource.currentLeaseId && state ? state.leases[resource.currentLeaseId] : null;

    if (currentLease && currentLease.ownerType === 'automation') {
      resource.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId: currentLease.leaseId, bindingDigest: currentLease.bindingDigest, fenceEpoch: resource.fenceEpoch, reasonCode: 'PROFILE_EXTERNAL_USE' });
      currentLease.recoveryPlanDigest = resource.recoveryPlanDigest;
      return;
    }

    if (!resource.recoverySubjectKind) {
      resource.recoverySubjectKind = currentLease?.ownerType === 'external' ? 'registered-external' : 'unregistered-external';
    }
    if (resource.recoveryBindingId === undefined) {
      resource.recoveryBindingId = currentLease ? currentLease.bindingId : resolved.bindingId;
      resource.recoveryBindingRevision = currentLease ? currentLease.bindingRevision : resolved.bindingRevision;
      resource.recoveryBindingDigest = currentLease ? currentLease.bindingDigest : resolved.bindingDigest;
    }
    if (resolved && (resource.recoveryBindingId !== resolved.bindingId || resource.recoveryBindingRevision !== resolved.bindingRevision || resource.recoveryBindingDigest !== resolved.bindingDigest)) {
      throw profileError('PROFILE_BINDING_STALE', 'Registry binding does not match durable external recovery tuple');
    }
    if (!resource.currentLeaseId && state) {
      const now = this.clock();
      const leaseId = opaqueId('lease');
      const epoch = resource.fenceEpoch === 0 ? 1 : resource.fenceEpoch;
      resource.fenceEpoch = epoch;
      const claimDigest = digestLf('webmcp-digest-v1:claim', { ownerType: 'external', physicalResourceId: resolved.physicalResourceId, profileAlias: resource.profileAlias });
      const leaseBindingDigest = computeLeaseBindingDigest({ claimDigest, bindingDigest: resource.recoveryBindingDigest, physicalResourceId: resolved.physicalResourceId, fenceEpoch: epoch, profileAlias: resource.profileAlias });
      const lease = {
        leaseId, physicalResourceId: resolved.physicalResourceId, profileAlias: resource.profileAlias,
        bindingId: resource.recoveryBindingId, bindingRevision: resource.recoveryBindingRevision, bindingDigest: resource.recoveryBindingDigest,
        runId: `run_external-${resource.profileAlias}`, runnerClaimDigest: claimDigest, leaseMode: 'single-context',
        fenceEpoch: epoch, leaseBindingDigest,
        state: 'external_use', issuedAt: nowIso(now),
        expiresAt: nowIso(now + 120000), heartbeatIntervalMs: 30000,
        leaseTtlMs: 120000, nodeId: 'node-external', ownerType: 'external',
        idempotencyKey: `idemp-ext-${leaseId}`, fingerprint: stableStringify({ ownerType: 'external', physicalResourceId: resolved.physicalResourceId }),
        requestedActions: [...resolved.allowedActions], allowedActions: [...resolved.allowedActions],
        tabs: {}, maxTabs: this.maxTabs, actionUses: 0, actionJournal: [], fences: {},
      };
      state.leases[leaseId] = lease;
      resource.currentLeaseId = leaseId;
      appendEvent(state, {
        leaseId, profileAlias: resource.profileAlias, state: 'external_use', stateReasonCode: 'PROFILE_EXTERNAL_USE',
        fenceEpoch: epoch, bindingDigest: resource.recoveryBindingDigest, bindingId: resource.recoveryBindingId, runId: lease.runId,
        timestamp: lease.issuedAt, leaseBindingDigest, livenessSummary: resource.livenessSummary, grantRevokeStatus: 'none',
      });
    }
    const activeLease = resource.currentLeaseId && state ? state.leases[resource.currentLeaseId] : null;
    if (activeLease) {
      resource.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId: activeLease.leaseId, bindingDigest: activeLease.bindingDigest, fenceEpoch: resource.fenceEpoch, reasonCode: 'PROFILE_EXTERNAL_USE' });
      activeLease.recoveryPlanDigest = resource.recoveryPlanDigest;
    }
  }

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
      if (isExternalRecoveryResource(resource, lease)) {
        const expectedBindingId = resource.recoveryBindingId || lease?.bindingId;
        const expectedBindingRevision = resource.recoveryBindingRevision || lease?.bindingRevision;
        const expectedBindingDigest = resource.recoveryBindingDigest || lease?.bindingDigest;
        if (expectedBindingId !== undefined && (resolved.bindingId !== expectedBindingId || resolved.bindingRevision !== expectedBindingRevision || resolved.bindingDigest !== expectedBindingDigest)) {
          throw profileError('PROFILE_BINDING_STALE', 'Registry binding does not match durable external recovery tuple');
        }
      }
      reconcileResource(resource, { liveness, hasCurrentLease: Boolean(lease), now: nowIso(this.clock()) });
      this._prepareExternalRecovery(resource, resolved, state);
      if (lease && !isExternalRecoveryResource(resource, lease) && (liveness.summary === 'failed' || liveness.indeterminate) && resource.state !== 'quarantined') {
        const mutationNow = this.clock();
        const mutationNowIso = nowIso(mutationNow);
        const priorState = lease.state;
        const priorEpoch = resource.fenceEpoch;
        const newEpoch = priorEpoch + 1;
        transition(resource, 'quarantined', 'PROFILE_RECLAIM_UNSAFE', mutationNowIso);
        resource.fenceEpoch = newEpoch;
        resource.needsReconciliation = true;
        resource.livenessSummary = liveness.summary;
        resource.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId: lease.leaseId, bindingDigest: lease.bindingDigest, fenceEpoch: newEpoch, reasonCode: 'PROFILE_RECLAIM_UNSAFE' });
        lease.state = 'quarantined';
        lease.fenceEpoch = newEpoch;
        lease.leaseBindingDigest = computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: lease.physicalResourceId, fenceEpoch: newEpoch, profileAlias: lease.profileAlias });
        lease.fences = {};
        lease.recoveryPlanDigest = resource.recoveryPlanDigest;
        const event = appendEvent(state, {
          leaseId: lease.leaseId, profileAlias: lease.profileAlias, state: 'quarantined', stateReasonCode: 'PROFILE_QUARANTINED',
          fenceEpoch: newEpoch, bindingDigest: lease.bindingDigest, bindingId: lease.bindingId, runId: lease.runId,
          timestamp: mutationNowIso, leaseBindingDigest: lease.leaseBindingDigest, livenessSummary: liveness.summary,
          grantRevokeStatus: 'pending',
        });
        const receipt = buildRecoveryReceipt({
          leaseId: lease.leaseId, profileAlias: lease.profileAlias, bindingId: lease.bindingId, bindingRevision: lease.bindingRevision,
          bindingDigest: lease.bindingDigest, runId: lease.runId, priorState, newState: 'quarantined', priorFenceEpoch: priorEpoch,
          newFenceEpoch: newEpoch, reasonCode: 'PROFILE_RECLAIM_UNSAFE', lastActionOutcome: 'none',
          dependentGrantRevokeStatus: 'pending',
          probeOutcomes: {
            governorHealth: liveness.probes?.governor || 'unknown',
            runnerClaim: ['active', 'terminal', 'revoked'].includes(liveness.probes?.runnerClaim) ? liveness.probes.runnerClaim : 'unknown',
            browserAlive: liveness.browserAlive === true,
            extensionConnected: liveness.extensionConnected === true,
            dependentGrantsRevoked: false,
            registryCurrent: liveness.probes?.registry === 'healthy',
          },
          authorityKind: 'governor-automatic', createdAt: mutationNowIso,
          eventId: event.eventId,
        });
        state.receipts.push(receipt);
        if (state.receipts.length > 128) state.receipts.splice(0, state.receipts.length - 128);
      }
      return redactResource(resource);
    });
  }

  async reconcileAll() {
    const state = this.repository.read();
    const aliases = Object.values(state.resources).flatMap((resource) => resource.aliases || [resource.profileAlias]);
    return Promise.all(aliases.map((alias) => this.reconcileProfile(alias)));
  }

  async acquire(input, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !['authenticatedLocalCapability', 'capability'].includes(key))) throw profileError('PROFILE_REQUEST_INVALID', 'Acquire options are invalid');
    const { authenticatedLocalCapability = false } = options;
    const request = validateLeaseRequest(input, { requireRequestedActions: true });
    if (request.ownerType === 'external' && !authenticatedLocalCapability) throw profileError('PROFILE_IPC_AUTH', 'Authenticated local capability is required for external ownership');
    const resolved = safeBinding(await this._resolve(request.profileAlias), request);
    const { allowedActions: allowed } = await this._authoritativeActions(request, resolved);
    if (request.ownerType === 'automation') {
      let live;
      try { live = await this._live({ profileAlias: request.profileAlias, physicalResourceId: resolved.physicalResourceId }); requireActionLiveness(live); } catch (error) {
        this.repository.transact((state) => {
          const resource = this._findResource(state, resolved.physicalResourceId);
          if (resource) {
            if (resource.state !== 'unknown' && resource.state !== 'quarantined') {
              transition(resource, error.code === 'PROFILE_EXTERNAL_USE' ? 'external_use' : 'unknown', error.code, nowIso(this.clock()));
            }
            resource.needsReconciliation = true;
            resource.livenessSummary = live?.summary || 'unknown';
            if (error.code === 'PROFILE_EXTERNAL_USE') {
              this._prepareExternalRecovery(resource, resolved, state);
            }
          }
        });
        throw error;
      }
    }
    const fingerprint = requestFingerprint(request);
    return this.repository.transact((state) => {
      const now = this.clock();
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
        fenceEpoch: epoch, leaseBindingDigest: computeLeaseBindingDigest({ claimDigest: request.runnerClaimDigest, bindingDigest: request.bindingDigest, physicalResourceId: resolved.physicalResourceId, fenceEpoch: epoch, profileAlias: request.profileAlias }),
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
      if (lease.state === 'external_use') {
        resource.stateReasonCode = 'PROFILE_EXTERNAL_USE';
        resource.recoverySubjectKind = 'registered-external';
        resource.recoveryBindingId = request.bindingId;
        resource.recoveryBindingRevision = request.bindingRevision;
        resource.recoveryBindingDigest = request.bindingDigest;
        resource.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId, bindingDigest: lease.bindingDigest, fenceEpoch: epoch, reasonCode: 'PROFILE_EXTERNAL_USE' });
        lease.recoveryPlanDigest = resource.recoveryPlanDigest;
        appendEvent(state, { leaseId, profileAlias: lease.profileAlias, state: lease.state, stateReasonCode: 'PROFILE_EXTERNAL_USE', fenceEpoch: epoch, bindingDigest: lease.bindingDigest, bindingId: lease.bindingId, runId: lease.runId, timestamp: lease.issuedAt, leaseBindingDigest: lease.leaseBindingDigest, livenessSummary: 'unknown', grantRevokeStatus: 'none' });
      } else {
        delete resource.stateReasonCode;
        delete resource.recoverySubjectKind;
        delete resource.recoveryBindingId;
        delete resource.recoveryBindingRevision;
        delete resource.recoveryBindingDigest;
        delete resource.recoveryPlanDigest;
      }
      resource.needsReconciliation = false;
      const liveSummary = request.ownerType === 'automation' ? 'healthy' : 'unknown';
      resource.livenessSummary = liveSummary;
      return redactLease(lease);
    });
  }

  async openTab(input = {}) {
    input = validateOpenTabInput(input);
    const state = this.repository.read();
    const lease = state.leases[input.leaseId];
    const resource = lease && state.resources[lease.physicalResourceId];
    if (!lease || resource?.currentLeaseId !== lease.leaseId) throw profileError('PROFILE_LEASE_NOT_FOUND', 'Governor lease is not current');
    if (lease.runId !== input.runId) throw profileError('PROFILE_TAB_NOT_OWNED', 'Tab belongs to a different run');
    for (const [key, code] of [['fenceEpoch', 'PROFILE_FENCE_STALE'], ['leaseBindingDigest', 'PROFILE_FENCE_STALE'], ['bindingId', 'PROFILE_BINDING_STALE'], ['bindingDigest', 'PROFILE_BINDING_STALE'], ['runnerClaimDigest', 'PROFILE_CLAIM_INVALID']]) if (input[key] !== undefined && input[key] !== lease[key]) throw profileError(code, 'Tab lease facts are stale');
    if (!['leased', 'active'].includes(lease.state) || !['leased', 'active'].includes(resource.state)) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Tab operation requires an active lease');
    if (Date.parse(lease.expiresAt) <= this.clock()) throw profileError('PROFILE_LEASE_EXPIRED', 'Lease TTL expired; reconciliation is required');
    try { await this._authoritativeLeaseActions(lease); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code }); }
    let live;
    try { live = await this._live({ leaseId: lease.leaseId, profileAlias: lease.profileAlias }); requireActionLiveness(live); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code, livenessSummary: live?.summary }); }
    const expected = { leaseId: lease.leaseId, fenceEpoch: input.fenceEpoch ?? lease.fenceEpoch, leaseBindingDigest: input.leaseBindingDigest ?? lease.leaseBindingDigest, runId: input.runId };
    return this.repository.transact((next) => {
      const mutationNow = this.clock();
      const current = this._assertLeaseFacts(next, expected, { claimRequired: true });
      const currentResource = next.resources[current.physicalResourceId];
      if (!['leased', 'active'].includes(current.state) || !['leased', 'active'].includes(currentResource.state)) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Tab operation requires an active lease');
      if (Date.parse(current.expiresAt) <= mutationNow) throw profileError('PROFILE_LEASE_EXPIRED', 'Lease TTL expired; reconciliation is required');
      if (Object.keys(current.tabs).length >= current.maxTabs) throw profileError('PROFILE_TAB_LIMIT', 'Lease tab limit is exhausted');
      const tabHandle = `tab_${randomBytes(10).toString('hex')}`;
      current.tabs[tabHandle] = { runId: current.runId, createdAt: nowIso(mutationNow) };
      return { tabHandle, leaseId: current.leaseId, fenceEpoch: current.fenceEpoch };
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
    input = validateLeaseControlInput(input, { allowNow: true });
    const initialNow = this.clock();
    const state = this.repository.read();
    const lease = this._assertLeaseFacts(state, input, { claimRequired: true });
    const initialResource = state.resources[lease.physicalResourceId];
    if (initialNow >= Date.parse(lease.expiresAt)) {
      if (!isExternalRecoveryResource(initialResource, lease)) {
        this.repository.transact((next) => {
          const current = next.leases[lease.leaseId];
          const resource = current && next.resources[current.physicalResourceId];
          if (current && resource?.currentLeaseId === current.leaseId && !isExternalRecoveryResource(resource, current)) {
            transition(resource, 'unknown', 'PROFILE_LEASE_EXPIRED', nowIso(initialNow));
            resource.needsReconciliation = true;
            resource.livenessSummary = 'unknown';
          }
        });
      }
      throw profileError('PROFILE_LEASE_EXPIRED', 'Lease TTL expired; reconciliation is required');
    }
    try { await this._authoritativeLeaseActions(lease); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code }); }
    let live;
    try { live = await this._live({ leaseId: lease.leaseId, profileAlias: lease.profileAlias }); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code || 'PROFILE_LIVENESS_UNKNOWN' }); }
    try { requireActionLiveness(live); } catch (error) { await this._barrierOnFailure(lease, error, { reasonCode: error.code, livenessSummary: live.summary }); }
    return this.repository.transact((next) => {
      const mutationNow = this.clock();
      const current = this._assertLeaseFacts(next, input, { claimRequired: true });
      const resource = next.resources[current.physicalResourceId];
      if (mutationNow >= Date.parse(current.expiresAt)) {
        if (resource && resource.currentLeaseId === current.leaseId && !isExternalRecoveryResource(resource, current)) {
          transition(resource, 'unknown', 'PROFILE_LEASE_EXPIRED', nowIso(mutationNow));
          resource.needsReconciliation = true;
          resource.livenessSummary = live.summary;
        }
        throw profileError('PROFILE_LEASE_EXPIRED', 'Lease TTL expired; reconciliation is required');
      }
      current.expiresAt = nowIso(mutationNow + current.leaseTtlMs);
      current.heartbeatCount = (current.heartbeatCount || 0) + 1;
      appendEvent(next, { leaseId: current.leaseId, profileAlias: current.profileAlias, state: current.state, stateReasonCode: 'HEARTBEAT_OK', fenceEpoch: current.fenceEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: nowIso(mutationNow), leaseBindingDigest: current.leaseBindingDigest, counts: { heartbeats: current.heartbeatCount }, livenessSummary: live.summary, grantRevokeStatus: 'none' });
      return redactLease(current);
    });
  }

  renew(input) { return this.heartbeat(input); }

  async release(input = {}) {
    input = validateLeaseControlInput(input);
    const state = this.repository.read();
    const lease = state.leases[input.leaseId];
    if (!lease || state.resources[lease.physicalResourceId]?.currentLeaseId !== lease.leaseId) return { released: false };
    const resource = state.resources[lease.physicalResourceId];
    assertExternalRecoveryBlocked(resource, lease);
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
      const mutationNow = this.clock();
      const mutationNowIso = nowIso(mutationNow);
      const current = next.leases[lease.leaseId];
      if (!current) return { released: false };
      const resource = next.resources[current.physicalResourceId];
      if (!resource || resource.currentLeaseId !== current.leaseId || current.fenceEpoch !== input.fenceEpoch || current.leaseBindingDigest !== input.leaseBindingDigest) return { released: false };
      current.state = 'cooldown';
      current.releasedAt = mutationNowIso;
      resource.currentLeaseId = null;
      resource.state = 'cooldown';
      resource.stateReasonCode = 'PROFILE_RELEASE';
      resource.cooldownUntil = nowIso(mutationNow + this.cooldownMs);
      resource.needsReconciliation = true;
      resource.livenessSummary = live?.summary || 'unknown';
      appendEvent(next, { leaseId: current.leaseId, profileAlias: current.profileAlias, state: 'cooldown', stateReasonCode: 'PROFILE_RELEASE', fenceEpoch: current.fenceEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: current.releasedAt, leaseBindingDigest: current.leaseBindingDigest, livenessSummary: live?.summary || 'unknown', grantRevokeStatus: 'revoked' });
      return { released: true, leaseId: current.leaseId, state: 'cooldown' };
    });
  }

  _fenceScope(input, tabHandle, profileAlias) {
    const scope = { profileAlias: profileAlias || input.profileAlias, actions: [input.action] };
    if (tabHandle !== undefined) scope.tabHandle = tabHandle;
    return scope;
  }

  async createFence(input = {}) {
    input = validateCreateFenceInput(input);
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
    return this.repository.transact((next) => {
      const mutationNow = this.clock();
      const mutationNowIso = nowIso(mutationNow);
      const current = this._assertLeaseFacts(next, input, { claimRequired: true });
      const currentResource = next.resources[current.physicalResourceId];
      if (!['leased', 'active'].includes(currentResource.state)) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Profile resource requires reconciliation');
      if (Date.parse(current.expiresAt) <= mutationNow) throw profileError('PROFILE_LEASE_EXPIRED', 'Lease TTL expired; reconciliation is required');
      if (current.actionUses >= this.maxFenceUses) throw profileError('PROFILE_FENCE_STALE', 'Fence use limit is exhausted');
      if (current.state === 'leased') {
        transition(current, 'active', undefined, mutationNowIso);
        transition(currentResource, 'active', undefined, mutationNowIso);
      }
      current.actionUses += 1;
      const scope = this._fenceScope(input, input.tabHandle, current.profileAlias);
      const issuedAt = mutationNowIso;
      const ttlMs = Math.min(current.leaseTtlMs, 300000);
      const expiresAt = nowIso(mutationNow + ttlMs);
      const proof = { schema: SCHEMAS.fence, fenceId: opaqueId('fence'), leaseId: current.leaseId, fenceEpoch: current.fenceEpoch, leaseBindingDigest: current.leaseBindingDigest, runId: current.runId, bindingId: current.bindingId, purpose: input.purpose || 'browser-action', scope, ttlMs, maxUses: this.maxFenceUses, issuedAt, expiresAt };
      proof.fenceDigest = computeFenceDigest({ ...proof });
      if (ACTION_KIND.has(input.actionKind)) proof.actionKind = input.actionKind;
      current.fences = current.fences || {};
      current.fences[proof.fenceId] = { proof: { ...proof }, uses: 0 };
      return proof;
    });
  }

  async authorizeFence(proof) {
    if (!proof) throw profileError('PROFILE_FENCE_REQUIRED', 'A current action fence is required');
    proof = validateActionFence(proof);
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
      const mutationNow = this.clock();
      const current = this._assertLeaseFacts(next, proof);
      const currentResource = next.resources[current.physicalResourceId];
      if (!['leased', 'active'].includes(currentResource.state)) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Profile resource requires reconciliation');
      const authoritative = current.fences?.[proof.fenceId];
      if (!authoritative || stableStringify(authoritative.proof) !== stableStringify(proof)) throw profileError('PROFILE_FENCE_STALE', 'Fence facts are not the issued authoritative proof');
      if (Date.parse(current.expiresAt) <= mutationNow || Date.parse(proof.expiresAt) <= mutationNow) throw profileError('PROFILE_FENCE_STALE', 'Fence or lease has expired');
      if (authoritative.uses >= authoritative.proof.maxUses) throw profileError('PROFILE_FENCE_STALE', 'Fence use limit is exhausted');
      authoritative.uses += 1;
      return { authorized: true, actionDispatch: 'local-authority-approved' };
    });
  }

  async recordAction(input = {}) {
    input = validateActionRecordInput(input);
    const { leaseId, actionId, outcome, fenceId, fenceEpoch, leaseBindingDigest, bindingId, bindingDigest, runId, runnerClaimDigest, resolution, actionKind } = input;
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
      const rawTrusted = await this.actionResolutionAuthorizer({ leaseId, actionId, outcome, fenceId, fenceEpoch, leaseBindingDigest, bindingId, bindingDigest, runId, runnerClaimDigest, capability: resolution.capability });
      assertAuthorizerResult(rawTrusted, new Set(['authorized']), 'Trusted action resolution');
      if (!(await this._revokeGrants(lease))) throw profileError('PROFILE_DEPENDENT_GRANT_REVOKE_FAILED', 'Dependent grant revocation did not complete');
      revokeStatus = 'revoked';
    }
    return this.repository.transact((state) => {
      const mutationNow = this.clock();
      const mutationNowIso = nowIso(mutationNow);
      const current = this._assertLeaseFacts(state, { leaseId, fenceEpoch, leaseBindingDigest, bindingId, bindingDigest, runId, runnerClaimDigest });
      if (bindingDigest !== current.bindingDigest) throw profileError('PROFILE_BINDING_STALE', 'Action binding is stale');
      const resource = state.resources[current.physicalResourceId];
      const prior = current.actionJournal?.find((entry) => entry.actionId === actionId);
      current.actionJournal = (current.actionJournal || []).filter((entry) => entry.actionId !== actionId);
      current.actionJournal.push({ actionId, fenceId, outcome, at: mutationNowIso, actionKind: typeof actionKind === 'string' ? actionKind : undefined });
      if (current.actionJournal.length > 64) current.actionJournal.shift();
      if (outcome !== 'indeterminate') return { leaseId, actionId, outcome };
      const priorState = current.state;
      const priorEpoch = resource.fenceEpoch;
      const newEpoch = priorEpoch + 1;
      transition(resource, 'quarantined', 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', mutationNowIso);
      resource.fenceEpoch = newEpoch;
      resource.needsReconciliation = true;
      resource.livenessSummary = 'unknown';
      current.state = 'quarantined';
      current.fenceEpoch = newEpoch;
      current.leaseBindingDigest = computeLeaseBindingDigest({ claimDigest: current.runnerClaimDigest, bindingDigest: current.bindingDigest, physicalResourceId: current.physicalResourceId, fenceEpoch: newEpoch, profileAlias: current.profileAlias });
      current.fences = {};
      current.recoveryPlanDigest = computeRecoveryPlanDigest({ leaseId, bindingDigest: current.bindingDigest, fenceEpoch: newEpoch, reasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE' });
      resource.recoveryPlanDigest = current.recoveryPlanDigest;
      const event = appendEvent(state, { leaseId, profileAlias: current.profileAlias, state: 'quarantined', stateReasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', fenceEpoch: newEpoch, bindingDigest: current.bindingDigest, bindingId: current.bindingId, runId: current.runId, timestamp: mutationNowIso, leaseBindingDigest: current.leaseBindingDigest, livenessSummary: 'unknown', grantRevokeStatus: revokeStatus });
      const receipt = buildRecoveryReceipt({
        leaseId, profileAlias: current.profileAlias, bindingId: current.bindingId, bindingRevision: current.bindingRevision,
        bindingDigest: current.bindingDigest, runId: current.runId, priorState, newState: 'quarantined', priorFenceEpoch: priorEpoch,
        newFenceEpoch: newEpoch, reasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', lastActionOutcome: 'indeterminate',
        dependentGrantRevokeStatus: revokeStatus,
        probeOutcomes: { governorHealth: 'unknown', runnerClaim: 'unknown', browserAlive: false, extensionConnected: false, dependentGrantsRevoked: revokeStatus === 'revoked' },
        authorityKind: 'governor-automatic', createdAt: mutationNowIso,
        eventId: event.eventId,
      });
      state.receipts.push(receipt);
      if (state.receipts.length > 128) state.receipts.splice(0, state.receipts.length - 128);
      return receipt;
    });
  }

  async recover(profileAlias, options = {}) {
    validateProfileAlias(profileAlias);
    if (options?.authenticatedLocalCapability !== true || typeof this.recoveryAuthorizer !== 'function') throw profileError('PROFILE_IPC_AUTH', 'Trusted recovery authorization is required');
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !['authenticatedLocalCapability', 'capability'].includes(key))) throw profileError('PROFILE_REQUEST_INVALID', 'Recovery options are invalid');
    const initialState = this.repository.read();
    const initialResources = Object.values(initialState.resources).filter((candidate) => candidate.profileAlias === profileAlias || candidate.aliases?.includes(profileAlias));
    if (initialResources.length > 1) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery profile alias is ambiguously bound to multiple durable resources');
    const initialResource = initialResources[0];
    if (!initialResource) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery requires a durable resource barrier');
    const initialLease = initialResource.currentLeaseId ? initialState.leases[initialResource.currentLeaseId] : null;
    assertExternalRecoveryBlocked(initialResource, initialLease);
    const resolved = await this._resolve(profileAlias);
    const state = this.repository.read();
    const resource = state.resources[resolved.physicalResourceId];
    if (!resource) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery requires a durable resource barrier');
    const leaseId = resource.currentLeaseId;
    if (!leaseId) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery requires a durable owner barrier');
    const lease = state.leases[leaseId];
    assertExternalRecoveryBlocked(resource, lease);
    if (lease.actionJournal?.some((entry) => entry.outcome === 'indeterminate')) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery requires durable resolution of indeterminate actions');
    await this._currentBinding(lease);
    const rawTrusted = await this.recoveryAuthorizer({ profileAlias, physicalResourceId: resolved.physicalResourceId, leaseId, state: resource.state, fenceEpoch: resource.fenceEpoch, bindingDigest: lease.bindingDigest, recoveryPlanDigest: resource.recoveryPlanDigest, indeterminateResolved: !lease.actionJournal?.some((entry) => entry.outcome === 'indeterminate'), capability: options.capability });
    const trusted = assertAuthorizerResult(rawTrusted, new Set(['authorized', 'evidence']), 'Trusted recovery authorization');
    if (!isPlainObject(trusted.evidence)) throw profileError('PROFILE_RECLAIM_UNSAFE', 'Recovery evidence is invalid');
    if (resource.state === 'external_use' || trusted.evidence?.expectedState === 'external_use') {
      if (resource.state === 'external_use') {
        assertSafeExternalRecoveryEvidence(trusted.evidence);
      }
      throw profileError('PROFILE_RECLAIM_UNSAFE', 'External-use recovery is contract-blocked until receipt contract binds evidence digest');
    }
    assertSafeRecoveryEvidence(trusted.evidence);
    if (!(await this._revokeGrants(lease))) throw profileError('PROFILE_DEPENDENT_GRANT_REVOKE_FAILED', 'Dependent grant revocation did not complete');
    let live;
    try { live = await this._live({ profileAlias, physicalResourceId: resolved.physicalResourceId }); } catch { live = null; }
    const safeRunnerClaim = (claim) => (['active', 'terminal', 'revoked'].includes(claim) ? claim : 'unknown');
    const probeOutcomes = {
      governorHealth: live?.probes?.governor || 'unknown',
      runnerClaim: safeRunnerClaim(trusted.evidence.runnerClaim),
      browserAlive: trusted.evidence.browserAlive === true || live?.browserAlive === true,
      extensionConnected: trusted.evidence.extensionConnected === true || live?.extensionConnected === true,
      dependentGrantsRevoked: trusted.evidence.dependentGrantsRevoked ?? true,
      registryCurrent: trusted.evidence.registryCurrent ?? (live?.probes?.registry === 'healthy'),
    };
    const livenessSummary = live?.summary || 'unknown';
    const reasonCode = 'RECOVERY_OPERATOR_RECONCILE';
    const result = applyEvidenceRecovery(this.repository, { physicalResourceId: resolved.physicalResourceId, leaseId, evidence: trusted.evidence, probeOutcomes, livenessSummary, trustedAuthorization: true, reasonCode, now: nowIso(this.clock()) });
    return {
      ...result,
      recovered: true,
    };
  }

  async detectExternalUse(profileAlias) {
    validateProfileAlias(profileAlias);
    const resolved = await this._resolve(profileAlias);
    const live = await this._live({ profileAlias, physicalResourceId: resolved.physicalResourceId });
    return this.repository.transact((state) => {
      const resource = state.resources[resolved.physicalResourceId];
      if (!resource) throw profileError('PROFILE_GOVERNOR_NOT_READY', 'Profile requires initial reconciliation');
      if (live.externalUse && !resource.currentLeaseId) {
        transition(resource, 'external_use', 'PROFILE_EXTERNAL_USE', nowIso(this.clock()));
        resource.needsReconciliation = true;
        resource.livenessSummary = live.summary;
        this._prepareExternalRecovery(resource, resolved, state);
      }
      return redactResource(resource);
    });
  }

  async transition(input = {}) {
    input = validateTransitionInput(input);
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

  async externalRelease(input = {}) {
    const control = validateLeaseControlInput(input);
    const state = this.repository.read();
    const lease = state.leases[control.leaseId];
    const resource = lease && state.resources[lease.physicalResourceId];
    assertExternalRecoveryBlocked(resource, lease);
    return this.release(control);
  }

  async getResourceProjection(profileAlias) {
    validateProfileAlias(profileAlias);
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
