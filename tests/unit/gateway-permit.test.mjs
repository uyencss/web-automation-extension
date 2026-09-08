import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import {
  canonicalJson,
  digestCanonical,
  createSafeReceipt,
  redactContext,
  SCHEMAS,
} from '../../server/gateway/trusted-context-schema.mjs';
import { PermitStore } from '../../server/gateway/permit-store.mjs';
import { GatewayVerifier, classifyTool } from '../../server/gateway/verifier.mjs';
import { InteractiveRuntime } from '../../server/gateway/interactive-runtime.mjs';
import { createGatewayServer, sanitizeParams } from '../../server/gateway_server.js';

// ---------------------------------------------------------------------------
// Helpers: build permits and trusted contexts with the CURRENT committed
// interactive contract (webmcp-execution-permit/1 + webmcp-trusted-context/1,
// domain webmcp-digest-v1:permit, LF-separated JCS digest, detached Ed25519
// signature). No Runner imports, no durable ledger, no SQLite.
// ---------------------------------------------------------------------------

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { publicKey, privateKey, rawPublicKeyHex, keyId: 'ed25519-test-key-01' };
}

const DIGEST = (ch) => `sha256:${ch.repeat(64)}`;

function buildSignedContext({
  keys = makeKeyPair(),
  seq = 1,
  runId = 'run_test_001',
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
  ttlMs = 60000,
  expiresAt = new Date(Date.now() + 3600000).toISOString(),
  notBefore = new Date(Date.now() - 1000).toISOString(),
  revocations = [],
} = {}) {
  const base = {
    schema: SCHEMAS.TRUSTED_CONTEXT,
    messageId: `ctxmsg_${Math.random().toString(36).slice(2, 10)}`,
    seq,
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
    revocations,
  };
  const canonical = canonicalJson(base);
  const contextDigest = digestCanonical('webmcp-digest-v1:trusted-context', base);
  const toSign = Buffer.from(`webmcp-digest-v1:trusted-context\n${canonical}`, 'utf8');
  const signature = sign(null, toSign, keys.privateKey).toString('hex');
  return { message: { ...base, signature, contextDigest }, keys };
}

function buildSignedPermit({
  keys = makeKeyPair(),
  permitId = `permit_${Math.random().toString(36).slice(2, 10)}`,
  runId = 'run_test_001',
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
  actionClasses = ['browser.navigate', 'browser.batch'],
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
  tamperDigest = false,
} = {}) {
  const base = {
    schema: SCHEMAS.PERMIT,
    permitId,
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
  const toSign = Buffer.from(`webmcp-digest-v1:permit\n${canonical}`, 'utf8');
  const signature = sign(null, toSign, keys.privateKey).toString('hex');
  let permitDigest = digestCanonical('webmcp-digest-v1:permit', base);
  if (tamperDigest) permitDigest = DIGEST('0');
  return { ...base, signature, permitDigest };
}

function buildSignedDurableRunnerPermit({ keys = makeKeyPair(), ...overrides } = {}) {
  const wire = buildSignedPermit({
    keys,
    actionClasses: ['browser.invokeTool'],
    ...overrides,
  });
  const {
    profileId: _profileId,
    automationStoreRevision: _automationStoreRevision,
    automationStoreDigest: _automationStoreDigest,
    siteStoreRevision: _siteStoreRevision,
    siteStoreDigest: _siteStoreDigest,
    signature: _signature,
    permitDigest: _permitDigest,
    ...base
  } = wire;
  const durable = { ...base, schema: SCHEMAS.DURABLE_PERMIT };
  const canonical = canonicalJson(durable);
  durable.signature = sign(
    null,
    Buffer.from(`webmcp-digest-v1:durable-permit\n${canonical}`, 'utf8'),
    keys.privateKey,
  ).toString('hex');
  const { signature: _durableSignature, ...durableProjection } = durable;
  durable.permitDigest = digestCanonical('webmcp-digest-v1:durable-permit', durableProjection);
  return { permit: durable, keys };
}

test('Gateway accepts a construction-owned durable Runner permit at the coordinator wire seam', () => {
  const { permit, keys } = buildSignedDurableRunnerPermit();
  const verifier = new GatewayVerifier({
    publicKey: keys.rawPublicKeyHex,
    keyId: keys.keyId,
    mode: 'enforce',
  });
  const result = verifier.verifyRequest({
    tool: 'webmcp.invokeTool',
    params: { targetOrigin: 'https://example.test' },
    permit,
    profileId: 'interactive-profile',
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.actionClass, 'browser.invokeTool');
});

test('durable Runner permit is authoritative without trusted context and ignores stale legacy context', () => {
  const { permit, keys } = buildSignedDurableRunnerPermit();
  const { permit: stalePermit } = buildSignedDurableRunnerPermit({ keys, permitId: 'permit_stale_context', nonce: 'nonce_stale_context' });
  const verifier = new GatewayVerifier({
    publicKey: keys.rawPublicKeyHex,
    keyId: keys.keyId,
    mode: 'enforce',
  });
  const { message: staleContext } = buildSignedContext({ keys, runId: 'legacy-run', phaseId: 'legacy-phase' });

  const withoutContext = verifier.verifyRequest({
    tool: 'webmcp.invokeTool',
    params: { targetOrigin: 'https://example.test' },
    permit: stalePermit,
    profileId: 'interactive-profile',
  });
  const withStaleContext = verifier.verifyRequest({
    tool: 'webmcp.invokeTool',
    params: { targetOrigin: 'https://example.test' },
    permit,
    profileId: 'interactive-profile',
    context: staleContext,
  });

  assert.equal(withoutContext.decision, 'allow');
  assert.equal(withStaleContext.decision, 'allow');
});

function sendSocketMessage(socketPath, messageObj) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(`${JSON.stringify(messageObj)}\n`);
    });
    let data = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => {
      data += chunk;
    });
    client.on('end', () => {
      try {
        resolve(JSON.parse(data.trim()));
      } catch (err) {
        resolve({ raw: data, error: err.message });
      }
    });
    client.on('error', reject);
  });
}

