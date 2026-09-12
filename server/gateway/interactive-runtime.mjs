import { PermitStore } from './permit-store.mjs';
import { GatewayVerifier, readGovernorActiveFence, extractFenceProof, fenceProofEpoch, fenceProofLeaseId, isMutatingAction, fenceScopeAdmitsAction, logFenceDivergence } from './verifier.mjs';
import { TrustedContextChannel } from './trusted-context-channel.mjs';
import { loadDispatcherRouteMap } from './dispatcher-route-resolver.mjs';
import {
  createSafeReceipt,
  redactContext,
  digestAction,
  digestResult,
  buildEvidence,
  buildCoordinatorEvidence,
  digestCanonical,
  canonicalJson,
  RECEIPT_DIGEST_DOMAIN,
} from './trusted-context-schema.mjs';

function normalizeTargetOriginForReceipt(targetOrigin) {
  if (typeof targetOrigin !== 'string' || !targetOrigin) return null;
  try {
    const u = new URL(targetOrigin);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === targetOrigin) return targetOrigin;
    return null;
  } catch {
    return null;
  }
}

function deriveTargetOrigin({ targetOrigin, params }) {
  const candidates = [];
  if (typeof targetOrigin === 'string' && targetOrigin) candidates.push(targetOrigin);
  if (params && typeof params === 'object') {
    if (typeof params.targetOrigin === 'string' && params.targetOrigin) candidates.push(params.targetOrigin);
    if (typeof params.url === 'string' && params.url) candidates.push(params.url);
    if (typeof params.sourceOrigin === 'string' && params.sourceOrigin) candidates.push(params.sourceOrigin);
  }
  for (const cand of candidates) {
    try {
      const u = new URL(cand);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin) return u.origin;
    } catch {
      // try next
    }
  }
  return null;
}

export class InteractiveRuntime {
  constructor({
    publicKey = null,
    keyId = null,
    expectedPhase = null,
    permitStore = null,
    trustedContextChannel = null,
    mode = 'enforce',
    socketPath = null,
    allowTestSeams = false,
    _testSeam = false,
    physicalRouteMap = null,
    routeMap = null,
    aliasToPhysicalMap = null,
    governor = null,
    fenceMode = null,
    divergenceSink = null,
    getActiveFence = null,
  } = {}) {
    const isProduction = process.env.NODE_ENV === 'production';
    const isTestEnv = process.env.NODE_ENV === 'test';
    const isTestContract = isTestEnv && process.env.WEBMCP_ALLOW_TEST_SEAMS === '1';
    const isTestSeamAllowed = isTestContract && Boolean(allowTestSeams || _testSeam);

    const pinnedPublicKey = process.env.WEBMCP_RUNNER_PUBLIC_KEY || process.env.WEBMCP_GATEWAY_PUBLIC_KEY || null;
    const pinnedKeyId = process.env.WEBMCP_RUNNER_KEY_ID || null;
    const pinnedSocketPath = process.env.WEBMCP_TRUSTED_CONTEXT_SOCKET || null;

    if (mode === 'observe' && !isTestSeamAllowed) {
      throw new Error(`Interactive mode 'observe' is only allowed through explicit test seams`);
    }

    if (mode !== 'enforce' && isProduction && !isTestSeamAllowed) {
      throw new Error(`Interactive mode '${mode}' is not permitted in production construction`);
    }

    if (trustedContextChannel && !isTestSeamAllowed) {
      throw new Error('Injected trustedContextChannel is not permitted in production construction');
    }

    if (permitStore && !isTestSeamAllowed) {
      throw new Error('Injected permitStore is not permitted in production construction');
    }

    if (!isTestSeamAllowed) {
      if (publicKey && publicKey !== pinnedPublicKey) {
        throw new Error('Passing custom publicKey is not permitted in production construction');
      }
      if (keyId && keyId !== pinnedKeyId) {
        throw new Error('Passing custom keyId is not permitted in production construction');
      }
      if (socketPath && socketPath !== pinnedSocketPath) {
        throw new Error('Passing custom socketPath is not permitted in production construction');
      }
    }

    // Physical route map injection is gated to explicit test seams; production loads local registry itself
    const injectedMap = physicalRouteMap || routeMap || aliasToPhysicalMap || null;
    if (injectedMap !== null && injectedMap !== undefined && !isTestSeamAllowed) {
      throw new Error('Passing custom physicalRouteMap is not permitted in production construction');
    }

    // A3 (ADR 0012 D6): the in-process Governor singleton is same-trust-domain
    // local state (no daemon/socket), so unlike caller-supplied keys/stores it
    // is accepted in production construction. Null keeps the pre-wire path.
    this.governor = governor || null;
    this.fenceMode = fenceMode ?? null;
    if (typeof getActiveFence === 'function') {
      this.getActiveFence = getActiveFence;
    } else if (this.governor) {
      const gov = this.governor;
      this.getActiveFence = (profileKey) => readGovernorActiveFence(gov, profileKey);
    } else {
      this.getActiveFence = null;
    }

    this.permitStore = (isTestSeamAllowed && permitStore) || new PermitStore();
    this.publicKey = !isTestSeamAllowed ? pinnedPublicKey : publicKey;
    this.keyId = !isTestSeamAllowed ? pinnedKeyId : (keyId || null);
    this.expectedPhase = expectedPhase || null;
    this.mode = mode; // off | observe | enforce

    // Private in-memory alias-to-physical route map (read-only local registry)
    if (isTestSeamAllowed && injectedMap !== null && injectedMap !== undefined) {
      if (injectedMap instanceof Map) {
        this.physicalRouteMap = new Map(injectedMap);
      } else if (injectedMap && typeof injectedMap === 'object') {
        this.physicalRouteMap = new Map(Object.entries(injectedMap));
      } else {
        this.physicalRouteMap = new Map();
      }
    } else {
      try {
        this.physicalRouteMap = loadDispatcherRouteMap();
      } catch {
        this.physicalRouteMap = new Map();
      }
    }

    this.verifier = new GatewayVerifier({
      publicKey: this.publicKey,
      keyId: this.keyId,
      expectedPhase: this.expectedPhase,
      permitStore: this.permitStore,
      mode: this.mode === 'observe' ? 'observe' : 'enforce',
      physicalRouteMap: this.physicalRouteMap,
      fenceMode: this.fenceMode,
      divergenceSink: divergenceSink ?? undefined,
      getActiveFence: this.getActiveFence,
    });

    this.trustedContextChannel =
      trustedContextChannel ||
      new TrustedContextChannel({
        socketPath: !isTestSeamAllowed ? pinnedSocketPath : socketPath,
        publicKey: this.publicKey,
        keyId: this.keyId,
        permitStore: this.permitStore,
      });

    // In-memory receipt registry: receiptId -> receipt (frozen)
    this._receiptRegistry = new Map();
  }

