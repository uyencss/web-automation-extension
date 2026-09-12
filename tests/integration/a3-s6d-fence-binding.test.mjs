// A3 S6d — fence scope binding (F1), per-boundary batch authorization (F4 +
// batch defect), external-use observe pass-through (F2).
//
// Pins: browser-kit 3d58328, vault-kit e71c764.
// Mode: fenceMode is PINNED per-case via constructor/env override (works under
// both A3_FENCE_MODE=enforce and A3_FENCE_MODE=observe runs).
// All Governor state under fs.mkdtemp(os.tmpdir()); no real browser/network.
process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';
import { canonicalJson, digestCanonical, SCHEMAS } from '../../server/gateway/trusted-context-schema.mjs';
import { PermitStore } from '../../server/gateway/permit-store.mjs';
import {
  GatewayVerifier,
  readGovernorActiveFence,
  drainFenceDivergences,
} from '../../server/gateway/verifier.mjs';
import { InteractiveRuntime } from '../../server/gateway/interactive-runtime.mjs';

const DIGEST = (ch) => `sha256:${ch.repeat(64)}`;
const DIGEST_A = DIGEST('a');
const CLAIM_A = DIGEST('b');
const PAGE_URL = 'https://example.test/page';

function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { publicKey, privateKey, rawPublicKeyHex, keyId: 'ed25519-test-key-01' };
}

function buildSignedContext({ keys, fenceEpoch = 1, runId = 'run_s6d_test01', profileAlias = 'interactive-profile' } = {}) {
  const base = {
    schema: SCHEMAS.TRUSTED_CONTEXT, messageId: `ctxmsg_s6d_${Math.random().toString(36).slice(2, 10)}`, seq: 1, runId,
    claimGeneration: fenceEpoch, claimDigest: DIGEST('0'), projectId: 'project_test_123',
    profileAlias, profileId: profileAlias, bindingId: 'pb_test-profile',
    bindingRevision: 1, bindingDigest: DIGEST_A, automationStoreRevision: 3, automationStoreDigest: DIGEST('2'),
    siteStoreRevision: 4, siteStoreDigest: DIGEST('3'), fenceEpoch, phaseId: 'interactive-action', stateVersion: 1,
    planRevision: 1, planDigest: DIGEST('4'), instructionDigest: DIGEST('5'), policyRevision: DIGEST('6'),
    ttlMs: 60000, keyId: keys.keyId, publicKey: keys.rawPublicKeyHex, issuedAt: new Date().toISOString(),
    notBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revocations: [],
  };
  const canonical = canonicalJson(base);
  const signature = sign(null, Buffer.from(`webmcp-digest-v1:trusted-context\n${canonical}`, 'utf8'), keys.privateKey).toString('hex');
  return { ...base, signature, contextDigest: digestCanonical('webmcp-digest-v1:trusted-context', base) };
}

function buildSignedPermit({ keys, actionClasses = ['browser.navigate'], runId = 'run_s6d_test01', profileAlias = 'interactive-profile' } = {}) {
  const base = {
    schema: SCHEMAS.PERMIT, permitId: `permit_s6d_${Math.random().toString(36).slice(2, 10)}`, runId,
    claimGeneration: 1, claimDigest: DIGEST('0'), projectId: 'project_test_123',
    profileAlias, profileId: profileAlias, bindingId: 'pb_test-profile',
    bindingRevision: 1, bindingDigest: DIGEST_A, automationStoreRevision: 3, automationStoreDigest: DIGEST('2'),
    siteStoreRevision: 4, siteStoreDigest: DIGEST('3'), phaseId: 'interactive-action',
    origins: ['https://example.test'], actionClasses, budget: { maxCalls: 50 }, stateVersion: 1,
    planRevision: 1, planDigest: DIGEST('4'), instructionDigest: DIGEST('5'), policyRevision: DIGEST('6'),
    keyId: keys.keyId, nonce: `nonce_s6d_${Math.random().toString(36).slice(2, 14)}`, issuedAt: new Date().toISOString(),
    notBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString(),
    ttlMs: 30000, revocationId: 'rev_s6d_001',
  };
  const canonical = canonicalJson(base);
  const signature = sign(null, Buffer.from('webmcp-digest-v1:permit\n' + canonical, 'utf8'), keys.privateKey).toString('hex');
  return { ...base, signature, permitDigest: digestCanonical('webmcp-digest-v1:permit', base) };
}