function makeFakeExtension(port, profileId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const forwarded = [];
  ws.on('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'extensionReady',
      params: { name: 'fake-test-ext', version: '1.0.0', profileId, capabilities: ['navigate', 'click', 'batch'] },
    }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!('id' in msg)) return;
    forwarded.push(msg);
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { success: true, echoedMethod: msg.method, echoedParams: msg.params },
    }));
  });
  return { ws, forwarded };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}

// ---------------------------------------------------------------------------
// Signed short-lived permit: missing / expired / TTL
// ---------------------------------------------------------------------------

test('RED: missing permit denied before downstream (enforce)', () => {
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ permitStore: store, mode: 'enforce' });
  const r = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: null,
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'EXECUTION_PERMIT_REQUIRED');
  assert.equal(r.actionClass, 'browser.navigate');
});

test('expired window denied (past expiresAt and future notBefore)', () => {
  const keys = makeKeyPair();
  const now = Date.now();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });

  const expired = buildSignedPermit({ keys, expiresAt: new Date(now - 10000).toISOString() });
  const rPast = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: expired,
    context,
    now: new Date(now),
  });
  assert.equal(rPast.decision, 'deny');
  assert.equal(rPast.reason, 'EXECUTION_PERMIT_EXPIRED');
  assert.equal(store.isReplay(expired.nonce, now), false, 'expired deny must not mark replay');
  assert.equal(store.getBudgetUsage(expired.permitId), null, 'expired deny must not consume budget');

  const future = buildSignedPermit({
    keys,
    issuedAt: new Date(now + 60000).toISOString(),
    notBefore: new Date(now + 60000).toISOString(),
    expiresAt: new Date(now + 90000).toISOString(),
  });
  const rFuture = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: future,
    context,
    now: new Date(now),
  });
  assert.equal(rFuture.decision, 'deny');
  assert.equal(rFuture.reason, 'EXECUTION_PERMIT_EXPIRED');
});

