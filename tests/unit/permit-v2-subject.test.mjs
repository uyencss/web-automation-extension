import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import {
  canonicalJson,
  digestCanonical,
  permitDigestDomain,
  validatePermitStructure,
  SCHEMAS,
} from '../../server/gateway/trusted-context-schema.mjs';
import { PermitStore } from '../../server/gateway/permit-store.mjs';
import { GatewayVerifier } from '../../server/gateway/verifier.mjs';

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { publicKey, privateKey, rawPublicKeyHex, keyId: 'ed25519-test-key-01' };
}

const DIGEST = (ch) => `sha256:${ch.repeat(64)}`;

const VALID_SESSION_ID = 'sess_0123456789abcdef0123456789abcdef';
const VALID_PERMIT_CORRELATION = 'corr_session_0123456789abcdef0123456789abcdef';
const VALID_SESSION_CONTEXT_DIGEST = DIGEST('a');
const VALID_RUN_ID = 'run_0123456789abcdef';

function buildSignedV2Permit({
  keys = makeKeyPair(),
  permitId = `permit_${Math.random().toString(36).slice(2, 10)}`,
  subjectType = 'interactive-session',
  runId = undefined,
  sessionId = VALID_SESSION_ID,
  permitCorrelation = VALID_PERMIT_CORRELATION,
  sessionContextDigest = VALID_SESSION_CONTEXT_DIGEST,
  claimGeneration = 2,
  claimDigest = DIGEST('0'),
  projectId = 'project_test_123',
  profileAlias = 'interactive-profile',
  profileId = null,
  bindingId = 'pb_test_123',
  bindingRevision = 2,
  bindingDigest = DIGEST('1'),
  automationStoreRevision = 3,
  automationStoreDigest = DIGEST('2'),
  siteStoreRevision = 4,
  siteStoreDigest = DIGEST('3'),
  actionClasses = ['browser.navigate'],
  origins = ['https://example.test'],
  budget = { maxCalls: 5 },
  stateVersion = 1,
  planRevision = 1,
  planDigest = DIGEST('4'),
  instructionDigest = DIGEST('5'),
  policyRevision = DIGEST('6'),
  expiresAt = new Date(Date.now() + 30000).toISOString(),
  notBefore = new Date(Date.now() - 1000).toISOString(),
  nonce = `nonce_${Math.random().toString(36).slice(2, 18)}`,
  revocationId = 'rev_001',
  ttlMs = 30000,
  issuedAt = new Date().toISOString(),
  phaseId = 'interactive-action',
} = {}) {
  const base = {
    schema: SCHEMAS.PERMIT_V2,
    subjectType,
    ...(subjectType === 'interactive-session' ? {
      sessionId,
      permitCorrelation,
      sessionContextDigest,
    } : {
      runId: runId || VALID_RUN_ID,
    }),
    permitId,
    claimGeneration,
    claimDigest,
    projectId,
    profileAlias,
    profileId: profileId || profileAlias,
    bindingId,
    bindingRevision,
    bindingDigest,
    automationStoreRevision,
    automationStoreDigest,
    siteStoreRevision,
    siteStoreDigest,
    phaseId,
    origins,
    actionClasses,
    budget,
    stateVersion,
    planRevision,
    planDigest,
    instructionDigest,
    policyRevision,
    keyId: keys.keyId,
    nonce,
    issuedAt,
    notBefore,
    expiresAt,
    ttlMs,
    revocationId,
  };
  const canonical = canonicalJson(base);
  const toSign = Buffer.from(`${permitDigestDomain(base)}\n${canonical}`, 'utf8');
  const signature = sign(null, toSign, keys.privateKey).toString('hex');
  const permitDigest = digestCanonical(permitDigestDomain(base), base);
  return { permit: { ...base, signature, permitDigest }, keys };
}

