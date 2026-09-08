import { createHash, createPublicKey, randomBytes } from 'node:crypto';

export const SCHEMAS = Object.freeze({
  TRUSTED_CONTEXT: 'webmcp-trusted-context/1',
  PERMIT: 'webmcp-execution-permit/1',
  DURABLE_PERMIT: 'webmcp-durable-execution-permit/1',
  RECEIPT: 'webmcp-execution-receipt/1',
  ACK: 'webmcp-trusted-context-ack/1',
});

export function permitDigestDomain(permit) {
  return permit?.schema === SCHEMAS.DURABLE_PERMIT
    ? 'webmcp-digest-v1:durable-permit'
    : 'webmcp-digest-v1:permit';
}

export const RECEIPT_DIGEST_DOMAIN = 'webmcp-digest-v1:tool-receipt';
export const ACTION_DIGEST_DOMAIN = 'webmcp-digest-v1:interactive-action';
export const RECEIPT_ORDER_DOMAIN = 'webmcp-digest-v1:interactive-receipt-order';
export const OUTPUT_DOMAIN = 'webmcp-digest-v1:interactive-output';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Strict RFC 8785 JSON Canonicalization Scheme (JCS) serializer.
 * Deterministically sorts object keys by UTF-16 code units.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Computes a SHA-256 digest over canonical JSON with optional domain label separation.
 */