test('TTL overrun denied: short-lived permit fails closed past issuedAt + ttlMs', () => {
  const keys = makeKeyPair();
  const now = Date.now();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });
  // Window is still valid (expiresAt in future) but issuedAt + ttlMs is in the past.
  const stale = buildSignedPermit({
    keys,
    issuedAt: new Date(now - 62000).toISOString(),
    notBefore: new Date(now - 62000).toISOString(),
    expiresAt: new Date(now + 30000).toISOString(),
    ttlMs: 60000,
  });
  const r = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: stale,
    context,
    now: new Date(now),
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'EXECUTION_PERMIT_EXPIRED');
  assert.equal(store.getBudgetUsage(stale.permitId), null);
});

// ---------------------------------------------------------------------------
// Logical scope: origin / action / raw wrapper
// ---------------------------------------------------------------------------

test('wrong-key permit denied fail-closed without ledger mutation or key leakage', () => {
  const keysA = makeKeyPair();
  const keysB = makeKeyPair();
  const { message: context } = buildSignedContext({ keys: keysA });
  const permit = buildSignedPermit({ keys: keysA, nonce: 'nonce_wrong_key_test' });

  // Positive control: the same permit verifies under its own pinned key.
  const controlStore = new PermitStore();
  const controlVerifier = new GatewayVerifier({ publicKey: keysA.publicKey, permitStore: controlStore, mode: 'enforce' });
  const rControl = controlVerifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit,
    context,
  });
  assert.equal(rControl.decision, 'allow');

  // Independent wrong-key case: valid permit from A verified against pinned B.
  // Both test keys share the same keyId, isolating the signature check.
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keysB.publicKey, permitStore: store, mode: 'enforce' });
  const r = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit,
    context,
  });
  assert.equal(r.decision, 'deny');
  assert.ok(
    r.reason === 'EXECUTION_PERMIT_FORGED' || r.reason === 'EXECUTION_KEY_MISMATCH',
    `wrong-key must fail closed, got ${r.reason}`,
  );
  assert.equal(store.getBudgetUsage(permit.permitId), null, 'wrong-key deny must not consume budget');
  assert.equal(store.isReplay(permit.nonce, Date.now()), false, 'wrong-key deny must not mark replay');
  assert.equal(store.seenNonce.has(permit.nonce), false, 'wrong-key deny must not record nonce');
  assert.equal(r.signature, undefined);
  assert.equal(r.permitDigest, undefined);
  assert.equal(r.permit, undefined);
  const serialized = JSON.stringify(r);
  assert.equal(serialized.includes(permit.signature), false, 'deny must not leak signature material');
  assert.equal(serialized.includes('privateKey'), false, 'deny must not leak private-key material');
});

test('wrong origin denied (evil url, missing origin, targetOrigin mismatch)', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });

  const evil = buildSignedPermit({ keys, origins: ['https://example.test'] });
  const rEvil = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://evil.test/page' },
    permit: evil,
    context,
  });
  assert.equal(rEvil.decision, 'deny');
  assert.equal(rEvil.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');

  const missing = buildSignedPermit({ keys, origins: ['https://example.test'] });
  const rMissing = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: {},
    permit: missing,
    context,
  });
  assert.equal(rMissing.decision, 'deny');
  assert.equal(rMissing.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');

  const mismatch = buildSignedPermit({ keys, origins: ['https://example.test'] });
  const rMismatch = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: mismatch,
    targetOrigin: 'https://evil.test',
    context,
  });
  assert.equal(rMismatch.decision, 'deny');
  assert.equal(rMismatch.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');
  assert.equal(store.getBudgetUsage(evil.permitId), null);
});

test('wrong action scope denied; raw wrapper cannot broaden scope', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });

  const navigateOnly = buildSignedPermit({ keys, actionClasses: ['browser.navigate'] });
  const rClick = verifier.verifyRequest({
    tool: 'browser_click',
    params: { url: 'https://example.test/page' },
    permit: navigateOnly,
    context,
  });
  assert.equal(rClick.decision, 'deny');
  assert.equal(rClick.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');

  // Smuggling click through the raw wrapper must still deny: inner resolves to
  // browser.raw.navigate, which is outside the permit's exact scope.
  const rRaw = verifier.verifyRequest({
    tool: 'browser_raw_command',
    params: { method: 'navigate', url: 'https://example.test/page' },
    permit: navigateOnly,
    context,
  });
  assert.equal(rRaw.decision, 'deny');
  assert.equal(rRaw.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');

  // Bounded browser.raw.* wildcard allows a known raw leaf.
  const rawScope = buildSignedPermit({ keys, actionClasses: ['browser.raw.*'] });
  const rRawAllow = verifier.verifyRequest({
    tool: 'browser_raw_command',
    params: { method: 'navigate', url: 'https://example.test/page' },
    permit: rawScope,
    context,
  });
  assert.equal(rRawAllow.decision, 'allow');
  assert.equal(store.getBudgetUsage(navigateOnly.permitId), null);
});