  async start() {
    if (this.trustedContextChannel) {
      await this.trustedContextChannel.start();
    }
    return this;
  }

  async stop() {
    if (this.trustedContextChannel) {
      await this.trustedContextChannel.stop();
    }
  }

  getCurrentContext() {
    return this.trustedContextChannel ? this.trustedContextChannel.getContext() : null;
  }

  isEnforcing() {
    return this.mode === 'enforce';
  }

  _storeReceipt(receipt) {
    if (receipt && receipt.receiptId) {
      this._receiptRegistry.set(receipt.receiptId, receipt);
    }
    return receipt;
  }

  _governorFenceEpochFor(permit, context) {
    // A3 (ADR 0012 D1): the Governor-issued live epoch wins when the runtime
    // is wired to the in-process Governor. Null keeps the legacy derivation.
    try {
      if (!this.governor) return null;
      const alias = context?.profileAlias || context?.profileId
        || permit?.profileAlias || permit?.profileId || null;
      const live = alias ? readGovernorActiveFence(this.governor, alias) : null;
      return live && Number.isSafeInteger(live.fenceEpoch) ? live.fenceEpoch : null;
    } catch {
      return null;
    }
  }

  // A3 authoritative fence check (ADR 0012 D3): validates the presented
  // proof against the Governor via authorizeFence (issuance, scope, expiry,
  // use count, liveness) BEFORE the sync verifier precheck runs. Returns a
  // fence-layer deny verdict, or null to continue down the sync path.
  //  - missing proof → PROFILE_FENCE_REQUIRED (sync gate also covers this);
  //  - Governor typed failure (PROFILE_FENCE_STALE, PROFILE_LEASE_NOT_FOUND,
  //    PROFILE_LEASE_EXPIRED, scope/use failures, …) → PROFILE_FENCE_STALE;
  //  - non-Governor failure (check could not resolve) → REQUIRED;
  //  - no governor wired → fail-safe REQUIRED for mutating actions under
  //    enforce (never allow on an unvalidated proof);
  //  - fence-observe → log divergence and continue (return null); the sync
  //    gate then records its own would-deny and the HTTP path forwards it.
  // Read-only actions and the composite batch outer call are exempt here
  // (batch children authorize individually via authorizeBatchFences).
  async authorizeFenceAsync({ actionClass, params, permit } = {}) {
    const fenceMode = this.verifier?.fenceMode ?? 'off';
    if (fenceMode === 'off') return null;
    if (!isMutatingAction(actionClass) || actionClass === 'browser.batch') return null;
    const proof = extractFenceProof(params);
    const profileKey = permit?.profileAlias || permit?.profileId || null;
    const correlationId = permit?.runId ?? permit?.permitId ?? null;
    const deny = (reason) => {
      const verdict = this.verifier.fenceVerdict(reason, actionClass);
      logFenceDivergence(this.verifier.divergenceSink, {
        profileKey,
        leaseId: fenceProofLeaseId(proof),
        fenceEpoch: fenceProofEpoch(proof),
        correlationId,
        decision: verdict.decision,
        reason,
      });
      return verdict;
    };
    if (proof === undefined || proof === null) {
      if (fenceMode === 'observe') return null;
      return deny('PROFILE_FENCE_REQUIRED');
    }
    if (!this.governor || typeof this.governor.authorizeFence !== 'function') {
      if (fenceMode === 'observe') return null;
      return deny('PROFILE_FENCE_REQUIRED');
    }
    if (!fenceScopeAdmitsAction(proof, actionClass)) {
      // S6d Fix A: bind the issued proof to the requested action before the
      // authoritative call — a `browser-read` proof must never authorize a
      // mutating call even when the lease admits both (fence scope does not
      // admit the requested action). Observe logs divergence and continues.
      const reason = 'PROFILE_FENCE_STALE';
      if (fenceMode === 'observe') {
        const verdict = this.verifier.fenceVerdict(reason, actionClass);
        logFenceDivergence(this.verifier.divergenceSink, {
          profileKey,
          leaseId: fenceProofLeaseId(proof),
          fenceEpoch: fenceProofEpoch(proof),
          correlationId,
          decision: verdict.decision,
          reason,
        });
        return null;
      }
      return deny(reason);
    }
    try {
      await this.governor.authorizeFence(proof);
      return null;
    } catch (error) {
      const reason = (error && typeof error.code === 'string' && error.code.startsWith('PROFILE_'))
        ? 'PROFILE_FENCE_STALE'
        : 'PROFILE_FENCE_REQUIRED';
      if (fenceMode === 'observe') {
        const verdict = this.verifier.fenceVerdict(reason, actionClass);
        logFenceDivergence(this.verifier.divergenceSink, {
          profileKey,
          leaseId: fenceProofLeaseId(proof),
          fenceEpoch: fenceProofEpoch(proof),
          correlationId,
          decision: verdict.decision,
          reason,
        });
        return null;
      }
      return deny(reason);
    }
  }

