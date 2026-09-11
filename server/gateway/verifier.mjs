import { verify } from 'node:crypto';
import { PermitStore } from './permit-store.mjs';
import {
  canonicalJson,
  digestCanonical,
  toKeyObject,
  keysMatch,
  validatePermitStructure,
  permitDigestDomain,
  isNormalizedHttpOrigin,
  SCHEMAS,
} from './trusted-context-schema.mjs';

const ACTION_CLASS_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*(?:[._:-][a-zA-Z0-9]+)*$/;

const TOOL_TO_ACTION = new Map([
  ['webmcp.invokeTool', 'browser.invokeTool'],
  ['webmcp.listTools', 'browser.listTools'],
  ['browser_navigate', 'browser.navigate'],
  ['browser_click', 'browser.click'],
  ['browser_type', 'browser.type'],
  ['browser_scroll', 'browser.scroll'],
  ['browser_select', 'browser.select'],
  ['browser_hover', 'browser.hover'],
  ['browser_evaluate', 'browser.evaluate'],
  ['browser_screenshot', 'browser.screenshot'],
  ['browser_page_text', 'browser.getPageText'],
  ['browser_aria_snapshot', 'browser.getAriaSnapshot'],
  ['browser_element_bounds', 'browser.getElementBounds'],
  ['page.click', 'browser.click'],
  ['page.type', 'browser.type'],
  ['page.scroll', 'browser.scroll'],
  ['browser_raw_command', 'browser.raw'],
  ['browser_batch', 'browser.batch'],
  ['batch', 'browser.batch'],
  ['navigate', 'browser.navigate'],
  ['click', 'browser.click'],
  ['type', 'browser.type'],
  ['scroll', 'browser.scroll'],
  ['listDownloadEvents', 'browser.listDownloadEvents'],
  ['clearDownloadEvents', 'browser.clearDownloadEvents'],
  ['browser_list_download_events', 'browser.listDownloadEvents'],
  ['browser_clear_download_events', 'browser.clearDownloadEvents'],
]);

// Raw execution is an escape hatch for catalogued leaf commands only. A
// syntactically valid but unknown raw name must remain fail-closed.
const KNOWN_RAW_METHODS = new Set([
  'listTabs', 'navigate', 'newTab', 'closeTab', 'activateTab', 'getActiveTab',
  'listFrames', 'click', 'type', 'waitForSelector', 'getPageContent', 'getPageText',
  'readPage', 'querySelectorAll', 'getWindowVariable', 'findByText', 'pageFetch',
  'evaluateJS', 'executeCDP', 'screenshot', 'webmcp.listTools', 'webmcp.invokeTool',
  'getAccessibilityTree', 'getDOMSnapshot', 'getElementBounds', 'getInteractiveElements',
  'getAriaSnapshot', 'clickByRef', 'typeByRef', 'hoverByRef', 'selectByRef',
  'waitForStable', 'startConsoleCapture', 'stopConsoleCapture', 'readConsoleMessages',
  'clearConsoleMessages', 'listDownloadEvents', 'clearDownloadEvents', 'dispatchClick',
  'moveMouse', 'pressKey', 'typeText', 'scroll', 'hover', 'selectOption', 'getCookies',
  'setCookie', 'deleteCookie', 'deleteCookies', 'getLocalStorage', 'setLocalStorage', 'listWindows',
  'createWindow', 'setViewport', 'resetViewport', 'ping', 'getExtensionInfo',
  'list_profiles', 'set_profile_name',
]);

export function classifyTool(tool, params = {}) {
  if (!tool || typeof tool !== 'string') return 'browser.unknown';
  if (tool === 'browser_raw_command' || tool === 'raw') {
    const aliases = ['method', 'command', 'action']
      .filter((key) => typeof params?.[key] === 'string' && params[key].trim())
      .map((key) => params[key].trim());
    const inner = aliases[0];
    if (!inner || aliases.some((candidate) => candidate !== inner) || !ACTION_CLASS_PATTERN.test(inner.replaceAll('.', '_')) || !KNOWN_RAW_METHODS.has(inner)) {
      return 'browser.raw.unknown';
    }
    return `browser.raw.${inner}`;
  }
  if (TOOL_TO_ACTION.has(tool)) return TOOL_TO_ACTION.get(tool);
  if (tool.startsWith('browser_') || tool.startsWith('page.') || tool.startsWith('webmcp.')) {
    const sub = tool.replace(/^browser[_.]|^page[_.]|^webmcp[_.]/, '');
    return `browser.${sub}`;
  }
  return `browser.${tool}`;
}

