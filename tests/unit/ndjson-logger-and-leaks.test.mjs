import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

import { InteractiveRuntime } from '../../server/gateway/interactive-runtime.mjs';
import { PermitStore } from '../../server/gateway/permit-store.mjs';
import { GatewayVerifier } from '../../server/gateway/verifier.mjs';
import { TrustedContextChannel } from '../../server/gateway/trusted-context-channel.mjs';
import { digestCanonical, canonicalJson, SCHEMAS } from '../../server/gateway/trusted-context-schema.mjs';
import { createGatewayServer, getGatewayGovernorSingleton, resetGatewayGovernorSingleton } from '../../server/gateway_server.js';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';

const require = createRequire(import.meta.url);
const ndjson = require('../../lib/ndjson-logger.cjs');
const {
  createLogger,
  redact,
  runWithCorrId,
  getCorrId,
  newCorrId,
  rotateFileIfNeeded,
  getOpenFdCount,
  startMemHeartbeat,
} = ndjson;

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId: 'k_test_1',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function signPermit(keys, overrides = {}) {
  const now = overrides._nowMs ?? Date.now();
  const base = {
    schema: SCHEMAS.PERMIT,
    permitId: `perm_${crypto.randomBytes(4).toString('hex')}`,
    revocationId: `rev_${crypto.randomBytes(4).toString('hex')}`,
    nonce: `nonce_${crypto.randomBytes(6).toString('hex')}`,
    projectId: 'proj_1',
    runId: 'run_1',
    phaseId: 'phase_1',
    profileId: 'prof_1',
    profileAlias: 'prof_1',
    claimGeneration: 1,
    claimDigest: 'sha256:' + 'a'.repeat(64),
    bindingId: 'pb_1',
    bindingRevision: 1,
    bindingDigest: 'sha256:' + 'b'.repeat(64),
    automationStoreRevision: 1,
    automationStoreDigest: 'sha256:' + 'c'.repeat(64),
    siteStoreRevision: 1,
    siteStoreDigest: 'sha256:' + 'd'.repeat(64),
    planRevision: 1,
    planDigest: 'sha256:' + 'e'.repeat(64),
    instructionDigest: 'sha256:' + 'f'.repeat(64),
    policyRevision: 'sha256:' + '6'.repeat(64),
    stateVersion: 1,
    keyId: keys.keyId,
    actionClasses: ['browser.navigate'],
    origins: ['https://example.test'],
    budget: { maxCalls: 5 },
    ttlMs: 30000,
    issuedAt: new Date(now - 1000).toISOString(),
    notBefore: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 10000).toISOString(),
    ...overrides,
  };
  delete base._nowMs;
  const permitDigest = digestCanonical('webmcp-digest-v1:permit', base);
  const canonical = canonicalJson(base);
  const signature = crypto.sign(null, Buffer.from(`webmcp-digest-v1:permit\n${canonical}`, 'utf8'), keys.privateKey).toString('hex');
  return { ...base, permitDigest, signature };
}

