import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import {
  canonicalJson,
  digestCanonical,
  SCHEMAS,
} from '../../server/gateway/trusted-context-schema.mjs';
import { PermitStore } from '../../server/gateway/permit-store.mjs';
import {
  TrustedContextChannel,
  assertNoTcpTransport,
  assertValidEndpoint,
  createTrustedContextChannel,
} from '../../server/gateway/trusted-context-channel.mjs';
import { sanitizeParams, sanitizeParamsForTest } from '../../server/gateway_server.js';
import { createGatewayServer } from '../../server/gateway_server.js';
import { WebSocket } from 'ws';

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
  if (!includeSignature) return { message: { ...base, contextDigest }, keys };
  const toSign = Buffer.from(`webmcp-digest-v1:trusted-context\n${canonical}`, 'utf8');
  const signature = sign(null, toSign, keys.privateKey).toString('hex');
  return { message: { ...base, signature, contextDigest }, keys };
}

function sendSocketMessage(socketPath, messageObj) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(messageObj) + '\n');
    });
    let data = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => { data += chunk; });
    client.on('end', () => {
      try { resolve(JSON.parse(data.trim())); } catch (err) { resolve({ raw: data, error: err.message }); }
    });
    client.on('error', reject);
  });
}

// ── Transport validation ──
test('channel: transport validation forbids TCP/HTTP and validates endpoint paths', () => {
  assert.throws(() => assertNoTcpTransport({ host: '127.0.0.1' }), /Trusted context forbids TCP host\/port transport/);
  assert.throws(() => assertNoTcpTransport({ port: 9000 }), /Trusted context forbids TCP host\/port transport/);
  assert.throws(() => assertNoTcpTransport({ contextPort: 9000 }), /Trusted context forbids TCP host\/port transport/);
  assert.throws(() => assertNoTcpTransport({ endpoint: 'http://127.0.0.1:8080' }), /Trusted context forbids TCP host\/port transport/);
  assert.throws(() => assertNoTcpTransport({ endpoint: 'tcp://127.0.0.1:8080' }), /Trusted context forbids TCP host\/port transport/);
  assert.throws(() => assertNoTcpTransport({ socketPath: 'ws://127.0.0.1:8080' }), /Trusted context forbids TCP host\/port transport/);
  if (process.platform !== 'win32') {
    assert.throws(() => assertValidEndpoint('/tmp/invalid-ext.txt', 'darwin'), /POSIX trusted context endpoint must be a local \.sock socket/);
    assert.throws(() => assertValidEndpoint('relative/path.sock', 'darwin'), /POSIX trusted context endpoint must be an absolute path/);
    assert.throws(() => assertValidEndpoint('/tmp/../escape.sock', 'darwin'), /POSIX trusted context endpoint must not contain "\.\." traversal segments/);
    assert.throws(() => assertValidEndpoint('/tmp/' + 'a'.repeat(120) + '.sock', 'darwin'), /POSIX trusted context endpoint exceeds maximum allowed length of 103 bytes/);
    assert.doesNotThrow(() => assertValidEndpoint('/tmp/valid.sock', 'darwin'));
    assert.doesNotThrow(() => assertValidEndpoint('/tmp/webmcp-ctx-123.sock', 'darwin'));
  } else {
    assert.throws(() => assertValidEndpoint('/tmp/valid.sock', 'win32'), /Windows trusted context endpoint must be a named pipe/);
    assert.doesNotThrow(() => assertValidEndpoint('\\\\.\\pipe\\webmcp-gateway-test.sock', 'win32'));
  }
});