  // Batch companion: authorize EVERY mutating child's proof individually
  // (per-side-effect boundary, first deny wins) so no child can suppress
  // Governor validation of another — same `fenceId` or repeated proof alike,
  // each boundary consumes its own authorization use. Malformed children are
  // left for the sync verifier (which owns MALFORMED/SCOPE verdicts).
  // Returns the first fence deny verdict, or null to continue.
  async authorizeBatchFences({ actions, permit } = {}) {
    if (!Array.isArray(actions) || actions.length === 0) return null;
    for (const act of actions) {
      if (!act || typeof act !== 'object' || Array.isArray(act)) continue;
      const childMethod = act.method || act.tool || act.action || act.command;
      if (typeof childMethod !== 'string' || !childMethod.trim()) continue;
      if (childMethod === 'batch' || childMethod === 'browser_batch') continue;
      const childParams = act.params && typeof act.params === 'object' && !Array.isArray(act.params) ? act.params : {};
      const childClass = this.verifier.classifyTool(childMethod, childParams);
      if (!isMutatingAction(childClass) || childClass === 'browser.batch') continue;
      const verdict = await this.authorizeFenceAsync({ actionClass: childClass, params: childParams, permit });
      if (verdict) return verdict;
    }
    return null;
  }

  _buildReceiptBase({ permit, context, actionClass, attempt, outcome, sequence, method, params, targetOrigin, result, children = null, decision = null }) {
    const normalizedTarget = normalizeTargetOriginForReceipt(targetOrigin) || deriveTargetOrigin({ targetOrigin, params });
    const safeTarget = normalizedTarget || null;
    // Use digestAction helper indirectly via createSafeReceipt, but compute here for explicit control
    const resultDigest = result !== undefined && result !== null ? digestResult(result) : null;
    const evidence = permit?.schema === 'webmcp-durable-execution-permit/1'
      ? buildCoordinatorEvidence(result !== undefined ? result : null)
      : buildEvidence(result !== undefined ? result : null);
    const receipt = createSafeReceipt({
      permitId: permit?.permitId || null,
      runId: permit?.runId || context?.runId || null,
      projectId: permit?.projectId || context?.projectId || null,
      profileAlias: permit?.profileAlias || context?.profileAlias || null,
      profileId: permit?.profileId || context?.profileId || null,
      claimGeneration: permit?.claimGeneration ?? context?.claimGeneration ?? null,
      claimDigest: permit?.claimDigest || context?.claimDigest || null,
      // A3 (ADR 0012 D1/D4): the receipt carries the Governor-issued live
      // epoch when the runtime is wired to the in-process Governor. The
      // `stateVersion + 1` derivation is retired on the wired path; it
      // remains only as the unwired fallback for durable permits.
      // A durable permit owns the coordinator phase fence. A stale legacy
      // trusted context must never override that durable binding.
      fenceEpoch: this._governorFenceEpochFor(permit, context)
        ?? (permit?.schema === 'webmcp-durable-execution-permit/1'
          ? (Number.isSafeInteger(permit?.stateVersion) ? permit.stateVersion + 1 : null)
          : context?.fenceEpoch ?? permit?.claimGeneration ?? null),
      phaseId: permit?.phaseId || context?.phaseId || null,
      bindingId: permit?.bindingId || context?.bindingId || null,
      bindingRevision: permit?.bindingRevision ?? context?.bindingRevision ?? null,
      bindingDigest: permit?.bindingDigest || context?.bindingDigest || null,
      policyRevision: permit?.policyRevision || context?.policyRevision || null,
      automationStoreRevision: permit?.automationStoreRevision ?? context?.automationStoreRevision ?? null,
      automationStoreDigest: permit?.automationStoreDigest || context?.automationStoreDigest || null,
      siteStoreRevision: permit?.siteStoreRevision ?? context?.siteStoreRevision ?? null,
      siteStoreDigest: permit?.siteStoreDigest || context?.siteStoreDigest || null,
      stateVersion: permit?.stateVersion ?? context?.stateVersion ?? null,
      planRevision: permit?.planRevision ?? context?.planRevision ?? null,
      planDigest: permit?.planDigest || context?.planDigest || null,
      instructionDigest: permit?.instructionDigest || context?.instructionDigest || null,
      actionClass: actionClass || null,
      attempt,
      outcome,
      sequence,
      method: method || actionClass || 'unknown',
      params: params || {},
      targetOrigin: safeTarget,
      resultDigest,
      evidence,
      decision,
      reason: null,
      children,
    });
    return this._storeReceipt(receipt);
  }

