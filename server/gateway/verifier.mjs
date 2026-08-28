import { verify } from 'node:crypto';
import { PermitStore } from './permit-store.mjs';

const ACTION_CLASS = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const ORIGIN = /^https?:\/\/[^/?#]+$/;

const TOOL_TO_ACTION = new Map([
  ['webmcp.invokeTool', 'browser.invokeTool'],
  ['webmcp.listTools', 'browser.listTools'],
  ['browser_navigate', 'browser.navigate'],
  ['browser_click', 'browser.click'],
  ['page.click', 'browser.click'],
  ['browser_raw_command', 'browser.raw'],
  ['browser_batch', 'browser.batch'],
]);

function classifyTool(tool, params) {
  if (TOOL_TO_ACTION.has(tool)) return TOOL_TO_ACTION.get(tool);
  if (tool.startsWith('browser_') || tool.startsWith('page.') || tool.startsWith('webmcp.')) return `browser.${tool.replace(/^browser[_.]|^page[_.]|^webmcp[_.]/,'')}`;
  return `browser.${tool}`;
}

function normalizeOrigin(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch { return null; }
}

export class GatewayVerifier {
  constructor({ publicKey, permitStore = new PermitStore(), mode = 'enforce' } = {}) {
    this.publicKey = publicKey;
    this.permitStore = permitStore;
    this.mode = mode; // off|observe|enforce
  }

  verifyRequest({ tool, params = {}, permit, targetOrigin, now = new Date() } = {}) {
    // Tool visibility is not authorization — always classify server-side
    const actionClass = classifyTool(tool, params);

    // Missing/invalid permit path
    if (!permit) {
      const decision = this.mode === 'enforce' ? 'deny' : 'would-deny';
      return { decision, reason: 'EXECUTION_PERMIT_REQUIRED', actionClass };
    }

    // Expired / notBefore window
    const notBefore = Date.parse(permit.notBefore);
    const expiresAt = Date.parse(permit.expiresAt);
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    if (nowMs < notBefore - 1000 || nowMs > expiresAt + 1000) {
      return { decision: 'deny', reason: 'EXECUTION_PERMIT_EXPIRED', actionClass };
    }

    // Revocation / replay
    if (this.permitStore.isRevoked(permit.revocationId, permit.permitId)) {
      return { decision: 'deny', reason: 'EXECUTION_PERMIT_REVOKED', actionClass };
    }
    if (this.permitStore.isReplay(permit.nonce, nowMs)) {
      return { decision: 'deny', reason: 'EXECUTION_PERMIT_REVOKED', actionClass };
    }

    // Digest + signature re-check (if publicKey available)
    if (this.publicKey && permit.signature) {
      try {
        const { permitDigest: _pd, signature: _sig, ...proj } = permit;
        const canonical = `webmcp-digest-v1\u0000webmcp-execution-permit/1\u0000${JSON.stringify(proj)}`;
        const toVerify = Buffer.from(canonical, 'utf8');
        const sig = Buffer.from(permit.signature, 'hex');
        const ok = verify(null, toVerify, this.publicKey, sig);
        if (!ok) return { decision: 'deny', reason: 'EXECUTION_PERMIT_REQUIRED', actionClass };
      } catch {
        return { decision: 'deny', reason: 'EXECUTION_PERMIT_REQUIRED', actionClass };
      }
    }

    // Scope checks: action, origin, profile, phase
    if (!permit.actionClasses?.includes(actionClass) && !permit.actionClasses?.includes('*') && actionClass !== 'browser.raw' && actionClass !== 'browser.batch') {
      // raw/batch need recursive child checks handled by caller
      if (!actionClass.startsWith('browser.') || !permit.actionClasses.some(c => actionClass === c || actionClass.startsWith(c+'.'))) {
        return { decision: 'deny', reason: 'EXECUTION_PERMIT_SCOPE_DENIED', actionClass };
      }
    }
    if (targetOrigin && permit.origins?.length) {
      const origin = normalizeOrigin(targetOrigin) || targetOrigin;
      if (!permit.origins.includes(origin)) return { decision: 'deny', reason: 'EXECUTION_PERMIT_SCOPE_DENIED', actionClass };
    }

    // Budget atomic reserve (must happen before execution)
    if (permit.budget?.maxCalls !== undefined) {
      const reserved = this.permitStore.tryReserve(permit);
      if (!reserved) return { decision: 'deny', reason: 'EXECUTION_BUDGET_EXHAUSTED', actionClass };
    }

    // raw_command unknown action deny in enforce
    if (tool === 'browser_raw_command') {
      const inner = params?.method || params?.command || params?.action;
      if (!inner || typeof inner !== 'string' || !ACTION_CLASS.test(inner.replaceAll('.','_'))) {
        if (this.mode === 'enforce') return { decision: 'deny', reason: 'TOOL_ACTION_NOT_ALLOWED', actionClass: 'browser.raw.unknown' };
      }
    }

    // batch recursive: caller should have expanded; if batch contains disallowed child, outer must deny
    // This verifier handles single action; batch expansion is in caller

    if (this.mode === 'enforce') {
      this.permitStore.markSeen(permit.nonce, permit.expiresAt);
      return { decision: 'allow', actionClass };
    }
    if (this.mode === 'observe') {
      this.permitStore.markSeen(permit.nonce, permit.expiresAt);
      return { decision: 'would-allow', actionClass };
    }
    // off
    return { decision: 'allow-off', actionClass };
  }

  verifyBatch({ tool, params, permit, now } = {}) {
    // Expect params.actions is array of {tool, params, targetOrigin}
    const actions = params?.actions || params?.batch || [];
    if (!Array.isArray(actions) || !actions.length) return this.verifyRequest({ tool, params, permit, now });
    const results = [];
    let denyReason = null;
    for (const act of actions) {
      const r = this.verifyRequest({ tool: act.tool || tool, params: act.params || {}, permit, targetOrigin: act.targetOrigin, now });
      results.push(r);
      if (r.decision === 'deny') denyReason = r.reason;
    }
    if (denyReason) return { decision: 'deny', reason: denyReason, actionClass: 'browser.batch', children: results };
    return { decision: 'allow', actionClass: 'browser.batch', children: results };
  }
}