function buildSignedDurablePermit({ keys, actionClasses = ['browser.navigate'], runId = 'run_s6d_test01', profileAlias = 'interactive-profile' } = {}) {
  const wire = buildSignedPermit({ keys, actionClasses, runId, profileAlias });
  const {
    profileId: _profileId, automationStoreRevision: _asr, automationStoreDigest: _asd,
    siteStoreRevision: _ssr, siteStoreDigest: _ssd, signature: _sig, permitDigest: _pd, ...base
  } = wire;
  const durable = { ...base, schema: SCHEMAS.DURABLE_PERMIT };
  const canonical = canonicalJson(durable);
  durable.signature = sign(null, Buffer.from(`webmcp-digest-v1:durable-permit\n${canonical}`, 'utf8'), keys.privateKey).toString('hex');
  const { signature: _dsig, ...durableProjection } = durable;
  durable.permitDigest = digestCanonical('webmcp-digest-v1:durable-permit', durableProjection);
  return durable;
}

const BERLIN_LIVENESS = async () => ({
  governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true,
});

function makeS6dGovernor(dir, { clock = null, liveness = null, physicalResourceId = 'prsc_s6d-binding' } = {}) {
  const statePath = path.join(dir, 'governor-state.json');
  const repository = new GovernorRepository({ statePath });
  const governor = new ProfileGovernor({
    repository,
    registry: {
      resolve: async () => ({
        physicalResourceId,
        bindingId: 'pb_test-profile',
        bindingRevision: 1,
        bindingDigest: DIGEST_A,
        allowedActions: ['browser-read', 'browser-write'],
      }),
    },
    claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read', 'browser-write'], ...req }) },
    liveness: liveness ?? BERLIN_LIVENESS,
    revokeGrants: async () => true,
    ...(clock ? { clock } : {}),
  });
  return { governor, repository, statePath };
}

let leaseCounter = 0;
function leaseRequest(overrides = {}) {
  leaseCounter += 1;
  return {
    schema: 'webmcp-profile-lease-request/1',
    requestId: `plr_s6d-${String(leaseCounter).padStart(6, '0')}`,
    ownerType: 'automation',
    nodeId: 'node-s6d-1',
    runId: 'run_s6d-lease01',
    runnerClaimDigest: CLAIM_A,
    bindingId: 'pb_test-profile',
    bindingRevision: 1,
    bindingDigest: DIGEST_A,
    profileAlias: 'interactive-profile',
    leaseMode: 'single-context',
    requestedActions: ['browser-read', 'browser-write'],
    heartbeatIntervalMs: 1000,
    leaseTtlMs: 60000,
    idempotencyKey: `s6d-key-${leaseCounter}`,
    ...overrides,
  };
}

async function setupLiveLease(t, governorOptions = {}) {
  const dir = tmpDir('a3-s6d-bind-');
  const { governor } = makeS6dGovernor(dir, governorOptions);
  t.after(() => { try { governor.close(); } catch {} });
  await governor.reconcileProfile('interactive-profile');
  const lease = await governor.acquire(leaseRequest());
  return { governor, lease };
}

function fenceArgs(lease, { action = 'browser-write', actionKind = 'click' } = {}) {
  return {
    leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest,
    bindingId: lease.bindingId, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest,
    action, actionKind,
  };
}

function channelWith(ctx) {
  return { getContext: () => ctx, start: async () => {}, stop: async () => {} };
}