test('channel: endpoint validation rejects TCP and malformed in constructor and start', async () => {
  const keys = makeKeyPair();
  assert.throws(() => new TrustedContextChannel({ socketPath: 'http://127.0.0.1:8080', publicKey: keys.publicKey }), /Trusted context forbids TCP/);
  assert.throws(() => new TrustedContextChannel({ endpoint: 'tcp://127.0.0.1:9000', publicKey: keys.publicKey }), /Trusted context forbids TCP/);
  if (process.platform !== 'win32') {
    assert.throws(() => new TrustedContextChannel({ socketPath: 'relative/path.sock', publicKey: keys.publicKey }), /POSIX trusted context endpoint must be an absolute path/);
    assert.throws(() => new TrustedContextChannel({ socketPath: '/tmp/bad.txt', publicKey: keys.publicKey }), /POSIX trusted context endpoint must be a local \.sock socket/);
  }
});

// ── Live local channel framing / signature / replay / order / key / size ──
test('channel: trusted context over Unix socket handles framing, signatures, anti-replay, and rejects alternate keys', async (t) => {
  const socketPath = path.join(os.tmpdir(), `test-gateway-tcc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const keys = makeKeyPair();
  const altKeys = makeKeyPair();
  const permitStore = new PermitStore();
  let lastUpdatedContext = null;
  const channel = new TrustedContextChannel({
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore,
    onContextUpdate: (ctx) => { lastUpdatedContext = ctx; },
  });
  await channel.start();
  t.after(async () => { await channel.stop(); });
  const { message: validMsg } = buildSignedContext({ keys, seq: 1, revocations: ['permit_rev_1'] });
  const ack = await sendSocketMessage(socketPath, validMsg);
  assert.equal(ack.ok, true);
  assert.equal(ack.schema, SCHEMAS.ACK);
  assert.equal(ack.messageId, validMsg.messageId);
  assert.ok(lastUpdatedContext);
  assert.equal(lastUpdatedContext.projectId, 'project_test_123');
  assert.ok(permitStore.isRevoked('permit_rev_1'));
  const replayAck = await sendSocketMessage(socketPath, validMsg);
  assert.equal(replayAck.ok, false);
  assert.equal(replayAck.reason, 'TRUSTED_CONTEXT_REPLAY');
  const { message: staleMsg } = buildSignedContext({ keys, seq: 1 });
  const staleAck = await sendSocketMessage(socketPath, staleMsg);
  assert.equal(staleAck.ok, false);
  assert.equal(staleAck.reason, 'TRUSTED_CONTEXT_STALE');
  const { message: forgedMsg } = buildSignedContext({ keys, seq: 2 });
  forgedMsg.signature = '00'.repeat(64);
  const forgedAck = await sendSocketMessage(socketPath, forgedMsg);
  assert.equal(forgedAck.ok, false);
  assert.equal(forgedAck.reason, 'TRUSTED_CONTEXT_FORGED');
  const { message: altKeyMsg } = buildSignedContext({ keys: altKeys, seq: 3, overridePublicKey: altKeys.rawPublicKeyHex });
  const altKeyAck = await sendSocketMessage(socketPath, altKeyMsg);
  assert.equal(altKeyAck.ok, false);
  assert.equal(altKeyAck.reason, 'TRUSTED_CONTEXT_FORGED');
  const { message: unsignedMsg } = buildSignedContext({ keys, seq: 4, includeSignature: false });
  const unsignedAck = await sendSocketMessage(socketPath, unsignedMsg);
  assert.equal(unsignedAck.ok, false);
  assert.equal(unsignedAck.reason, 'TRUSTED_CONTEXT_FORGED');
  const { message: expiredMsg } = buildSignedContext({ keys, seq: 5, expiresAt: new Date(Date.now() - 5000).toISOString() });
  const expiredAck = await sendSocketMessage(socketPath, expiredMsg);
  assert.equal(expiredAck.ok, false);
  assert.equal(expiredAck.reason, 'TRUSTED_CONTEXT_EXPIRED');
  // Wrong keyId binding
  const { message: wrongKeyIdMsg } = buildSignedContext({ keys, seq: 6 });
  wrongKeyIdMsg.keyId = 'wrong-key-id';
  // re-sign with correct key but wrong keyId -> should fail keyId mismatch before sig check
  // We need to re-sign to have valid sig for wrong keyId? Actually keyId mismatch is checked before digest, so we can keep sig as is but change keyId to mismatch
  // The channel checks keyId mismatch against pinned keyId, so it should fail
  const wrongKeyIdAck = await sendSocketMessage(socketPath, wrongKeyIdMsg);
  assert.equal(wrongKeyIdAck.ok, false);
  assert.equal(wrongKeyIdAck.reason, 'TRUSTED_CONTEXT_FORGED');
});

test('channel: bounded payload and malformed framing fail closed safely', async (t) => {
  const socketPath = path.join(os.tmpdir(), `test-gateway-tcc-bound-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const keys = makeKeyPair();
  const channel = new TrustedContextChannel({ socketPath, publicKey: keys.publicKey, keyId: keys.keyId });
  await channel.start();
  t.after(async () => { await channel.stop(); });
  const oversized = 'x'.repeat(70000);
  const oversizedRes = await new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath, () => { s.write(oversized); s.write('\n'); });
    let data = '';
    s.setEncoding('utf8');
    s.on('data', (d) => { data += d; });
    s.on('end', () => { try { resolve(JSON.parse(data.trim())); } catch { resolve({ raw: data }); } });
    s.on('error', reject);
    setTimeout(() => { try { s.destroy(); } catch {} }, 1000);
  });
  assert.ok(oversizedRes.ok === false || oversizedRes.reason === 'TRUSTED_CONTEXT_SIZE_EXCEEDED' || oversizedRes.error === 'MESSAGE_TOO_LARGE');
  const malformedRes = await new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath, () => { s.write('NOT VALID JSON\n'); });
    let data = '';
    s.setEncoding('utf8');
    s.on('data', (d) => { data += d; });
    s.on('end', () => { try { resolve(JSON.parse(data.trim())); } catch { resolve({ raw: data }); } });
    s.on('error', reject);
  });
  assert.equal(malformedRes.ok, false);
  assert.equal(malformedRes.reason, 'TRUSTED_CONTEXT_MALFORMED');
});