test('ndjson-logger: 8-field ECS/OTel schema, danger normalization, child, ring, flushSync', async (t) => {
  const dir = makeTmpDir('ndjson-schema-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'logs', 'gateway.ndjson');
  const seen = [];
  const logger = createLogger({ proc: 'gateway', filePath: logFile, ringSize: 3, onEntry: (e) => seen.push(e) });

  const e1 = logger.info('booted', { port: 7865 });
  assert.equal(e1.proc, 'gateway');
  assert.equal(e1.mod, 'core');
  assert.equal(e1.level, 'info');
  assert.equal(e1.corrId, undefined);
  assert.equal(e1.err, undefined);
  assert.deepEqual(e1.meta, { port: 7865 });

  const child = logger.child({ mod: 'renderer', proc: 'desktop-renderer' });
  const e2 = child.log('danger', 'boom', new Error('kaboom'));
  assert.equal(e2.level, 'error');
  assert.equal(e2.proc, 'desktop-renderer');
  assert.equal(e2.mod, 'renderer');
  assert.equal(e2.err.name, 'Error');
  assert.equal(e2.err.message, 'kaboom');

  logger.warn('w1');
  logger.error('e3');
  assert.equal(logger.recent().length, 3);
  assert.equal(seen.length, 4);

  logger.flushSync();
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.equal(lines[1].level, 'error');

  if (process.platform !== 'win32') {
    assert.equal(fs.lstatSync(path.dirname(logFile)).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(logFile).mode & 0o777, 0o600);
  }
  await logger.close();
});

test('ndjson-logger: rotation keeps active + .1..4 (5 files max) and rotateFileIfNeeded works', async (t) => {
  const dir = makeTmpDir('ndjson-rot-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'service.ndjson');
  const logger = createLogger({ proc: 'test', filePath: logFile, maxBytes: 256, maxFiles: 5 });

  for (let i = 0; i < 20; i++) {
    logger.info(`rotation-entry-${i}-${'x'.repeat(120)}`);
    await logger.flush();
  }
  await logger.close();

  assert.equal(fs.existsSync(`${logFile}.1`), true);
  assert.equal(fs.existsSync(`${logFile}.4`), true);
  assert.equal(fs.existsSync(`${logFile}.5`), false, 'must cap at maxFiles=5 (active + .1..4)');

  // Pre-spawn rotateFileIfNeeded helper
  const legacyFile = path.join(dir, 'legacy.stdout.log');
  fs.writeFileSync(legacyFile, 'a'.repeat(512));
  assert.equal(rotateFileIfNeeded(legacyFile, 256, 5), true);
  assert.equal(fs.existsSync(`${legacyFile}.1`), true);
  assert.equal(fs.existsSync(legacyFile), false);
});

test('ndjson-logger: symlink safety blocks writes and rotation on symlink targets', async (t) => {
  if (process.platform === 'win32') return;
  const dir = makeTmpDir('ndjson-sym-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'DO-NOT-TOUCH');
  const link = path.join(dir, 'evil.ndjson');
  fs.symlinkSync(victim, link);

  const logger = createLogger({ proc: 'test', filePath: link, maxBytes: 256 });
  logger.info('should not clobber symlink');
  await logger.flush();
  logger.fatal('fatal should not clobber symlink');
  await logger.close();

  assert.equal(fs.readFileSync(victim, 'utf8'), 'DO-NOT-TOUCH');
  assert.equal(rotateFileIfNeeded(link, 1, 5), false);
  assert.equal(fs.existsSync(`${link}.1`), false);
});

test('ndjson-logger: 15+ secret/PII/cookie redaction vectors + allowlist + cycle/depth guards', () => {
  // 1-5: L1 sensitive keys + allowlist
  const cyclic = { ok: 1 };
  cyclic.self = cyclic;
  const deep = { a: { b: { c: { d: { e: { f: { g: 'too-deep' } } } } } } };
  const out = redact({
    password: 'p1',
    otpSecret: 'JBSWY3DPEHPK3PXP',
    rawKey: 'base64secret',
    clientSecret: 'cs_123',
    refreshToken: 'rt_123',
    executionPermit: 'perm_secret',
    c_user: '1000123456',
    xs: '45%3Aabc',
    hasPassword: true,
    hasOtp: false,
    hasToken: true,
    cookieCount: 12,
    cookieHostCount: 3,
    tokenPreview: 'tok_ab...cd',
    cyclic,
    deep,
    longStr: 'z'.repeat(3000),
  });
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.otpSecret, '[REDACTED]');
  assert.equal(out.rawKey, '[REDACTED]');
  assert.equal(out.clientSecret, '[REDACTED]');
  assert.equal(out.refreshToken, '[REDACTED]');
  assert.equal(out.executionPermit, '[REDACTED]');
  assert.equal(out.c_user, '[REDACTED]');
  assert.equal(out.xs, '[REDACTED]');
  assert.equal(out.hasPassword, true);
  assert.equal(out.hasOtp, false);
  assert.equal(out.hasToken, true);
  assert.equal(out.cookieCount, 12);
  assert.equal(out.cookieHostCount, 3);
  assert.equal(out.tokenPreview, 'tok_ab...cd');
  assert.equal(out.cyclic.self, '[Circular]');
  assert.equal(out.deep.a.b.c.d.e, '[Truncated]');
  assert.ok(out.longStr.endsWith('...[truncated]'));

  // 6-18: L2 string sweeps (13 distinct patterns incl. JSON-quoted Auth/KV)
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const vectors = [
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAsecret', '[REDACTED_PEM]'],
    ['{"Authorization": "Bearer superSecretToken999"}', 'superSecretToken999', '[REDACTED]'],
    ['Authorization: Basic dXNlcjpwYXNzMTIz', 'dXNlcjpwYXNzMTIz', '[REDACTED]'],
    ['Bearer standaloneSecretToken888', 'standaloneSecretToken888', '[REDACTED]'],
    ['{"password": "myJsonPass!", "api_key": "ak_secret_777", "rawKey": "YWJjZGVm=="}', 'myJsonPass!', '[REDACTED]'],
    ['WEBMCP_GATEWAY_TOKEN=gw_tok_secret123 vaultPassphrase=myVaultPass', 'gw_tok_secret123', '[REDACTED]'],
    ['Cookie: c_user=1000999; xs=45%3Asecret\nHost: example.com', '1000999', '[REDACTED_COOKIE]'],
    ['Set-Cookie: __Secure-1PSID=g.a000secretcookie; HttpOnly', 'g.a000secretcookie', '[REDACTED_COOKIE]'],
    ['raw c_user=1000888; xs=99%3Axyz; SID=sid_secret_1; __Secure-3PSID=psid_secret_3', 'psid_secret_3', '[REDACTED]'],
    [`jwt=${jwt}`, 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', '[REDACTED_JWT]'],
    ['google ya29.a0AfB_byC1234567890abcdefghij and 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz', 'ya29.a0AfB', '[REDACTED_OAUTH]'],
    ['ghp_1234567890abcdefghij123456 sk-proj-1234567890abcdefghij AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe', 'ghp_1234567890', '[REDACTED_KEY]'],
    ['https://admin:superpass@proxy.example.com:8080/api?access_token=qtok_999&ok=1', 'superpass', '[REDACTED]'],
    ['clean\x00\x07\x1bmsg', '\x00', 'cleanmsg'],
  ];
  for (const [input, secret, marker] of vectors) {
    const cleaned = redact(input);
    assert.equal(cleaned.includes(secret), false, `secret leaked for input: ${input} -> ${cleaned}`);
    assert.equal(cleaned.includes(marker), true, `marker ${marker} missing for input: ${input} -> ${cleaned}`);
  }
});

test('ndjson-logger: AsyncLocalStorage corrId, getOpenFdCount, and startMemHeartbeat', async () => {
  assert.equal(getCorrId(), undefined);
  const generated = newCorrId();
  assert.match(generated, /^c_[0-9a-f]{8}$/);

  const captured = await runWithCorrId('req-abc-123', async () => {
    await new Promise((r) => setTimeout(r, 5));
    return getCorrId();
  });
  assert.equal(captured, 'req-abc-123');
  assert.equal(getCorrId(), undefined);

  const fdCount = getOpenFdCount();
  if (process.platform !== 'win32') assert.ok(fdCount > 0, `expected >0 FDs, got ${fdCount}`);

  const beforeListeners = process.listenerCount('SIGUSR2');
  const logger = createLogger({ proc: 'hb-test' });
  const hb = startMemHeartbeat(logger, { intervalMs: 600000, rssWarnMb: 99999, enableSigusr2: true });
  const sample = hb.sample();
  assert.ok(sample.rssMb > 0);
  hb.stop();
  assert.equal(process.listenerCount('SIGUSR2'), beforeListeners);
  await logger.close();
});

test('P0-1: InteractiveRuntime skips storing permitless mode=off receipts and caps _receiptRegistry FIFO at 5000', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSeams = process.env.WEBMCP_ALLOW_TEST_SEAMS;
  process.env.NODE_ENV = 'test';
  process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';
  try {
    const offRuntime = new InteractiveRuntime({ mode: 'off', allowTestSeams: true });
    for (let i = 0; i < 20; i++) {
      const r = offRuntime.createAppliedReceipt({ method: 'ping', params: {}, result: { ok: true } });
      assert.ok(r.receiptId);
    }
    assert.equal(offRuntime._receiptRegistry.size, 0, 'mode=off without permitId must not populate _receiptRegistry');

    const enforceRuntime = new InteractiveRuntime({ mode: 'enforce', allowTestSeams: true });
    const first = enforceRuntime._storeReceipt({ receiptId: 'rcpt_0', permitId: 'p0' });
    assert.equal(first.receiptId, 'rcpt_0');
    for (let i = 1; i <= 5050; i++) {
      enforceRuntime._storeReceipt({ receiptId: `rcpt_${i}`, permitId: `p${i}` });
    }
    assert.equal(enforceRuntime._receiptRegistry.size, 5000);
    assert.equal(enforceRuntime._receiptRegistry.has('rcpt_0'), false, 'oldest receipt must be evicted FIFO');
    assert.equal(enforceRuntime._receiptRegistry.has('rcpt_5050'), true, 'newest receipt must be retained');
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
    if (prevSeams === undefined) delete process.env.WEBMCP_ALLOW_TEST_SEAMS; else process.env.WEBMCP_ALLOW_TEST_SEAMS = prevSeams;
  }
});

test('P1-2: PermitStore.markSeen() runs skew-safe gc() for seenNonce+budget and caps revoked FIFO at 10000', () => {
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, keyId: keys.keyId, permitStore: store, mode: 'enforce' });

  const t0 = Date.now();
  const p1 = signPermit(keys, { _nowMs: t0, expiresAt: new Date(t0 + 5000).toISOString() });
  const r1 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test/a' }, permit: p1, now: new Date(t0) });
  assert.equal(r1.decision, 'allow');
  assert.equal(store.seenNonce.has(p1.nonce), true);
  assert.equal(store.budget.has(p1.permitId), true);
  assert.ok(Number.isFinite(store.budget.get(p1.permitId).expiresAt));

  // Within 1000ms verifier skew window (t0 + 5500): p1 must NOT be evicted yet
  const pMid = signPermit(keys, { _nowMs: t0 + 5500, expiresAt: new Date(t0 + 20000).toISOString() });
  const rMid = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test/mid' }, permit: pMid, now: new Date(t0 + 5500) });
  assert.equal(rMid.decision, 'allow');
  assert.equal(store.seenNonce.has(p1.nonce), true, 'must keep nonce within 1000ms verifier skew');

  // Past skew window (t0 + 6500 > t0 + 5000 + 1000): p1 nonce and budget must be evicted
  const p2 = signPermit(keys, { _nowMs: t0 + 6500, expiresAt: new Date(t0 + 30000).toISOString() });
  const r2 = verifier.verifyRequest({ tool: 'browser_navigate', params: { url: 'https://example.test/b' }, permit: p2, now: new Date(t0 + 6500) });
  assert.equal(r2.decision, 'allow');
  assert.equal(store.seenNonce.has(p1.nonce), false, 'expired nonce must be GCed on markSeen');
  assert.equal(store.budget.has(p1.permitId), false, 'expired budget entry must be GCed on markSeen');

  // Revoked FIFO cap at 10000
  for (let i = 0; i < 10050; i++) store.revoke(`rev_${i}`);
  assert.equal(store.revoked.size, 10000);
  assert.equal(store.revoked.has('rev_0'), false);
  assert.equal(store.revoked.has('rev_10049'), true);
});

