import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import {
  canonicalJson,
  digestCanonical,
  toKeyObject,
  keysMatch,
  toRawPublicKeyHex,
  validateTrustedContextMessage,
  validatePermitStructure,
  createSafeReceipt,
  redactContext,
  isNormalizedHttpOrigin,
  SCHEMAS,
} from '../../server/gateway/trusted-context-schema.mjs';

import { PermitStore } from '../../server/gateway/permit-store.mjs';
import { GatewayVerifier, classifyTool, isActionScopeAllowed, normalizeOrigin } from '../../server/gateway/verifier.mjs';
import { TrustedContextChannel } from '../../server/gateway/trusted-context-channel.mjs';
import { InteractiveRuntime } from '../../server/gateway/interactive-runtime.mjs';
import { createGatewayServer } from '../../server/gateway_server.js';

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { publicKey, privateKey, rawPublicKeyHex, keyId: 'ed25519-runner-key-01' };
}

function buildSignedContext({
  keys = makeKeyPair(),
  seq = 1,
  runId = 'run_test_001',
  claimGeneration = 2,
  claimDigest = 'sha256:' + '0'.repeat(64),
  projectId = 'project_test_123',
  profileAlias = 'interactive-profile',
  profileId = null,
  bindingId = 'pb_test_123',
  bindingRevision = 2,
  bindingDigest = 'sha256:' + '1'.repeat(64),
  automationStoreRevision = 3,
  automationStoreDigest = 'sha256:' + '2'.repeat(64),
  siteStoreRevision = 4,
  siteStoreDigest = 'sha256:' + '3'.repeat(64),
  fenceEpoch = 2,
  phaseId = 'interactive-action',
  stateVersion = 1,
  planRevision = 1,
  planDigest = 'sha256:' + '4'.repeat(64),
  instructionDigest = 'sha256:' + '5'.repeat(64),
  policyRevision = 'sha256:' + '6'.repeat(64),
  ttlMs = 60000,
  expiresAt = new Date(Date.now() + 3600000).toISOString(),
  notBefore = new Date(Date.now() - 1000).toISOString(),
  revocations = [],
  includeSignature = true,
  overridePublicKey = null,
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
    publicKey: overridePublicKey || keys.rawPublicKeyHex,
    issuedAt: new Date().toISOString(),
    notBefore,
    expiresAt,
    revocations,
  };

  const canonical = canonicalJson(base);
  const contextDigest = digestCanonical('webmcp-digest-v1:trusted-context', base);

  if (!includeSignature) {
    return {
      message: { ...base, contextDigest },
      keys,
    };
  }

  const toSign = Buffer.from(`webmcp-digest-v1:trusted-context\n${canonical}`, 'utf8');
  const signature = sign(null, toSign, keys.privateKey).toString('hex');

  return {
    message: { ...base, signature, contextDigest },
    keys,
  };
}

function buildSignedPermit({
  keys = makeKeyPair(),
  permitId = `permit_${Math.random().toString(36).slice(2, 10)}`,
  runId = 'run_test_001',
  claimGeneration = 2,
  claimDigest = 'sha256:' + '0'.repeat(64),
  projectId = 'project_test_123',
  profileAlias = 'interactive-profile',
  profileId = null,
  bindingId = 'pb_test_123',
  bindingRevision = 2,
  bindingDigest = 'sha256:' + '1'.repeat(64),
  automationStoreRevision = 3,
  automationStoreDigest = 'sha256:' + '2'.repeat(64),
  siteStoreRevision = 4,
  siteStoreDigest = 'sha256:' + '3'.repeat(64),
  actionClasses = ['browser.navigate', 'browser.click', 'browser.type', 'browser.batch', 'browser.raw'],
  origins = ['https://example.test', 'https://app.example.test'],
  budget = { maxCalls: 5 },
  stateVersion = 1,
  planRevision = 1,
  planDigest = 'sha256:' + '4'.repeat(64),
  instructionDigest = 'sha256:' + '5'.repeat(64),
  policyRevision = 'sha256:' + '6'.repeat(64),
  expiresAt = new Date(Date.now() + 3600000).toISOString(),
  notBefore = new Date(Date.now() - 1000).toISOString(),
  nonce = `nonce_${Math.random().toString(36).slice(2, 18)}`,
  revocationId = 'rev_001',
  ttlMs = 60000,
  issuedAt = new Date().toISOString(),
  tamperDigest = false,
  tamperSignature = false,
  phaseId = 'interactive-action',
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
  let signature = sign(null, toSign, keys.privateKey).toString('hex');
  let permitDigest = digestCanonical('webmcp-digest-v1:permit', base);

  if (tamperDigest) {
    permitDigest = 'sha256:' + '0'.repeat(64);
  }
  if (tamperSignature) {
    signature = 'ee'.repeat(64);
  }

  return { ...base, signature, permitDigest };
}

function sendSocketMessage(socketPath, messageObj) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(messageObj) + '\n');
    });

    let data = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => {
      data += chunk;
    });

    client.on('end', () => {
      try {
        const parsed = JSON.parse(data.trim());
        resolve(parsed);
      } catch (err) {
        resolve({ raw: data, error: err.message });
      }
    });

    client.on('error', (err) => {
      reject(err);
    });
  });
}

function makeFakeExtension(port, profileId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const forwarded = [];

  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'extensionReady',
        params: {
          name: 'fake-test-ext',
          version: '1.0.0',
          profileId,
          capabilities: ['navigate', 'click', 'batch'],
        },
      }),
    );
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!('id' in msg)) return;
    forwarded.push(msg);
    if (msg.method === 'batch') {
      const actions = Array.isArray(msg.params?.actions) ? msg.params.actions : [];
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          total: actions.length,
          executed: actions.length,
          success: actions.length,
          errors: 0,
          results: actions.map((action, index) => ({ index, method: action.method, ok: true, result: { success: true } })),
        },
      }));
      return;
    }
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { success: true, echoedMethod: msg.method, echoedParams: msg.params },
      }),
    );
  });

  return { ws, forwarded };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}

// ─────────────────────────────────────────────────────────────
// 1. Structural & Canonical Tests
// ─────────────────────────────────────────────────────────────
test('canonicalJson deterministically sorts keys and formats primitives', () => {
  const obj1 = { z: 1, a: 'hello', m: { b: 2, a: 1 }, arr: [3, 2, 1] };
  const obj2 = { a: 'hello', arr: [3, 2, 1], m: { a: 1, b: 2 }, z: 1 };
  assert.equal(canonicalJson(obj1), canonicalJson(obj2));
  assert.equal(canonicalJson(obj1), '{"a":"hello","arr":[3,2,1],"m":{"a":1,"b":2},"z":1}');
});

test('keysMatch correctly compares public keys across formats and rejects mismatches', () => {
  const kp1 = makeKeyPair();
  const kp2 = makeKeyPair();

  assert.equal(keysMatch(kp1.publicKey, kp1.publicKey), true);
  assert.equal(keysMatch(kp1.rawPublicKeyHex, kp1.publicKey), true);
  assert.equal(keysMatch(kp1.publicKey, kp2.publicKey), false);
  assert.equal(keysMatch(kp1.rawPublicKeyHex, kp2.rawPublicKeyHex), false);
  assert.equal(keysMatch(null, kp1.publicKey), false);
});

test('classifyTool maps actions and isolates unknown raw commands', () => {
  assert.equal(classifyTool('browser_navigate'), 'browser.navigate');
  assert.equal(classifyTool('browser_click'), 'browser.click');
  assert.equal(classifyTool('browser_batch'), 'browser.batch');
  assert.equal(classifyTool('browser_raw_command', { method: 'getCookies' }), 'browser.raw.getCookies');
  assert.equal(classifyTool('browser_raw_command', { method: 'custom_action' }), 'browser.raw.unknown');
  assert.equal(classifyTool('browser_raw_command', { method: '???invalid!!!' }), 'browser.raw.unknown');
  assert.equal(classifyTool('browser_raw_command', {}), 'browser.raw.unknown');
});

test('createSafeReceipt never leaks private keys or credentials', () => {
  const receipt = createSafeReceipt({
    permitId: 'permit_123',
    runId: 'run_123',
    projectId: 'proj_123',
    profileAlias: 'alias_123',
    actionClass: 'browser.navigate',
    decision: 'allow',
  });

  assert.equal(receipt.schema, SCHEMAS.RECEIPT);
  assert.ok(receipt.receiptId.startsWith('rcpt_'));
  assert.ok(receipt.receiptDigest.startsWith('sha256:'));
  assert.equal(receipt.decision, 'allow');

  const str = JSON.stringify(receipt);
  assert.ok(!str.includes('privateKey'));
  assert.ok(!str.includes('secret'));
  assert.ok(!str.includes('token'));
  assert.ok(!str.includes('hostname'));
});