  // Create final receipts for gateway success/failure/timeout paths
  createAppliedReceipt({ permit, context, method, params, targetOrigin, result, sequence = 1 }) {
    const verifierActionClass = this.verifier.classifyTool(method, params);
    return this._buildReceiptBase({
      permit,
      context,
      actionClass: verifierActionClass,
      attempt: 'attempted',
      outcome: 'applied',
      sequence,
      method,
      params,
      targetOrigin,
      result,
    });
  }

  createFailedReceipt({ permit, context, method, params, targetOrigin, result, sequence = 1, reason = null, children = null, decision = 'deny' }) {
    const actionClass = this.verifier.classifyTool(method, params);
    const receipt = this._buildReceiptBase({
      permit,
      context,
      actionClass,
      attempt: 'attempted',
      outcome: 'failed',
      sequence,
      method,
      params,
      targetOrigin,
      result,
      children,
      decision: 'deny',
    });
    // Attach reason without affecting digest? Create new receipt with reason via createSafeReceipt then re-store
    // Since _buildReceiptBase already stored, we need to patch reason safely by creating a new receipt with reason
    if (reason) {
      const withReason = createSafeReceipt({
        permitId: receipt.permitId,
        runId: receipt.runId,
        projectId: receipt.projectId,
        profileAlias: receipt.profileAlias,
        profileId: receipt.profileId,
        claimGeneration: receipt.claimGeneration,
        claimDigest: receipt.claimDigest,
        fenceEpoch: receipt.fenceEpoch,
        phaseId: receipt.phaseId,
        bindingId: receipt.bindingId,
        bindingRevision: receipt.bindingRevision,
        bindingDigest: receipt.bindingDigest,
        automationStoreRevision: receipt.automationStoreRevision,
        automationStoreDigest: receipt.automationStoreDigest,
        siteStoreRevision: receipt.siteStoreRevision,
        siteStoreDigest: receipt.siteStoreDigest,
        stateVersion: receipt.stateVersion,
        planRevision: receipt.planRevision,
        planDigest: receipt.planDigest,
        instructionDigest: receipt.instructionDigest,
        policyRevision: receipt.policyRevision,
        actionClass: receipt.actionClass,
        attempt: receipt.attempt,
        outcome: receipt.outcome,
        sequence: receipt.sequence,
        method,
        params,
        targetOrigin: receipt.targetOrigin,
        resultDigest: receipt.resultDigest,
        evidence: receipt.evidence,
        decision,
        reason,
        children: receipt.children,
      });
      // Replace registry entry: remove old, store new
      this._receiptRegistry.delete(receipt.receiptId);
      return this._storeReceipt(withReason);
    }
    return receipt;
  }

  createIndeterminateReceipt({ permit, context, method, params, targetOrigin, sequence = 1, reason = null, children = null, decision = 'deny' }) {
    const actionClass = this.verifier.classifyTool(method, params);
    const receipt = this._buildReceiptBase({
      permit,
      context,
      actionClass,
      attempt: 'attempted',
      outcome: 'indeterminate',
      sequence,
      method,
      params,
      targetOrigin,
      result: null,
      children,
      decision: 'deny',
    });
    if (reason) {
      const withReason = createSafeReceipt({
        permitId: receipt.permitId,
        runId: receipt.runId,
        projectId: receipt.projectId,
        profileAlias: receipt.profileAlias,
        profileId: receipt.profileId,
        claimGeneration: receipt.claimGeneration,
        claimDigest: receipt.claimDigest,
        fenceEpoch: receipt.fenceEpoch,
        phaseId: receipt.phaseId,
        bindingId: receipt.bindingId,
        bindingRevision: receipt.bindingRevision,
        bindingDigest: receipt.bindingDigest,
        automationStoreRevision: receipt.automationStoreRevision,
        automationStoreDigest: receipt.automationStoreDigest,
        siteStoreRevision: receipt.siteStoreRevision,
        siteStoreDigest: receipt.siteStoreDigest,
        stateVersion: receipt.stateVersion,
        planRevision: receipt.planRevision,
        planDigest: receipt.planDigest,
        instructionDigest: receipt.instructionDigest,
        policyRevision: receipt.policyRevision,
        actionClass: receipt.actionClass,
        attempt: receipt.attempt,
        outcome: receipt.outcome,
        sequence: receipt.sequence,
        method,
        params,
        targetOrigin: receipt.targetOrigin,
        resultDigest: receipt.resultDigest,
        evidence: receipt.evidence,
        decision,
        reason,
        children: receipt.children,
      });
      this._receiptRegistry.delete(receipt.receiptId);
      return this._storeReceipt(withReason);
    }
    return receipt;
  }