export function digestCanonical(domainLabel, value) {
  const canonical = typeof value === 'string' ? value : canonicalJson(value);
  const input = domainLabel ? `${domainLabel}\n${canonical}` : canonical;
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

/**
 * Computes actionDigest over canonical {method,params,targetOrigin} with fixed domain.
 */
export function digestAction({ method, params, targetOrigin }) {
  const normalizedParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const payload = {
    method: String(method || ''),
    params: normalizedParams,
    targetOrigin: targetOrigin || null,
  };
  return digestCanonical(ACTION_DIGEST_DOMAIN, payload);
}

/**
 * Computes resultDigest over canonical result (or null).
 */
export function digestResult(result) {
  if (result === null || result === undefined) return null;
  return digestCanonical('webmcp-digest-v1:interactive-result', result);
}

/**
 * Builds evidence summary without leaking raw content.
 */
export function buildEvidence(result) {
  if (result === null || result === undefined) {
    return Object.freeze({ types: [], count: 0, bytes: 0 });
  }
  try {
    const canonical = canonicalJson(result);
    const bytes = Buffer.byteLength(canonical, 'utf8');
    const types = [];
    if (result && typeof result === 'object') {
      if ('result' in result || 'error' in result) types.push('json-rpc');
      else types.push('result');
    } else {
      types.push(typeof result);
    }
    return Object.freeze({ types, count: types.length, bytes });
  } catch {
    return Object.freeze({ types: ['unknown'], count: 1, bytes: 0 });
  }
}

/**
 * Receipt-order digest for cross-package closure.
 */
export function digestReceiptOrder(receipts) {
  if (!Array.isArray(receipts)) return digestCanonical(RECEIPT_ORDER_DOMAIN, []);
  const ordered = receipts
    .map((r) => ({ sequence: r.sequence, receiptId: r.receiptId, receiptDigest: r.receiptDigest }));
  return digestCanonical(RECEIPT_ORDER_DOMAIN, ordered);
}

/**
 * Output digest for cross-package closure.
 */
export function digestOutput(resultDigests) {
  return digestCanonical(OUTPUT_DOMAIN, { resultDigests: [...resultDigests] });
}

/**
 * Converts various key representations (KeyObject, PEM string, DER buffer, raw 32-byte hex)
 * into a Node.js crypto KeyObject.
 */
export function toKeyObject(keyInput) {
  if (!keyInput) return null;
  if (typeof keyInput === 'object' && keyInput.type === 'public') {
    return keyInput;
  }
  if (typeof keyInput === 'string') {
    if (keyInput.startsWith('-----BEGIN')) {
      return createPublicKey(keyInput);
    }
    // 64-char hex string: raw 32-byte Ed25519 public key
    if (/^[0-9a-fA-F]{64}$/.test(keyInput)) {
      const rawBuf = Buffer.from(keyInput, 'hex');
      const spkiBuf = Buffer.concat([ED25519_SPKI_PREFIX, rawBuf]);
      return createPublicKey({ key: spkiBuf, format: 'der', type: 'spki' });
    }
    // 88-char hex string: full SPKI DER
    if (/^[0-9a-fA-F]{88}$/.test(keyInput)) {
      const spkiBuf = Buffer.from(keyInput, 'hex');
      return createPublicKey({ key: spkiBuf, format: 'der', type: 'spki' });
    }
  }
  if (Buffer.isBuffer(keyInput)) {
    if (keyInput.length === 32) {
      const spkiBuf = Buffer.concat([ED25519_SPKI_PREFIX, keyInput]);
      return createPublicKey({ key: spkiBuf, format: 'der', type: 'spki' });
    }
    return createPublicKey({ key: keyInput, format: 'der', type: 'spki' });
  }
  return null;
}

/**
 * Compares two public keys to determine if they represent the exact same key.
 */
export function keysMatch(keyA, keyB) {
  if (!keyA || !keyB) return false;
  try {
    const objA = toKeyObject(keyA);
    const objB = toKeyObject(keyB);
    if (!objA || !objB) return false;
    const derA = objA.export({ type: 'spki', format: 'der' });
    const derB = objB.export({ type: 'spki', format: 'der' });
    return Buffer.compare(derA, derB) === 0;
  } catch {
    return false;
  }
}

/**
 * Exports raw 32-byte Ed25519 public key hex string from any supported key format.
 */
export function toRawPublicKeyHex(keyInput) {
  const obj = toKeyObject(keyInput);
  if (!obj) return null;
  const der = obj.export({ type: 'spki', format: 'der' });
  return der.subarray(-32).toString('hex');
}

const SHA256_PATTERN = /^sha256:[0-9a-fA-F]{64}$/;
const SAFE_REASON_PATTERN = /^[A-Z][A-Z0-9_:-]{1,96}$/;
const SAFE_EVIDENCE_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const SAFE_RECEIPT_CHILD_FIELDS = Object.freeze([
  'schema', 'receiptId', 'permitId', 'runId', 'projectId', 'profileAlias', 'profileId',
  'claimGeneration', 'claimDigest', 'fenceEpoch', 'phaseId', 'bindingId', 'bindingRevision',
  'bindingDigest', 'automationStoreRevision', 'automationStoreDigest', 'siteStoreRevision',
  'siteStoreDigest', 'stateVersion', 'planRevision', 'planDigest', 'instructionDigest',
  'policyRevision', 'actionClass', 'attempt', 'outcome', 'sequence', 'actionDigest',
  'targetOrigin', 'resultDigest', 'evidence', 'decision', 'reason', 'evaluatedAt',
  'receiptDigest',
]);

function safeReasonCode(reason) {
  if (reason === null || reason === undefined) return null;
  return typeof reason === 'string' && SAFE_REASON_PATTERN.test(reason) ? reason : 'EXECUTION_FAILED';
}

function safeEvidenceSummary(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || !Array.isArray(evidence.types)
    || evidence.types.some((type) => typeof type !== 'string' || !SAFE_EVIDENCE_TYPE_PATTERN.test(type))
    || new Set(evidence.types).size !== evidence.types.length
    || !Number.isInteger(evidence.count) || evidence.count < 0
    || evidence.count !== evidence.types.length
    || !Number.isInteger(evidence.bytes) || evidence.bytes < 0) {
    return Object.freeze({ types: [], count: 0, bytes: 0 });
  }
  return Object.freeze({
    types: [...evidence.types],
    count: evidence.count,
    bytes: evidence.bytes,
  });
}