test('P1-3: ProfileGovernor release clears fences, prunes unreferenced cooldown leases, and gateway close resets singleton', async (t) => {
  const dir = makeTmpDir('gov-prune-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'governor-state.json');
  const repo = new GovernorRepository({ statePath });
  const binding = {
    physicalResourceId: 'prsc_test-prof-1',
    bindingId: 'pb_test-1',
    bindingRevision: 1,
    bindingDigest: 'sha256:' + '1'.repeat(64),
    allowedActions: ['browser-read', 'browser-write'],
  };
  let now = Date.now();
  const gov = new ProfileGovernor({
    repository: repo,
    registry: { resolve: async () => binding },
    claims: {
      validate: async (req) => ({
        valid: true,
        active: true,
        runId: req.runId,
        nodeId: req.nodeId,
        bindingId: req.bindingId,
        bindingRevision: req.bindingRevision,
        bindingDigest: req.bindingDigest,
        runnerClaimDigest: req.runnerClaimDigest,
        allowedActions: ['browser-read', 'browser-write'],
      }),
    },
    liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }),
    revokeGrants: async () => true,
    clock: () => now,
  });

  await gov.reconcileProfile('prof-one');
  const req = {
    schema: 'webmcp-profile-lease-request/1',
    requestId: 'plr_req-0001',
    ownerType: 'automation',
    nodeId: 'node-test-1',
    runId: 'run_test-0001',
    runnerClaimDigest: 'sha256:' + '2'.repeat(64),
    bindingId: binding.bindingId,
    bindingRevision: binding.bindingRevision,
    bindingDigest: binding.bindingDigest,
    profileAlias: 'prof-one',
    leaseMode: 'single-context',
    requestedActions: ['browser-read', 'browser-write'],
    heartbeatIntervalMs: 5000,
    leaseTtlMs: 60000,
    idempotencyKey: 'idem-key-0001',
  };
  const leased = await gov.acquire(req);
  await gov.createFence({
    leaseId: leased.leaseId,
    fenceEpoch: leased.fenceEpoch,
    leaseBindingDigest: leased.leaseBindingDigest,
    runId: req.runId,
    bindingId: req.bindingId,
    bindingDigest: req.bindingDigest,
    runnerClaimDigest: req.runnerClaimDigest,
    action: 'browser-write',
  });
  const beforeRelease = repo.read();
  assert.equal(Object.keys(beforeRelease.leases[leased.leaseId].fences).length, 1);

  await gov.release({
    leaseId: leased.leaseId,
    fenceEpoch: leased.fenceEpoch,
    leaseBindingDigest: leased.leaseBindingDigest,
    runId: req.runId,
    bindingId: req.bindingId,
    bindingDigest: req.bindingDigest,
    runnerClaimDigest: req.runnerClaimDigest,
  });
  const afterRelease = repo.read();
  assert.deepEqual(afterRelease.leases[leased.leaseId].fences, {}, 'release() must clear current.fences');

  // Inject an old unreferenced cooldown lease directly into valid state and verify next release prunes it
  const ghostId = 'lease_0000000000000001';
  repo.transact((st) => {
    st.leases[ghostId] = { ...st.leases[leased.leaseId], leaseId: ghostId, state: 'cooldown', fences: {} };
  });
  assert.ok(repo.read().leases[ghostId]);
  await gov.reconcileProfile('prof-one');
  const leased2 = await gov.acquire({ ...req, requestId: 'plr_req-0002', idempotencyKey: 'idem-key-0002' });
  await gov.release({
    leaseId: leased2.leaseId,
    fenceEpoch: leased2.fenceEpoch,
    leaseBindingDigest: leased2.leaseBindingDigest,
    runId: req.runId,
    bindingId: req.bindingId,
    bindingDigest: req.bindingDigest,
    runnerClaimDigest: req.runnerClaimDigest,
  });
  const afterSecond = repo.read();
  assert.equal(afterSecond.leases[ghostId], undefined, 'unreferenced cooldown lease must be pruned on release()');
  assert.ok(afterSecond.leases[leased2.leaseId], 'lease referenced by events must remain valid');
  gov.close();

  // Gateway singleton close + reset allows clean re-open
  const prevState = process.env.WEBMCP_GOVERNOR_STATE;
  const prevFence = process.env.A3_FENCE_MODE;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSeams = process.env.WEBMCP_ALLOW_TEST_SEAMS;
  process.env.WEBMCP_GOVERNOR_STATE = path.join(dir, 'gw-singleton.json');
  process.env.A3_FENCE_MODE = 'observe';
  process.env.NODE_ENV = 'test';
  process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';
  resetGatewayGovernorSingleton();
  let gw1 = null;
  let gw2 = null;
  try {
    gw1 = createGatewayServer({ port: 0, interactiveMode: 'off', allowTestSeams: true });
    await gw1.start();
    assert.ok(gw1.governor);
    await gw1.close();
    gw1 = null;
    gw2 = createGatewayServer({ port: 0, interactiveMode: 'off', allowTestSeams: true });
    await gw2.start();
    assert.ok(gw2.governor);
    assert.equal(gw2.governor.repository._closed, false, 'new gateway must receive fresh open governor repository');
    await gw2.close();
    gw2 = null;
  } finally {
    if (gw1) { try { await gw1.close(); } catch {} }
    if (gw2) { try { await gw2.close(); } catch {} }
    resetGatewayGovernorSingleton();
    if (prevState === undefined) delete process.env.WEBMCP_GOVERNOR_STATE; else process.env.WEBMCP_GOVERNOR_STATE = prevState;
    if (prevFence === undefined) delete process.env.A3_FENCE_MODE; else process.env.A3_FENCE_MODE = prevFence;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
    if (prevSeams === undefined) delete process.env.WEBMCP_ALLOW_TEST_SEAMS; else process.env.WEBMCP_ALLOW_TEST_SEAMS = prevSeams;
  }
});