test('unknown raw denied closed (TOOL_ACTION_NOT_ALLOWED) before ledger mutation', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });
  assert.equal(classifyTool('browser_raw_command', { method: '???unknown!!!' }), 'browser.raw.unknown');

  const permit = buildSignedPermit({ keys });
  for (const params of [{ method: '???unknown!!!' }, {}]) {
    const r = verifier.verifyRequest({ tool: 'browser_raw_command', params, permit, context });
    assert.equal(r.decision, 'deny');
    assert.equal(r.reason, 'TOOL_ACTION_NOT_ALLOWED');
  }
  assert.equal(store.getBudgetUsage(permit.permitId), null);
  assert.equal(store.isReplay(permit.nonce, Date.now()), false);
});

// ---------------------------------------------------------------------------
// Replay fence and revocation
// ---------------------------------------------------------------------------

test('replay nonce denied; decision leaks no signature material', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });

  const permit = buildSignedPermit({ keys, nonce: 'nonce_replay_test' });
  const r1 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit,
    context,
  });
  assert.equal(r1.decision, 'allow');
  const r2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit,
    context,
  });
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.reason, 'EXECUTION_PERMIT_REVOKED');
  assert.equal(store.isReplay(permit.nonce, Date.now()), true);
  assert.equal(r2.signature, undefined);
  assert.equal(r2.permitDigest, undefined);
  assert.equal(r2.permit, undefined);
  assert.equal(JSON.stringify(r2).includes(permit.signature), false);
});

test('revoked permit denied by revocationId and by permitId', () => {
  const keys = makeKeyPair();
  const { message: context } = buildSignedContext({ keys });

  const byRevocation = buildSignedPermit({ keys });
  const store1 = new PermitStore();
  store1.revoke(byRevocation.revocationId);
  const v1 = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store1, mode: 'enforce' });
  const r1 = v1.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: byRevocation,
    context,
  });
  assert.equal(r1.decision, 'deny');
  assert.equal(r1.reason, 'EXECUTION_PERMIT_REVOKED');

  const byPermit = buildSignedPermit({ keys });
  const store2 = new PermitStore();
  store2.revoke(byPermit.permitId);
  const v2 = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store2, mode: 'enforce' });
  const r2 = v2.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: byPermit,
    context,
  });
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.reason, 'EXECUTION_PERMIT_REVOKED');
});

test('gateway token alone cannot authorize (no permit still denies)', () => {
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ permitStore: store, mode: 'enforce' });
  const r = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: null,
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'EXECUTION_PERMIT_REQUIRED');
});

// ---------------------------------------------------------------------------
// Budget fence: sequential, shared-permitId, and atomic batch
// ---------------------------------------------------------------------------

test('budget fence: shared permitId across fresh nonces exhausts maxCalls', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });

  const first = buildSignedPermit({
    keys, permitId: 'permit_budget_unique_id', budget: { maxCalls: 1 }, nonce: 'nonce_budget_first',
  });
  const r1 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: first,
    context,
  });
  assert.equal(r1.decision, 'allow');

  const second = buildSignedPermit({
    keys, permitId: 'permit_budget_unique_id', budget: { maxCalls: 1 }, nonce: 'nonce_budget_second',
  });
  const r2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: second,
    context,
  });
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.reason, 'EXECUTION_BUDGET_EXHAUSTED');
});