// ─────────────────────────────────────────────────────────────
// 2. Local Unix Domain Socket Trusted-Context Transport Tests
// ─────────────────────────────────────────────────────────────
test('trusted context channel over Unix socket handles framing, signatures, anti-replay, and rejects alternate keys', async (t) => {
  const socketPath = path.join(os.tmpdir(), `test-sock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const keys = makeKeyPair();
  const altKeys = makeKeyPair();
  const permitStore = new PermitStore();

  let lastUpdatedContext = null;
  const channel = new TrustedContextChannel({
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore,
    onContextUpdate: (ctx) => {
      lastUpdatedContext = ctx;
    },
  });

  await channel.start();
  t.after(async () => {
    await channel.stop();
  });

  // 1. Valid signed message with pinned key
  const { message: validMsg } = buildSignedContext({ keys, seq: 1, revocations: ['permit_rev_1'] });
  const ack = await sendSocketMessage(socketPath, validMsg);
  assert.equal(ack.ok, true);
  assert.equal(ack.schema, SCHEMAS.ACK);
  assert.equal(ack.messageId, validMsg.messageId);
  assert.ok(lastUpdatedContext);
  assert.equal(lastUpdatedContext.projectId, 'project_test_123');
  assert.ok(permitStore.isRevoked('permit_rev_1'));

  // 2. Replay of same messageId fails closed
  const replayAck = await sendSocketMessage(socketPath, validMsg);
  assert.equal(replayAck.ok, false);
  assert.equal(replayAck.reason, 'TRUSTED_CONTEXT_REPLAY');

  // 3. Stale sequence fails closed
  const { message: staleMsg } = buildSignedContext({ keys, seq: 1 });
  const staleAck = await sendSocketMessage(socketPath, staleMsg);
  assert.equal(staleAck.ok, false);
  assert.equal(staleAck.reason, 'TRUSTED_CONTEXT_STALE');

  // 4. Forged signature fails closed
  const { message: forgedMsg } = buildSignedContext({ keys, seq: 2 });
  forgedMsg.signature = '00'.repeat(64);
  const forgedAck = await sendSocketMessage(socketPath, forgedMsg);
  assert.equal(forgedAck.ok, false);
  assert.equal(forgedAck.reason, 'TRUSTED_CONTEXT_FORGED');

  // 5. Alternate public key in context message fails closed
  const { message: altKeyMsg } = buildSignedContext({
    keys: altKeys,
    seq: 3,
    overridePublicKey: altKeys.rawPublicKeyHex,
  });
  const altKeyAck = await sendSocketMessage(socketPath, altKeyMsg);
  assert.equal(altKeyAck.ok, false);
  assert.equal(altKeyAck.reason, 'TRUSTED_CONTEXT_FORGED');

  // 6. Unsigned context message fails closed
  const { message: unsignedMsg } = buildSignedContext({ keys, seq: 4, includeSignature: false });
  const unsignedAck = await sendSocketMessage(socketPath, unsignedMsg);
  assert.equal(unsignedAck.ok, false);
  assert.equal(unsignedAck.reason, 'TRUSTED_CONTEXT_FORGED');

  // 7. Expired context fails closed
  const { message: expiredMsg } = buildSignedContext({
    keys,
    seq: 5,
    expiresAt: new Date(Date.now() - 5000).toISOString(),
  });
  const expiredAck = await sendSocketMessage(socketPath, expiredMsg);
  assert.equal(expiredAck.ok, false);
  assert.equal(expiredAck.reason, 'TRUSTED_CONTEXT_EXPIRED');
});

// ─────────────────────────────────────────────────────────────
// 3. Matrix Tests: Cryptographic, Context Binding, Budget, Batch
// ─────────────────────────────────────────────────────────────
test('matrix: valid permit allow vs tampered-digest/forged/expired/wrong-key/wrong-profile/stale-fence/replay/over-budget/unknown-raw', () => {
  const keys = makeKeyPair();
  const otherKeys = makeKeyPair();
  const permitStore = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, keyId: keys.keyId, permitStore, mode: 'enforce' });

  const { message: context } = buildSignedContext({ keys, fenceEpoch: 3, bindingRevision: 2 });

  // 1. Valid allow
  const validPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 2 });
  const r1 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: validPermit,
    context,
  });
  assert.equal(r1.decision, 'allow');
  assert.equal(r1.actionClass, 'browser.navigate');

  // 2. Tampered permitDigest (altered permitDigest whose signature projection still verifies) -> Denied
  const tamperedDigestPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 2, tamperDigest: true });
  const r2_td = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: tamperedDigestPermit,
    context,
  });
  assert.equal(r2_td.decision, 'deny');
  assert.equal(r2_td.reason, 'EXECUTION_PERMIT_FORGED');

  // 3. Missing permit deny
  const r2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: {},
    permit: null,
    context,
  });
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.reason, 'EXECUTION_PERMIT_REQUIRED');

  // 4. Forged permit signature deny
  const forgedPermit = { ...validPermit, nonce: 'nonce_f1', signature: 'ee'.repeat(64) };
  const r3 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: forgedPermit,
    context,
  });
  assert.equal(r3.decision, 'deny');
  assert.equal(r3.reason, 'EXECUTION_PERMIT_FORGED');

  // 5. Expired permit deny
  const expiredPermit = buildSignedPermit({
    keys,
    claimGeneration: 3,
    bindingRevision: 2,
    expiresAt: new Date(Date.now() - 10000).toISOString(),
  });
  const r4 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: expiredPermit,
    context,
  });
  assert.equal(r4.decision, 'deny');
  assert.equal(r4.reason, 'EXECUTION_PERMIT_EXPIRED');

  // 6. Wrong key permit deny
  const wrongKeyPermit = buildSignedPermit({ keys: otherKeys, claimGeneration: 3, bindingRevision: 2 });
  const r5 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: wrongKeyPermit,
    context,
  });
  assert.equal(r5.decision, 'deny');
  assert.ok(['EXECUTION_KEY_MISMATCH', 'EXECUTION_PERMIT_FORGED'].includes(r5.reason));

  // 7. Wrong profile deny
  const wrongProfilePermit = buildSignedPermit({
    keys,
    claimGeneration: 3,
    bindingRevision: 2,
    profileAlias: 'different-profile',
  });
  const r6 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: wrongProfilePermit,
    context,
  });
  assert.equal(r6.decision, 'deny');
  assert.equal(r6.reason, 'EXECUTION_PROFILE_MISMATCH');

  // 8. Stale fence deny (context has fenceEpoch 3, permit has claimGeneration 2)
  const staleFencePermit = buildSignedPermit({ keys, claimGeneration: 2, bindingRevision: 2 });
  const r7 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: staleFencePermit,
    context,
  });
  assert.equal(r7.decision, 'deny');
  assert.equal(r7.reason, 'EXECUTION_FENCE_STALE');

  // 9. Replay permit nonce deny
  const replayPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 2, nonce: 'nonce_replay_test' });
  const r8_1 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: replayPermit,
    context,
  });
  assert.equal(r8_1.decision, 'allow');
  const r8_2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: replayPermit,
    context,
  });
  assert.equal(r8_2.decision, 'deny');
  assert.equal(r8_2.reason, 'EXECUTION_PERMIT_REVOKED');

  // 10. Over budget deny
  const budgetPermit1 = buildSignedPermit({
    keys,
    permitId: 'permit_budget_unique_id',
    claimGeneration: 3,
    bindingRevision: 2,
    budget: { maxCalls: 1 },
    nonce: 'nonce_budget_first',
  });
  const r9_1 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: budgetPermit1,
    context,
  });
  assert.equal(r9_1.decision, 'allow');

  const budgetPermit2 = buildSignedPermit({
    keys,
    permitId: 'permit_budget_unique_id',
    claimGeneration: 3,
    bindingRevision: 2,
    budget: { maxCalls: 1 },
    nonce: 'nonce_budget_second',
  });
  const r9_2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: budgetPermit2,
    context,
  });
  assert.equal(r9_2.decision, 'deny');
  assert.equal(r9_2.reason, 'EXECUTION_BUDGET_EXHAUSTED');

  // 11. Unknown raw command deny
  const r10 = verifier.verifyRequest({
    tool: 'browser_raw_command',
    params: { method: '???forbidden!!!' },
    permit: validPermit,
    context,
  });
  assert.equal(r10.decision, 'deny');
  assert.equal(r10.reason, 'TOOL_ACTION_NOT_ALLOWED');
});

test('batch preflight denies whole batch and reserves multi-child budget atomically', () => {
  const keys = makeKeyPair();
  const permitStore = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, permitStore, mode: 'enforce' });

  const { message: context } = buildSignedContext({ keys, fenceEpoch: 1 });

  // 1. Two-child batch with maxCalls=1 -> Fails budget preflight, 0 budget consumed
  const tightBudgetPermit = buildSignedPermit({
    keys,
    claimGeneration: 1,
    origins: ['https://example.test'],
    budget: { maxCalls: 1 },
    nonce: 'nonce_batch_tight_budget',
  });

  const twoChildParams = {
    actions: [
      { method: 'browser_navigate', params: { url: 'https://example.test' } },
      { method: 'browser_navigate', params: { url: 'https://example.test' } },
    ],
  };

  const tightBudgetRes = verifier.verifyBatch({
    tool: 'browser_batch',
    params: twoChildParams,
    permit: tightBudgetPermit,
    context,
  });

  assert.equal(tightBudgetRes.decision, 'deny');
  assert.equal(tightBudgetRes.reason, 'EXECUTION_BUDGET_EXHAUSTED');
  assert.equal(permitStore.budget.get(tightBudgetPermit.permitId), undefined, 'Budget entry should not be created on failed preflight');
  assert.equal(permitStore.seenNonce.has(tightBudgetPermit.nonce), false, 'Nonce should not be marked seen on failed preflight');

  // 2. Batch containing 1 valid action and 1 origin-violating action -> Denied, 0 budget consumed
  const batchPermit = buildSignedPermit({
    keys,
    claimGeneration: 1,
    origins: ['https://example.test'],
    budget: { maxCalls: 10 },
    nonce: 'nonce_batch_scope_test',
  });

  const mixedOriginParams = {
    actions: [
      { method: 'browser_navigate', params: { url: 'https://example.test' } },
      { method: 'browser_navigate', params: { url: 'https://malicious-origin.test' } },
    ],
  };

  const scopeDeniedRes = verifier.verifyBatch({
    tool: 'browser_batch',
    params: mixedOriginParams,
    permit: batchPermit,
    context,
  });

  assert.equal(scopeDeniedRes.decision, 'deny');
  assert.equal(scopeDeniedRes.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');
  assert.equal(scopeDeniedRes.children.length, 2);
  assert.equal(scopeDeniedRes.children[0].decision, 'allow');
  assert.equal(scopeDeniedRes.children[1].decision, 'deny');

  // Verify that budget and replay state were NOT consumed
  assert.equal(permitStore.budget.get(batchPermit.permitId), undefined);
  assert.equal(permitStore.seenNonce.has(batchPermit.nonce), false);

  // 3. Valid two-child batch with maxCalls=2 -> Atomically reserves 2 calls
  const validBatchPermit = buildSignedPermit({
    keys,
    claimGeneration: 1,
    origins: ['https://example.test'],
    budget: { maxCalls: 2 },
    nonce: 'nonce_batch_valid_test',
  });

  const validBatchRes = verifier.verifyBatch({
    tool: 'browser_batch',
    params: twoChildParams,
    permit: validBatchPermit,
    context,
  });

  assert.equal(validBatchRes.decision, 'allow');
  assert.equal(validBatchRes.children.length, 2);
  const budgetEntry = permitStore.budget.get(validBatchPermit.permitId);
  assert.equal(budgetEntry.used, 2, 'Batch of 2 child calls consumed exactly 2 budget units');
  assert.equal(permitStore.seenNonce.has(validBatchPermit.nonce), true);
});

// ─────────────────────────────────────────────────────────────
// 4. Fixture Vectors Contract Parity
// ─────────────────────────────────────────────────────────────
test('fixtures: e4-cli-interactive-vectors.json vectors pass strict verification', () => {
  const fixturePath = fileURLToPath(new URL('../fixtures/e4-cli-interactive-vectors.json', import.meta.url));
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  assert.equal(fixture.contract, 'webmcp-browser-e4-cli-interactive-vectors/1');

  const pubKey = toKeyObject(fixture.keys.spkiPublicKeyPem);
  assert.ok(pubKey);

  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: pubKey, keyId: fixture.keys.keyId, permitStore: store, mode: 'enforce' });
  const fixtureTime = new Date('2026-08-27T00:30:00.000Z');

  const validCtxVec = fixture.vectors.find((v) => v.id === 'valid-trusted-context');
  const validPermitVec = fixture.vectors.find((v) => v.id === 'valid-permit');
  const tamperedDigestVec = fixture.vectors.find((v) => v.id === 'tampered-digest-permit');
  const forgedPermitVec = fixture.vectors.find((v) => v.id === 'forged-permit');
  const wrongProfileVec = fixture.vectors.find((v) => v.id === 'wrong-profile-permit');
  const staleFenceVec = fixture.vectors.find((v) => v.id === 'stale-fence-permit');

  assert.ok(validCtxVec && validPermitVec);

  // Valid permit + context allows
  const rValid = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: validPermitVec.permit,
    context: validCtxVec.message,
    now: fixtureTime,
  });
  assert.equal(rValid.decision, 'allow');

  // Tampered permit digest denies
  const rTampered = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: tamperedDigestVec.permit,
    context: validCtxVec.message,
    now: fixtureTime,
  });
  assert.equal(rTampered.decision, 'deny');
  assert.equal(rTampered.reason, 'EXECUTION_PERMIT_FORGED');

  // Forged permit denies
  const rForged = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: forgedPermitVec.permit,
    context: validCtxVec.message,
    now: fixtureTime,
  });
  assert.equal(rForged.decision, 'deny');
  assert.equal(rForged.reason, 'EXECUTION_PERMIT_FORGED');

  // Wrong profile denies
  const rWrongProf = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: wrongProfileVec.permit,
    context: validCtxVec.message,
    now: fixtureTime,
  });
  assert.equal(rWrongProf.decision, 'deny');
  assert.equal(rWrongProf.reason, 'EXECUTION_PROFILE_MISMATCH');

  // Stale fence denies
  const rStaleFence = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: staleFenceVec.permit,
    context: validCtxVec.message,
    now: fixtureTime,
  });
  assert.equal(rStaleFence.decision, 'deny');
  assert.equal(rStaleFence.reason, 'EXECUTION_FENCE_STALE');
});

// ─────────────────────────────────────────────────────────────
// 5. Observe Mode Fail-Closed Forwarding Test
// ─────────────────────────────────────────────────────────────
test('observe mode never forwards a would-deny command', async (t) => {
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `gateway-obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({
    port: 0,
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    interactiveMode: 'observe',
    allowTestSeams: true,
    token: 'test-secret-token',
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

  // Publish active context so server enters observe state with context
  const { message: contextMsg } = buildSignedContext({ keys, fenceEpoch: 2 });
  const sockAck = await sendSocketMessage(socketPath, contextMsg);
  assert.equal(sockAck.ok, true);

  // Request with invalid origin permit -> Would-deny in observe mode
  const permitWrongOrigin = buildSignedPermit({ keys, claimGeneration: 2, origins: ['https://allowed.test'] });
  const res = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'browser_navigate',
      params: { url: 'https://disallowed.test' },
      profileId: 'interactive-profile',
      permit: permitWrongOrigin,
    }),
  });

  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.decision, 'would-deny');
  assert.equal(body.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');
  assert.equal(fakeExt.forwarded.length, 0, 'Extension MUST NOT receive any command on would-deny');
});