function makeFenceRuntime(keys, { governor = null, fenceMode = 'enforce', context = null } = {}) {
  return new InteractiveRuntime({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore: new PermitStore(),
    trustedContextChannel: channelWith(context),
    mode: 'enforce',
    allowTestSeams: true,
    governor,
    fenceMode,
  });
}

function navigateParams(proof) {
  return proof === undefined
    ? { url: PAGE_URL }
    : { url: PAGE_URL, fenceProof: proof };
}

// ── S6d test 1: issued browser-read proof + mutating request → STALE ─────────

test('S6d Fix A: issued browser-read proof cannot authorize a mutating request (async + sync)', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context });
  const readProof = await governor.createFence(fenceArgs(lease, { action: 'browser-read', actionKind: 'read' }));
  assert.deepEqual(readProof.scope.actions, ['browser-read'], 'issued read proof must carry the browser-read scope');

  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(readProof),
    permit: buildSignedPermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'deny', `read-scoped proof on a mutating call must deny (got ${r.decision})`);
  assert.equal(r.reason, 'PROFILE_FENCE_STALE', `scope mismatch must map to PROFILE_FENCE_STALE (got ${r.reason})`);

  // Direct-sync callers get the same binding via checkPhysicalFence.
  const sync = runtime.verifier.verifyRequest({
    tool: 'browser_navigate', params: navigateParams(readProof),
    permit: buildSignedPermit({ keys }), context,
  });
  assert.equal(sync.decision, 'deny');
  assert.equal(sync.reason, 'PROFILE_FENCE_STALE');
});

test('S6d Fix A: scope mismatch under observe logs divergence and continues', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'observe', context });
  const readProof = await governor.createFence(fenceArgs(lease, { action: 'browser-read', actionKind: 'read' }));
  drainFenceDivergences();
  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(readProof),
    permit: buildSignedPermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  // Fix-2 semantics: fence-observe never denies at the runtime layer — the
  // would-deny verdict carries the fence-layer marker and the gateway HTTP
  // path forwards it (pinned end-to-end by the Fix C server test below).
  assert.equal(r.decision, 'would-deny', `observe must not deny the scope-mismatched request (got ${r.decision})`);
  assert.equal(r.reason, 'PROFILE_FENCE_STALE');
  assert.equal(r.fenceLayer, true, 'observe scope divergence must carry the fence-layer marker');
  const diverged = drainFenceDivergences();
  assert.ok(diverged.some((d) => d.reason === 'PROFILE_FENCE_STALE'), `observe must log the scope divergence (got ${JSON.stringify(diverged)})`);
});

// ── S6d test 2: bound proofs allow ───────────────────────────────────────────

test('S6d Fix A: bound proofs allow — browser-write + mutating, browser-read + read', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context });

  const writeProof = await governor.createFence(fenceArgs(lease, { action: 'browser-write', actionKind: 'click' }));
  const rWrite = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(writeProof),
    permit: buildSignedPermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(rWrite.decision, 'allow', `write-scoped proof on a mutating call must allow (got ${rWrite.decision}/${rWrite.reason})`);

  const readProof = await governor.createFence(fenceArgs(lease, { action: 'browser-read', actionKind: 'read' }));
  const rRead = await runtime.enforceRequestAsync({
    method: 'browser_page_text', params: { url: PAGE_URL, fenceProof: readProof },
    permit: buildSignedPermit({ keys, actionClasses: ['browser.getPageText'] }),
    profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(rRead.decision, 'allow', `read-scoped proof on a read-only call must allow (got ${rRead.decision}/${rRead.reason})`);
});

// ── S6d tests 3-5: per-boundary batch authorization ──────────────────────────

function batchChild(proof) {
  return { method: 'browser_navigate', params: proof === undefined ? { url: PAGE_URL } : { url: PAGE_URL, fenceProof: proof } };
}