test('batch with one child denied denies composite with deterministic children', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });

  const permit = buildSignedPermit({ keys, origins: ['https://example.test'], nonce: 'nonce_batch_scope_test' });
  const r = verifier.verifyBatch({
    tool: 'browser_batch',
    params: {
      actions: [
        { method: 'browser_navigate', params: { url: 'https://example.test/a' } },
        { method: 'browser_navigate', params: { url: 'https://malicious-origin.test/b' } },
      ],
    },
    permit,
    context,
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');
  assert.ok(Array.isArray(r.children));
  assert.equal(r.children.length, 2);
  assert.equal(r.children[0].decision, 'allow');
  assert.equal(r.children[1].decision, 'deny');
  assert.equal(r.children[1].reason, 'EXECUTION_PERMIT_SCOPE_DENIED');
  assert.equal(store.budget.get(permit.permitId), undefined, 'denied batch must not consume budget');
  assert.equal(store.seenNonce.has(permit.nonce), false, 'denied batch must not mark replay');
});

test('atomic batch budget: over-budget denies without mutation, fitting batch reserves total', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });

  const twoChildParams = {
    actions: [
      { method: 'browser_navigate', params: { url: 'https://example.test/a' } },
      { method: 'browser_navigate', params: { url: 'https://example.test/b' } },
    ],
  };

  const tight = buildSignedPermit({
    keys, origins: ['https://example.test'], budget: { maxCalls: 1 }, nonce: 'nonce_batch_tight_budget',
  });
  const rTight = verifier.verifyBatch({ tool: 'browser_batch', params: twoChildParams, permit: tight, context });
  assert.equal(rTight.decision, 'deny');
  assert.equal(rTight.reason, 'EXECUTION_BUDGET_EXHAUSTED');
  assert.equal(store.budget.get(tight.permitId), undefined);
  assert.equal(store.seenNonce.has(tight.nonce), false);

  const fitting = buildSignedPermit({
    keys, origins: ['https://example.test'], budget: { maxCalls: 2 }, nonce: 'nonce_batch_valid_test',
  });
  const rFit = verifier.verifyBatch({ tool: 'browser_batch', params: twoChildParams, permit: fitting, context });
  assert.equal(rFit.decision, 'allow');
  assert.equal(rFit.children.length, 2);
  assert.equal(store.budget.get(fitting.permitId).used, 2);
  assert.equal(store.seenNonce.has(fitting.nonce), true);
});

test('concurrent budget reserves atomically: exactly one winner', async () => {
  const store = new PermitStore();
  const permit = { permitId: 'permit_concurrent_1', budget: { maxCalls: 1 } };
  const results = await Promise.all([
    store.reserveBudgetAtomic(permit, 1),
    store.reserveBudgetAtomic(permit, 1),
  ]);
  assert.equal(results.filter(Boolean).length, 1, 'exactly one concurrent reserve should succeed');
  assert.equal(store.getBudgetUsage(permit.permitId).used, 1);
});

// ---------------------------------------------------------------------------
// Trusted context binding: profile / phase / project / fence
// ---------------------------------------------------------------------------

test('trusted context binding: wrong profile, phase, and project fail closed', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });

  const wrongProfile = buildSignedPermit({ keys, profileAlias: 'different-profile' });
  const rProfile = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: wrongProfile,
    context,
  });
  assert.equal(rProfile.decision, 'deny');
  assert.equal(rProfile.reason, 'EXECUTION_PROFILE_MISMATCH');

  const wrongPhase = buildSignedPermit({ keys, phaseId: 'other-phase' });
  const rPhase = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: wrongPhase,
    context,
  });
  assert.equal(rPhase.decision, 'deny');
  assert.equal(rPhase.reason, 'EXECUTION_PHASE_MISMATCH');

  const wrongProject = buildSignedPermit({ keys, projectId: 'other_project' });
  const rProject = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: wrongProject,
    context,
  });
  assert.equal(rProject.decision, 'deny');
  assert.equal(rProject.reason, 'EXECUTION_PROJECT_MISMATCH');

  assert.equal(store.getBudgetUsage(wrongProfile.permitId), null);
  assert.equal(store.isReplay(wrongProfile.nonce, Date.now()), false);
});

test('stale fence denied: permit claimGeneration below context fenceEpoch', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys, fenceEpoch: 3 });

  const stale = buildSignedPermit({ keys, claimGeneration: 2 });
  const r = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: stale,
    context,
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'EXECUTION_FENCE_STALE');
  assert.equal(store.isReplay(stale.nonce, Date.now()), false);
});