function buildSignedContext({
  keys = makeKeyPair(),
  runId = VALID_PERMIT_CORRELATION,
  claimGeneration = 2,
  claimDigest = DIGEST('0'),
  projectId = 'project_test_123',
  profileAlias = 'interactive-profile',
  profileId = null,
  bindingId = 'pb_test_123',
  bindingRevision = 2,
  bindingDigest = DIGEST('1'),
  automationStoreRevision = 3,
  automationStoreDigest = DIGEST('2'),
  siteStoreRevision = 4,
  siteStoreDigest = DIGEST('3'),
  fenceEpoch = 2,
  phaseId = 'interactive-action',
  stateVersion = 1,
  planRevision = 1,
  planDigest = DIGEST('4'),
  instructionDigest = DIGEST('5'),
  policyRevision = DIGEST('6'),
  ttlMs = 30000,
  notBefore = new Date(Date.now() - 1000).toISOString(),
  expiresAt = new Date(Date.now() + 30000).toISOString(),
} = {}) {
  const base = {
    schema: SCHEMAS.TRUSTED_CONTEXT,
    messageId: `ctxmsg_${Math.random().toString(36).slice(2, 10)}`,
    seq: 1,
    runId,
    claimGeneration,
    claimDigest,
    projectId,
    profileAlias,
    profileId: profileId || profileAlias,
    bindingId,
    bindingRevision,
    bindingDigest,
    automationStoreRevision,
    automationStoreDigest,
    siteStoreRevision,
    siteStoreDigest,
    fenceEpoch,
    phaseId,
    stateVersion,
    planRevision,
    planDigest,
    instructionDigest,
    policyRevision,
    ttlMs,
    keyId: keys.keyId,
    publicKey: keys.rawPublicKeyHex,
    issuedAt: new Date().toISOString(),
    notBefore,
    expiresAt,
    revocations: [],
  };
  const canonical = canonicalJson(base);
  const contextDigest = digestCanonical('webmcp-digest-v1:trusted-context', base);
  const toSign = Buffer.from(`webmcp-digest-v1:trusted-context\n${canonical}`, 'utf8');
  const signature = sign(null, toSign, keys.privateKey).toString('hex');
  return { ...base, signature, contextDigest };
}

// ─── 1. DIGEST DOMAIN CHECKS ────────────────────────────────────────────────

test('permitDigestDomain: explicit v2 branch returns webmcp-digest-v1:permit', () => {
  assert.equal(permitDigestDomain({ schema: 'webmcp-execution-permit/2' }), 'webmcp-digest-v1:permit');
  assert.equal(permitDigestDomain({ schema: SCHEMAS.PERMIT_V2 }), 'webmcp-digest-v1:permit');
  assert.equal(permitDigestDomain({ schema: SCHEMAS.PERMIT }), 'webmcp-digest-v1:permit');
  assert.equal(permitDigestDomain({ schema: SCHEMAS.DURABLE_PERMIT }), 'webmcp-digest-v1:durable-permit');
});

// ─── 2. STRUCTURE VALIDATION POSITIVE ────────────────────────────────────────

test('validatePermitStructure: validates valid v2 interactive-session permit', () => {
  const { permit } = buildSignedV2Permit({ subjectType: 'interactive-session' });
  const result = validatePermitStructure(permit);
  assert.equal(result.ok, true);
  assert.equal(result.value.schema, 'webmcp-execution-permit/2');
  assert.equal(result.value.subjectType, 'interactive-session');
  assert.equal('runId' in result.value, false);
});

test('validatePermitStructure: validates valid v2 runner-run permit', () => {
  const { permit } = buildSignedV2Permit({ subjectType: 'runner-run', runId: VALID_RUN_ID });
  const result = validatePermitStructure(permit);
  assert.equal(result.ok, true);
  assert.equal(result.value.schema, 'webmcp-execution-permit/2');
  assert.equal(result.value.subjectType, 'runner-run');
  assert.equal(result.value.runId, VALID_RUN_ID);
});

// ─── 3. STRUCTURE VALIDATION NEGATIVE ────────────────────────────────────────

test('validatePermitStructure: fails on v2 interactive-session containing runId', () => {
  const { permit } = buildSignedV2Permit({ subjectType: 'interactive-session' });
  permit.runId = VALID_RUN_ID;
  const result = validatePermitStructure(permit);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXECUTION_PERMIT_MALFORMED');
  assert.match(result.error, /must not contain runId/);
});

test('validatePermitStructure: fails on v2 runner-run containing session fields', () => {
  const { permit } = buildSignedV2Permit({ subjectType: 'runner-run', runId: VALID_RUN_ID });
  permit.sessionId = VALID_SESSION_ID;
  const result = validatePermitStructure(permit);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXECUTION_PERMIT_MALFORMED');
  assert.match(result.error, /must not contain session fields/);
});

test('validatePermitStructure: fails on v2 interactive-session missing or invalid session fields', () => {
  // Missing sessionId
  const { permit: p1 } = buildSignedV2Permit({ subjectType: 'interactive-session' });
  delete p1.sessionId;
  assert.equal(validatePermitStructure(p1).ok, false);

  // Invalid sessionId format
  const { permit: p2 } = buildSignedV2Permit({ subjectType: 'interactive-session', sessionId: 'bad_sess' });
  assert.equal(validatePermitStructure(p2).ok, false);

  // Missing permitCorrelation
  const { permit: p3 } = buildSignedV2Permit({ subjectType: 'interactive-session' });
  delete p3.permitCorrelation;
  assert.equal(validatePermitStructure(p3).ok, false);

  // Invalid permitCorrelation format
  const { permit: p4 } = buildSignedV2Permit({ subjectType: 'interactive-session', permitCorrelation: 'bad_corr' });
  assert.equal(validatePermitStructure(p4).ok, false);

  // permitCorrelation equal to sessionId
  const { permit: p5 } = buildSignedV2Permit({ subjectType: 'interactive-session', permitCorrelation: VALID_SESSION_ID });
  assert.equal(validatePermitStructure(p5).ok, false);

  // Missing sessionContextDigest
  const { permit: p6 } = buildSignedV2Permit({ subjectType: 'interactive-session' });
  delete p6.sessionContextDigest;
  assert.equal(validatePermitStructure(p6).ok, false);

  // Invalid sessionContextDigest (not sha256)
  const { permit: p7 } = buildSignedV2Permit({ subjectType: 'interactive-session', sessionContextDigest: 'md5:bad' });
  assert.equal(validatePermitStructure(p7).ok, false);
});