// ─────────────────────────────────────────────────────────────
// 6. End-to-End Real Gateway Server + Real Sockets Integration
// ─────────────────────────────────────────────────────────────
test('e2e: real gateway server with real unix socket trusted context and real HTTP enforcement', async (t) => {
  const socketPath = path.join(os.tmpdir(), `gateway-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const keys = makeKeyPair();

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

  // 1. Connect fake browser extension with profile 'interactive-profile'
  const fakeExt = makeFakeExtension(actualPort, 'interactive-profile');
  t.after(() => {
    try { fakeExt.ws.terminate(); } catch {}
  });

  await waitFor(async () => app.connectedProfileIds().includes('interactive-profile'));

  // 2. Health check before trusted context update
  const healthRes1 = await fetch(`http://127.0.0.1:${actualPort}/health`);
  const health1 = await healthRes1.json();
  assert.equal(health1.ok, true);
  assert.equal(health1.interactive.enabled, true);
  assert.equal(health1.interactive.hasContext, false);

  // 3. HTTP POST /api in enforce mode BEFORE trusted context is established -> Denied 403
  const validPermitBeforeContext = buildSignedPermit({ keys, claimGeneration: 2 });
  const noCtxRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'browser_navigate',
      params: { url: 'https://example.test' },
      profileId: 'interactive-profile',
      permit: validPermitBeforeContext,
    }),
  });
  assert.equal(noCtxRes.status, 403);
  const noCtxBody = await noCtxRes.json();
  assert.equal(noCtxBody.decision, 'deny');
  assert.equal(noCtxBody.reason, 'EXECUTION_CONTEXT_REQUIRED');
  assert.equal(fakeExt.forwarded.length, 0, 'No message should reach extension when context is missing');

  // 4. Publish active context over Unix domain socket
  const { message: contextMsg } = buildSignedContext({ keys, fenceEpoch: 2 });
  const sockAck = await sendSocketMessage(socketPath, contextMsg);
  assert.equal(sockAck.ok, true);

  // 4a. Unauthenticated health check exposes minimal status and omits sensitive contextSummary
  const unauthHealthRes = await fetch(`http://127.0.0.1:${actualPort}/health`);
  const unauthHealth = await unauthHealthRes.json();
  assert.equal(unauthHealth.interactive.hasContext, true);
  assert.equal(unauthHealth.interactive.contextSummary, undefined);

  // 4b. Authenticated health check with token provides full contextSummary
  const authHealthRes = await fetch(`http://127.0.0.1:${actualPort}/health`, {
    headers: { Authorization: 'Bearer test-secret-token' },
  });
  const authHealth = await authHealthRes.json();
  assert.equal(authHealth.interactive.hasContext, true);
  assert.equal(authHealth.interactive.contextSummary.projectId, 'project_test_123');

  // 5. HTTP POST /api without permit -> Denied 403
  const unauthRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'browser_navigate',
      params: { url: 'https://example.test' },
      profileId: 'interactive-profile',
    }),
  });
  assert.equal(unauthRes.status, 403);
  const unauthBody = await unauthRes.json();
  assert.equal(unauthBody.decision, 'deny');
  assert.equal(unauthBody.reason, 'EXECUTION_PERMIT_REQUIRED');
  assert.equal(fakeExt.forwarded.length, 0, 'No message should reach extension on missing permit');

  // 6. HTTP POST /api with valid signed permit -> Allowed 200 and forwarded to Extension
  const validPermit = buildSignedPermit({ keys, claimGeneration: 2 });
  const validRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'browser_navigate',
      params: { url: 'https://example.test' },
      profileId: 'interactive-profile',
      permit: validPermit,
    }),
  });
  assert.equal(validRes.status, 200);
  const validBody = await validRes.json();
  assert.equal(validBody.result.echoedMethod, 'navigate');
  assert.ok(validBody.receipt);
  assert.equal(validBody.receipt.decision, 'allow');
  assert.equal(fakeExt.forwarded.length, 1, 'Extension received forwarded command');

  // 7. HTTP POST /api with tampered permitDigest -> Denied 403
  const tamperedPermit = buildSignedPermit({ keys, claimGeneration: 2, tamperDigest: true });
  const tamperedRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'browser_navigate',
      params: { url: 'https://example.test' },
      profileId: 'interactive-profile',
      permit: tamperedPermit,
    }),
  });
  assert.equal(tamperedRes.status, 403);
  const tamperedBody = await tamperedRes.json();
  assert.equal(tamperedBody.decision, 'deny');
  assert.equal(tamperedBody.reason, 'EXECUTION_PERMIT_FORGED');
  assert.equal(fakeExt.forwarded.length, 1, 'No additional command forwarded');

  // 8. HTTP POST /api with omitted profileId against a single connected wrong-profile WebSocket
  fakeExt.ws.close();
  await waitFor(async () => app.connectedProfileIds().length === 0);

  const wrongExt = makeFakeExtension(actualPort, 'unauthorized-other-profile');
  t.after(() => {
    try { wrongExt.ws.terminate(); } catch {}
  });
  await waitFor(async () => app.connectedProfileIds().includes('unauthorized-other-profile'));

  const omittedProfPermit = buildSignedPermit({ keys, claimGeneration: 2, profileAlias: 'interactive-profile' });
  const omittedProfRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'browser_navigate',
      params: { url: 'https://example.test' },
      // profileId intentionally omitted
      permit: omittedProfPermit,
    }),
  });
  assert.equal(omittedProfRes.status, 403);
  const omittedProfBody = await omittedProfRes.json();
  assert.equal(omittedProfBody.decision, 'deny');
  assert.equal(omittedProfBody.reason, 'EXECUTION_PROFILE_MISMATCH');
  assert.equal(wrongExt.forwarded.length, 0, 'No message forwarded to wrong profile extension');
});

// ─────────────────────────────────────────────────────────────
// 7. Hardening Regression Tests: Phase Fence, Store Revisions, Production Guards
// ─────────────────────────────────────────────────────────────
test('phase fence binding: enforces required phaseId, context phase binding, and expectedPhase', () => {
  const keys = makeKeyPair();
  const permitStore = new PermitStore();
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    expectedPhase: 'interactive-action',
    permitStore,
    mode: 'enforce',
  });

  const { message: ctxWithPhase } = buildSignedContext({ keys, fenceEpoch: 2, phaseId: 'interactive-action' });

  // 1. Valid phase matches both context and verifier expectedPhase
  const validPermit = buildSignedPermit({ keys, claimGeneration: 2 });
  const r1 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: validPermit,
    context: ctxWithPhase,
  });
  assert.equal(r1.decision, 'allow');

  // 2. Permit with mismatched phaseId vs context phaseId
  const wrongPhasePermit = buildSignedPermit({ keys, claimGeneration: 2 });
  wrongPhasePermit.phaseId = 'background-worker-phase';
  // Re-sign to make signature valid over the altered payload
  const { permitDigest: _pd, signature: _sig, ...proj } = wrongPhasePermit;
  const canonical = canonicalJson(proj);
  const toSign = Buffer.from(`webmcp-digest-v1:permit\n${canonical}`, 'utf8');
  wrongPhasePermit.signature = sign(null, toSign, keys.privateKey).toString('hex');
  wrongPhasePermit.permitDigest = digestCanonical('webmcp-digest-v1:permit', proj);

  const r2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: wrongPhasePermit,
    context: ctxWithPhase,
  });
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.reason, 'EXECUTION_PHASE_MISMATCH');

  // 3. Permit with missing phaseId fails structural check
  const missingPhasePermit = { ...validPermit };
  delete missingPhasePermit.phaseId;
  const r3 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: missingPhasePermit,
    context: ctxWithPhase,
  });
  assert.equal(r3.decision, 'deny');
  assert.equal(r3.reason, 'EXECUTION_PERMIT_MALFORMED');
});

test('revisions, digests, and key binding: strictly verifies binding, automation store, site store, and keyId', () => {
  const keys = makeKeyPair();
  const permitStore = new PermitStore();
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore,
    mode: 'enforce',
  });

  const { message: context } = buildSignedContext({
    keys,
    bindingRevision: 5,
    fenceEpoch: 3,
  });

  function resign(permitObj) {
    const { permitDigest: _pd, signature: _sig, ...proj } = permitObj;
    const canonical = canonicalJson(proj);
    const toSign = Buffer.from(`webmcp-digest-v1:permit\n${canonical}`, 'utf8');
    permitObj.signature = sign(null, toSign, keys.privateKey).toString('hex');
    permitObj.permitDigest = digestCanonical('webmcp-digest-v1:permit', proj);
    return permitObj;
  }

  // 1. Stale binding revision
  const staleBindingPermit = resign(buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 4 }));
  const r1 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: staleBindingPermit, context });
  assert.equal(r1.decision, 'deny');
  assert.equal(r1.reason, 'EXECUTION_REVISION_STALE');

  // 2. Mismatched binding digest
  const wrongBindingDigestPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5 });
  wrongBindingDigestPermit.bindingDigest = 'sha256:' + '9'.repeat(64);
  resign(wrongBindingDigestPermit);
  const r2 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: wrongBindingDigestPermit, context });
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.reason, 'EXECUTION_REVISION_STALE');

  // 3. Mismatched automation store digest
  const wrongAutoDigestPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5 });
  wrongAutoDigestPermit.automationStoreDigest = 'sha256:' + '8'.repeat(64);
  resign(wrongAutoDigestPermit);
  const r3 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: wrongAutoDigestPermit, context });
  assert.equal(r3.decision, 'deny');
  assert.equal(r3.reason, 'EXECUTION_REVISION_STALE');

  // 4. Mismatched site store digest
  const wrongSiteDigestPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5 });
  wrongSiteDigestPermit.siteStoreDigest = 'sha256:' + '7'.repeat(64);
  resign(wrongSiteDigestPermit);
  const r4 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: wrongSiteDigestPermit, context });
  assert.equal(r4.decision, 'deny');
  assert.equal(r4.reason, 'EXECUTION_REVISION_STALE');

  // 5. KeyId mismatch between permit and verifier
  const wrongKeyIdPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5 });
  wrongKeyIdPermit.keyId = 'untrusted-alternate-key-99';
  resign(wrongKeyIdPermit);
  const r5 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: wrongKeyIdPermit, context });
  assert.equal(r5.decision, 'deny');
  assert.equal(r5.reason, 'EXECUTION_KEY_MISMATCH');

  // 6. Stale plan revision
  const stalePlanPermit = resign(buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5, planRevision: 0 }));
  const r6 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: stalePlanPermit, context });
  assert.equal(r6.decision, 'deny');
  assert.equal(r6.reason, 'EXECUTION_REVISION_STALE');

  // 7. Mismatched plan digest
  const wrongPlanDigestPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5 });
  wrongPlanDigestPermit.planDigest = 'sha256:' + 'e'.repeat(64);
  resign(wrongPlanDigestPermit);
  const r7 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: wrongPlanDigestPermit, context });
  assert.equal(r7.decision, 'deny');
  assert.equal(r7.reason, 'EXECUTION_REVISION_STALE');

  // 8. Mismatched instruction digest
  const wrongInstDigestPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5 });
  wrongInstDigestPermit.instructionDigest = 'sha256:' + 'e'.repeat(64);
  resign(wrongInstDigestPermit);
  const r8 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: wrongInstDigestPermit, context });
  assert.equal(r8.decision, 'deny');
  assert.equal(r8.reason, 'EXECUTION_REVISION_STALE');

  // 9. Mismatched policy revision
  const wrongPolicyPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5 });
  wrongPolicyPermit.policyRevision = 'sha256:' + 'e'.repeat(64);
  resign(wrongPolicyPermit);
  const r9 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: wrongPolicyPermit, context });
  assert.equal(r9.decision, 'deny');
  assert.equal(r9.reason, 'EXECUTION_REVISION_STALE');

  // 10. Stale state version
  const staleStatePermit = resign(buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5, stateVersion: 0 }));
  const r10 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: staleStatePermit, context });
  assert.equal(r10.decision, 'deny');
  assert.equal(r10.reason, 'EXECUTION_REVISION_STALE');

  // 11. Mismatched runId
  const wrongRunIdPermit = resign(buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5, runId: 'run_other_123' }));
  const r11 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: wrongRunIdPermit, context });
  assert.equal(r11.decision, 'deny');
  assert.equal(r11.reason, 'EXECUTION_REVISION_STALE');

  // 12. Mismatched claim digest
  const wrongClaimDigestPermit = buildSignedPermit({ keys, claimGeneration: 3, bindingRevision: 5 });
  wrongClaimDigestPermit.claimDigest = 'sha256:' + 'e'.repeat(64);
  resign(wrongClaimDigestPermit);
  const r12 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test' }, permit: wrongClaimDigestPermit, context });
  assert.equal(r12.decision, 'deny');
  assert.equal(r12.reason, 'EXECUTION_REVISION_STALE');
});