test('missing trusted context denied at the gateway seam (EXECUTION_CONTEXT_REQUIRED)', () => {
  const keys = makeKeyPair();
  const runtime = new InteractiveRuntime({
    publicKey: keys.publicKey,
    permitStore: new PermitStore(),
    mode: 'enforce',
    allowTestSeams: true,
  });
  assert.equal(runtime.getCurrentContext(), null);
  const permit = buildSignedPermit({ keys });
  const r = runtime.enforceRequest({
    method: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit,
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'EXECUTION_CONTEXT_REQUIRED');
  assert.ok(r.receipt, 'deny carries a blocked receipt');
});

test('InteractiveRuntime admits a durable Runner permit without the legacy context socket', () => {
  const { permit, keys } = buildSignedDurableRunnerPermit();
  const runtime = new InteractiveRuntime({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore: new PermitStore(),
    mode: 'enforce',
    allowTestSeams: true,
  });
  const r = runtime.enforceRequest({
    method: 'webmcp.invokeTool',
    params: { targetOrigin: 'https://example.test' },
    permit,
    profileId: 'interactive-profile',
    targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'allow');
  assert.equal(r.actionClass, 'browser.invokeTool');
  assert.equal(r.receipt.fenceEpoch, permit.claimGeneration);
});

// ---------------------------------------------------------------------------
// Physical-profile routing through the local route map
// ---------------------------------------------------------------------------

test('physical-profile routing: unmapped request profile denied, mapped physical allowed', () => {
  const keys = makeKeyPair();
  const { message: context } = buildSignedContext({ keys });
  const routeMap = new Map([['interactive-profile', 'phys-1']]);

  const evil = buildSignedPermit({ keys, nonce: 'nonce_phys_evil' });
  const storeEvil = new PermitStore();
  const verifierEvil = new GatewayVerifier({
    publicKey: keys.publicKey, permitStore: storeEvil, mode: 'enforce', physicalRouteMap: routeMap,
  });
  const rEvil = verifierEvil.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: evil,
    profileId: 'phys-evil',
    context,
  });
  assert.equal(rEvil.decision, 'deny');
  assert.equal(rEvil.reason, 'EXECUTION_PROFILE_MISMATCH');
  assert.equal(storeEvil.getBudgetUsage(evil.permitId), null);

  const mapped = buildSignedPermit({ keys, nonce: 'nonce_phys_mapped' });
  const storeMapped = new PermitStore();
  const verifierMapped = new GatewayVerifier({
    publicKey: keys.publicKey, permitStore: storeMapped, mode: 'enforce', physicalRouteMap: routeMap,
  });
  const rMapped = verifierMapped.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: mapped,
    profileId: 'phys-1',
    context,
  });
  assert.equal(rMapped.decision, 'allow');
  // Portable permit never carries the physical identity.
  assert.equal('profileId' in mapped && mapped.profileId !== 'phys-1', true);
});

// ---------------------------------------------------------------------------
// Observe mode: visible would-deny / would-allow without ledger mutation
// ---------------------------------------------------------------------------

test('observe labels would-deny and would-allow; denies never mutate, allows consume like enforce', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'observe' });
  const { message: context } = buildSignedContext({ keys });

  const scoped = buildSignedPermit({ keys, actionClasses: ['browser.navigate'], budget: { maxCalls: 1 } });
  const rDeny = verifier.verifyRequest({
    tool: 'browser_click',
    params: { url: 'https://example.test/page' },
    permit: scoped,
    context,
  });
  assert.equal(rDeny.decision, 'would-deny');
  assert.equal(rDeny.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');
  assert.equal(store.getBudgetUsage(scoped.permitId), null, 'would-deny must not consume budget');
  assert.equal(store.isReplay(scoped.nonce, Date.now()), false, 'would-deny must not mark replay');

  const rAllow = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: scoped,
    context,
  });
  assert.equal(rAllow.decision, 'would-allow');
  // Committed contract: observe shadows enforce decisions but still records the
  // ledger entry, so replaying the same nonce is a visible would-deny.
  assert.equal(store.getBudgetUsage(scoped.permitId).used, 1);
  assert.equal(store.isReplay(scoped.nonce, Date.now()), true);

  const rReplay = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: scoped,
    context,
  });
  assert.equal(rReplay.decision, 'would-deny');
  assert.equal(rReplay.reason, 'EXECUTION_PERMIT_REVOKED');
});