function batchPermit(keys) {
  return buildSignedPermit({ keys, actionClasses: ['browser.navigate', 'browser.batch'] });
}

test('S6d Fix B: same fenceId with altered proof content in a later child is denied', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context });
  const proof = await governor.createFence(fenceArgs(lease, { action: 'browser-write', actionKind: 'click' }));
  const altered = { ...proof, leaseBindingDigest: DIGEST('f') };
  assert.equal(altered.fenceId, proof.fenceId, 'tampered child must reuse the same fenceId');
  const r = await runtime.enforceRequestAsync({
    method: 'batch', params: { actions: [batchChild(proof), batchChild(altered)] },
    permit: batchPermit(keys), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'deny', `altered same-ID proof must deny (got ${r.decision})`);
  assert.equal(r.reason, 'PROFILE_FENCE_STALE', `altered proof must map to PROFILE_FENCE_STALE (got ${r.reason})`);
});

test('S6d Fix B: repeated identical proof is authorized per boundary (counted)', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context });
  const proof = await governor.createFence(fenceArgs(lease, { action: 'browser-write', actionKind: 'click' }));
  let calls = 0;
  const orig = governor.authorizeFence.bind(governor);
  governor.authorizeFence = async (presented) => { calls += 1; return orig(presented); };
  const r = await runtime.enforceRequestAsync({
    method: 'batch', params: { actions: [batchChild(proof), batchChild(proof)] },
    permit: batchPermit(keys), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(calls, 2, `one proof reused across two boundaries must authorize twice (saw ${calls})`);
  assert.equal(r.decision, 'allow', `repeated valid proof must still allow after per-boundary authorization (got ${r.decision}/${r.reason})`);
});

test('S6d Fix B: durable mutating batch with one child missing its proof is denied (async + sync)', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context: null });
  const proof = await governor.createFence(fenceArgs(lease, { action: 'browser-write', actionKind: 'click' }));
  const durableBatchPermit = () => buildSignedDurablePermit({ keys, actionClasses: ['browser.navigate', 'browser.batch'] });

  const r = await runtime.enforceRequestAsync({
    method: 'batch', params: { actions: [batchChild(proof), batchChild(undefined)] },
    permit: durableBatchPermit(), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'deny', `durable batch with a proofless mutating child must deny (got ${r.decision})`);
  assert.equal(r.reason, 'PROFILE_FENCE_REQUIRED', `missing child proof must map to PROFILE_FENCE_REQUIRED (got ${r.reason})`);

  // The sync path gates durable batch children identically.
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey, permitStore: new PermitStore(), mode: 'enforce', fenceMode: 'enforce',
    getActiveFence: (profileKey) => readGovernorActiveFence(governor, profileKey),
  });
  const sync = verifier.verifyBatch({
    tool: 'browser_batch',
    params: { actions: [batchChild(proof), batchChild(undefined)] },
    permit: durableBatchPermit(),
    targetOrigin: 'https://example.test',
    profileId: 'interactive-profile',
    context: null,
  });
  assert.equal(sync.decision, 'deny', `sync durable batch with a proofless child must deny (got ${sync.decision})`);
  assert.equal(sync.reason, 'PROFILE_FENCE_REQUIRED');
  assert.equal(sync.fenceLayer, true, 'durable fence denies must carry the fence-layer marker');
});

// ── S6d test 6: external-use observe pass-through vs enforce block ───────────

function makeFakeExtension(port, profileId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const forwarded = [];
  ws.on('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', method: 'extensionReady',
      params: { name: 'fake-s6d-ext', version: '1.0.0', profileId, capabilities: ['navigate'] },
    }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!('id' in msg)) return;
    forwarded.push(msg);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { success: true } }));
  });
  return { ws, forwarded };
}

async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}

function sendSocketMessage(socketPath, messageObj) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(`${JSON.stringify(messageObj)}\n`);
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