  createBlockedReceipt({ permit, context, method, params, targetOrigin, reason, sequence = 1, children = null }) {
    const actionClass = this.verifier.classifyTool(method, params);
    const outcome = reason === 'EXECUTION_FENCE_STALE' ? 'fence-lost' : 'blocked';
    const receipt = this._buildReceiptBase({
      permit,
      context,
      actionClass,
      attempt: 'not-attempted',
      outcome,
      sequence,
      method,
      params,
      targetOrigin,
      result: null,
      children,
    });
    if (reason) {
      const withReason = createSafeReceipt({
        permitId: receipt.permitId,
        runId: receipt.runId,
        projectId: receipt.projectId,
        profileAlias: receipt.profileAlias,
        profileId: receipt.profileId,
        claimGeneration: receipt.claimGeneration,
        claimDigest: receipt.claimDigest,
        fenceEpoch: receipt.fenceEpoch,
        phaseId: receipt.phaseId,
        bindingId: receipt.bindingId,
        bindingRevision: receipt.bindingRevision,
        bindingDigest: receipt.bindingDigest,
        automationStoreRevision: receipt.automationStoreRevision,
        automationStoreDigest: receipt.automationStoreDigest,
        siteStoreRevision: receipt.siteStoreRevision,
        siteStoreDigest: receipt.siteStoreDigest,
        stateVersion: receipt.stateVersion,
        planRevision: receipt.planRevision,
        planDigest: receipt.planDigest,
        instructionDigest: receipt.instructionDigest,
        policyRevision: receipt.policyRevision,
        actionClass: receipt.actionClass,
        attempt: receipt.attempt,
        outcome: receipt.outcome,
        sequence: receipt.sequence,
        method,
        params,
        targetOrigin: receipt.targetOrigin,
        resultDigest: receipt.resultDigest,
        evidence: receipt.evidence,
        reason,
        children: receipt.children,
      });
      this._receiptRegistry.delete(receipt.receiptId);
      return this._storeReceipt(withReason);
    }
    return receipt;
  }