// ---------------------------------------------------------------------------
// Gateway forwarding end to end: allow forwards sanitized, deny never forwards
// ---------------------------------------------------------------------------

test('gateway HTTP: valid trusted forwarding vs tampered deny-before-forward, no secret leakage', async (t) => {
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `gateway-permit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({
    port: 0,
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    interactiveMode: 'enforce',
    token: 'test-secret-token',
    allowTestSeams: true,
  });
  const { port: actualPort } = await app.start();
  t.after(async () => {
    await app.close();
  });

  const fakeExt = makeFakeExtension(actualPort, 'interactive-profile');
  t.after(() => {
    try { fakeExt.ws.terminate(); } catch {}
  });
  await waitFor(async () => app.connectedProfileIds().includes('interactive-profile'));

  const { message: contextMsg } = buildSignedContext({ keys, fenceEpoch: 2 });
  const sockAck = await sendSocketMessage(socketPath, contextMsg);
  assert.equal(sockAck.ok, true);

  async function postApi(body) {
    const res = await fetch(`http://127.0.0.1:${actualPort}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-token' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  // Valid permit: allowed and forwarded with permit material stripped.
  const validPermit = buildSignedPermit({ keys, claimGeneration: 2 });
  const rValid = await postApi({
    method: 'browser_navigate',
    params: { url: 'https://example.test/valid', permit: { leak: 1 }, token: 'leak' },
    profileId: 'interactive-profile',
    permit: validPermit,
  });
  assert.equal(rValid.status, 200);
  assert.equal(fakeExt.forwarded.length, 1);
  const forwarded = fakeExt.forwarded[0];
  assert.equal(forwarded.method, 'navigate');
  assert.equal(JSON.stringify(forwarded).includes('leak'), false, 'forwarded payload must not leak permit/token material');
  assert.equal(forwarded.params.permit, undefined);
  assert.equal(forwarded.params.signature, undefined);
  assert.equal(forwarded.params.nonce, undefined);
  assert.ok(rValid.body.receipt, 'allow carries an execution receipt');

  // Tampered digest: 403 deny-before-forward, nothing additional forwarded.
  const tampered = buildSignedPermit({ keys, claimGeneration: 2, tamperDigest: true });
  const rTampered = await postApi({
    method: 'browser_navigate',
    params: { url: 'https://example.test/valid' },
    profileId: 'interactive-profile',
    permit: tampered,
  });
  assert.equal(rTampered.status, 403);
  assert.equal(rTampered.body.reason, 'EXECUTION_PERMIT_FORGED');
  assert.equal(fakeExt.forwarded.length, 1, 'denied request must not forward');

  // Origin override outside the permit scope: 403, still no forward.
  const scoped = buildSignedPermit({ keys, claimGeneration: 2, origins: ['https://example.test'] });
  const rOverride = await postApi({
    method: 'browser_navigate',
    params: { url: 'https://evil.test/page' },
    profileId: 'interactive-profile',
    permit: scoped,
  });
  assert.equal(rOverride.status, 403);
  assert.equal(rOverride.body.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');
  assert.equal(fakeExt.forwarded.length, 1, 'scope-denied request must not forward');
});

// ---------------------------------------------------------------------------
// Redaction: receipts and diagnostics carry no secrets
// ---------------------------------------------------------------------------

test('receipts and decisions are redacted: no raw secrets, keys, or permit material', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });
  const permit = buildSignedPermit({ keys });

  const r = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit,
    context,
  });
  assert.equal(r.decision, 'allow');
  assert.equal(JSON.stringify(r).includes(permit.signature), false);

  const sanitized = sanitizeParams({
    url: 'https://example.test/page',
    permit: { permitId: 'leak' },
    executionPermit: { leak: 2 },
    _permit: { leak: 3 },
    token: 'leak-token',
    profileId: 'phys-leak',
  });
  assert.equal(sanitized.permit, undefined);
  assert.equal(sanitized.executionPermit, undefined);
  assert.equal(sanitized._permit, undefined);
  assert.equal(sanitized.token, undefined);
  assert.equal(sanitized.profileId, undefined);
  assert.equal(sanitized.url, 'https://example.test/page');

  const receipt = createSafeReceipt({
    permitId: permit.permitId,
    runId: permit.runId,
    projectId: permit.projectId,
    profileAlias: permit.profileAlias,
    profileId: permit.profileId,
    claimGeneration: permit.claimGeneration,
    claimDigest: permit.claimDigest,
    phaseId: permit.phaseId,
    bindingId: permit.bindingId,
    bindingRevision: permit.bindingRevision,
    bindingDigest: permit.bindingDigest,
    actionClass: 'browser.navigate',
    attempt: 'not-attempted',
    outcome: 'not-applied',
    sequence: 1,
    method: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    targetOrigin: 'https://example.test',
    decision: 'allow',
    reason: 'EXECUTION_PERMIT_REQUIRED',
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes('privateKey'), false);
  assert.equal(serialized.includes('leak-token'), false);
  assert.ok(receipt.receiptDigest);

  const summary = redactContext(context);
  assert.equal(JSON.stringify(summary).includes(keys.rawPublicKeyHex), false, 'diagnostic summary must not carry key material');
});