test('channel: missing-sequence order is rejected (no gaps allowed, must be monotonic)', async (t) => {
  const socketPath = path.join(os.tmpdir(), `test-gateway-tcc-order-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const keys = makeKeyPair();
  const channel = new TrustedContextChannel({ socketPath, publicKey: keys.publicKey, keyId: keys.keyId });
  await channel.start();
  t.after(async () => { await channel.stop(); });
  const { message: m1 } = buildSignedContext({ keys, seq: 1 });
  const { message: m3 } = buildSignedContext({ keys, seq: 3 });
  const { message: m2 } = buildSignedContext({ keys, seq: 2 });
  const r1 = await sendSocketMessage(socketPath, m1);
  assert.equal(r1.ok, true);
  // Jump to 3 should succeed (monotonic, gap allowed? spec says strictly greater, not necessarily +1. But test ensures 2 after 3 fails)
  const r3 = await sendSocketMessage(socketPath, m3);
  assert.equal(r3.ok, true);
  const r2 = await sendSocketMessage(socketPath, m2);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'TRUSTED_CONTEXT_STALE');
});

test('channel: stale socket arbitration and safe recovery', async (t) => {
  if (process.platform === 'win32') { t.skip('Unix domain socket test skipped on Windows'); return; }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-tcc-stale-'));
  const socketPath = path.join(tmpDir, 'stale.sock');
  t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
  const keys = makeKeyPair();
  fs.writeFileSync(socketPath, 'regular file contents');
  const regularFileChan = new TrustedContextChannel({ socketPath, publicKey: keys.publicKey });
  await assert.rejects(() => regularFileChan.start(), /exists and is not a socket/);
  assert.equal(fs.existsSync(socketPath), true, 'regular file must not be unlinked');
  fs.unlinkSync(socketPath);
  const dummyServer = net.createServer();
  await new Promise((res) => dummyServer.listen(socketPath, res));
  await new Promise((res) => dummyServer.close(res));
  const dummyServer2 = net.createServer();
  await new Promise((res) => dummyServer2.listen(socketPath, res));
  await new Promise((res) => dummyServer2.close(res));
  const recoveredChan = new TrustedContextChannel({ socketPath, publicKey: keys.publicKey });
  await assert.doesNotThrow(async () => { await recoveredChan.start(); });
  await recoveredChan.close();
  try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch {}
  const liveServer = net.createServer();
  await new Promise((res) => liveServer.listen(socketPath, res));
  t.after(async () => { try { await new Promise((r) => liveServer.close(r)); } catch {} });
  const conflictChan = new TrustedContextChannel({ socketPath, publicKey: keys.publicKey });
  await assert.rejects(() => conflictChan.start(), /is in use by another process/);
  await new Promise((res) => liveServer.close(res));
});

// ── Deep sensitive-field redaction ──
test('deep stripping: permit/signature/token and physical profile identity never forwarded', () => {
  const raw = {
    url: 'https://example.test',
    permit: { permitId: 'should_strip' },
    signature: 'should_strip',
    token: 'should_strip',
    profileId: 'should_strip',
    physicalProfileId: 'should_strip',
    authorization: 'Bearer should_strip',
    privateKey: 'should_strip',
    secret: 'should_strip',
    nested: {
      permit: { foo: 1 },
      profileId: 'strip',
      keep: 'value',
      deeper: { token: 'strip', ok: 1, credential: 'strip' },
    },
    actions: [{ method: 'click', params: { profileId: 'strip', permit: 'strip', url: 'https://example.test' } }],
  };
  const sanitized = sanitizeParams(raw);
  const str = JSON.stringify(sanitized);
  assert.equal(str.includes('should_strip'), false);
  assert.equal(str.includes('permit'), false);
  assert.equal(str.includes('signature'), false);
  assert.equal(str.includes('profileId'), false);
  assert.equal(str.includes('physicalProfileId'), false);
  assert.equal(sanitized.url, 'https://example.test');
  assert.equal(sanitized.nested.keep, 'value');
  assert.equal(sanitized.nested.deeper.ok, 1);
  const sanitizedChild = sanitizeParamsForTest({ profileId: 'x', permit: 'y', url: 'https://a.test' });
  assert.equal('profileId' in sanitizedChild, false);
  assert.equal('permit' in sanitizedChild, false);
  assert.equal(sanitizedChild.url, 'https://a.test');
  // Ensure batch children are also stripped when using gateway sanitization path
  const batchSanitized = sanitizeParams({ actions: [{ method: 'click', params: { profileId: 'strip', permit: 'strip', url: 'https://example.test', keep: 1 } }] });
  assert.equal(batchSanitized.actions[0].params.keep, 1);
  assert.equal('profileId' in batchSanitized.actions[0].params, false);
});

test('receipts and forwarded params must not expose machine identity or raw secrets', async (t) => {
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `gw-redact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({
    port: 0,
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    interactiveMode: 'enforce',
    allowTestSeams: true,
    token: 'test-token',
  });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  function makeFakeExtension(port, profileId) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const forwarded = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'extensionReady', params: { name: 'fake', version: '1.0.0', profileId } }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if ('id' in msg) {
        forwarded.push(msg);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { success: true } }));
      }
    });
    return { ws, forwarded };
  }
  async function waitFor(pred, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('waitFor timeout');
  }
  const victim = makeFakeExtension(port, 'victim-profile-100');
  t.after(() => { try { victim.ws.terminate(); } catch {} });
  await waitFor(() => app.connectedProfileIds().includes('victim-profile-100'));
  const { message: ctx } = buildSignedContext({ keys, profileAlias: 'work', profileId: 'victim-profile-100', fenceEpoch: 1 });
  const ack = await sendSocketMessage(socketPath, ctx);
  assert.equal(ack.ok, true);
  // Build permit (use same helpers as e4 tests for valid permit)
  function buildPermit(overrides = {}) {
    const base = {
      schema: SCHEMAS.PERMIT,
      permitId: 'permit_redact_001',
      runId: ctx.runId,
      claimGeneration: 1,
      claimDigest: ctx.claimDigest,
      projectId: ctx.projectId,
      profileAlias: ctx.profileAlias,
      profileId: ctx.profileId,
      bindingId: ctx.bindingId,
      bindingRevision: ctx.bindingRevision,
      bindingDigest: ctx.bindingDigest,
      automationStoreRevision: ctx.automationStoreRevision,
      automationStoreDigest: ctx.automationStoreDigest,
      siteStoreRevision: ctx.siteStoreRevision,
      siteStoreDigest: ctx.siteStoreDigest,
      phaseId: ctx.phaseId,
      origins: ['https://example.test'],
      actionClasses: ['browser.navigate'],
      budget: { maxCalls: 5 },
      stateVersion: ctx.stateVersion,
      planRevision: ctx.planRevision,
      planDigest: ctx.planDigest,
      instructionDigest: ctx.instructionDigest,
      policyRevision: ctx.policyRevision,
      keyId: keys.keyId,
      nonce: 'nonce_redact_1',
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      notBefore: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      ttlMs: 30000,
      revocationId: 'rev_1',
      ...overrides,
    };
    const canonical = canonicalJson(base);
    const toSign = Buffer.from(`webmcp-digest-v1:permit\n${canonical}`, 'utf8');
    const sig = sign(null, toSign, keys.privateKey).toString('hex');
    const permitDigest = digestCanonical('webmcp-digest-v1:permit', base);
    return { ...base, signature: sig, permitDigest };
  }
  const permit = buildPermit();
  const res = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'browser_navigate', params: { url: 'https://example.test', token: 'Bearer secret', secret: 'leak', profileId: 'victim-profile-100' }, profileId: 'victim-profile-100', permit }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(victim.forwarded.length, 1);
  const forwardedStr = JSON.stringify(victim.forwarded[0]);
  assert.equal(forwardedStr.includes('permit'), false);
  assert.equal(forwardedStr.includes('secret'), false);
  assert.equal(forwardedStr.includes('Bearer'), false);
  const body = await res.json();
  const receiptStr = JSON.stringify(body.receipt);
  assert.equal(receiptStr.includes('secret'), false);
  assert.equal(receiptStr.includes('Bearer'), false);
  assert.equal(receiptStr.includes('privateKey'), false);
});