function projectChildReceipt(child) {
  if (!child || typeof child !== 'object' || Array.isArray(child)) return null;
  const projected = {};
  for (const key of SAFE_RECEIPT_CHILD_FIELDS) {
    if (child[key] !== undefined) projected[key] = child[key];
  }
  projected.evidence = safeEvidenceSummary(projected.evidence);
  if ('reason' in projected) projected.reason = safeReasonCode(projected.reason);
  return projected;
}

/**
 * Validates the structure and field types of a trusted-context message.
 */
export function validateTrustedContextMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'Message must be an object' };
  }

  if (input.schema !== SCHEMAS.TRUSTED_CONTEXT) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_SCHEMA_UNSUPPORTED', error: `Expected schema ${SCHEMAS.TRUSTED_CONTEXT}` };
  }

  if (typeof input.messageId !== 'string' || input.messageId.length < 4 || input.messageId.length > 128) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'messageId is invalid' };
  }

  if (input.seq !== undefined && (!Number.isInteger(input.seq) || input.seq < 1)) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'seq must be a positive integer' };
  }

  if (typeof input.runId !== 'string' || !input.runId.trim()) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'runId is required' };
  }

  if (typeof input.claimGeneration !== 'number' || !Number.isInteger(input.claimGeneration) || input.claimGeneration < 0) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'claimGeneration must be non-negative integer' };
  }

  if (typeof input.claimDigest !== 'string' || !SHA256_PATTERN.test(input.claimDigest)) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'claimDigest must be a valid sha256 digest' };
  }

  if (typeof input.projectId !== 'string' || !input.projectId.trim()) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'projectId is required' };
  }

  if (typeof input.profileAlias !== 'string' || !input.profileAlias.trim()) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'profileAlias is required' };
  }

  if (typeof input.profileId !== 'string' || !input.profileId.trim()) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'profileId is required' };
  }

  if (typeof input.bindingId !== 'string' || !input.bindingId.trim()) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'bindingId is required' };
  }

  if (typeof input.bindingRevision !== 'number' || !Number.isInteger(input.bindingRevision) || input.bindingRevision < 0) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'bindingRevision must be non-negative integer' };
  }

  if (typeof input.bindingDigest !== 'string' || !SHA256_PATTERN.test(input.bindingDigest)) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'bindingDigest must be a valid sha256 digest' };
  }

  if (typeof input.automationStoreRevision !== 'number' || !Number.isInteger(input.automationStoreRevision) || input.automationStoreRevision < 0) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'automationStoreRevision must be non-negative integer' };
  }

  if (typeof input.automationStoreDigest !== 'string' || !SHA256_PATTERN.test(input.automationStoreDigest)) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'automationStoreDigest must be a valid sha256 digest' };
  }

  if (typeof input.siteStoreRevision !== 'number' || !Number.isInteger(input.siteStoreRevision) || input.siteStoreRevision < 0) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'siteStoreRevision must be non-negative integer' };
  }

  if (typeof input.siteStoreDigest !== 'string' || !SHA256_PATTERN.test(input.siteStoreDigest)) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'siteStoreDigest must be a valid sha256 digest' };
  }

  if (typeof input.fenceEpoch !== 'number' || !Number.isInteger(input.fenceEpoch) || input.fenceEpoch < 0) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'fenceEpoch must be non-negative integer' };
  }

  if (typeof input.phaseId !== 'string' || !input.phaseId.trim()) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'phaseId is required' };
  }

  if (typeof input.stateVersion !== 'number' || !Number.isInteger(input.stateVersion) || input.stateVersion < 0) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'stateVersion must be non-negative integer' };
  }

  if (typeof input.planRevision !== 'number' || !Number.isInteger(input.planRevision) || input.planRevision < 0) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'planRevision must be non-negative integer' };
  }

  if (typeof input.planDigest !== 'string' || !SHA256_PATTERN.test(input.planDigest)) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'planDigest must be a valid sha256 digest' };
  }

  if (typeof input.instructionDigest !== 'string' || !SHA256_PATTERN.test(input.instructionDigest)) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'instructionDigest must be a valid sha256 digest' };
  }

  if (typeof input.policyRevision !== 'string' || !input.policyRevision.trim()) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'policyRevision is required' };
  }

  if (typeof input.ttlMs !== 'number' || !Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 60000) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'ttlMs must be a positive number <= 60000' };
  }

  if (typeof input.keyId !== 'string' || !input.keyId.trim()) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'keyId is required' };
  }

  if (!input.publicKey || (typeof input.publicKey !== 'string' && !Buffer.isBuffer(input.publicKey))) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'publicKey is required' };
  }

  if (!toKeyObject(input.publicKey)) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'publicKey is invalid' };
  }

  if (typeof input.issuedAt !== 'string' || Number.isNaN(Date.parse(input.issuedAt))) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'issuedAt must be a valid ISO date' };
  }

  if (typeof input.notBefore !== 'string' || Number.isNaN(Date.parse(input.notBefore))) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'notBefore must be a valid ISO date' };
  }

  if (typeof input.expiresAt !== 'string' || Number.isNaN(Date.parse(input.expiresAt))) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'expiresAt must be a valid ISO date' };
  }

  if (input.revocations !== undefined && (!Array.isArray(input.revocations) || input.revocations.some((r) => typeof r !== 'string'))) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'revocations must be an array of strings' };
  }

  if (typeof input.signature !== 'string' || !input.signature.trim()) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_FORGED', error: 'signature is required' };
  }

  if (typeof input.contextDigest !== 'string' || !SHA256_PATTERN.test(input.contextDigest)) {
    return { ok: false, reason: 'TRUSTED_CONTEXT_MALFORMED', error: 'contextDigest must be a valid sha256 digest' };
  }

  return { ok: true, value: input };
}