// ---------------------------------------------------------------------------
// Shared fixture parity (honest): LF+JCS digest recomputation, detached
// signature excluded, mutation differs. Byte identity with the pinned Runner
// fixture is enforced by cross-package-contract-parity.test.mjs.
// ---------------------------------------------------------------------------

test('D1 permit vector digest matches LF+JCS and tamper changes digest', () => {
  const vecPath = fileURLToPath(new URL('../fixtures/permit-vectors.json', import.meta.url));
  const fixture = JSON.parse(fs.readFileSync(vecPath, 'utf8'));
  assert.equal(fixture.schema, 'webmcp-fixture-vectors/1');
  assert.equal(fixture.contract, 'webmcp-execution-permit/1');
  assert.ok(Array.isArray(fixture.vectors) && fixture.vectors.length > 0);

  for (const vec of fixture.vectors) {
    const jcs = canonicalJson(vec.projection);
    assert.equal(jcs, vec.canonical, `canonical JCS must match fixture for ${vec.name}`);
    const computed = digestCanonical('webmcp-digest-v1:permit', vec.projection);
    assert.equal(computed, vec.digest, `LF digest must match fixture for ${vec.name}`);
    assert.equal(computed, vec.permitDigest, `permitDigest must match digest for ${vec.name}`);
    assert.ok(vec.signatureExcluded, 'signature stays detached');
    assert.deepEqual(vec.excludedFromDigest, ['permitDigest', 'signature']);

    const mutJcs = canonicalJson(vec.mutation.protectedProjection);
    assert.equal(mutJcs, vec.mutation.canonical);
    const mutDigest = digestCanonical('webmcp-digest-v1:permit', vec.mutation.protectedProjection);
    assert.equal(mutDigest, vec.mutation.digest);
    assert.notEqual(computed, mutDigest, 'mutation digest must differ');
    assert.equal(vec.mutation.digestsDiffer, true);

    // TTL discipline: short-lived (<= 60s) and window matches ttlMs.
    assert.ok(vec.value.ttlMs > 0 && vec.value.ttlMs <= 60000, `ttlMs bounded for ${vec.name}`);
    const windowMs = Date.parse(vec.value.expiresAt) - Date.parse(vec.value.notBefore);
    assert.equal(windowMs, vec.value.ttlMs, `window must match ttlMs for ${vec.name}`);

    // Legacy NUL framing must NOT reproduce the D1 digest.
    const nulDigest = `sha256:${createHash('sha256').update(`webmcp-digest-v1\u0000webmcp-execution-permit/1\u0000${jcs}`, 'utf8').digest('hex')}`;
    assert.notEqual(nulDigest, computed, 'NUL digest must not equal D1 LF digest');
  }
});