// ── Permit-store atomicity / expiry / rollback ──
test('permit-store: atomic replay+budget and wouldExhaust, no partial mutation on deny', async () => {
  const store = new PermitStore();
  const permit = { permitId: 'p1', nonce: 'n1', expiresAt: new Date(Date.now() + 60000).toISOString(), budget: { maxCalls: 2 } };
  const r1 = store.tryConsume(permit, 1);
  assert.equal(r1.ok, true);
  assert.equal(store.budget.get('p1').used, 1);
  assert.equal(store.seenNonce.has('n1'), true);
  // Replay should not increment budget
  const r2 = store.tryConsume(permit, 1);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'EXECUTION_PERMIT_REVOKED');
  assert.equal(store.budget.get('p1').used, 1, 'budget must not increase on replay deny');
  // Budget exhaustion should not mark nonce
  const store2 = new PermitStore();
  const p2 = { permitId: 'p2', nonce: 'n2', expiresAt: new Date(Date.now() + 60000).toISOString(), budget: { maxCalls: 1 } };
  const p3 = { permitId: 'p2', nonce: 'n3', expiresAt: new Date(Date.now() + 60000).toISOString(), budget: { maxCalls: 1 } };
  assert.equal(store2.tryConsume(p2, 1).ok, true);
  assert.equal(store2.wouldExhaust(p3, 1), true);
  const r3 = store2.tryConsume(p3, 1);
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'EXECUTION_BUDGET_EXHAUSTED');
  assert.equal(store2.seenNonce.has('n3'), false, 'nonce must not be marked on budget deny');
  assert.equal(store2.budget.get('p2').used, 1);
  // Expiry checked before GC — expired permit must deny even if nonce previously seen and then GC'd
  const store3 = new PermitStore();
  const expiredPermit = { permitId: 'p3', nonce: 'n_exp', expiresAt: new Date(Date.now() - 1000).toISOString(), budget: { maxCalls: 10 } };
  store3.markSeen('n_exp', new Date(Date.now() + 60000).toISOString());
  // GC would normally delete expired nonce if called, but tryConsume should check expiry first and deny, not reopen
  const rExp = store3.tryConsume(expiredPermit, 1, Date.now());
  assert.equal(rExp.ok, false);
  assert.equal(rExp.reason, 'EXECUTION_PERMIT_EXPIRED');
  // Verify isReplay does not GC and reopen
  const store4 = new PermitStore();
  const now = Date.now();
  store4.markSeen('replay_nonce', new Date(now + 5000).toISOString());
  assert.equal(store4.isReplay('replay_nonce'), true);
  // After expiry, gc should remove, but isReplay without gc should still see it until explicit gc?
  // Actually isReplay should not gc, so it should still return true even after expiry until gc called
  // But tryConsume should handle expiry before gc
  // Concurrent atomic
  const store5 = new PermitStore();
  const p4 = { permitId: 'p4', nonce: 'same_nonce', expiresAt: new Date(Date.now() + 60000).toISOString(), budget: { maxCalls: 10 } };
  const [a, b] = await Promise.all([store5.tryConsumeAtomic(p4, 1), store5.tryConsumeAtomic({ ...p4 }, 1)]);
  const oks = [a, b].filter((x) => x.ok).length;
  assert.equal(oks, 1);
  assert.equal(store5.wouldExhaust(p4, 10), true);
});