test('production gateway construction guards injection surfaces and enforces fail-closed defaults (P0-1 & P0-2)', () => {
  const origEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';

    // 1. Injected custom runtime in production throws
    assert.throws(
      () => {
        createGatewayServer({
          interactiveRuntime: { mode: 'observe' },
        });
      },
      /not permitted in production/,
    );

    // 2. Injected custom runtime in production throws even if allowTestSeams: true is passed
    assert.throws(
      () => {
        createGatewayServer({
          interactiveRuntime: { mode: 'observe' },
          allowTestSeams: true,
        });
      },
      /not permitted in production/,
    );

    // 3. Setting observe mode in production throws
    assert.throws(
      () => {
        createGatewayServer({
          interactiveMode: 'observe',
        });
      },
      /only allowed through explicit test seams|cannot be selected by production caller/,
    );

    // 4. Setting observe mode in production throws even if allowTestSeams: true is passed
    assert.throws(
      () => {
        createGatewayServer({
          interactiveMode: 'observe',
          allowTestSeams: true,
        });
      },
      /only allowed through explicit test seams|cannot be selected by production caller/,
    );

    // 5. Production construction defaults to enforce mode
    const app = createGatewayServer({ port: 0 });
    assert.equal(app.runtime.mode, 'enforce');
  } finally {
    process.env.NODE_ENV = origEnv;
  }

  // 6. In non-production, setting observe mode without explicit allowTestSeams throws
  assert.throws(
    () => {
      createGatewayServer({
        interactiveMode: 'observe',
      });
    },
    /only allowed through explicit test seams/,
  );

  // 7. InteractiveRuntime without pinned key fails closed on any permit
  const noKeyVerifier = new GatewayVerifier({ publicKey: null, mode: 'enforce' });
  const keys = makeKeyPair();
  const samplePermit = buildSignedPermit({ keys });
  const noKeyRes = noKeyVerifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: samplePermit,
  });
  assert.equal(noKeyRes.decision, 'deny');
  assert.equal(noKeyRes.reason, 'EXECUTION_KEY_MISMATCH');
});

test('phaseId binding and expectedPhase enforcement denies before extension forwarding (P0-3)', async (t) => {
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `gateway-phase-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({
    port: 0,
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    expectedPhase: 'interactive-action',
    allowTestSeams: true,
    token: 'test-secret-token',
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

  // Publish context with phaseId 'interactive-action'
  const { message: contextMsg } = buildSignedContext({ keys, fenceEpoch: 1, phaseId: 'interactive-action' });
  const sockAck = await sendSocketMessage(socketPath, contextMsg);
  assert.equal(sockAck.ok, true);

  // 1. Permit with wrong phaseId -> Denied 403, 0 messages forwarded to extension
  const wrongPhasePermit = buildSignedPermit({ keys, claimGeneration: 1 });
  wrongPhasePermit.phaseId = 'wrong-phase-id';
  // Resign permit
  const { permitDigest: _pd, signature: _sig, ...proj } = wrongPhasePermit;
  wrongPhasePermit.signature = sign(null, Buffer.from(`webmcp-digest-v1:permit\n${canonicalJson(proj)}`, 'utf8'), keys.privateKey).toString('hex');
  wrongPhasePermit.permitDigest = digestCanonical('webmcp-digest-v1:permit', proj);

  const resWrongPhase = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'browser_navigate',
      params: { url: 'https://example.test' },
      profileId: 'interactive-profile',
      permit: wrongPhasePermit,
    }),
  });

  assert.equal(resWrongPhase.status, 403);
  const bodyWrongPhase = await resWrongPhase.json();
  assert.equal(bodyWrongPhase.decision, 'deny');
  assert.equal(bodyWrongPhase.reason, 'EXECUTION_PHASE_MISMATCH');
  assert.equal(fakeExt.forwarded.length, 0, 'Must deny before extension forwarding');

  // 2. Permit with missing phaseId -> Denied 403, 0 messages forwarded to extension
  const missingPhasePermit = buildSignedPermit({ keys, claimGeneration: 1 });
  delete missingPhasePermit.phaseId;
  const resMissingPhase = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'browser_navigate',
      params: { url: 'https://example.test' },
      profileId: 'interactive-profile',
      permit: missingPhasePermit,
    }),
  });

  assert.equal(resMissingPhase.status, 403);
  const bodyMissingPhase = await resMissingPhase.json();
  assert.equal(bodyMissingPhase.decision, 'deny');
  assert.equal(bodyMissingPhase.reason, 'EXECUTION_PERMIT_MALFORMED');
  assert.equal(fakeExt.forwarded.length, 0, 'Must deny before extension forwarding');
});

test('contextDigest and permitDigest verification only against pinned key (P0-4)', async (t) => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore: store,
    mode: 'enforce',
  });

  const { message: context } = buildSignedContext({ keys, fenceEpoch: 1 });

  // 1. Altered contextDigest fails closed
  const tamperedContext = { ...context, contextDigest: 'sha256:' + 'f'.repeat(64) };
  const validPermit = buildSignedPermit({ keys, claimGeneration: 1 });
  const rTamperedCtx = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: validPermit,
    context: tamperedContext,
  });
  assert.equal(rTamperedCtx.decision, 'deny');
  assert.equal(rTamperedCtx.reason, 'EXECUTION_PERMIT_FORGED');

  // 2. Altered permitDigest fails closed
  const tamperedPermit = buildSignedPermit({ keys, claimGeneration: 1, tamperDigest: true });
  const rTamperedPermit = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: tamperedPermit,
    context,
  });
  assert.equal(rTamperedPermit.decision, 'deny');
  assert.equal(rTamperedPermit.reason, 'EXECUTION_PERMIT_FORGED');

  // 3. Alternate public key provided in permit fails closed
  const altKeys = makeKeyPair();
  const altKeyPermit = buildSignedPermit({ keys, claimGeneration: 1 });
  altKeyPermit.publicKey = altKeys.rawPublicKeyHex;
  const { permitDigest: _pd, signature: _sig, ...proj } = altKeyPermit;
  altKeyPermit.signature = sign(null, Buffer.from(`webmcp-digest-v1:permit\n${canonicalJson(proj)}`, 'utf8'), keys.privateKey).toString('hex');
  altKeyPermit.permitDigest = digestCanonical('webmcp-digest-v1:permit', proj);

  const rAltKey = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: altKeyPermit,
    context,
  });
  assert.equal(rAltKey.decision, 'deny');
  assert.equal(rAltKey.reason, 'EXECUTION_KEY_MISMATCH');
});

test('trusted context channel rejects oversized payload framing', async (t) => {
  const socketPath = path.join(os.tmpdir(), `test-large-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const keys = makeKeyPair();
  const channel = new TrustedContextChannel({
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
  });

  await channel.start();
  t.after(async () => {
    await channel.stop();
  });

  // Oversized 70KB message
  const largeData = {
    schema: SCHEMAS.TRUSTED_CONTEXT,
    messageId: 'large_msg',
    seq: 1,
    projectId: 'proj',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    junk: 'x'.repeat(70000),
  };

  const response = await sendSocketMessage(socketPath, largeData);
  assert.equal(response.ok, false);
  assert.equal(response.reason, 'TRUSTED_CONTEXT_SIZE_EXCEEDED');
});