test('P2-1: gateway HTTP body cap (413), corrId logging, PII scrub, and WS handshake timeout', async (t) => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSeams = process.env.WEBMCP_ALLOW_TEST_SEAMS;
  process.env.NODE_ENV = 'test';
  process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';
  const entries = [];
  const logger = createLogger({ proc: 'gateway', onEntry: (e) => entries.push(e) });
  const gw = createGatewayServer({
    port: 0,
    token: 'tok-test',
    interactiveMode: 'off',
    allowTestSeams: true,
    handshakeTimeoutMs: 120,
    logger,
  });
  const { port } = await gw.start();
  t.after(async () => {
    await gw.close();
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
    if (prevSeams === undefined) delete process.env.WEBMCP_ALLOW_TEST_SEAMS; else process.env.WEBMCP_ALLOW_TEST_SEAMS = prevSeams;
  });

  // 1. Oversized /interactive/revoke (>1 MiB) -> 413
  const bigBody = JSON.stringify({ permitId: 'p_' + 'x'.repeat(1100 * 1024) });
  const res413 = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/interactive/revoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok-test',
        'x-webmcp-corr-id': 'corr-body-cap',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(bigBody);
  });
  assert.equal(res413.status, 413);

  // 2. Stalled WS without extensionReady is terminated by handshake timeout
  const stalledWs = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => stalledWs.once('close', resolve));
  assert.ok(entries.some((e) => e.msg === 'Extension handshake timed out'));

  // 3. Extension ready scrubs email/name & extension event scrubs raw params
  const goodWs = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => goodWs.once('open', resolve));
  goodWs.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'extensionReady',
    params: { profileId: 'p_scrub', name: 'WebMCP', version: '1.0.0', profileEmail: 'secret-user@example.com', profileName: 'Real Private Name' },
  }));
  goodWs.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'customEvent',
    params: { secretPayload: 'do-not-log-this-value' },
  }));
  await new Promise((r) => setTimeout(r, 80));
  const serializedLogs = JSON.stringify(entries);
  assert.equal(serializedLogs.includes('secret-user@example.com'), false, 'email must be scrubbed from logs');
  assert.equal(serializedLogs.includes('Real Private Name'), false, 'profile name must be scrubbed from logs');
  assert.equal(serializedLogs.includes('do-not-log-this-value'), false, 'raw extension event params must be scrubbed');
  goodWs.close();

  // 4. Oversized /api/aqua/launch (>2 MiB) -> 413 PAYLOAD_TOO_LARGE + Connection: close
  const aquaBig = JSON.stringify({ profileId: 'a'.repeat(2100 * 1024) });
  const aquaRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/aqua/launch',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-test' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(aquaBig);
  });
  assert.equal(aquaRes.status, 413);
  assert.equal(aquaRes.headers.connection, 'close');
  assert.equal(aquaRes.json.error, 'PAYLOAD_TOO_LARGE');

  // 5. gateway defaultLogDir honors WEBMCP_HOME & disables disk/SIGUSR2 under NODE_TEST_CONTEXT even without NODE_ENV=test
  const prevHome = process.env.WEBMCP_HOME;
  const prevLogDir = process.env.WEBMCP_LOG_DIR;
  const prevLogFile = process.env.WEBMCP_LOG_FILE;
  const prevTestCtx = process.env.NODE_TEST_CONTEXT;
  const customHome = makeTmpDir('gw-home-');
  t.after(() => fs.rmSync(customHome, { recursive: true, force: true }));
  try {
    delete process.env.NODE_ENV;
    delete process.env.WEBMCP_LOG_DIR;
    delete process.env.WEBMCP_LOG_FILE;
    process.env.WEBMCP_HOME = customHome;
    // Under NODE_TEST_CONTEXT (current runner), default logFile stays '' (no disk pollution)
    const gwTestCtx = createGatewayServer({ port: 0, interactiveMode: 'off' });
    assert.equal(gwTestCtx.logger.getFilePath(), '');
    await gwTestCtx.close();
    // Outside test context, default logFile resolves under WEBMCP_HOME/logs/gateway.ndjson
    delete process.env.NODE_TEST_CONTEXT;
    const gwProdHome = createGatewayServer({ port: 0, interactiveMode: 'off' });
    assert.equal(gwProdHome.logger.getFilePath(), path.join(customHome, 'logs', 'gateway.ndjson'));
    await gwProdHome.close();
  } finally {
    if (prevHome === undefined) delete process.env.WEBMCP_HOME; else process.env.WEBMCP_HOME = prevHome;
    if (prevLogDir === undefined) delete process.env.WEBMCP_LOG_DIR; else process.env.WEBMCP_LOG_DIR = prevLogDir;
    if (prevLogFile === undefined) delete process.env.WEBMCP_LOG_FILE; else process.env.WEBMCP_LOG_FILE = prevLogFile;
    if (prevTestCtx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevTestCtx;
  }
});

test('P2-1: TrustedContextChannel enforces idle socket timeout and destroys open sockets in stop()', async (t) => {
  if (process.platform === 'win32') return;
  const sockPath = path.join(os.tmpdir(), `wmcp-idle-${process.pid}-${Date.now()}.sock`);
  const ch = new TrustedContextChannel({ socketPath: sockPath, socketTimeoutMs: 120 });
  await ch.start();
  t.after(() => ch.stop());

  // 1. Idle client gets destroyed after socketTimeoutMs
  const idleClient = net.connect(sockPath);
  await new Promise((resolve) => idleClient.once('close', resolve));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ch._sockets.size, 0);

  // 2. Active open client does not hang stop()
  const ch2 = new TrustedContextChannel({
    socketPath: path.join(os.tmpdir(), `wmcp-stop-${process.pid}-${Date.now()}.sock`),
    socketTimeoutMs: 60000,
  });
  await ch2.start();
  const hanger = net.connect(ch2.socketPath);
  await new Promise((resolve) => hanger.once('connect', resolve));
  const t0 = Date.now();
  await ch2.stop();
  assert.ok(Date.now() - t0 < 2000, 'stop() must destroy tracked sockets instead of hanging');
  hanger.destroy();
});