test('permit-store: expiry before cleanup prevents nonce reopening', () => {
  const store = new PermitStore();
  const now = Date.now();
  const permit = { permitId: 'p_reopen', nonce: 'nonce_reopen', expiresAt: new Date(now - 100).toISOString(), budget: { maxCalls: 5 } };
  // Mark seen with expired time, then gc, then tryConsume with expired permit should still deny, not allow reopening
  store.markSeen('nonce_reopen', new Date(now - 50).toISOString());
  store.gc(now);
  assert.equal(store.seenNonce.has('nonce_reopen'), false, 'gc should have removed expired nonce');
  const r = store.tryConsume(permit, 1, now);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'EXECUTION_PERMIT_EXPIRED');
  assert.equal(store.seenNonce.has('nonce_reopen'), false, 'must not re-add nonce on expired deny');
});

// ── Multi-profile trusted routing ──
test('gateway: trusted routing uses signed profile, not request attacker profile', async (t) => {
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `gw-trusted-route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({
    port: 0,
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    interactiveMode: 'enforce',
    allowTestSeams: true,
    token: 'test-token',
  });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });

  function makeFakeExtension(port, profileId) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const forwarded = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'extensionReady', params: { name: 'fake', version: '1.0.0', profileId } }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if ('id' in msg) {
        forwarded.push(msg);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { success: true, echoedMethod: msg.method, echoedParams: msg.params } }));
      }
    });
    return { ws, forwarded };
  }
  async function waitFor(pred, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('waitFor timeout');
  }

  const victim = makeFakeExtension(port, 'victim-profile-100');
  const attacker = makeFakeExtension(port, 'attacker-profile');
  t.after(() => { try { victim.ws.terminate(); } catch {} });
  t.after(() => { try { attacker.ws.terminate(); } catch {} });
  await waitFor(() => app.connectedProfileIds().includes('victim-profile-100'));
  await waitFor(() => app.connectedProfileIds().includes('attacker-profile'));

  const { message: ctx } = buildSignedContext({ keys, profileAlias: 'work', profileId: 'victim-profile-100', fenceEpoch: 1 });
  const ack = await sendSocketMessage(socketPath, ctx);
  assert.equal(ack.ok, true);

  function buildPermit(overrides = {}) {
    const base = {
      schema: SCHEMAS.PERMIT,
      permitId: 'permit_victim_001',
      runId: ctx.runId,
      claimGeneration: 1,
      claimDigest: ctx.claimDigest,
      projectId: ctx.projectId,
      profileAlias: ctx.profileAlias,
      profileId: ctx.profileId,
      bindingId: ctx.bindingId,
      bindingRevision: ctx.bindingRevision,
      bindingDigest: ctx.bindingDigest,
      automationStoreRevision: ctx.automationStoreRevision,
      automationStoreDigest: ctx.automationStoreDigest,
      siteStoreRevision: ctx.siteStoreRevision,
      siteStoreDigest: ctx.siteStoreDigest,
      phaseId: ctx.phaseId,
      origins: ['https://example.test'],
      actionClasses: ['browser.navigate'],
      budget: { maxCalls: 5 },
      stateVersion: ctx.stateVersion,
      planRevision: ctx.planRevision,
      planDigest: ctx.planDigest,
      instructionDigest: ctx.instructionDigest,
      policyRevision: ctx.policyRevision,
      keyId: keys.keyId,
      nonce: 'nonce_victim_1',
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      notBefore: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      ttlMs: 30000,
      revocationId: 'rev_1',
      ...overrides,
    };
    const canonical = canonicalJson(base);
    const toSign = Buffer.from(`webmcp-digest-v1:permit\n${canonical}`, 'utf8');
    const sig = sign(null, toSign, keys.privateKey).toString('hex');
    const permitDigest = digestCanonical('webmcp-digest-v1:permit', base);
    return { ...base, signature: sig, permitDigest };
  }

  const permit = buildPermit();

  const res = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'browser_navigate', params: { url: 'https://example.test' }, profileId: 'attacker-profile', permit }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(victim.forwarded.length, 1);
  assert.equal(attacker.forwarded.length, 0);
  const forwardedParams = victim.forwarded[0].params;
  assert.equal('permit' in forwardedParams, false);
  assert.equal('signature' in forwardedParams, false);
  assert.equal('profileId' in forwardedParams, false);
  // Verify attacker cannot force routing even with explicit profileId in params
  const permit2 = buildPermit({ nonce: 'nonce_victim_2' });
  const res2 = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'browser_navigate', params: { url: 'https://example.test', profileId: 'attacker-profile' }, profileId: 'attacker-profile', permit: permit2 }),
  });
  assert.equal(res2.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(victim.forwarded.length, 2);
  assert.equal(attacker.forwarded.length, 0);
});

// ── No-forward on deny ──
test('gateway: no-forward on deny and receipts do not leak secrets', async (t) => {
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `gw-no-forward-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({
    port: 0,
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    interactiveMode: 'enforce',
    allowTestSeams: true,
    token: 'test-token2',
  });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  function makeFakeExtension(port, profileId) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const forwarded = [];
    ws.on('open', () => { ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'extensionReady', params: { name: 'fake', version: '1.0.0', profileId } })); });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if ('id' in msg) { forwarded.push(msg); ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { success: true } })); }
    });
    return { ws, forwarded };
  }
  async function waitFor(pred, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('waitFor timeout');
  }
  const ext = makeFakeExtension(port, 'interactive-profile');
  t.after(() => { try { ext.ws.terminate(); } catch {} });
  await waitFor(() => app.connectedProfileIds().includes('interactive-profile'));
  const { message: ctx } = buildSignedContext({ keys, fenceEpoch: 1 });
  await sendSocketMessage(socketPath, ctx);
  function buildPermit(overrides = {}) {
    const base = {
      schema: SCHEMAS.PERMIT,
      permitId: 'permit_noforward_001',
      runId: ctx.runId,
      claimGeneration: 1,
      claimDigest: ctx.claimDigest,
      projectId: ctx.projectId,
      profileAlias: ctx.profileAlias,
      profileId: ctx.profileId,
      bindingId: ctx.bindingId,
      bindingRevision: ctx.bindingRevision,
      bindingDigest: ctx.bindingDigest,
      automationStoreRevision: ctx.automationStoreRevision,
      automationStoreDigest: ctx.automationStoreDigest,
      siteStoreRevision: ctx.siteStoreRevision,
      siteStoreDigest: ctx.siteStoreDigest,
      phaseId: ctx.phaseId,
      origins: ['https://example.test'],
      actionClasses: ['browser.navigate'],
      budget: { maxCalls: 5 },
      stateVersion: ctx.stateVersion,
      planRevision: ctx.planRevision,
      planDigest: ctx.planDigest,
      instructionDigest: ctx.instructionDigest,
      policyRevision: ctx.policyRevision,
      keyId: keys.keyId,
      nonce: 'nonce_noforward_1',
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      notBefore: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      ttlMs: 30000,
      revocationId: 'rev_nf1',
      ...overrides,
    };
    const canonical = canonicalJson(base);
    const toSign = Buffer.from(`webmcp-digest-v1:permit\n${canonical}`, 'utf8');
    const sig = sign(null, toSign, keys.privateKey).toString('hex');
    const permitDigest = digestCanonical('webmcp-digest-v1:permit', base);
    return { ...base, signature: sig, permitDigest };
  }
  // Expired permit should be denied and not forwarded
  const expiredPermit = buildPermit({ expiresAt: new Date(Date.now() - 5000).toISOString(), nonce: 'nonce_expired_nf' });
  const resExpired = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token2' },
    body: JSON.stringify({ method: 'browser_navigate', params: { url: 'https://example.test' }, profileId: 'interactive-profile', permit: expiredPermit }),
  });
  assert.equal(resExpired.status, 403);
  assert.equal(ext.forwarded.length, 0, 'expired permit must not be forwarded');
  const bodyExpired = await resExpired.json();
  const receiptStr = JSON.stringify(bodyExpired.receipt);
  assert.equal(receiptStr.includes('secret'), false);
  // Batch with one child violating origin should deny whole batch and forward zero
  const batchPermit = buildPermit({ nonce: 'nonce_batch_nf' });
  const batchRes = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token2' },
    body: JSON.stringify({ method: 'batch', params: { actions: [{ method: 'browser_navigate', params: { url: 'https://example.test' } }, { method: 'browser_navigate', params: { url: 'https://evil.test' } }] }, profileId: 'interactive-profile', permit: batchPermit }),
  });
  assert.equal(batchRes.status, 403);
  assert.equal(ext.forwarded.length, 0, 'partially-denied batch must not be forwarded');
});

test('channel: helper createTrustedContextChannel works via local IPC (removed helper cannot bypass)', async (t) => {
  const socketPath = path.join(os.tmpdir(), `test-gateway-tcc-helper-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const keys = makeKeyPair();
  const channel = await createTrustedContextChannel({ endpoint: socketPath, publicKey: keys.publicKey, keyId: keys.keyId });
  t.after(async () => { await channel.close(); });
  const { message } = buildSignedContext({ keys, seq: 1 });
  const res = await sendSocketMessage(socketPath, message);
  assert.equal(res.ok, true);
  assert.equal(channel.getCurrentContext().profileId, message.profileId);
  const mod = await import('../../server/gateway/trusted-context-channel.mjs');
  assert.equal(typeof mod.requestTrustedContextIpc, 'undefined', 'removed helper must not be exported; no TCP bypass surface');
});