  /**
   * Batch helpers: create child receipts + aggregate.
   */
  createBatchAppliedReceipts({ permit, context, actions, results }) {
    const children = [];
    const resultArray = Array.isArray(results) ? results : [];
    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      const method = act.method || act.tool || 'unknown';
      const params = act.params || {};
      const targetOrigin = act.targetOrigin || deriveTargetOrigin({ params }) || null;
      const childResult = resultArray[i] !== undefined ? resultArray[i] : (resultArray.length === 0 ? { success: true } : null);
      const receipt = this._buildReceiptBase({
        permit,
        context,
        actionClass: this.verifier.classifyTool(method, params),
        attempt: 'attempted',
        outcome: 'applied',
        sequence: i + 1,
        method,
        params,
        targetOrigin,
        result: childResult,
      });
      children.push(receipt);
    }
    // Aggregate browser.batch receipt - non-counted, sequence null (using max sequence +1 but flagged)
    // Spec says non-counted aggregate; we assign sequence = children.length + 1 but mark as aggregate
    const aggregate = createSafeReceipt({
      permitId: permit?.permitId || null,
      runId: permit?.runId || context?.runId || null,
      projectId: permit?.projectId || context?.projectId || null,
      profileAlias: permit?.profileAlias || context?.profileAlias || null,
      profileId: permit?.profileId || context?.profileId || null,
      claimGeneration: permit?.claimGeneration ?? context?.claimGeneration ?? null,
      claimDigest: permit?.claimDigest || context?.claimDigest || null,
      fenceEpoch: this._governorFenceEpochFor(permit, context) ?? context?.fenceEpoch ?? null,
      phaseId: permit?.phaseId || context?.phaseId || null,
      bindingId: permit?.bindingId || context?.bindingId || null,
      bindingRevision: permit?.bindingRevision ?? context?.bindingRevision ?? null,
      bindingDigest: permit?.bindingDigest || context?.bindingDigest || null,
      policyRevision: permit?.policyRevision || context?.policyRevision || null,
      automationStoreRevision: permit?.automationStoreRevision ?? context?.automationStoreRevision ?? null,
      automationStoreDigest: permit?.automationStoreDigest || context?.automationStoreDigest || null,
      siteStoreRevision: permit?.siteStoreRevision ?? context?.siteStoreRevision ?? null,
      siteStoreDigest: permit?.siteStoreDigest || context?.siteStoreDigest || null,
      stateVersion: permit?.stateVersion ?? context?.stateVersion ?? null,
      planRevision: permit?.planRevision ?? context?.planRevision ?? null,
      planDigest: permit?.planDigest || context?.planDigest || null,
      instructionDigest: permit?.instructionDigest || context?.instructionDigest || null,
      actionClass: 'browser.batch',
      attempt: 'attempted',
      outcome: 'applied',
      sequence: 1,
      method: 'batch',
      params: { count: actions.length },
      targetOrigin: children[0]?.targetOrigin || null,
      resultDigest: digestResult({ receipts: children.length }),
      evidence: buildEvidence({ count: children.length }),
      children,
    });
    this._storeReceipt(aggregate);
    return { aggregate, children };
  }

  createBatchResultReceipts({ permit, context, actions, results }) {
    const children = [];
    const resultArray = Array.isArray(results) ? results : [];
    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      const method = act.method || act.tool || 'unknown';
      const expectedMethod = act.forwardedMethod || method;
      const params = act.params || {};
      const targetOrigin = act.targetOrigin || deriveTargetOrigin({ params }) || null;
      const childResult = resultArray[i] ?? null;
      if (
        childResult &&
        childResult.ok === true &&
        childResult.index === i &&
        childResult.method === expectedMethod
      ) {
        children.push(this._buildReceiptBase({
          permit,
          context,
          actionClass: this.verifier.classifyTool(method, params),
          attempt: 'attempted',
          outcome: 'applied',
          sequence: i + 1,
          method,
          params,
          targetOrigin,
          result: childResult,
        }));
        continue;
      }
      children.push(this.createFailedReceipt({
        permit,
        context,
        method,
        params,
        targetOrigin,
        result: childResult,
        sequence: i + 1,
        reason: 'BATCH_CHILD_FAILED',
      }));
    }

    const aggregate = createSafeReceipt({
      permitId: permit?.permitId || null,
      runId: permit?.runId || context?.runId || null,
      projectId: permit?.projectId || context?.projectId || null,
      profileAlias: permit?.profileAlias || context?.profileAlias || null,
      profileId: permit?.profileId || context?.profileId || null,
      claimGeneration: permit?.claimGeneration ?? context?.claimGeneration ?? null,
      claimDigest: permit?.claimDigest || context?.claimDigest || null,
      fenceEpoch: this._governorFenceEpochFor(permit, context) ?? context?.fenceEpoch ?? null,
      phaseId: permit?.phaseId || context?.phaseId || null,
      bindingId: permit?.bindingId || context?.bindingId || null,
      bindingRevision: permit?.bindingRevision ?? context?.bindingRevision ?? null,
      bindingDigest: permit?.bindingDigest || context?.bindingDigest || null,
      policyRevision: permit?.policyRevision || context?.policyRevision || null,
      automationStoreRevision: permit?.automationStoreRevision ?? context?.automationStoreRevision ?? null,
      automationStoreDigest: permit?.automationStoreDigest || context?.automationStoreDigest || null,
      siteStoreRevision: permit?.siteStoreRevision ?? context?.siteStoreRevision ?? null,
      siteStoreDigest: permit?.siteStoreDigest || context?.siteStoreDigest || null,
      stateVersion: permit?.stateVersion ?? context?.stateVersion ?? null,
      planRevision: permit?.planRevision ?? context?.planRevision ?? null,
      planDigest: permit?.planDigest || context?.planDigest || null,
      instructionDigest: permit?.instructionDigest || context?.instructionDigest || null,
      actionClass: 'browser.batch',
      attempt: 'attempted',
      outcome: 'failed',
      sequence: 1,
      method: 'batch',
      params: { count: actions.length },
      targetOrigin: children[0]?.targetOrigin || null,
      resultDigest: digestResult({ results: resultArray.length }),
      evidence: buildEvidence({ count: children.length, failed: children.filter((child) => child.outcome === 'failed').length }),
      decision: 'deny',
      reason: 'BATCH_CHILD_FAILED',
      children,
    });
    this._storeReceipt(aggregate);
    return { aggregate, children };
  }

  createBatchBlockedReceipts({ permit, context, actions, reason }) {
    const children = [];
    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      const method = act.method || act.tool || 'unknown';
      const params = act.params || {};
      const targetOrigin = act.targetOrigin || deriveTargetOrigin({ params }) || null;
      const outcome = 'blocked';
      const receipt = this._buildReceiptBase({
        permit,
        context,
        actionClass: this.verifier.classifyTool(method, params),
        attempt: 'not-attempted',
        outcome,
        sequence: i + 1,
        method,
        params,
        targetOrigin,
        result: null,
      });
      // Patch reason
      const withReason = createSafeReceipt({
        permitId: receipt.permitId,
        runId: receipt.runId,
        projectId: receipt.projectId,
        profileAlias: receipt.profileAlias,
        profileId: receipt.profileId,
        claimGeneration: receipt.claimGeneration,
        claimDigest: receipt.claimDigest,
        fenceEpoch: receipt.fenceEpoch,
        phaseId: receipt.phaseId,
        bindingId: receipt.bindingId,
        bindingRevision: receipt.bindingRevision,
        bindingDigest: receipt.bindingDigest,
        automationStoreRevision: receipt.automationStoreRevision,
        automationStoreDigest: receipt.automationStoreDigest,
        siteStoreRevision: receipt.siteStoreRevision,
        siteStoreDigest: receipt.siteStoreDigest,
        stateVersion: receipt.stateVersion,
        planRevision: receipt.planRevision,
        planDigest: receipt.planDigest,
        instructionDigest: receipt.instructionDigest,
        policyRevision: receipt.policyRevision,
        actionClass: receipt.actionClass,
        attempt: receipt.attempt,
        outcome: receipt.outcome,
        sequence: receipt.sequence,
        method,
        params,
        targetOrigin: receipt.targetOrigin,
        resultDigest: receipt.resultDigest,
        evidence: receipt.evidence,
        reason: reason || 'EXECUTION_PERMIT_SCOPE_DENIED',
      });
      this._receiptRegistry.delete(receipt.receiptId);
      this._storeReceipt(withReason);
      children.push(withReason);
    }
    const aggregate = createSafeReceipt({
      permitId: permit?.permitId || null,
      runId: permit?.runId || context?.runId || null,
      projectId: permit?.projectId || context?.projectId || null,
      profileAlias: permit?.profileAlias || context?.profileAlias || null,
      profileId: permit?.profileId || context?.profileId || null,
      claimGeneration: permit?.claimGeneration ?? context?.claimGeneration ?? null,
      claimDigest: permit?.claimDigest || context?.claimDigest || null,
      fenceEpoch: this._governorFenceEpochFor(permit, context) ?? context?.fenceEpoch ?? null,
      phaseId: permit?.phaseId || context?.phaseId || null,
      bindingId: permit?.bindingId || context?.bindingId || null,
      bindingRevision: permit?.bindingRevision ?? context?.bindingRevision ?? null,
      bindingDigest: permit?.bindingDigest || context?.bindingDigest || null,
      policyRevision: permit?.policyRevision || context?.policyRevision || null,
      automationStoreRevision: permit?.automationStoreRevision ?? context?.automationStoreRevision ?? null,
      automationStoreDigest: permit?.automationStoreDigest || context?.automationStoreDigest || null,
      siteStoreRevision: permit?.siteStoreRevision ?? context?.siteStoreRevision ?? null,
      siteStoreDigest: permit?.siteStoreDigest || context?.siteStoreDigest || null,
      stateVersion: permit?.stateVersion ?? context?.stateVersion ?? null,
      planRevision: permit?.planRevision ?? context?.planRevision ?? null,
      planDigest: permit?.planDigest || context?.planDigest || null,
      instructionDigest: permit?.instructionDigest || context?.instructionDigest || null,
      actionClass: 'browser.batch',
      attempt: 'not-attempted',
      outcome: 'blocked',
      sequence: 1,
      method: 'batch',
      params: { count: actions.length },
      targetOrigin: children[0]?.targetOrigin || null,
      resultDigest: null,
      evidence: buildEvidence(null),
      reason: reason || 'EXECUTION_PERMIT_SCOPE_DENIED',
      children,
    });
    this._storeReceipt(aggregate);
    return { aggregate, children };
  }

  verifyReceipts(receipts) {
    if (!Array.isArray(receipts) || receipts.length === 0) {
      return { ok: false, reason: 'RECEIPTS_MALFORMED' };
    }
    for (const r of receipts) {
      if (!r || typeof r !== 'object' || typeof r.receiptId !== 'string' || typeof r.receiptDigest !== 'string') {
        return { ok: false, reason: 'RECEIPTS_MALFORMED' };
      }
      const stored = this._receiptRegistry.get(r.receiptId);
      if (!stored) {
        return { ok: false, reason: 'RECEIPT_NOT_FOUND' };
      }
      if (stored.receiptDigest !== r.receiptDigest) {
        return { ok: false, reason: 'RECEIPT_DIGEST_MISMATCH' };
      }
      // Verify canonical content matches stored (excluding receiptDigest comparison already)
      const { receiptDigest: _sd, ...storedProj } = stored;
      const { receiptDigest: _rd, ...incomingProj } = r;
      const expected = digestCanonical(RECEIPT_DIGEST_DOMAIN, storedProj);
      const incomingDigest = r.receiptDigest;
      if (expected !== incomingDigest) {
        return { ok: false, reason: 'RECEIPT_CANONICAL_MISMATCH' };
      }
      // Also ensure incoming projection equals stored projection via digest
      const incomingExpected = digestCanonical(RECEIPT_DIGEST_DOMAIN, incomingProj);
      if (incomingExpected !== r.receiptDigest) {
        return { ok: false, reason: 'RECEIPT_CANONICAL_MISMATCH' };
      }
      // Strict field equality for canonical content
      const storedCanonical = canonicalJson(storedProj);
      const incomingCanonical = canonicalJson(incomingProj);
      if (storedCanonical !== incomingCanonical) {
        return { ok: false, reason: 'RECEIPT_CONTENT_MISMATCH' };
      }
    }
    return { ok: true };
  }

  revokePermit({ permitId, revocationId }) {
    if (permitId) this.permitStore.revoke(permitId);
    if (revocationId) this.permitStore.revoke(revocationId);
    // Also revoke both via combined check; PermitStore.isRevoked checks either
    return { ok: true, revoked: { permitId: permitId || null, revocationId: revocationId || null } };
  }

  enforceRequest({
    method,
    params = {},
    verificationParams = params,
    profileId = null,
    permit = null,
    targetOrigin = null,
    now = new Date(),
  } = {}) {
    const context = this.getCurrentContext();
    const durablePermit = permit?.schema === 'webmcp-durable-execution-permit/1';
    const verificationContext = durablePermit ? null : context;
    const authParams = verificationParams || params || {};

    let verifierResult;

    // Fail-closed check when in enforce or observe mode: require active context and valid permit
    if (this.mode !== 'off' && !context && !durablePermit) {
      const actionClass = this.verifier.classifyTool(method, authParams);
      const reason = !permit ? 'EXECUTION_PERMIT_REQUIRED' : 'EXECUTION_CONTEXT_REQUIRED';
      const decision = this.mode === 'observe' ? 'would-deny' : 'deny';
      verifierResult = { decision, reason, actionClass };
    } else if (method === 'batch' || method === 'browser_batch') {
      verifierResult = this.verifier.verifyBatch({
        tool: method,
        params: authParams,
        permit,
        targetOrigin,
        profileId,
        context: verificationContext,
        now,
      });
    } else {
      verifierResult = this.verifier.verifyRequest({
        tool: method,
        params: authParams,
        permit,
        targetOrigin: targetOrigin || authParams?.targetOrigin || authParams?.url || authParams?.sourceOrigin,
        profileId,
        context: verificationContext,
        now,
      });
    }

    // Build E5 receipt for this enforcement decision
    const safeTarget = normalizeTargetOriginForReceipt(targetOrigin) || deriveTargetOrigin({ targetOrigin, params });
    const isDeny = verifierResult.decision === 'deny' || verifierResult.decision === 'would-deny';
    const attempt = isDeny ? 'not-attempted' : 'not-attempted';
    // For preflight, outcome is blocked/not-applied for deny, not-applied for allow (not yet applied)
    let outcome;
    if (isDeny) {
      outcome = verifierResult.reason === 'EXECUTION_FENCE_STALE' ? 'fence-lost' : 'blocked';
    } else {
      outcome = 'not-applied';
    }

    const receipt = this._buildReceiptBase({
      permit,
      context,
      actionClass: verifierResult.actionClass,
      attempt,
      outcome,
      sequence: 1,
      method,
      params,
      targetOrigin: safeTarget,
      result: null,
    });

    // Patch reason if deny
    let finalReceipt = receipt;
    if (isDeny && verifierResult.reason) {
      const withReason = createSafeReceipt({
        permitId: receipt.permitId,
        runId: receipt.runId,
        projectId: receipt.projectId,
        profileAlias: receipt.profileAlias,
        profileId: receipt.profileId,
        claimGeneration: receipt.claimGeneration,
        claimDigest: receipt.claimDigest,
        fenceEpoch: receipt.fenceEpoch,
        phaseId: receipt.phaseId,
        bindingId: receipt.bindingId,
        bindingRevision: receipt.bindingRevision,
        bindingDigest: receipt.bindingDigest,
        automationStoreRevision: receipt.automationStoreRevision,
        automationStoreDigest: receipt.automationStoreDigest,
        siteStoreRevision: receipt.siteStoreRevision,
        siteStoreDigest: receipt.siteStoreDigest,
        stateVersion: receipt.stateVersion,
        planRevision: receipt.planRevision,
        planDigest: receipt.planDigest,
        instructionDigest: receipt.instructionDigest,
        policyRevision: receipt.policyRevision,
        actionClass: receipt.actionClass,
        attempt: receipt.attempt,
        outcome: receipt.outcome,
        sequence: receipt.sequence,
        method,
        params,
        targetOrigin: receipt.targetOrigin,
        resultDigest: receipt.resultDigest,
        evidence: receipt.evidence,
        reason: verifierResult.reason,
      });
      this._receiptRegistry.delete(receipt.receiptId);
      finalReceipt = this._storeReceipt(withReason);
    }

    // For deny, children mapping: if batch denied, need to include child blocked receipts? But we create via _buildReceiptBase already?
    // For batch deny, verifier returns children array; we should ensure receipt reflects that but we keep simple
    if (verifierResult.children && Array.isArray(verifierResult.children)) {
      // Create child blocked receipts internally and attach? For now return as is, but ensure enforcement receipt's children are not leaked raw?
      // We will handle batch final receipts via createBatchBlockedReceipts when gateway forwards zero children.
    }

    return {
      ...verifierResult,
      receipt: finalReceipt,
    };
  }

  // Async request path (ADR 0012 D3): runs the authoritative Governor fence
  // check first, then delegates to the sync enforceRequest (which runs the
  // cheap epoch precheck plus the full permit layers). The gateway HTTP path
  // uses this; direct sync enforceRequest stays for dormant/test callers.
  // A fence deny here carries a blocked receipt and never reaches the sync
  // ledger (no budget/nonce consumed). Fence-observe never denies here —
  // authorizeFenceAsync logs divergence and returns null to continue.
  async enforceRequestAsync({
    method,
    params = {},
    verificationParams = params,
    profileId = null,
    permit = null,
    targetOrigin = null,
    now = new Date(),
  } = {}) {
    const authParams = verificationParams || params || {};
    let fenceVerdict = null;
    if (method === 'batch' || method === 'browser_batch') {
      const actions = Array.isArray(authParams?.actions)
        ? authParams.actions
        : (Array.isArray(authParams?.batch) ? authParams.batch : []);
      fenceVerdict = await this.authorizeBatchFences({ actions, permit });
    } else {
      const actionClass = this.verifier.classifyTool(method, authParams);
      fenceVerdict = await this.authorizeFenceAsync({ actionClass, params: authParams, permit });
    }
    if (fenceVerdict) {
      const safeTarget = normalizeTargetOriginForReceipt(targetOrigin) || deriveTargetOrigin({ targetOrigin, params });
      const receipt = this.createBlockedReceipt({
        permit,
        context: this.getCurrentContext(),
        method,
        params: params || {},
        targetOrigin: safeTarget,
        reason: fenceVerdict.reason,
        sequence: 1,
      });
      return { ...fenceVerdict, receipt };
    }
    return this.enforceRequest({ method, params, verificationParams, profileId, permit, targetOrigin, now });
  }

  getContextSummary() {
    const ctx = this.getCurrentContext();
    return redactContext(ctx);
  }
}