export function isNormalizedHttpOrigin(origin) {
  if (typeof origin !== 'string' || !origin.trim() || origin.includes('*')) {
    return false;
  }
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return false;
    }
    return u.origin === origin;
  } catch {
    return false;
  }
}

/**
 * Validates structural requirements for an execution permit.
 */
export function validatePermitStructure(permit) {
  if (!permit || typeof permit !== 'object' || Array.isArray(permit)) {
    return { ok: false, reason: 'EXECUTION_PERMIT_REQUIRED', error: 'Permit must be an object' };
  }

  const durablePermit = permit.schema === SCHEMAS.DURABLE_PERMIT;
  if (permit.schema !== SCHEMAS.PERMIT && !durablePermit) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: `Expected schema ${SCHEMAS.PERMIT}` };
  }

  if (typeof permit.permitId !== 'string' || !permit.permitId.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'permitId is required' };
  }

  if (typeof permit.runId !== 'string' || !permit.runId.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'runId is required' };
  }

  if (typeof permit.claimGeneration !== 'number' || !Number.isInteger(permit.claimGeneration) || permit.claimGeneration < 0) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'claimGeneration must be non-negative integer' };
  }

  if (typeof permit.claimDigest !== 'string' || !SHA256_PATTERN.test(permit.claimDigest)) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'claimDigest must be a valid sha256 digest' };
  }

  if (typeof permit.projectId !== 'string' || !permit.projectId.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'projectId is required' };
  }

  if (typeof permit.profileAlias !== 'string' || !permit.profileAlias.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'profileAlias is required' };
  }

  if (!durablePermit && (typeof permit.profileId !== 'string' || !permit.profileId.trim())) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'profileId is required' };
  }

  if (typeof permit.bindingId !== 'string' || !permit.bindingId.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'bindingId is required' };
  }

  if (typeof permit.bindingRevision !== 'number' || !Number.isInteger(permit.bindingRevision) || permit.bindingRevision < 0) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'bindingRevision must be non-negative integer' };
  }

  if (typeof permit.bindingDigest !== 'string' || !SHA256_PATTERN.test(permit.bindingDigest)) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'bindingDigest must be a valid sha256 digest' };
  }

  if (!durablePermit && (typeof permit.automationStoreRevision !== 'number' || !Number.isInteger(permit.automationStoreRevision) || permit.automationStoreRevision < 0)) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'automationStoreRevision must be non-negative integer' };
  }

  if (!durablePermit && (typeof permit.automationStoreDigest !== 'string' || !SHA256_PATTERN.test(permit.automationStoreDigest))) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'automationStoreDigest must be a valid sha256 digest' };
  }

  if (!durablePermit && (typeof permit.siteStoreRevision !== 'number' || !Number.isInteger(permit.siteStoreRevision) || permit.siteStoreRevision < 0)) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'siteStoreRevision must be non-negative integer' };
  }

  if (!durablePermit && (typeof permit.siteStoreDigest !== 'string' || !SHA256_PATTERN.test(permit.siteStoreDigest))) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'siteStoreDigest must be a valid sha256 digest' };
  }

  if (typeof permit.phaseId !== 'string' || !permit.phaseId.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'phaseId is required' };
  }

  if (!Array.isArray(permit.origins) || permit.origins.length === 0 || permit.origins.some((o) => !isNormalizedHttpOrigin(o))) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'origins must be non-empty array of explicit normalized http/https origins and cannot contain wildcards' };
  }

  if (!Array.isArray(permit.actionClasses) || permit.actionClasses.length === 0 || permit.actionClasses.some((a) => typeof a !== 'string' || !a.trim() || a.trim() === '*' || (a.includes('*') && a !== 'browser.raw.*'))) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'actionClasses must be non-empty array of exact classes or explicit "browser.raw.*" and cannot contain arbitrary wildcards' };
  }

  if (!permit.budget || typeof permit.budget !== 'object' || typeof permit.budget.maxCalls !== 'number' || !Number.isInteger(permit.budget.maxCalls) || permit.budget.maxCalls <= 0) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'budget.maxCalls must be a positive integer' };
  }

  if (typeof permit.stateVersion !== 'number' || !Number.isInteger(permit.stateVersion) || permit.stateVersion < 0) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'stateVersion must be non-negative integer' };
  }

  if (typeof permit.planRevision !== 'number' || !Number.isInteger(permit.planRevision) || permit.planRevision < 0) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'planRevision must be non-negative integer' };
  }

  if (typeof permit.planDigest !== 'string' || !SHA256_PATTERN.test(permit.planDigest)) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'planDigest must be a valid sha256 digest' };
  }

  if (typeof permit.instructionDigest !== 'string' || !SHA256_PATTERN.test(permit.instructionDigest)) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'instructionDigest must be a valid sha256 digest' };
  }

  if (typeof permit.policyRevision !== 'string' || !permit.policyRevision.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'policyRevision is required' };
  }

  if (typeof permit.keyId !== 'string' || !permit.keyId.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'keyId is required' };
  }

  if (typeof permit.nonce !== 'string' || !permit.nonce.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'nonce is required' };
  }

  if (typeof permit.issuedAt !== 'string' || Number.isNaN(Date.parse(permit.issuedAt))) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'issuedAt must be a valid ISO date' };
  }

  if (typeof permit.notBefore !== 'string' || Number.isNaN(Date.parse(permit.notBefore))) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'notBefore must be a valid ISO date' };
  }

  if (typeof permit.expiresAt !== 'string' || Number.isNaN(Date.parse(permit.expiresAt))) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'expiresAt must be a valid ISO date' };
  }

  if (typeof permit.ttlMs !== 'number' || !Number.isFinite(permit.ttlMs) || permit.ttlMs <= 0 || permit.ttlMs > 60000) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'ttlMs must be a positive number <= 60000' };
  }

  if (typeof permit.revocationId !== 'string' || !permit.revocationId.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'revocationId is required' };
  }

  if (typeof permit.signature !== 'string' || !permit.signature.trim()) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'signature is required' };
  }

  if (typeof permit.permitDigest !== 'string' || !SHA256_PATTERN.test(permit.permitDigest)) {
    return { ok: false, reason: 'EXECUTION_PERMIT_MALFORMED', error: 'permitDigest must be a valid sha256 digest' };
  }

  return { ok: true, value: permit };
}