export function isActionScopeAllowed(allowedClasses, actionClass) {
  if (!Array.isArray(allowedClasses) || allowedClasses.length === 0 || !actionClass || typeof actionClass !== 'string') return false;
  if (
    actionClass === 'browser.unknown' ||
    actionClass === 'browser.raw.unknown' ||
    actionClass === 'unknown' ||
    actionClass.endsWith('.unknown') ||
    actionClass.includes('.unknown.')
  ) {
    return false;
  }
  if (allowedClasses.includes(actionClass)) return true;
  return allowedClasses.includes('browser.raw.*')
    && actionClass.startsWith('browser.raw.')
    && actionClass !== 'browser.raw.unknown'
    && !actionClass.endsWith('.unknown');
}

export function normalizeOrigin(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) ? u.origin : null;
  } catch {
    if (/^https?:\/\/[^/?#]+/.test(url)) {
      return url.replace(/^(https?:\/\/[^/?#]+).*$/, '$1');
    }
    return null;
  }
}

export function extractExecutedOrigin(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  if (typeof params.url === 'string' && params.url.trim()) {
    return normalizeOrigin(params.url);
  }
  if (typeof params.sourceOrigin === 'string' && params.sourceOrigin.trim()) {
    return normalizeOrigin(params.sourceOrigin);
  }
  if (typeof params.targetOrigin === 'string' && params.targetOrigin.trim()) {
    return normalizeOrigin(params.targetOrigin);
  }
  return null;
}

export class GatewayVerifier {
  constructor({ publicKey = null, keyId = null, expectedPhase = null, permitStore = new PermitStore(), mode = 'enforce', physicalRouteMap = null, routeMap = null, aliasToPhysicalMap = null } = {}) {
    this.publicKey = publicKey;
    this.keyId = keyId || null;
    this.expectedPhase = expectedPhase || null;
    this.permitStore = permitStore;
    this.mode = mode; // off | observe | enforce
    const rawMap = physicalRouteMap || routeMap || aliasToPhysicalMap || null;
    if (rawMap instanceof Map) {
      this.physicalRouteMap = rawMap;
    } else if (rawMap && typeof rawMap === 'object') {
      this.physicalRouteMap = new Map(Object.entries(rawMap));
    } else {
      this.physicalRouteMap = new Map();
    }
  }

  _isPhysicalRouteAllowed(profileId, context, permit) {
    if (!profileId || typeof profileId !== 'string') return false;
    if (!this.physicalRouteMap || this.physicalRouteMap.size === 0) return false;
    // Exact match only, no pattern
    const logicals = new Set();
    if (context?.profileAlias && typeof context.profileAlias === 'string') logicals.add(context.profileAlias);
    if (context?.profileId && typeof context.profileId === 'string') logicals.add(context.profileId);
    if (permit?.profileAlias && typeof permit.profileAlias === 'string') logicals.add(permit.profileAlias);
    if (permit?.profileId && typeof permit.profileId === 'string') logicals.add(permit.profileId);
    for (const logical of logicals) {
      const phys = this.physicalRouteMap.get(logical);
      if (phys && phys === profileId) return true;
    }
    return false;
  }

  classifyTool(tool, params) {
    return classifyTool(tool, params);
  }

  deny(reason, actionClass) {
    const decision = this.mode === 'observe' ? 'would-deny' : 'deny';
    return { decision, reason, actionClass };
  }

  checkBudget(permit, count = 1, dryRun = false) {
    if (!permit?.budget || permit.budget.maxCalls === undefined) return true;
    const key = permit.permitId;
    let entry = this.permitStore.budget.get(key);
    if (!entry) {
      if (dryRun) {
        return count <= (permit.budget.maxCalls ?? Infinity);
      }
      entry = { maxCalls: permit.budget.maxCalls ?? Infinity, used: 0 };
      this.permitStore.budget.set(key, entry);
    }
    if (entry.used + count > entry.maxCalls) {
      return false;
    }
    if (!dryRun) {
      entry.used += count;
    }
    return true;
  }

  verifyPermitSignature(permit, keyInput) {
    if (!permit || !permit.signature || !permit.permitDigest) return false;
    const keyObj = toKeyObject(keyInput);
    if (!keyObj) return false;

    const { permitDigest, signature: _sig, ...projection } = permit;
    const expectedDigest = digestCanonical(permitDigestDomain(permit), projection);

    // Reject missing or altered permitDigest
    if (!permitDigest || permitDigest !== expectedDigest) {
      return false;
    }

    const canonical = canonicalJson(projection);
    const sig = Buffer.from(permit.signature, 'hex');

    // Strict single frozen canonical/domain contract: 'webmcp-digest-v1:permit\n' + canonicalJson
    try {
      const data = Buffer.from(`${permitDigestDomain(permit)}\n${canonical}`, 'utf8');
      return verify(null, data, keyObj, sig);
    } catch {
      return false;
    }
  }

  verifyRequest({
    tool,
    params = {},
    permit = null,
    targetOrigin = null,
    profileId = null,
    context = null,
    now = new Date(),
    dryRun = false,
  } = {}) {
    const actionClass = this.classifyTool(tool, params);
    const durablePermit = permit?.schema === 'webmcp-durable-execution-permit/1';

    // Unknown raw action in enforce or observe mode
    if (actionClass === 'browser.raw.unknown') {
      return this.deny('TOOL_ACTION_NOT_ALLOWED', actionClass);
    }

    // Missing permit check
    if (!permit) {
      return this.deny('EXECUTION_PERMIT_REQUIRED', actionClass);
    }

    // Structural permit check
    const structCheck = validatePermitStructure(permit);
    if (!structCheck.ok) {
      return this.deny(structCheck.reason, actionClass);
    }

    // Check altered permitDigest explicitly
    const { permitDigest, signature: _sig, ...projection } = permit;
      const expectedDigest = digestCanonical(permitDigestDomain(permit), projection);
    if (!permitDigest || permitDigest !== expectedDigest) {
      return this.deny('EXECUTION_PERMIT_FORGED', actionClass);
    }

    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);

    // Strict cryptographic verification: only pinned public key is the verification authority
    if (!this.publicKey) {
      return this.deny('EXECUTION_KEY_MISMATCH', actionClass);
    }
    if (!permit.signature) {
      return this.deny('EXECUTION_PERMIT_REQUIRED', actionClass);
    }
    const ok = this.verifyPermitSignature(permit, this.publicKey);
    if (!ok) {
      return this.deny('EXECUTION_PERMIT_FORGED', actionClass);
    }

    // Context binding checks (if active context provided)
    if (context && !durablePermit) {
      const ctxExpiresAt = Date.parse(context.expiresAt);
      if (!Number.isNaN(ctxExpiresAt) && nowMs > ctxExpiresAt) {
        return this.deny('EXECUTION_CONTEXT_EXPIRED', actionClass);
      }

      if (context.contextDigest) {
        const { signature: _csig, contextDigest: _ccd, ...ctxProj } = context;
        const expectedCtxDigest = digestCanonical('webmcp-digest-v1:trusted-context', ctxProj);
        if (context.contextDigest !== expectedCtxDigest) {
          return this.deny('EXECUTION_PERMIT_FORGED', actionClass);
        }
      }

      if (context.publicKey && !keysMatch(context.publicKey, this.publicKey)) {
        return this.deny('EXECUTION_KEY_MISMATCH', actionClass);
      }

      if (permit.publicKey && !keysMatch(permit.publicKey, this.publicKey)) {
        return this.deny('EXECUTION_KEY_MISMATCH', actionClass);
      }

      // Project ID: required and must match
      if (permit.projectId !== context.projectId) {
        return this.deny('EXECUTION_PROJECT_MISMATCH', actionClass);
      }

      // Phase fence binding: require and compare permit phaseId against context phaseId
      if (permit.phaseId !== context.phaseId) {
        return this.deny('EXECUTION_PHASE_MISMATCH', actionClass);
      }

      // Context vs Permit profile binding
      const ctxProfile = context.profileAlias || context.profileId;
      const permitProfile = permit.profileAlias || permit.profileId;
      if (!ctxProfile || !permitProfile) {
        return this.deny('EXECUTION_PROFILE_MISMATCH', actionClass);
      }
      if (context.profileAlias && permit.profileAlias && permit.profileAlias !== context.profileAlias) {
        return this.deny('EXECUTION_PROFILE_MISMATCH', actionClass);
      }
      if (context.profileId && permit.profileId && permit.profileId !== context.profileId) {
        return this.deny('EXECUTION_PROFILE_MISMATCH', actionClass);
      }

      // Profile binding checks with effective profileId (logical or physical via local route map)
      if (profileId) {
        let logicalOk = true;
        if (context.profileId && profileId !== context.profileId && profileId !== context.profileAlias) logicalOk = false;
        if (logicalOk && context.profileAlias && profileId !== context.profileAlias && profileId !== context.profileId) logicalOk = false;
        if (logicalOk && permit.profileAlias && profileId !== permit.profileAlias && profileId !== permit.profileId) logicalOk = false;
        if (logicalOk && permit.profileId && profileId !== permit.profileId && profileId !== permit.profileAlias) logicalOk = false;
        if (!logicalOk) {
          if (!this._isPhysicalRouteAllowed(profileId, context, permit)) {
            return this.deny('EXECUTION_PROFILE_MISMATCH', actionClass);
          }
        }
      }

      // RunId / correlation check
      if (permit.schema === SCHEMAS.PERMIT_V2 && permit.subjectType === 'interactive-session') {
        if (permit.permitCorrelation !== context.runId) {
          return this.deny('EXECUTION_REVISION_STALE', actionClass);
        }
      } else {
        if (permit.runId !== context.runId) {
          return this.deny('EXECUTION_REVISION_STALE', actionClass);
        }
      }

      // Fence freshness check
      if (permit.claimGeneration < context.fenceEpoch) {
        return this.deny('EXECUTION_FENCE_STALE', actionClass);
      }

      // Claim digest check
      if (permit.claimDigest !== context.claimDigest) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }

      // Store and binding revision & digest checks
      if (permit.bindingId !== context.bindingId) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }
      if (permit.bindingRevision < context.bindingRevision) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }
      if (permit.bindingDigest !== context.bindingDigest) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }
      if (permit.automationStoreRevision < context.automationStoreRevision) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }
      if (permit.automationStoreDigest !== context.automationStoreDigest) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }
      if (permit.siteStoreRevision < context.siteStoreRevision) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }
      if (permit.siteStoreDigest !== context.siteStoreDigest) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }

      // Plan & instruction & policy revision/digest checks
      if (permit.planRevision < context.planRevision) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }
      if (permit.planDigest !== context.planDigest) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }
      if (permit.instructionDigest !== context.instructionDigest) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }
      if (permit.policyRevision !== context.policyRevision) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }
      if (permit.stateVersion < context.stateVersion) {
        return this.deny('EXECUTION_REVISION_STALE', actionClass);
      }

      // Key ID binding check
      if (permit.keyId !== context.keyId) {
        return this.deny('EXECUTION_KEY_MISMATCH', actionClass);
      }
    } else if (profileId) {
      let logicalOk = true;
      if (permit.profileAlias && profileId !== permit.profileAlias && profileId !== permit.profileId) logicalOk = false;
      if (logicalOk && permit.profileId && profileId !== permit.profileId && profileId !== permit.profileAlias) logicalOk = false;
      if (!logicalOk) {
        if (!this._isPhysicalRouteAllowed(profileId, null, permit)) {
          return this.deny('EXECUTION_PROFILE_MISMATCH', actionClass);
        }
      }
    }

    if (this.expectedPhase) {
      if (!permit.phaseId || permit.phaseId !== this.expectedPhase) {
        return this.deny('EXECUTION_PHASE_MISMATCH', actionClass);
      }
      if (context && !durablePermit && (!context.phaseId || context.phaseId !== this.expectedPhase)) {
        return this.deny('EXECUTION_PHASE_MISMATCH', actionClass);
      }
    }

    if (this.keyId) {
      if (!permit.keyId || permit.keyId !== this.keyId) {
        return this.deny('EXECUTION_KEY_MISMATCH', actionClass);
      }
    }

    // Permit validity window & TTL checks
    const notBefore = Date.parse(permit.notBefore);
    const expiresAt = Date.parse(permit.expiresAt);
    if ((!Number.isNaN(notBefore) && nowMs < notBefore - 1000) || (!Number.isNaN(expiresAt) && nowMs > expiresAt + 1000)) {
      return this.deny('EXECUTION_PERMIT_EXPIRED', actionClass);
    }

    if (permit.ttlMs !== undefined) {
      const issuedAt = Date.parse(permit.issuedAt);
      if (!Number.isNaN(issuedAt) && nowMs > issuedAt + Number(permit.ttlMs) + 1000) {
        return this.deny('EXECUTION_PERMIT_EXPIRED', actionClass);
      }
    }

    // Revocation check
    if (this.permitStore.isRevoked(permit.revocationId, permit.permitId)
      || (!durablePermit && (context?.revocations?.includes(permit.permitId) || context?.revocations?.includes(permit.revocationId)))) {
      return this.deny('EXECUTION_PERMIT_REVOKED', actionClass);
    }

    // Replay check
    if (this.permitStore.isReplay(permit.nonce, nowMs)) {
      return this.deny('EXECUTION_PERMIT_REVOKED', actionClass);
    }

    // Scope check: actionClasses (exact by default, explicit .* wildcard only)
    const allowedClasses = Array.isArray(permit.actionClasses) ? permit.actionClasses : [];
    if (!isActionScopeAllowed(allowedClasses, actionClass)) {
      return this.deny('EXECUTION_PERMIT_SCOPE_DENIED', actionClass);
    }

    // Scope check: executed parameter origin (required for every browser action)
    const executedOrigin = extractExecutedOrigin(params);
    if (!executedOrigin) {
      return this.deny('EXECUTION_PERMIT_SCOPE_DENIED', actionClass);
    }

    // If caller provided targetOrigin assertion in request, verify it normalizes and matches executedOrigin exactly
    if (targetOrigin !== null && targetOrigin !== undefined && targetOrigin !== '') {
      const assertedOrigin = normalizeOrigin(targetOrigin);
      if (!assertedOrigin || assertedOrigin !== executedOrigin) {
        return this.deny('EXECUTION_PERMIT_SCOPE_DENIED', actionClass);
      }
    }

    // If params also provided targetOrigin or sourceOrigin in addition to params.url, verify consistency
    if (typeof params?.url === 'string' && params.url.trim()) {
      if (params?.targetOrigin !== null && params?.targetOrigin !== undefined && params?.targetOrigin !== '') {
        const assertedParamOrigin = normalizeOrigin(params.targetOrigin);
        if (!assertedParamOrigin || assertedParamOrigin !== executedOrigin) {
          return this.deny('EXECUTION_PERMIT_SCOPE_DENIED', actionClass);
        }
      }
      if (params?.sourceOrigin !== null && params?.sourceOrigin !== undefined && params?.sourceOrigin !== '') {
        const assertedParamSource = normalizeOrigin(params.sourceOrigin);
        if (!assertedParamSource || assertedParamSource !== executedOrigin) {
          return this.deny('EXECUTION_PERMIT_SCOPE_DENIED', actionClass);
        }
      }
    }

    // Scope check: permit origins (reject empty/non-array, wildcards, or invalid/unnormalized entries)
    if (!Array.isArray(permit.origins) || permit.origins.length === 0 || permit.origins.some((o) => !isNormalizedHttpOrigin(o))) {
      return this.deny('EXECUTION_PERMIT_SCOPE_DENIED', actionClass);
    }
    if (!permit.origins.includes(executedOrigin)) {
      return this.deny('EXECUTION_PERMIT_SCOPE_DENIED', actionClass);
    }

    // Atomic budget check
    if (!this.checkBudget(permit, 1, dryRun)) {
      return this.deny('EXECUTION_BUDGET_EXHAUSTED', actionClass);
    }

    // Commit nonce if not dryRun
    if (!dryRun) {
      this.permitStore.markSeen(permit.nonce, permit.expiresAt);
      if (this.mode === 'enforce') {
        return { decision: 'allow', actionClass, permitId: permit.permitId };
      }
      if (this.mode === 'observe') {
        return { decision: 'would-allow', actionClass, permitId: permit.permitId };
      }
      return { decision: 'allow-off', actionClass, permitId: permit.permitId };
    }

    return { decision: 'allow', actionClass, permitId: permit.permitId };
  }

  verifyBatch({
    tool = 'browser_batch',
    params = {},
    permit = null,
    targetOrigin = null,
    profileId = null,
    context = null,
    now = new Date(),
    dryRun = false,
  } = {}) {
    const actions = params?.actions || params?.batch || [];
    if (!Array.isArray(actions) || actions.length === 0) {
      return this.verifyRequest({ tool, params, permit, targetOrigin, profileId, context, now, dryRun });
    }

    const callCount = actions.length;

    // Step 1: Preflight batch budget reservation before evaluating children
    if (!this.checkBudget(permit, callCount, true)) {
      return this.deny('EXECUTION_BUDGET_EXHAUSTED', 'browser.batch');
    }

    // Determine representative executed origin from first child for outer batch preflight
    const firstChild = actions[0];
    const firstChildOrigin = firstChild && typeof firstChild === 'object' && !Array.isArray(firstChild)
      ? extractExecutedOrigin(firstChild.params || firstChild)
      : null;
    const outerOrigin = firstChildOrigin || extractExecutedOrigin(params);

    // Step 2: Preflight outer permit validity in dry-run mode
    const outerParams = { ...params };
    if (!extractExecutedOrigin(outerParams) && outerOrigin) {
      outerParams.targetOrigin = outerOrigin;
    }
    const outerPreflight = this.verifyRequest({
      tool,
      params: outerParams,
      permit,
      targetOrigin: targetOrigin || outerOrigin,
      profileId,
      context,
      now,
      dryRun: true,
    });

    if (outerPreflight.decision === 'deny' || outerPreflight.decision === 'would-deny') {
      return outerPreflight;
    }

    // Step 3: Preflight every child action in dry-run mode before consuming any budget or replay state
    const childResults = [];
    let deniedResult = null;

    for (const act of actions) {
      if (!act || typeof act !== 'object' || Array.isArray(act)) {
        const res = this.deny('EXECUTION_PERMIT_MALFORMED', 'browser.batch');
        childResults.push(res);
        if (!deniedResult) deniedResult = res;
        continue;
      }

      if (typeof act.method !== 'string' || !act.method.trim()) {
        const res = this.deny('EXECUTION_PERMIT_MALFORMED', 'browser.unknown');
        childResults.push(res);
        if (!deniedResult) deniedResult = res;
        continue;
      }

      if (act.tool !== undefined && act.tool !== act.method) {
        const res = this.deny('EXECUTION_PERMIT_SCOPE_DENIED', this.classifyTool(act.method, act.params || {}));
        childResults.push(res);
        if (!deniedResult) deniedResult = res;
        continue;
      }

      if (act.action !== undefined && act.action !== act.method) {
        const res = this.deny('EXECUTION_PERMIT_SCOPE_DENIED', this.classifyTool(act.method, act.params || {}));
        childResults.push(res);
        if (!deniedResult) deniedResult = res;
        continue;
      }

      if (act.command !== undefined && act.command !== act.method) {
        const res = this.deny('EXECUTION_PERMIT_SCOPE_DENIED', this.classifyTool(act.method, act.params || {}));
        childResults.push(res);
        if (!deniedResult) deniedResult = res;
        continue;
      }

      const childMethod = act.method;
      const childParams = act.params || {};
      const childTargetOriginAssertion = act.targetOrigin || null;

      const childRes = this.verifyRequest({
        tool: childMethod,
        params: childParams,
        permit,
        targetOrigin: childTargetOriginAssertion,
        profileId,
        context,
        now,
        dryRun: true,
      });

      childResults.push(childRes);
      if ((childRes.decision === 'deny' || childRes.decision === 'would-deny') && !deniedResult) {
        deniedResult = childRes;
      }
    }

    // If ANY child fails preflight, deny entire composite batch immediately without consuming state
    if (deniedResult) {
      const decision = this.mode === 'observe' ? 'would-deny' : 'deny';
      return {
        decision,
        reason: deniedResult.reason || 'EXECUTION_PERMIT_SCOPE_DENIED',
        actionClass: 'browser.batch',
        children: childResults,
      };
    }

    // Step 4: All children passed preflight; atomically commit batch budget and mark replay nonce
    if (!dryRun) {
      this.checkBudget(permit, callCount, false);
      this.permitStore.markSeen(permit.nonce, permit.expiresAt);
      if (this.mode === 'enforce') {
        return {
          decision: 'allow',
          actionClass: 'browser.batch',
          permitId: permit?.permitId,
          children: childResults,
        };
      }
      if (this.mode === 'observe') {
        return {
          decision: 'would-allow',
          actionClass: 'browser.batch',
          permitId: permit?.permitId,
          children: childResults,
        };
      }
      return {
        decision: 'allow-off',
        actionClass: 'browser.batch',
        permitId: permit?.permitId,
        children: childResults,
      };
    }

    return {
      decision: 'allow',
      actionClass: 'browser.batch',
      permitId: permit?.permitId,
      children: childResults,
    };
  }
}