// ─────────────────────────────────────────────────────────────
// 8. Focused Negative Tests: Missing Phase, TTL, Binding & Store Fields
// ─────────────────────────────────────────────────────────────
test('negative: validateTrustedContextMessage fails closed on missing phase, ttl, or binding fields', () => {
  const keys = makeKeyPair();

  // 1. Missing phaseId
  const { message: msgNoPhase } = buildSignedContext({ keys });
  delete msgNoPhase.phaseId;
  const resNoPhase = validateTrustedContextMessage(msgNoPhase);
  assert.equal(resNoPhase.ok, false);
  assert.equal(resNoPhase.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 2. Empty phaseId
  const { message: msgEmptyPhase } = buildSignedContext({ keys, phaseId: '   ' });
  const resEmptyPhase = validateTrustedContextMessage(msgEmptyPhase);
  assert.equal(resEmptyPhase.ok, false);
  assert.equal(resEmptyPhase.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 3. Missing ttlMs
  const { message: msgNoTtl } = buildSignedContext({ keys });
  delete msgNoTtl.ttlMs;
  const resNoTtl = validateTrustedContextMessage(msgNoTtl);
  assert.equal(resNoTtl.ok, false);
  assert.equal(resNoTtl.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 4. ttlMs > 60000
  const { message: msgOverTtl } = buildSignedContext({ keys, ttlMs: 60001 });
  const resOverTtl = validateTrustedContextMessage(msgOverTtl);
  assert.equal(resOverTtl.ok, false);
  assert.equal(resOverTtl.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 5. ttlMs <= 0
  const { message: msgZeroTtl } = buildSignedContext({ keys, ttlMs: 0 });
  const resZeroTtl = validateTrustedContextMessage(msgZeroTtl);
  assert.equal(resZeroTtl.ok, false);
  assert.equal(resZeroTtl.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 6. Missing keyId
  const { message: msgNoKeyId } = buildSignedContext({ keys });
  delete msgNoKeyId.keyId;
  const resNoKeyId = validateTrustedContextMessage(msgNoKeyId);
  assert.equal(resNoKeyId.ok, false);
  assert.equal(resNoKeyId.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 7. Missing publicKey
  const { message: msgNoPubKey } = buildSignedContext({ keys });
  delete msgNoPubKey.publicKey;
  const resNoPubKey = validateTrustedContextMessage(msgNoPubKey);
  assert.equal(resNoPubKey.ok, false);
  assert.equal(resNoPubKey.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 8. Missing bindingRevision
  const { message: msgNoBindRev } = buildSignedContext({ keys });
  delete msgNoBindRev.bindingRevision;
  const resNoBindRev = validateTrustedContextMessage(msgNoBindRev);
  assert.equal(resNoBindRev.ok, false);
  assert.equal(resNoBindRev.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 9. Missing bindingDigest
  const { message: msgNoBindDig } = buildSignedContext({ keys });
  delete msgNoBindDig.bindingDigest;
  const resNoBindDig = validateTrustedContextMessage(msgNoBindDig);
  assert.equal(resNoBindDig.ok, false);
  assert.equal(resNoBindDig.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 10. Missing automationStoreRevision
  const { message: msgNoAutoRev } = buildSignedContext({ keys });
  delete msgNoAutoRev.automationStoreRevision;
  const resNoAutoRev = validateTrustedContextMessage(msgNoAutoRev);
  assert.equal(resNoAutoRev.ok, false);
  assert.equal(resNoAutoRev.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 11. Missing automationStoreDigest
  const { message: msgNoAutoDig } = buildSignedContext({ keys });
  delete msgNoAutoDig.automationStoreDigest;
  const resNoAutoDig = validateTrustedContextMessage(msgNoAutoDig);
  assert.equal(resNoAutoDig.ok, false);
  assert.equal(resNoAutoDig.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 12. Missing siteStoreRevision
  const { message: msgNoSiteRev } = buildSignedContext({ keys });
  delete msgNoSiteRev.siteStoreRevision;
  const resNoSiteRev = validateTrustedContextMessage(msgNoSiteRev);
  assert.equal(resNoSiteRev.ok, false);
  assert.equal(resNoSiteRev.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 13. Missing siteStoreDigest
  const { message: msgNoSiteDig } = buildSignedContext({ keys });
  delete msgNoSiteDig.siteStoreDigest;
  const resNoSiteDig = validateTrustedContextMessage(msgNoSiteDig);
  assert.equal(resNoSiteDig.ok, false);
  assert.equal(resNoSiteDig.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 14. Missing projectId
  const { message: msgNoProj } = buildSignedContext({ keys });
  delete msgNoProj.projectId;
  const resNoProj = validateTrustedContextMessage(msgNoProj);
  assert.equal(resNoProj.ok, false);
  assert.equal(resNoProj.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 15. Missing profileAlias
  const { message: msgNoProfileAlias } = buildSignedContext({ keys });
  delete msgNoProfileAlias.profileAlias;
  const resNoProfileAlias = validateTrustedContextMessage(msgNoProfileAlias);
  assert.equal(resNoProfileAlias.ok, false);
  assert.equal(resNoProfileAlias.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 16. Missing profileId
  const { message: msgNoProfileId } = buildSignedContext({ keys });
  delete msgNoProfileId.profileId;
  const resNoProfileId = validateTrustedContextMessage(msgNoProfileId);
  assert.equal(resNoProfileId.ok, false);
  assert.equal(resNoProfileId.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 17. Missing contextDigest
  const { message: msgNoDigest } = buildSignedContext({ keys });
  delete msgNoDigest.contextDigest;
  const resNoDigest = validateTrustedContextMessage(msgNoDigest);
  assert.equal(resNoDigest.ok, false);
  assert.equal(resNoDigest.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 18. Missing runId
  const { message: msgNoRunId } = buildSignedContext({ keys });
  delete msgNoRunId.runId;
  const resNoRunId = validateTrustedContextMessage(msgNoRunId);
  assert.equal(resNoRunId.ok, false);
  assert.equal(resNoRunId.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 19. Missing claimGeneration
  const { message: msgNoClaimGen } = buildSignedContext({ keys });
  delete msgNoClaimGen.claimGeneration;
  const resNoClaimGen = validateTrustedContextMessage(msgNoClaimGen);
  assert.equal(resNoClaimGen.ok, false);
  assert.equal(resNoClaimGen.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 20. Missing claimDigest
  const { message: msgNoClaimDig } = buildSignedContext({ keys });
  delete msgNoClaimDig.claimDigest;
  const resNoClaimDig = validateTrustedContextMessage(msgNoClaimDig);
  assert.equal(resNoClaimDig.ok, false);
  assert.equal(resNoClaimDig.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 21. Missing fenceEpoch
  const { message: msgNoFence } = buildSignedContext({ keys });
  delete msgNoFence.fenceEpoch;
  const resNoFence = validateTrustedContextMessage(msgNoFence);
  assert.equal(resNoFence.ok, false);
  assert.equal(resNoFence.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 22. Missing stateVersion
  const { message: msgNoStateVer } = buildSignedContext({ keys });
  delete msgNoStateVer.stateVersion;
  const resNoStateVer = validateTrustedContextMessage(msgNoStateVer);
  assert.equal(resNoStateVer.ok, false);
  assert.equal(resNoStateVer.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 23. Missing planRevision
  const { message: msgNoPlanRev } = buildSignedContext({ keys });
  delete msgNoPlanRev.planRevision;
  const resNoPlanRev = validateTrustedContextMessage(msgNoPlanRev);
  assert.equal(resNoPlanRev.ok, false);
  assert.equal(resNoPlanRev.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 24. Missing planDigest
  const { message: msgNoPlanDig } = buildSignedContext({ keys });
  delete msgNoPlanDig.planDigest;
  const resNoPlanDig = validateTrustedContextMessage(msgNoPlanDig);
  assert.equal(resNoPlanDig.ok, false);
  assert.equal(resNoPlanDig.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 25. Missing instructionDigest
  const { message: msgNoInstDig } = buildSignedContext({ keys });
  delete msgNoInstDig.instructionDigest;
  const resNoInstDig = validateTrustedContextMessage(msgNoInstDig);
  assert.equal(resNoInstDig.ok, false);
  assert.equal(resNoInstDig.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 26. Missing policyRevision
  const { message: msgNoPolRev } = buildSignedContext({ keys });
  delete msgNoPolRev.policyRevision;
  const resNoPolRev = validateTrustedContextMessage(msgNoPolRev);
  assert.equal(resNoPolRev.ok, false);
  assert.equal(resNoPolRev.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 27. Missing bindingId
  const { message: msgNoBindId } = buildSignedContext({ keys });
  delete msgNoBindId.bindingId;
  const resNoBindId = validateTrustedContextMessage(msgNoBindId);
  assert.equal(resNoBindId.ok, false);
  assert.equal(resNoBindId.reason, 'TRUSTED_CONTEXT_MALFORMED');

  // 28. Missing notBefore
  const { message: msgNoNotBefore } = buildSignedContext({ keys });
  delete msgNoNotBefore.notBefore;
  const resNoNotBefore = validateTrustedContextMessage(msgNoNotBefore);
  assert.equal(resNoNotBefore.ok, false);
  assert.equal(resNoNotBefore.reason, 'TRUSTED_CONTEXT_MALFORMED');
});

test('negative: validatePermitStructure fails closed on missing store fields, ttl, or required metadata', () => {
  const keys = makeKeyPair();

  // 1. Missing phaseId
  const p1 = buildSignedPermit({ keys });
  delete p1.phaseId;
  const r1 = validatePermitStructure(p1);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 2. Missing ttlMs
  const p2 = buildSignedPermit({ keys });
  delete p2.ttlMs;
  const r2 = validatePermitStructure(p2);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 3. ttlMs > 60000
  const p3 = buildSignedPermit({ keys, ttlMs: 60001 });
  const r3 = validatePermitStructure(p3);
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 4. ttlMs <= 0
  const p4 = buildSignedPermit({ keys, ttlMs: 0 });
  const r4 = validatePermitStructure(p4);
  assert.equal(r4.ok, false);
  assert.equal(r4.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 5. Missing automationStoreRevision
  const p5 = buildSignedPermit({ keys });
  delete p5.automationStoreRevision;
  const r5 = validatePermitStructure(p5);
  assert.equal(r5.ok, false);
  assert.equal(r5.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 6. Missing automationStoreDigest
  const p6 = buildSignedPermit({ keys });
  delete p6.automationStoreDigest;
  const r6 = validatePermitStructure(p6);
  assert.equal(r6.ok, false);
  assert.equal(r6.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 7. Missing siteStoreRevision
  const p7 = buildSignedPermit({ keys });
  delete p7.siteStoreRevision;
  const r7 = validatePermitStructure(p7);
  assert.equal(r7.ok, false);
  assert.equal(r7.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 8. Missing siteStoreDigest
  const p8 = buildSignedPermit({ keys });
  delete p8.siteStoreDigest;
  const r8 = validatePermitStructure(p8);
  assert.equal(r8.ok, false);
  assert.equal(r8.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 9. Missing bindingRevision
  const p9 = buildSignedPermit({ keys });
  delete p9.bindingRevision;
  const r9 = validatePermitStructure(p9);
  assert.equal(r9.ok, false);
  assert.equal(r9.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 10. Missing bindingDigest
  const p10 = buildSignedPermit({ keys });
  delete p10.bindingDigest;
  const r10 = validatePermitStructure(p10);
  assert.equal(r10.ok, false);
  assert.equal(r10.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 11. Missing keyId
  const p11 = buildSignedPermit({ keys });
  delete p11.keyId;
  const r11 = validatePermitStructure(p11);
  assert.equal(r11.ok, false);
  assert.equal(r11.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 12. Missing profile (both profileAlias and profileId)
  const p12 = buildSignedPermit({ keys });
  delete p12.profileAlias;
  delete p12.profileId;
  const r12 = validatePermitStructure(p12);
  assert.equal(r12.ok, false);
  assert.equal(r12.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 12b. Missing profileAlias alone (profileId only)
  const p12b = buildSignedPermit({ keys });
  delete p12b.profileAlias;
  const r12b = validatePermitStructure(p12b);
  assert.equal(r12b.ok, false);
  assert.equal(r12b.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 12c. Empty profileAlias (profileId only)
  const p12c = buildSignedPermit({ keys });
  p12c.profileAlias = '   ';
  const r12c = validatePermitStructure(p12c);
  assert.equal(r12c.ok, false);
  assert.equal(r12c.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 12d. Missing profileId alone (profileAlias only)
  const p12d = buildSignedPermit({ keys });
  delete p12d.profileId;
  const r12d = validatePermitStructure(p12d);
  assert.equal(r12d.ok, false);
  assert.equal(r12d.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 12e. Empty profileId (profileAlias only)
  const p12e = buildSignedPermit({ keys });
  p12e.profileId = '   ';
  const r12e = validatePermitStructure(p12e);
  assert.equal(r12e.ok, false);
  assert.equal(r12e.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 13. Missing signature
  const p13 = buildSignedPermit({ keys });
  delete p13.signature;
  const r13 = validatePermitStructure(p13);
  assert.equal(r13.ok, false);
  assert.equal(r13.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 14. Missing permitDigest
  const p14 = buildSignedPermit({ keys });
  delete p14.permitDigest;
  const r14 = validatePermitStructure(p14);
  assert.equal(r14.ok, false);
  assert.equal(r14.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 15. Missing issuedAt
  const p15 = buildSignedPermit({ keys });
  delete p15.issuedAt;
  const r15 = validatePermitStructure(p15);
  assert.equal(r15.ok, false);
  assert.equal(r15.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 16. Missing notBefore
  const p16 = buildSignedPermit({ keys });
  delete p16.notBefore;
  const r16 = validatePermitStructure(p16);
  assert.equal(r16.ok, false);
  assert.equal(r16.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 17. Missing runId
  const p17 = buildSignedPermit({ keys });
  delete p17.runId;
  const r17 = validatePermitStructure(p17);
  assert.equal(r17.ok, false);
  assert.equal(r17.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 18. Missing claimGeneration
  const p18 = buildSignedPermit({ keys });
  delete p18.claimGeneration;
  const r18 = validatePermitStructure(p18);
  assert.equal(r18.ok, false);
  assert.equal(r18.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 19. Missing claimDigest
  const p19 = buildSignedPermit({ keys });
  delete p19.claimDigest;
  const r19 = validatePermitStructure(p19);
  assert.equal(r19.ok, false);
  assert.equal(r19.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 20. Missing stateVersion
  const p20 = buildSignedPermit({ keys });
  delete p20.stateVersion;
  const r20 = validatePermitStructure(p20);
  assert.equal(r20.ok, false);
  assert.equal(r20.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 21. Missing planRevision
  const p21 = buildSignedPermit({ keys });
  delete p21.planRevision;
  const r21 = validatePermitStructure(p21);
  assert.equal(r21.ok, false);
  assert.equal(r21.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 22. Missing planDigest
  const p22 = buildSignedPermit({ keys });
  delete p22.planDigest;
  const r22 = validatePermitStructure(p22);
  assert.equal(r22.ok, false);
  assert.equal(r22.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 23. Missing instructionDigest
  const p23 = buildSignedPermit({ keys });
  delete p23.instructionDigest;
  const r23 = validatePermitStructure(p23);
  assert.equal(r23.ok, false);
  assert.equal(r23.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 24. Missing policyRevision
  const p24 = buildSignedPermit({ keys });
  delete p24.policyRevision;
  const r24 = validatePermitStructure(p24);
  assert.equal(r24.ok, false);
  assert.equal(r24.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 25. Missing bindingId
  const p25 = buildSignedPermit({ keys });
  delete p25.bindingId;
  const r25 = validatePermitStructure(p25);
  assert.equal(r25.ok, false);
  assert.equal(r25.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 26. Missing budget.maxCalls or non-positive maxCalls
  const p26 = buildSignedPermit({ keys });
  p26.budget = { maxCalls: 0 };
  const r26 = validatePermitStructure(p26);
  assert.equal(r26.ok, false);
  assert.equal(r26.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 27. Missing origins (empty array)
  const p27 = buildSignedPermit({ keys });
  p27.origins = [];
  const r27 = validatePermitStructure(p27);
  assert.equal(r27.ok, false);
  assert.equal(r27.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 27b. Bare wildcard origin ['*']
  const p27b = buildSignedPermit({ keys });
  p27b.origins = ['*'];
  const r27b = validatePermitStructure(p27b);
  assert.equal(r27b.ok, false);
  assert.equal(r27b.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 27c. Wildcard in origin host ['https://*']
  const p27c = buildSignedPermit({ keys });
  p27c.origins = ['https://*'];
  const r27c = validatePermitStructure(p27c);
  assert.equal(r27c.ok, false);
  assert.equal(r27c.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 27d. Wildcard subdomain ['https://*.example.com']
  const p27d = buildSignedPermit({ keys });
  p27d.origins = ['https://*.example.com'];
  const r27d = validatePermitStructure(p27d);
  assert.equal(r27d.ok, false);
  assert.equal(r27d.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 27e. Unnormalized origin with trailing slash ['https://example.test/']
  const p27e = buildSignedPermit({ keys });
  p27e.origins = ['https://example.test/'];
  const r27e = validatePermitStructure(p27e);
  assert.equal(r27e.ok, false);
  assert.equal(r27e.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 27f. Unnormalized origin with path ['https://example.test/path']
  const p27f = buildSignedPermit({ keys });
  p27f.origins = ['https://example.test/path'];
  const r27f = validatePermitStructure(p27f);
  assert.equal(r27f.ok, false);
  assert.equal(r27f.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 27g. Non-http/https origin ['javascript:void(0)']
  const p27g = buildSignedPermit({ keys });
  p27g.origins = ['javascript:void(0)'];
  const r27g = validatePermitStructure(p27g);
  assert.equal(r27g.ok, false);
  assert.equal(r27g.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 28. Missing actionClasses (empty array)
  const p28 = buildSignedPermit({ keys });
  p28.actionClasses = [];
  const r28 = validatePermitStructure(p28);
  assert.equal(r28.ok, false);
  assert.equal(r28.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 28b. Bare wildcard actionClass ['*']
  const p28b = buildSignedPermit({ keys });
  p28b.actionClasses = ['*'];
  const r28b = validatePermitStructure(p28b);
  assert.equal(r28b.ok, false);
  assert.equal(r28b.reason, 'EXECUTION_PERMIT_MALFORMED');
});

test('negative: verifier rejects missing context phase even when expectedPhase matches permit', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    expectedPhase: 'expected-stage-1',
    permitStore: store,
    mode: 'enforce',
  });

  const permit = buildSignedPermit({ keys, phaseId: 'expected-stage-1' });

  // 1. Context with missing/undefined phaseId fails closed with EXECUTION_PHASE_MISMATCH
  const { message: contextWithoutPhase } = buildSignedContext({ keys });
  delete contextWithoutPhase.phaseId;
  const { signature: _cs, contextDigest: _cd, ...ctxProj } = contextWithoutPhase;
  contextWithoutPhase.contextDigest = digestCanonical('webmcp-digest-v1:trusted-context', ctxProj);
  contextWithoutPhase.signature = sign(null, Buffer.from(`webmcp-digest-v1:trusted-context\n${canonicalJson(ctxProj)}`, 'utf8'), keys.privateKey).toString('hex');

  const result1 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit,
    context: contextWithoutPhase,
  });

  assert.equal(result1.decision, 'deny');
  assert.equal(result1.reason, 'EXECUTION_PHASE_MISMATCH');

  // 2. Context with mismatched phaseId fails closed
  const { message: contextDiffPhase } = buildSignedContext({ keys, phaseId: 'other-stage' });
  const result2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit,
    context: contextDiffPhase,
  });

  assert.equal(result2.decision, 'deny');
  assert.equal(result2.reason, 'EXECUTION_PHASE_MISMATCH');

  // 3. Permit with mismatched phaseId against expectedPhase fails closed even if no context
  const permitWrongPhase = buildSignedPermit({ keys, phaseId: 'wrong-phase' });
  const result3 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: permitWrongPhase,
    context: null,
  });

  assert.equal(result3.decision, 'deny');
  assert.equal(result3.reason, 'EXECUTION_PHASE_MISMATCH');
});

test('regression: missing target origin fails closed for single actions and batch children', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore: store,
    mode: 'enforce',
  });

  const { message: context } = buildSignedContext({ keys });
  const permit = buildSignedPermit({ keys, origins: ['https://example.test'] });

  // 1. Single action with missing origin (no url or targetOrigin in params) fails closed
  const r1 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: {},
    permit,
    context,
  });
  assert.equal(r1.decision, 'deny');
  assert.equal(r1.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');

  // 2. Single action with non-http/https origin fails closed
  const r2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'javascript:alert(1)' },
    permit,
    context,
  });
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');

  // 3. Batch where one child is missing origin fails the whole batch and commits 0 budget/replay
  const batchPermit = buildSignedPermit({
    keys,
    origins: ['https://example.test'],
    budget: { maxCalls: 5 },
  });

  const rBatch = verifier.verifyBatch({
    tool: 'batch',
    params: {
      actions: [
        { method: 'browser_navigate', params: { url: 'https://example.test' } },
        { method: 'browser_click', params: {} }, // missing origin
      ],
    },
    permit: batchPermit,
    context,
  });
  assert.equal(rBatch.decision, 'deny');
  assert.equal(rBatch.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');
  assert.equal(store.budget.get(batchPermit.permitId)?.used ?? 0, 0);
  assert.equal(store.isReplay(batchPermit.nonce, Date.now()), false);
});

test('regression: action scope exactness denies raw command escalation unless explicit wildcard is used', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore: store,
    mode: 'enforce',
  });

  const { message: context } = buildSignedContext({ keys });

  // 1. Permit with actionClasses: ['browser.raw'] does NOT authorize a raw leaf
  const permitExactRaw = buildSignedPermit({
    keys,
    actionClasses: ['browser.raw'],
    origins: ['https://example.test'],
  });
  const rExact = verifier.verifyRequest({
    tool: 'browser_raw_command',
    params: { method: 'getCookies', url: 'https://example.test' },
    permit: permitExactRaw,
    context,
  });
  assert.equal(rExact.decision, 'deny');
  assert.equal(rExact.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');

  // 2. Permit with actionClasses: ['browser.raw.*'] authorizes a catalogued raw leaf
  const permitWildcardRaw = buildSignedPermit({
    keys,
    actionClasses: ['browser.raw.*'],
    origins: ['https://example.test'],
  });
  const rWildcard = verifier.verifyRequest({
    tool: 'browser_raw_command',
    params: { method: 'getCookies', url: 'https://example.test' },
    permit: permitWildcardRaw,
    context,
  });
  assert.equal(rWildcard.decision, 'allow');

  // 3. Unknown/invalid raw commands are always denied even with browser.raw.*
  const rUnknownName = verifier.verifyRequest({
    tool: 'browser_raw_command',
    params: { method: 'custom_method', url: 'https://example.test' },
    permit: permitWildcardRaw,
    context,
  });
  assert.equal(rUnknownName.decision, 'deny');
  assert.equal(rUnknownName.reason, 'TOOL_ACTION_NOT_ALLOWED');

  const rUnknown = verifier.verifyRequest({
    tool: 'browser_raw_command',
    params: { method: '???invalid!!!', url: 'https://example.test' },
    permit: permitWildcardRaw,
    context,
  });
  assert.equal(rUnknown.decision, 'deny');
  assert.equal(rUnknown.reason, 'TOOL_ACTION_NOT_ALLOWED');
});

test('raw executable aliases must agree and explicit raw classes remain catalogued', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, keyId: keys.keyId, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys });
  const permit = buildSignedPermit({ keys, actionClasses: ['browser.raw.*'], origins: ['https://example.test'] });

  const divergent = verifier.verifyRequest({
    tool: 'browser_raw_command',
    params: { method: 'getCookies', command: 'setCookie', url: 'https://example.test' },
    permit,
    context,
  });
  assert.equal(divergent.decision, 'deny');
  assert.equal(divergent.reason, 'TOOL_ACTION_NOT_ALLOWED');

  const unknown = verifier.verifyRequest({
    tool: 'browser_raw_command',
    params: { method: 'custom_method', url: 'https://example.test' },
    permit,
    context,
  });
  assert.equal(unknown.decision, 'deny');
  assert.equal(unknown.reason, 'TOOL_ACTION_NOT_ALLOWED');
});

test('regression: download methods listDownloadEvents and clearDownloadEvents require verification in interactive mode', async (t) => {
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `gateway-dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({
    port: 0,
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    allowTestSeams: true,
  });

  const { port: actualPort } = await app.start();
  t.after(async () => {
    await app.close();
  });

  const client = net.createConnection(socketPath);
  await new Promise((resolve) => client.once('connect', resolve));
  const { message: ctxMsg } = buildSignedContext({ keys });
  client.write(JSON.stringify(ctxMsg) + '\n');
  await new Promise((r) => setTimeout(r, 80));
  client.end();

  // 1. listDownloadEvents in enforce mode without permit -> 403 EXECUTION_PERMIT_REQUIRED
  const unauthRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'listDownloadEvents', params: {} }),
  });
  assert.equal(unauthRes.status, 403);
  const unauthBody = await unauthRes.json();
  assert.equal(unauthBody.reason, 'EXECUTION_PERMIT_REQUIRED');

  // 2. listDownloadEvents with valid permit and valid targetOrigin -> 200 with result and receipt
  const validDlPermit = buildSignedPermit({
    keys,
    actionClasses: ['browser.listDownloadEvents', 'browser.clearDownloadEvents'],
    origins: ['https://example.test'],
  });
  const authRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'listDownloadEvents',
      params: { targetOrigin: 'https://example.test' },
      permit: validDlPermit,
      targetOrigin: 'https://example.test',
    }),
  });
  assert.equal(authRes.status, 200);
  const authBody = await authRes.json();
  assert.ok(authBody.result);
  assert.ok(authBody.receipt);
  assert.equal(authBody.receipt.decision, 'allow');
  assert.equal(authBody.receipt.actionClass, 'browser.listDownloadEvents');

  // 3. clearDownloadEvents in enforce mode without permit -> 403 EXECUTION_PERMIT_REQUIRED
  const clearUnauthRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'clearDownloadEvents' }),
  });
  assert.equal(clearUnauthRes.status, 403);

  // 4. clearDownloadEvents with valid permit -> 200 with result and receipt
  const validClearPermit = buildSignedPermit({
    keys,
    actionClasses: ['browser.clearDownloadEvents'],
    origins: ['https://example.test'],
  });
  const clearAuthRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'clearDownloadEvents',
      params: { targetOrigin: 'https://example.test' },
      permit: validClearPermit,
      targetOrigin: 'https://example.test',
    }),
  });
  assert.equal(clearAuthRes.status, 200);
  const clearAuthBody = await clearAuthRes.json();
  assert.ok(clearAuthBody.result);
  assert.ok(clearAuthBody.receipt);
  assert.equal(clearAuthBody.receipt.decision, 'allow');
});

test('regression: production construction rejects caller override of pinned public key, keyId, and socketPath', () => {
  const origEnv = process.env.NODE_ENV;
  const origKey = process.env.WEBMCP_RUNNER_PUBLIC_KEY;
  const origKeyId = process.env.WEBMCP_RUNNER_KEY_ID;
  const origSock = process.env.WEBMCP_TRUSTED_CONTEXT_SOCKET;
  try {
    process.env.NODE_ENV = 'production';
    process.env.WEBMCP_RUNNER_PUBLIC_KEY = 'pinned-public-key-hex-0001';
    process.env.WEBMCP_RUNNER_KEY_ID = 'pinned-key-id-0001';
    process.env.WEBMCP_TRUSTED_CONTEXT_SOCKET = '/tmp/pinned.sock';

    // 1. Overriding publicKey in production throws
    assert.throws(
      () => createGatewayServer({ publicKey: 'different-public-key' }),
      /Passing custom publicKey is not permitted in production construction/,
    );

    // 2. Overriding keyId in production throws
    assert.throws(
      () => createGatewayServer({ keyId: 'different-key-id' }),
      /Passing custom keyId is not permitted in production construction/,
    );

    // 3. Overriding socketPath in production throws
    assert.throws(
      () => createGatewayServer({ socketPath: '/tmp/different.sock' }),
      /Passing custom socketPath is not permitted in production construction/,
    );

    // 4. In InteractiveRuntime direct construction
    assert.throws(
      () => new InteractiveRuntime({ publicKey: 'different-public-key' }),
      /Passing custom publicKey is not permitted in production construction/,
    );
  } finally {
    process.env.NODE_ENV = origEnv;
    process.env.WEBMCP_RUNNER_PUBLIC_KEY = origKey;
    process.env.WEBMCP_RUNNER_KEY_ID = origKeyId;
    process.env.WEBMCP_TRUSTED_CONTEXT_SOCKET = origSock;
  }
});

test('regression: receipt includes safe identity and store revision audit facts', () => {
  const receiptBaseParams = {
    permitId: 'permit_test_123',
    runId: 'run_test_456',
    projectId: 'project_test_789',
    profileAlias: 'interactive-profile',
    profileId: 'interactive-profile-id',
    claimGeneration: 5,
    claimDigest: 'sha256:' + 'e'.repeat(64),
    fenceEpoch: 4,
    phaseId: 'interactive-action',
    bindingId: 'pb_test_123',
    bindingRevision: 7,
    bindingDigest: 'sha256:' + 'a'.repeat(64),
    automationStoreRevision: 3,
    automationStoreDigest: 'sha256:' + 'b'.repeat(64),
    siteStoreRevision: 4,
    siteStoreDigest: 'sha256:' + 'c'.repeat(64),
    stateVersion: 2,
    planRevision: 3,
    planDigest: 'sha256:' + 'f'.repeat(64),
    instructionDigest: 'sha256:' + '1'.repeat(64),
    policyRevision: 'sha256:' + 'd'.repeat(64),
    actionClass: 'browser.navigate',
    decision: 'allow',
    reason: null,
  };

  const receipt = createSafeReceipt(receiptBaseParams);

  assert.equal(receipt.schema, SCHEMAS.RECEIPT);
  assert.equal(receipt.permitId, 'permit_test_123');
  assert.equal(receipt.runId, 'run_test_456');
  assert.equal(receipt.projectId, 'project_test_789');
  assert.equal(receipt.profileAlias, 'interactive-profile');
  assert.equal(receipt.profileId, 'interactive-profile-id');
  assert.equal(receipt.claimGeneration, 5);
  assert.equal(receipt.claimDigest, 'sha256:' + 'e'.repeat(64));
  assert.equal(receipt.fenceEpoch, 4);
  assert.equal(receipt.phaseId, 'interactive-action');
  assert.equal(receipt.bindingId, 'pb_test_123');
  assert.equal(receipt.bindingRevision, 7);
  assert.equal(receipt.bindingDigest, 'sha256:' + 'a'.repeat(64));
  assert.equal(receipt.automationStoreRevision, 3);
  assert.equal(receipt.automationStoreDigest, 'sha256:' + 'b'.repeat(64));
  assert.equal(receipt.siteStoreRevision, 4);
  assert.equal(receipt.siteStoreDigest, 'sha256:' + 'c'.repeat(64));
  assert.equal(receipt.stateVersion, 2);
  assert.equal(receipt.planRevision, 3);
  assert.equal(receipt.planDigest, 'sha256:' + 'f'.repeat(64));
  assert.equal(receipt.instructionDigest, 'sha256:' + '1'.repeat(64));
  assert.equal(receipt.policyRevision, 'sha256:' + 'd'.repeat(64));
  assert.equal(receipt.actionClass, 'browser.navigate');
  assert.equal(receipt.decision, 'allow');
  assert.ok(receipt.receiptDigest.startsWith('sha256:'));

  // Ensure deterministic recompute of receiptDigest
  const { receiptDigest: _rd, ...proj } = receipt;
  const expectedDigest = digestCanonical('webmcp-digest-v1:tool-receipt', proj);
  assert.equal(receipt.receiptDigest, expectedDigest);

  // Assert every safe field is digest-sensitive
  const fieldsToMutate = [
    ['profileId', 'mutated-profile-id'],
    ['claimGeneration', 99],
    ['claimDigest', 'sha256:' + '9'.repeat(64)],
    ['fenceEpoch', 99],
    ['stateVersion', 99],
    ['planRevision', 99],
    ['planDigest', 'sha256:' + '9'.repeat(64)],
    ['instructionDigest', 'sha256:' + '9'.repeat(64)],
  ];
  for (const [field, newVal] of fieldsToMutate) {
    const mutated = createSafeReceipt({
      ...receiptBaseParams,
      [field]: newVal,
    });
    assert.notEqual(mutated.receiptDigest, receipt.receiptDigest, `Mutating ${field} must change receiptDigest`);
  }
});

// ─────────────────────────────────────────────────────────────
// 9. P0 & P1 Repair Regressions (P0-1, P0-2, P1-4, P1-5)
// ─────────────────────────────────────────────────────────────
test('P0-1 regression: caller metadata targetOrigin does not mask evil params.url', async (t) => {
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `gateway-p01-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({
    port: 0,
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
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

  const { message: contextMsg } = buildSignedContext({ keys, fenceEpoch: 1 });
  await sendSocketMessage(socketPath, contextMsg);

  // Permit is valid only for https://allowed.test
  const permit = buildSignedPermit({
    keys,
    claimGeneration: 1,
    origins: ['https://allowed.test'],
  });

  // Request supplies targetOrigin: https://allowed.test but params.url: https://evil.test
  const res = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'browser_navigate',
      params: { url: 'https://evil.test' },
      targetOrigin: 'https://allowed.test',
      profileId: 'interactive-profile',
      permit,
    }),
  });

  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.decision, 'deny');
  assert.equal(body.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');
  assert.equal(fakeExt.forwarded.length, 0, 'Zero extension forwards on evil forwarded url');
  assert.ok(body.receipt, 'Denial response includes receipt');
  assert.equal(body.receipt.profileId, 'interactive-profile');
  assert.equal(body.receipt.claimGeneration, 1);
  assert.equal(body.receipt.fenceEpoch, 1);
});

test('P0-2 regression: batch rejects conflicting tool vs method and forwards canonical {method, params}', async (t) => {
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `gateway-p02-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({
    port: 0,
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
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

  const { message: contextMsg } = buildSignedContext({ keys, fenceEpoch: 1 });
  await sendSocketMessage(socketPath, contextMsg);

  const permit = buildSignedPermit({
    keys,
    claimGeneration: 1,
    actionClasses: ['browser.navigate', 'browser.click', 'browser.batch'],
    origins: ['https://example.test'],
    budget: { maxCalls: 10 },
  });

  // 1. Conflicting { tool: allowed, method: raw } must be rejected with 0 extension forwards
  const conflictingRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'batch',
      params: {
        actions: [
          {
            tool: 'browser_navigate',
            method: 'browser_raw_command',
            params: { method: 'evil_raw', url: 'https://example.test' },
          },
        ],
      },
      profileId: 'interactive-profile',
      permit,
    }),
  });

  assert.equal(conflictingRes.status, 403);
  const conflictBody = await conflictingRes.json();
  assert.equal(conflictBody.decision, 'deny');
  assert.equal(fakeExt.forwarded.length, 0, 'Conflicting tool vs method must not forward any commands');

  // 2. Valid canonical batch with {method, params} forwards reconstructed canonical children stripped of metadata
  const validBatchRes = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-token',
    },
    body: JSON.stringify({
      method: 'batch',
      params: {
        actions: [
          {
            method: 'browser_navigate',
            params: { url: 'https://example.test' },
            targetOrigin: 'https://example.test', // metadata to be stripped
          },
          {
            method: 'browser_click',
            params: { url: 'https://example.test', selector: '#btn' },
          },
        ],
      },
      profileId: 'interactive-profile',
      permit: buildSignedPermit({
        keys,
        claimGeneration: 1,
        actionClasses: ['browser.navigate', 'browser.click', 'browser.batch'],
        origins: ['https://example.test'],
        budget: { maxCalls: 10 },
        nonce: 'nonce_p02_valid_batch',
      }),
    }),
  });

  assert.equal(validBatchRes.status, 200);
  assert.equal(fakeExt.forwarded.length, 1);
  const forwardedPayload = fakeExt.forwarded[0];
  assert.equal(forwardedPayload.method, 'batch');
  assert.equal(forwardedPayload.params.actions.length, 2);
  assert.deepEqual(forwardedPayload.params.actions[0], {
    method: 'navigate',
    params: { url: 'https://example.test' },
  });
  assert.deepEqual(forwardedPayload.params.actions[1], {
    method: 'click',
    params: { url: 'https://example.test', selector: '#btn' },
  });
});

test('P1-4 regression: bare wildcard in origins/actions rejected and browser.* cannot escalate to raw', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, keyId: keys.keyId, permitStore: store, mode: 'enforce' });
  const { message: context } = buildSignedContext({ keys, fenceEpoch: 1 });

  // 1. Permit with bare '*' origin fails structural check
  const permitStarOrigin = buildSignedPermit({ keys, claimGeneration: 1 });
  permitStarOrigin.origins = ['*'];
  const { permitDigest: _p1, signature: _s1, ...proj1 } = permitStarOrigin;
  permitStarOrigin.permitDigest = digestCanonical('webmcp-digest-v1:permit', proj1);
  permitStarOrigin.signature = sign(null, Buffer.from(`webmcp-digest-v1:permit\n${canonicalJson(proj1)}`, 'utf8'), keys.privateKey).toString('hex');

  const r1 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: permitStarOrigin,
    context,
  });
  assert.equal(r1.decision, 'deny');
  assert.equal(r1.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 2. Permit with bare '*' actionClass fails structural check
  const permitStarAction = buildSignedPermit({ keys, claimGeneration: 1 });
  permitStarAction.actionClasses = ['*'];
  const { permitDigest: _p2, signature: _s2, ...proj2 } = permitStarAction;
  permitStarAction.permitDigest = digestCanonical('webmcp-digest-v1:permit', proj2);
  permitStarAction.signature = sign(null, Buffer.from(`webmcp-digest-v1:permit\n${canonicalJson(proj2)}`, 'utf8'), keys.privateKey).toString('hex');

  const r2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: permitStarAction,
    context,
  });
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.reason, 'EXECUTION_PERMIT_MALFORMED');

  // 3. Broad wildcard action scopes are malformed rather than executable.
  const permitBrowserStar = buildSignedPermit({
    keys,
    claimGeneration: 1,
    actionClasses: ['browser.*'],
    origins: ['https://example.test'],
  });
  assert.equal(validatePermitStructure(permitBrowserStar).ok, false);

  const r3 = verifier.verifyRequest({
    tool: 'browser_raw_command',
    params: { method: 'arbitrary_raw', url: 'https://example.test' },
    permit: permitBrowserStar,
    context,
  });
  assert.equal(r3.decision, 'deny');
  assert.equal(r3.reason, 'TOOL_ACTION_NOT_ALLOWED');

  // 4. Exact action classes execute standard browser actions.
  const exactStandardPermit = buildSignedPermit({
    keys,
    claimGeneration: 1,
    actionClasses: ['browser.navigate'],
    origins: ['https://example.test'],
  });
  const r4 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: exactStandardPermit,
    context,
  });
  assert.equal(r4.decision, 'allow');

  // 5. Permit with empty origins array fails closed
  const permitEmptyOrigins = buildSignedPermit({
    keys,
    claimGeneration: 1,
    origins: ['https://example.test'],
  });
  permitEmptyOrigins.origins = [];
  const r5 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: permitEmptyOrigins,
    context,
  });
  assert.equal(r5.decision, 'deny');
  assert.equal(r5.reason, 'EXECUTION_PERMIT_MALFORMED');
});

test('P1-5 regression: unset NODE_ENV and production block test seams unless explicit test contract', () => {
  const origEnv = process.env.NODE_ENV;
  const origSeams = process.env.WEBMCP_ALLOW_TEST_SEAMS;

  try {
    // 1. Unset NODE_ENV: passing allowTestSeams: true does NOT open test seams
    delete process.env.NODE_ENV;
    delete process.env.WEBMCP_ALLOW_TEST_SEAMS;

    assert.throws(
      () => createGatewayServer({ interactiveMode: 'observe', allowTestSeams: true }),
      /only allowed through explicit test seams/,
    );
    assert.throws(
      () => createGatewayServer({ interactiveRuntime: { mode: 'enforce' }, allowTestSeams: true }),
      /not permitted in production construction/,
    );

    // 2. NODE_ENV = 'development': passing allowTestSeams: true does NOT open test seams
    process.env.NODE_ENV = 'development';
    assert.throws(
      () => createGatewayServer({ interactiveMode: 'observe', allowTestSeams: true }),
      /only allowed through explicit test seams/,
    );

    // 3. NODE_ENV = 'test' with WEBMCP_ALLOW_TEST_SEAMS = '1': allows test seams
    process.env.NODE_ENV = 'test';
    process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';
    const app = createGatewayServer({ port: 0, interactiveMode: 'observe', allowTestSeams: true });
    assert.equal(app.runtime.mode, 'observe');
  } finally {
    process.env.NODE_ENV = origEnv;
    process.env.WEBMCP_ALLOW_TEST_SEAMS = origSeams;
  }
});

// ─────────────────────────────────────────────────────────────
// 10. Residual Hardening Tests
// ─────────────────────────────────────────────────────────────
test('validatePermitStructure: requires both non-empty profileAlias and profileId and preserves distinct values', () => {
  const keys = makeKeyPair();

  // Valid permit with distinct profileAlias and profileId
  const validDistinctPermit = buildSignedPermit({
    keys,
    profileAlias: 'my-alias',
    profileId: 'my-profile-123',
  });
  const rValid = validatePermitStructure(validDistinctPermit);
  assert.equal(rValid.ok, true);
  assert.equal(rValid.value.profileAlias, 'my-alias');
  assert.equal(rValid.value.profileId, 'my-profile-123');

  // Alias-only permit (missing profileId) is rejected
  const aliasOnly = buildSignedPermit({ keys });
  delete aliasOnly.profileId;
  aliasOnly.profileAlias = 'alias-only';
  const rAliasOnly = validatePermitStructure(aliasOnly);
  assert.equal(rAliasOnly.ok, false);
  assert.equal(rAliasOnly.reason, 'EXECUTION_PERMIT_MALFORMED');

  // ProfileId-only permit (missing profileAlias) is rejected
  const idOnly = buildSignedPermit({ keys });
  delete idOnly.profileAlias;
  idOnly.profileId = 'id-only';
  const rIdOnly = validatePermitStructure(idOnly);
  assert.equal(rIdOnly.ok, false);
  assert.equal(rIdOnly.reason, 'EXECUTION_PERMIT_MALFORMED');

  // Whitespace-only profileAlias is rejected
  const emptyAlias = buildSignedPermit({ keys, profileAlias: '   ', profileId: 'valid-id' });
  const rEmptyAlias = validatePermitStructure(emptyAlias);
  assert.equal(rEmptyAlias.ok, false);
  assert.equal(rEmptyAlias.reason, 'EXECUTION_PERMIT_MALFORMED');

  // Whitespace-only profileId is rejected
  const emptyId = buildSignedPermit({ keys, profileAlias: 'valid-alias', profileId: '   ' });
  const rEmptyId = validatePermitStructure(emptyId);
  assert.equal(rEmptyId.ok, false);
  assert.equal(rEmptyId.reason, 'EXECUTION_PERMIT_MALFORMED');

  // Non-string profileAlias / profileId
  const nonStringAlias = buildSignedPermit({ keys });
  nonStringAlias.profileAlias = 123;
  assert.equal(validatePermitStructure(nonStringAlias).ok, false);
  const nonStringId = buildSignedPermit({ keys });
  nonStringId.profileId = { id: 'foo' };
  assert.equal(validatePermitStructure(nonStringId).ok, false);
});

test('isActionScopeAllowed: allows exact classes and bounded browser.raw.*, denies browser.* or arbitrary foo.* escalation, and denies unknown/raw.unknown', () => {
  // 1. Exact action classes
  assert.equal(isActionScopeAllowed(['browser.navigate'], 'browser.navigate'), true);
  assert.equal(isActionScopeAllowed(['browser.navigate'], 'browser.click'), false);
  assert.equal(isActionScopeAllowed(['browser.raw.custom_method'], 'browser.raw.custom_method'), true);
  assert.equal(isActionScopeAllowed(['browser.raw.custom_method'], 'browser.raw.other_method'), false);
  assert.equal(isActionScopeAllowed(['browser.raw'], 'browser.raw'), true);
  assert.equal(isActionScopeAllowed(['browser.raw'], 'browser.raw.custom_method'), false);
  assert.equal(isActionScopeAllowed(['custom.exact.action'], 'custom.exact.action'), true);
  assert.equal(isActionScopeAllowed(['custom.exact.action'], 'custom.exact.other'), false);

  // 2. browser.raw.* allows raw descendants but denies unknown and non-raw
  assert.equal(isActionScopeAllowed(['browser.raw.*'], 'browser.raw.custom_method'), true);
  assert.equal(isActionScopeAllowed(['browser.raw.*'], 'browser.raw.eval_js'), true);
  assert.equal(isActionScopeAllowed(['browser.raw.*'], 'browser.raw.unknown'), false);
  assert.equal(isActionScopeAllowed(['browser.raw.*'], 'browser.navigate'), false);
  assert.equal(isActionScopeAllowed(['browser.raw.*'], 'browser.unknown'), false);
  assert.equal(isActionScopeAllowed(['browser.raw.*'], 'custom.raw.action'), false);

  // 3. Broad browser.* is never an executable scope; standard actions must be exact.
  assert.equal(isActionScopeAllowed(['browser.*'], 'browser.navigate'), false);
  assert.equal(isActionScopeAllowed(['browser.*'], 'browser.click'), false);
  assert.equal(isActionScopeAllowed(['browser.*'], 'browser.type'), false);
  assert.equal(isActionScopeAllowed(['browser.*'], 'browser.batch'), false);
  assert.equal(isActionScopeAllowed(['browser.*'], 'browser.foo'), false);
  assert.equal(isActionScopeAllowed(['browser.*'], 'browser.raw'), false);
  assert.equal(isActionScopeAllowed(['browser.*'], 'browser.raw.custom_method'), false);
  assert.equal(isActionScopeAllowed(['browser.*'], 'browser.raw.unknown'), false);
  assert.equal(isActionScopeAllowed(['browser.*'], 'browser.unknown'), false);

  // 4. Arbitrary namespace wildcards are never executable scopes.
  assert.equal(isActionScopeAllowed(['foo.*'], 'foo.bar'), false);
  assert.equal(isActionScopeAllowed(['foo.*'], 'foo.baz.qux'), false);
  assert.equal(isActionScopeAllowed(['foo.*'], 'foo.raw'), false);
  assert.equal(isActionScopeAllowed(['foo.*'], 'foo.raw.action'), false);
  assert.equal(isActionScopeAllowed(['foo.*'], 'foo.unknown'), false);
  assert.equal(isActionScopeAllowed(['foo.*'], 'browser.raw.custom'), false);
  assert.equal(isActionScopeAllowed(['foo.*'], 'browser.unknown'), false);
  assert.equal(isActionScopeAllowed(['foo.*'], 'browser.raw.unknown'), false);

  // 5. Unknown methods and raw.unknown are unconditionally denied across any configuration
  assert.equal(isActionScopeAllowed(['browser.unknown'], 'browser.unknown'), false);
  assert.equal(isActionScopeAllowed(['browser.raw.unknown'], 'browser.raw.unknown'), false);
  assert.equal(isActionScopeAllowed(['unknown'], 'unknown'), false);
  assert.equal(isActionScopeAllowed(['foo.unknown'], 'foo.unknown'), false);
  assert.equal(isActionScopeAllowed(['browser.*', 'browser.raw.*'], 'browser.unknown'), false);
  assert.equal(isActionScopeAllowed(['browser.*', 'browser.raw.*'], 'browser.raw.unknown'), false);

  // 6. Invalid inputs fail closed
  assert.equal(isActionScopeAllowed([], 'browser.navigate'), false);
  assert.equal(isActionScopeAllowed(null, 'browser.navigate'), false);
  assert.equal(isActionScopeAllowed(['browser.navigate'], null), false);
  assert.equal(isActionScopeAllowed(['browser.navigate'], ''), false);
  assert.equal(isActionScopeAllowed(['*'], 'browser.navigate'), false);
});

test('permit origins: explicit normalized http/https origins enforced structurally and at verification', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore: store,
    mode: 'enforce',
  });
  const { message: context } = buildSignedContext({ keys });

  // 1. isNormalizedHttpOrigin helper unit checks
  assert.equal(isNormalizedHttpOrigin('https://example.test'), true);
  assert.equal(isNormalizedHttpOrigin('http://localhost:8080'), true);
  assert.equal(isNormalizedHttpOrigin('https://app.sub.example.com'), true);
  assert.equal(isNormalizedHttpOrigin('*'), false);
  assert.equal(isNormalizedHttpOrigin('https://*'), false);
  assert.equal(isNormalizedHttpOrigin('https://*.example.com'), false);
  assert.equal(isNormalizedHttpOrigin('https://example.test/'), false);
  assert.equal(isNormalizedHttpOrigin('https://example.test/path'), false);
  assert.equal(isNormalizedHttpOrigin('https://example.test?a=1'), false);
  assert.equal(isNormalizedHttpOrigin('javascript:alert(1)'), false);
  assert.equal(isNormalizedHttpOrigin('ws://localhost'), false);
  assert.equal(isNormalizedHttpOrigin(''), false);
  assert.equal(isNormalizedHttpOrigin(null), false);

  // 2. Structural validation rejects wildcard, non-http, or unnormalized entries
  const pWildcard = buildSignedPermit({ keys, origins: ['https://example.test', '*'] });
  assert.equal(validatePermitStructure(pWildcard).ok, false);
  assert.equal(validatePermitStructure(pWildcard).reason, 'EXECUTION_PERMIT_MALFORMED');

  const pTrailingSlash = buildSignedPermit({ keys, origins: ['https://example.test/'] });
  assert.equal(validatePermitStructure(pTrailingSlash).ok, false);
  assert.equal(validatePermitStructure(pTrailingSlash).reason, 'EXECUTION_PERMIT_MALFORMED');

  const pPath = buildSignedPermit({ keys, origins: ['https://example.test/api'] });
  assert.equal(validatePermitStructure(pPath).ok, false);
  assert.equal(validatePermitStructure(pPath).reason, 'EXECUTION_PERMIT_MALFORMED');

  const pNonHttp = buildSignedPermit({ keys, origins: ['ftp://example.test'] });
  assert.equal(validatePermitStructure(pNonHttp).ok, false);
  assert.equal(validatePermitStructure(pNonHttp).reason, 'EXECUTION_PERMIT_MALFORMED');

  // 3. Enforcement-level verification strictly enforces normalized origins and rejects unnormalized or disallowed
  const validPermit = buildSignedPermit({
    keys,
    origins: ['https://allowed1.test', 'https://allowed2.test'],
  });

  // Request on allowed1 is allowed
  const rAllowed = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://allowed1.test/page' },
    permit: validPermit,
    context,
    dryRun: true,
  });
  assert.equal(rAllowed.decision, 'allow');

  // Request on disallowed origin is denied
  const rDisallowed = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://evil.test/page' },
    permit: validPermit,
    context,
    dryRun: true,
  });
  assert.equal(rDisallowed.decision, 'deny');
  assert.equal(rDisallowed.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');

  // If permit.origins was corrupted with wildcard or unnormalized origin after signing, enforcement denies scope
  const corruptedPermit = buildSignedPermit({ keys, origins: ['https://allowed1.test'] });
  corruptedPermit.origins = ['*'];
  const { permitDigest: _pd, signature: _sig, ...proj } = corruptedPermit;
  corruptedPermit.permitDigest = digestCanonical('webmcp-digest-v1:permit', proj);
  corruptedPermit.signature = sign(null, Buffer.from(`webmcp-digest-v1:permit\n${canonicalJson(proj)}`, 'utf8'), keys.privateKey).toString('hex');

  const rCorrupted = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://allowed1.test' },
    permit: corruptedPermit,
    context,
    dryRun: true,
  });
  assert.equal(rCorrupted.decision, 'deny');
  assert.equal(rCorrupted.reason, 'EXECUTION_PERMIT_MALFORMED');
});

test('profile binding: distinct profileAlias and profileId binding preserved and verified against context and effective profileId', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore: store,
    mode: 'enforce',
  });

  const { message: context } = buildSignedContext({
    keys,
    profileAlias: 'marketing-profile',
    profileId: 'chrome-user-data-02',
  });

  // 1. Permit with matching distinct profileAlias and profileId is allowed
  const matchingPermit = buildSignedPermit({
    keys,
    profileAlias: 'marketing-profile',
    profileId: 'chrome-user-data-02',
  });
  const r1 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    profileId: 'chrome-user-data-02',
    permit: matchingPermit,
    context,
    dryRun: true,
  });
  assert.equal(r1.decision, 'allow');

  // 2. Request targeting alias directly is also allowed
  const r2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    profileId: 'marketing-profile',
    permit: matchingPermit,
    context,
    dryRun: true,
  });
  assert.equal(r2.decision, 'allow');

  // 3. Permit with mismatched profileAlias vs context is denied
  const wrongAliasPermit = buildSignedPermit({
    keys,
    profileAlias: 'engineering-profile',
    profileId: 'chrome-user-data-02',
  });
  const r3 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    profileId: 'chrome-user-data-02',
    permit: wrongAliasPermit,
    context,
    dryRun: true,
  });
  assert.equal(r3.decision, 'deny');
  assert.equal(r3.reason, 'EXECUTION_PROFILE_MISMATCH');

  // 4. Permit with mismatched profileId vs context is denied
  const wrongIdPermit = buildSignedPermit({
    keys,
    profileAlias: 'marketing-profile',
    profileId: 'chrome-user-data-99',
  });
  const r4 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    profileId: 'chrome-user-data-02',
    permit: wrongIdPermit,
    context,
    dryRun: true,
  });
  assert.equal(r4.decision, 'deny');
  assert.equal(r4.reason, 'EXECUTION_PROFILE_MISMATCH');

  // 5. Request targeting completely unauthorized profile is denied
  const r5 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    profileId: 'unauthorized-profile',
    permit: matchingPermit,
    context,
    dryRun: true,
  });
  assert.equal(r5.decision, 'deny');
  assert.equal(r5.reason, 'EXECUTION_PROFILE_MISMATCH');
});