/**
 * Creates a bounded, redacted execution receipt matching E5 live contract.
 * No raw params/results, credentials, cookies, tokens, private keys, physical paths,
 * machine identity or provider context.
 */
export function createSafeReceipt({
  permitId = null,
  runId = null,
  projectId = null,
  profileAlias = null,
  profileId = null,
  claimGeneration = null,
  claimDigest = null,
  fenceEpoch = null,
  phaseId = null,
  bindingId = null,
  bindingRevision = null,
  bindingDigest = null,
  automationStoreRevision = null,
  automationStoreDigest = null,
  siteStoreRevision = null,
  siteStoreDigest = null,
  stateVersion = null,
  planRevision = null,
  planDigest = null,
  instructionDigest = null,
  policyRevision = null,
  actionClass = null,
  attempt = 'not-attempted',
  outcome = 'not-applied',
  sequence = 1,
  method = null,
  params = null,
  targetOrigin = null,
  resultDigest = null,
  evidence = null,
  decision = null,
  reason = null,
  children = null,
} = {}) {
  // Normalize attempt/outcome
  const validAttempts = new Set(['not-attempted', 'attempted']);
  const validOutcomes = new Set(['not-applied', 'applied', 'failed', 'blocked', 'indeterminate', 'fence-lost']);
  const safeAttempt = validAttempts.has(attempt) ? attempt : 'not-attempted';
  const safeOutcome = validOutcomes.has(outcome) ? outcome : 'not-applied';
  const safeSequence = Number.isInteger(sequence) && sequence >= 1 ? sequence : 1;

  // Normalize targetOrigin: explicit normalized http/https or null
  let safeTargetOrigin = null;
  if (typeof targetOrigin === 'string' && targetOrigin) {
    try {
      const u = new URL(targetOrigin);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === targetOrigin) {
        safeTargetOrigin = targetOrigin;
      }
    } catch {
      safeTargetOrigin = null;
    }
  }

  // Compute actionDigest over canonical {method,params,targetOrigin}
  const safeMethod = typeof method === 'string' && method ? method : (actionClass ? actionClass.replace('.', '_') : 'unknown');
  const safeParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  let actionDigest = null;
  try {
    actionDigest = digestAction({ method: safeMethod, params: safeParams, targetOrigin: safeTargetOrigin });
  } catch {
    actionDigest = null;
  }

  // Normalize resultDigest
  let safeResultDigest = null;
  if (resultDigest === null || resultDigest === undefined) {
    safeResultDigest = null;
  } else if (typeof resultDigest === 'string' && SHA256_PATTERN.test(resultDigest)) {
    safeResultDigest = resultDigest.toLowerCase();
  } else if (typeof resultDigest === 'string') {
    safeResultDigest = null;
  } else {
    safeResultDigest = null;
  }

  // Normalize evidence
  const safeEvidence = safeEvidenceSummary(evidence);

  // Legacy decision mapping for backward compat (E4)
  let legacyDecision = ['allow', 'deny', 'would-allow', 'would-deny'].includes(decision) ? decision : null;
  if (!legacyDecision) {
    if (safeOutcome === 'applied') legacyDecision = 'allow';
    else if (safeOutcome === 'blocked' || safeOutcome === 'not-applied' || safeOutcome === 'fence-lost') legacyDecision = 'deny';
    else if (safeOutcome === 'failed' || safeOutcome === 'indeterminate') legacyDecision = 'allow';
    else legacyDecision = 'deny';
    if (safeAttempt === 'not-attempted' && (safeOutcome === 'blocked' || safeOutcome === 'not-applied')) {
      legacyDecision = 'deny';
    }
  }

  const receipt = {
    schema: SCHEMAS.RECEIPT,
    receiptId: `rcpt_${randomBytes(8).toString('hex')}`,
    permitId: permitId || null,
    runId: runId || null,
    projectId: projectId || null,
    profileAlias: profileAlias || null,
    profileId: profileId || null,
    claimGeneration: claimGeneration !== null && claimGeneration !== undefined ? claimGeneration : null,
    claimDigest: claimDigest || null,
    fenceEpoch: fenceEpoch !== null && fenceEpoch !== undefined ? fenceEpoch : null,
    phaseId: phaseId || null,
    bindingId: bindingId || null,
    bindingRevision: bindingRevision !== null && bindingRevision !== undefined ? bindingRevision : null,
    bindingDigest: bindingDigest || null,
    automationStoreRevision: automationStoreRevision !== null && automationStoreRevision !== undefined ? automationStoreRevision : null,
    automationStoreDigest: automationStoreDigest || null,
    siteStoreRevision: siteStoreRevision !== null && siteStoreRevision !== undefined ? siteStoreRevision : null,
    siteStoreDigest: siteStoreDigest || null,
    stateVersion: stateVersion !== null && stateVersion !== undefined ? stateVersion : null,
    planRevision: planRevision !== null && planRevision !== undefined ? planRevision : null,
    planDigest: planDigest || null,
    instructionDigest: instructionDigest || null,
    policyRevision: policyRevision || null,
    actionClass: actionClass || null,
    attempt: safeAttempt,
    outcome: safeOutcome,
    sequence: safeSequence,
    actionDigest,
    targetOrigin: safeTargetOrigin,
    resultDigest: safeResultDigest,
    evidence: safeEvidence,
    decision: legacyDecision,
    reason: safeReasonCode(reason),
    evaluatedAt: new Date().toISOString(),
  };

  if (Array.isArray(children)) {
    const projectedChildren = children.map(projectChildReceipt);
    if (projectedChildren.some((child) => !child)) {
      throw new Error('Receipt children must be safe receipt objects');
    }
    receipt.children = projectedChildren;
  }

  const { receiptDigest: _rd, ...receiptProjection } = receipt;
  receipt.receiptDigest = digestCanonical(RECEIPT_DIGEST_DOMAIN, receiptProjection);

  return Object.freeze(receipt);
}