test('validatePermitStructure: fails on unknown subjectType', () => {
  const { permit } = buildSignedV2Permit({ subjectType: 'runner-run', runId: VALID_RUN_ID });
  permit.subjectType = 'invalid-subject-type';
  const result = validatePermitStructure(permit);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXECUTION_PERMIT_MALFORMED');
  assert.match(result.error, /Invalid subjectType/);
});

// ─── 4. VERIFIER VERIFYREQUEST CHECKS ───────────────────────────────────────

test('GatewayVerifier: authorizes valid v2 interactive-session when context.runId === permit.permitCorrelation', () => {
  const keys = makeKeyPair();
  const { permit } = buildSignedV2Permit({ keys, subjectType: 'interactive-session' });
  const context = buildSignedContext({ keys, runId: permit.permitCorrelation });

  const verifier = new GatewayVerifier({ publicKey: keys.rawPublicKeyHex, keyId: keys.keyId, mode: 'enforce' });
  const decision = verifier.verifyRequest({
    context,
    permit,
    tool: 'navigate',
    params: { url: 'https://example.test' },
  });

  assert.equal(decision.decision, 'allow');
  assert.equal(decision.actionClass, 'browser.navigate');
  assert.equal(decision.permitId, permit.permitId);
});

test('GatewayVerifier: denies v2 interactive-session when correlation !== context.runId', () => {
  const keys = makeKeyPair();
  const { permit } = buildSignedV2Permit({ keys, subjectType: 'interactive-session' });
  const context = buildSignedContext({ keys, runId: 'corr_session_different999999999999' });

  const verifier = new GatewayVerifier({ publicKey: keys.rawPublicKeyHex, keyId: keys.keyId, mode: 'enforce' });
  const decision = verifier.verifyRequest({
    context,
    permit,
    tool: 'navigate',
    params: { url: 'https://example.test' },
  });

  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reason, 'EXECUTION_REVISION_STALE');
});

test('GatewayVerifier: authorizes valid v2 runner-run when context.runId === permit.runId', () => {
  const keys = makeKeyPair();
  const { permit } = buildSignedV2Permit({ keys, subjectType: 'runner-run', runId: VALID_RUN_ID });
  const context = buildSignedContext({ keys, runId: VALID_RUN_ID });

  const verifier = new GatewayVerifier({ publicKey: keys.rawPublicKeyHex, keyId: keys.keyId, mode: 'enforce' });
  const decision = verifier.verifyRequest({
    context,
    permit,
    tool: 'navigate',
    params: { url: 'https://example.test' },
  });

  assert.equal(decision.decision, 'allow');
  assert.equal(decision.actionClass, 'browser.navigate');
  assert.equal(decision.permitId, permit.permitId);
});

test('GatewayVerifier: denies v2 runner-run when context.runId !== permit.runId', () => {
  const keys = makeKeyPair();
  const { permit } = buildSignedV2Permit({ keys, subjectType: 'runner-run', runId: VALID_RUN_ID });
  const context = buildSignedContext({ keys, runId: 'run_other_12345678' });

  const verifier = new GatewayVerifier({ publicKey: keys.rawPublicKeyHex, keyId: keys.keyId, mode: 'enforce' });
  const decision = verifier.verifyRequest({
    context,
    permit,
    tool: 'navigate',
    params: { url: 'https://example.test' },
  });

  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reason, 'EXECUTION_REVISION_STALE');
});

test('GatewayVerifier: denies v2 interactive-session on signature tampering', () => {
  const keys = makeKeyPair();
  const { permit } = buildSignedV2Permit({ keys, subjectType: 'interactive-session' });
  permit.permitCorrelation = 'corr_session_tampered99999999999999';
  const context = buildSignedContext({ keys, runId: permit.permitCorrelation });

  const verifier = new GatewayVerifier({ publicKey: keys.rawPublicKeyHex, keyId: keys.keyId, mode: 'enforce' });
  const decision = verifier.verifyRequest({
    context,
    permit,
    tool: 'navigate',
    params: { url: 'https://example.test' },
  });

  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reason, 'EXECUTION_PERMIT_FORGED');
});