async function runFenceModeServer(t, fenceMode) {
  const { createGatewayServer, resetGatewayGovernorSingleton } =
    await import('../../server/gateway_server.js');
  const prevFence = process.env.A3_FENCE_MODE;
  const prevState = process.env.WEBMCP_GOVERNOR_STATE;
  process.env.A3_FENCE_MODE = fenceMode;
  const dir = tmpDir(`a3-s6d-server-${fenceMode}-`);
  process.env.WEBMCP_GOVERNOR_STATE = path.join(dir, 'governor-state.json');
  resetGatewayGovernorSingleton();
  t.after(() => {
    try { resetGatewayGovernorSingleton(); } catch {}
    if (prevFence === undefined) delete process.env.A3_FENCE_MODE; else process.env.A3_FENCE_MODE = prevFence;
    if (prevState === undefined) delete process.env.WEBMCP_GOVERNOR_STATE; else process.env.WEBMCP_GOVERNOR_STATE = prevState;
  });
  const keys = makeKeyPair();
  const app = createGatewayServer({
    port: 0,
    socketPath: path.join(dir, 'gateway.sock'),
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    interactiveMode: 'enforce',
    allowTestSeams: true,
    token: 's6d-token',
    physicalRouteMap: new Map([['interactive-profile', 'interactive-profile']]),
  });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'interactive-profile');
  t.after(() => { try { fakeExt.ws.terminate(); } catch {} });
  await waitFor(async () => app.connectedProfileIds().includes('interactive-profile'));
  const context = buildSignedContext({ keys, fenceEpoch: 2 });
  const ack = await sendSocketMessage(path.join(dir, 'gateway.sock'), context);
  assert.equal(ack.ok, true, `context socket must ack (got ${JSON.stringify(ack)})`);
  return { app, port, keys, fakeExt };
}

async function postApi(port, body, token = 's6d-token') {
  const res = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('S6d Fix C (server): external-use observe passes through with divergence; enforce blocks typed', async (t) => {
  const unfenced = (keys) => ({
    method: 'browser_navigate', params: { url: PAGE_URL },
    profileId: 'interactive-profile', permit: buildSignedPermit({ keys }),
  });

  const observed = await runFenceModeServer(t, 'observe');
  observed.app.governor.detectExternalUse = async () => ({ state: 'external_use', fenceEpoch: 2 });
  drainFenceDivergences();
  const lines = [];
  const origLog = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  let rPass;
  try {
    rPass = await postApi(observed.port, unfenced(observed.keys));
  } finally {
    console.log = origLog;
  }
  assert.equal(rPass.status, 200, `observe must continue past positive external-use (got ${rPass.status})`);
  assert.equal(observed.fakeExt.forwarded.length, 1, 'observe must forward past positive external-use instead of blocking');
  assert.ok(lines.some((l) => l.includes('External-use observe pass-through')), `observe must log the pass-through (saw ${JSON.stringify(lines)})`);
  const diverged = drainFenceDivergences();
  assert.ok(diverged.some((d) => d.reason === 'PROFILE_EXTERNAL_USE'), `observe must log external-use divergence (got ${JSON.stringify(diverged)})`);

  const enforced = await runFenceModeServer(t, 'enforce');
  enforced.app.governor.detectExternalUse = async () => ({ state: 'external_use', fenceEpoch: 2 });
  const rBlock = await postApi(enforced.port, unfenced(enforced.keys));
  assert.equal(rBlock.status, 403, `enforce must block positive external-use (got ${rBlock.status})`);
  assert.equal(rBlock.body.reason, 'PROFILE_EXTERNAL_USE', `enforce block must stay typed (got ${rBlock.body.reason})`);
  assert.equal(rBlock.body.receipt?.reason, 'PROFILE_EXTERNAL_USE', 'enforce block must carry a typed receipt');
  assert.equal(enforced.fakeExt.forwarded.length, 0, 'blocked external-use request must never forward');
});