/**
 * Returns a sanitized view of the active trusted context for diagnostics.
 */
export function redactContext(context) {
  if (!context) return null;
  return {
    schema: context.schema || SCHEMAS.TRUSTED_CONTEXT,
    messageId: context.messageId,
    seq: context.seq,
    runId: context.runId || null,
    projectId: context.projectId,
    profileAlias: context.profileAlias || context.profileId || null,
    profileId: context.profileId || context.profileAlias || null,
    bindingId: context.bindingId || null,
    bindingRevision: context.bindingRevision ?? null,
    bindingDigest: context.bindingDigest || null,
    fenceEpoch: context.fenceEpoch ?? null,
    phaseId: context.phaseId || null,
    automationStoreRevision: context.automationStoreRevision ?? null,
    automationStoreDigest: context.automationStoreDigest || null,
    siteStoreRevision: context.siteStoreRevision ?? null,
    siteStoreDigest: context.siteStoreDigest || null,
    policyRevision: context.policyRevision || null,
    planRevision: context.planRevision ?? null,
    planDigest: context.planDigest || null,
    instructionDigest: context.instructionDigest || null,
    stateVersion: context.stateVersion ?? null,
    keyId: context.keyId || null,
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
    ttlMs: context.ttlMs ?? null,
    contextDigest: context.contextDigest || null,
  };
}
