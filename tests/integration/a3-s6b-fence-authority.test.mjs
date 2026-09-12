// A3 S6b — authoritative fence proof validation + live-tuple hardening +
// durable-permit fence + observe pass-through (L2 blocking findings 1-4).
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
import fs from 'node:fs';
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

function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { publicKey, privateKey, rawPublicKeyHex, keyId: 'ed25519-test-key-01' };
}

function buildSignedContext({ keys, fenceEpoch = 1, runId = 'run_s6b_test01', profileAlias = 'interactive-profile' } = {}) {
  const base = {
    schema: SCHEMAS.TRUSTED_CONTEXT, messageId: `ctxmsg_s6b_${Math.random().toString(36).slice(2, 10)}`, seq: 1, runId,
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

function buildSignedPermit({ keys, actionClasses = ['browser.navigate'], runId = 'run_s6b_test01', profileAlias = 'interactive-profile' } = {}) {
  const base = {
    schema: SCHEMAS.PERMIT, permitId: `permit_s6b_${Math.random().toString(36).slice(2, 10)}`, runId,
    claimGeneration: 1, claimDigest: DIGEST('0'), projectId: 'project_test_123',
    profileAlias, profileId: profileAlias, bindingId: 'pb_test-profile',
    bindingRevision: 1, bindingDigest: DIGEST_A, automationStoreRevision: 3, automationStoreDigest: DIGEST('2'),
    siteStoreRevision: 4, siteStoreDigest: DIGEST('3'), phaseId: 'interactive-action',
    origins: ['https://example.test'], actionClasses, budget: { maxCalls: 50 }, stateVersion: 1,
    planRevision: 1, planDigest: DIGEST('4'), instructionDigest: DIGEST('5'), policyRevision: DIGEST('6'),
    keyId: keys.keyId, nonce: `nonce_s6b_${Math.random().toString(36).slice(2, 14)}`, issuedAt: new Date().toISOString(),
    notBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString(),
    ttlMs: 30000, revocationId: 'rev_s6b_001',
  };
  const canonical = canonicalJson(base);
  const signature = sign(null, Buffer.from('webmcp-digest-v1:permit\n' + canonical, 'utf8'), keys.privateKey).toString('hex');
  return { ...base, signature, permitDigest: digestCanonical('webmcp-digest-v1:permit', base) };
}

function buildSignedDurablePermit({ keys, actionClasses = ['browser.navigate'], runId = 'run_s6b_test01', profileAlias = 'interactive-profile' } = {}) {
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

function makeS6bGovernor(dir, { clock = null, liveness = null, physicalResourceId = 'prsc_s6b-authority' } = {}) {
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
    requestId: `plr_s6b-${String(leaseCounter).padStart(6, '0')}`,
    ownerType: 'automation',
    nodeId: 'node-s6b-1',
    runId: 'run_s6b-lease01',
    runnerClaimDigest: CLAIM_A,
    bindingId: 'pb_test-profile',
    bindingRevision: 1,
    bindingDigest: DIGEST_A,
    profileAlias: 'interactive-profile',
    leaseMode: 'single-context',
    requestedActions: ['browser-read', 'browser-write'],
    heartbeatIntervalMs: 1000,
    leaseTtlMs: 60000,
    idempotencyKey: `s6b-key-${leaseCounter}`,
    ...overrides,
  };
}

async function setupLiveLease(t, governorOptions = {}) {
  const dir = tmpDir('a3-s6b-auth-');
  const { governor } = makeS6bGovernor(dir, governorOptions);
  t.after(() => { try { governor.close(); } catch {} });
  await governor.reconcileProfile('interactive-profile');
  const lease = await governor.acquire(leaseRequest());
  const proof = await governor.createFence({
    leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest,
    bindingId: lease.bindingId, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest,
    action: 'browser-write', actionKind: 'click',
  });
  return { governor, lease, proof };
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
    ? { url: 'https://example.test/page' }
    : { url: 'https://example.test/page', fenceProof: proof };
}

// ── Fix 1: authoritative fence proof validation (async, real Governor) ──────

test('S6b Fix 1: valid issued proof (createFence + live lease) allows via the runtime async path', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context });
  const proof = await governor.createFence({
    leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest,
    bindingId: lease.bindingId, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest,
    action: 'browser-write', actionKind: 'click',
  });
  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(proof),
    permit: buildSignedPermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'allow', `issued live proof must allow (got ${r.decision}/${r.reason})`);
});

test('S6b Fix 1: invented proof with correct epoch denies PROFILE_FENCE_STALE', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease, proof } = await setupLiveLease(t);
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context });
  const invented = { ...proof, fenceId: 'fence_ffffffffffffffff' };
  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(invented),
    permit: buildSignedPermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'deny', `unissued proof with correct epoch must deny (got ${r.decision})`);
  assert.equal(r.reason, 'PROFILE_FENCE_STALE', `unissued proof must map to PROFILE_FENCE_STALE (got ${r.reason})`);
});

test('S6b Fix 1: expired proof denies PROFILE_FENCE_STALE', async (t) => {
  const keys = makeKeyPair();
  let now = Date.now();
  const dir = tmpDir('a3-s6b-expired-');
  const { governor } = makeS6bGovernor(dir, { clock: () => now });
  t.after(() => { try { governor.close(); } catch {} });
  await governor.reconcileProfile('interactive-profile');
  const lease = await governor.acquire(leaseRequest({ leaseTtlMs: 5000 }));
  const proof = await governor.createFence({
    leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest,
    bindingId: lease.bindingId, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest,
    action: 'browser-write', actionKind: 'click',
  });
  now += 60000; // past both the fence ttl and the lease TTL
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context });
  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(proof),
    permit: buildSignedPermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'deny', `expired proof must deny (got ${r.decision})`);
  assert.equal(r.reason, 'PROFILE_FENCE_STALE', `expired proof must map to PROFILE_FENCE_STALE (got ${r.reason})`);
});

test('S6b Fix 1: absent proof denies PROFILE_FENCE_REQUIRED', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context });
  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(undefined),
    permit: buildSignedPermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'PROFILE_FENCE_REQUIRED');
});

test('S6b Fix 1: fail-safe — no governor wired denies mutating actions PROFILE_FENCE_REQUIRED, never allows unvalidated proof', async (t) => {
  const keys = makeKeyPair();
  const { proof, lease } = await setupLiveLease(t);
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor: null, fenceMode: 'enforce', context });
  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams({ fenceEpoch: lease.fenceEpoch }),
    permit: buildSignedPermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'deny', `epoch-only proof with no governor must deny (got ${r.decision})`);
  assert.equal(r.reason, 'PROFILE_FENCE_REQUIRED');
  assert.ok(!proof || true);
});

test('S6b Fix 1+2: observe logs divergence and does not block the same invented-proof request', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease, proof } = await setupLiveLease(t);
  const context = buildSignedContext({ keys, fenceEpoch: lease.fenceEpoch });
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'observe', context });
  drainFenceDivergences();
  const invented = { ...proof, fenceId: 'fence_ffffffffffffffff' };
  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(invented),
    permit: buildSignedPermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'allow', `observe must not block the invented-proof request (got ${r.decision}/${r.reason})`);
  const diverged = drainFenceDivergences();
  assert.ok(diverged.length >= 1, 'observe must log at least one fence divergence record');
  assert.ok(diverged.some((d) => d.reason === 'PROFILE_FENCE_STALE'), `divergence must carry PROFILE_FENCE_STALE (got ${JSON.stringify(diverged)})`);
});

test('S6b Fix 1: sync precheck prefers the Governor live tuple over a stale context epoch', (t) => {
  const keys = makeKeyPair();
  const liveEpoch = 9;
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey, permitStore: new PermitStore(), mode: 'enforce', fenceMode: 'enforce',
    getActiveFence: () => ({ profileKey: 'interactive-profile', leaseId: 'lease_aaaaaaaaaaaaaaaa', fenceEpoch: liveEpoch }),
  });
  const context = buildSignedContext({ keys, fenceEpoch: 3 });
  const liveProof = verifier.verifyRequest({
    tool: 'browser_navigate', params: navigateParams({ fenceEpoch: liveEpoch, scope: { actions: ['browser-write'] } }),
    permit: buildSignedPermit({ keys }), context,
  });
  assert.equal(liveProof.decision, 'allow', `proof matching the live tuple must allow despite stale context (got ${liveProof.decision}/${liveProof.reason})`);
  const staleProof = verifier.verifyRequest({
    tool: 'browser_navigate', params: navigateParams({ fenceEpoch: 3, scope: { actions: ['browser-write'] } }),
    permit: buildSignedPermit({ keys }), context,
  });
  assert.equal(staleProof.decision, 'deny');
  assert.equal(staleProof.reason, 'PROFILE_FENCE_STALE');
});

// ── Fix 3: live-tuple reader hardening ───────────────────────────────────────

test('S6b Fix 3: reader supplies the live epoch for a leased resource with an unexpired lease', async (t) => {
  const { governor, lease } = await setupLiveLease(t);
  const live = readGovernorActiveFence(governor, 'interactive-profile');
  assert.deepEqual(live, { profileKey: 'interactive-profile', leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch });
});

test('S6b Fix 3: quarantined resources are non-live (fail-closed)', async (t) => {
  const dir = tmpDir('a3-s6b-quar-');
  const { governor } = makeS6bGovernor(dir);
  t.after(() => { try { governor.close(); } catch {} });
  await governor.reconcileProfile('interactive-profile');
  await governor.acquire(leaseRequest());
  const failedLiveness = async () => ({ governor: 'healthy', registry: 'failed', runnerClaim: 'terminal', browserAlive: false, extensionConnected: false });
  const dir2 = tmpDir('a3-s6b-quar2-');
  fs.copyFileSync(path.join(dir, 'governor-state.json'), path.join(dir2, 'governor-state.json'));
  const { governor: gov2 } = makeS6bGovernor(dir2, { liveness: failedLiveness });
  t.after(() => { try { gov2.close(); } catch {} });
  const reconciled = await gov2.reconcileProfile('interactive-profile');
  assert.equal(reconciled.state, 'quarantined');
  assert.equal(readGovernorActiveFence(gov2, 'interactive-profile'), null, 'quarantined resource must not supply a live epoch');
});

test('S6b Fix 3: orphan left unknown by a failed reconcile is non-live (L2 orphan case)', async (t) => {
  const dir = tmpDir('a3-s6b-unknown-');
  const { governor } = makeS6bGovernor(dir);
  await governor.reconcileProfile('interactive-profile');
  await governor.acquire(leaseRequest());
  governor.close(); // crash: durable state survives, no clean release
  const { governor: gov2 } = makeS6bGovernor(dir); // constructor marks survivors unknown; no reconcile runs
  t.after(() => { try { gov2.close(); } catch {} });
  const state = gov2.repository.read();
  const resource = Object.values(state.resources || {}).find((r) => r.profileAlias === 'interactive-profile');
  assert.equal(resource?.state, 'unknown', 'reopened orphan must be unknown before reconcile');
  assert.equal(readGovernorActiveFence(gov2, 'interactive-profile'), null, 'unknown orphan must not supply a live epoch');
});

test('S6b Fix 3: external_use resources are non-live', async (t) => {
  const dir = tmpDir('a3-s6b-extuse-');
  const externalUseLiveness = async () => ({
    governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false,
  });
  const { governor } = makeS6bGovernor(dir, { liveness: externalUseLiveness });
  t.after(() => { try { governor.close(); } catch {} });
  await governor.reconcileProfile('interactive-profile');
  const detected = await governor.detectExternalUse('interactive-profile');
  assert.equal(detected.state, 'external_use');
  assert.equal(readGovernorActiveFence(governor, 'interactive-profile'), null, 'external_use resource must not supply a live epoch');
});

test('S6b Fix 3: released resources (needsReconciliation) are non-live', async (t) => {
  const { governor, lease } = await setupLiveLease(t);
  await governor.release({
    leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest,
    bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest,
  });
  assert.equal(readGovernorActiveFence(governor, 'interactive-profile'), null, 'released/cooldown resource must not supply a live epoch');
});

test('S6b Fix 3: lease expired by TTL is non-live even while the resource still reads leased', async (t) => {
  const keys = makeKeyPair();
  assert.ok(keys);
  let now = Date.now();
  const dir = tmpDir('a3-s6b-ttl-');
  const { governor } = makeS6bGovernor(dir, { clock: () => now });
  t.after(() => { try { governor.close(); } catch {} });
  await governor.reconcileProfile('interactive-profile');
  await governor.acquire(leaseRequest({ leaseTtlMs: 5000 }));
  assert.ok(readGovernorActiveFence(governor, 'interactive-profile', now), 'unexpired lease must supply the live epoch');
  now += 60000;
  assert.equal(readGovernorActiveFence(governor, 'interactive-profile', now), null, 'TTL-expired lease must not supply a live epoch');
});

test('S6b Fix 3: resources with no live state (ready, no lease) are non-live', async (t) => {
  const dir = tmpDir('a3-s6b-ready-');
  const { governor } = makeS6bGovernor(dir);
  t.after(() => { try { governor.close(); } catch {} });
  await governor.reconcileProfile('interactive-profile');
  assert.equal(readGovernorActiveFence(governor, 'interactive-profile'), null, 'leaseless resource must not supply a live epoch');
});

// ── Fix 4: durable permits must not bypass the fence ─────────────────────────

test('S6b Fix 4: durable permit + mutating tool + no proof denies PROFILE_FENCE_REQUIRED', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease } = await setupLiveLease(t);
  assert.ok(lease);
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context: null });
  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(undefined),
    permit: buildSignedDurablePermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'deny', `durable mutating request without proof must deny (got ${r.decision})`);
  assert.equal(r.reason, 'PROFILE_FENCE_REQUIRED');
});

test('S6b Fix 4: durable permit + mutating tool + valid issued proof allows', async (t) => {
  const keys = makeKeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context: null });
  const proof = await governor.createFence({
    leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest,
    bindingId: lease.bindingId, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest,
    action: 'browser-write', actionKind: 'click',
  });
  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(proof),
    permit: buildSignedDurablePermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'allow', `durable mutating request with issued proof must allow (got ${r.decision}/${r.reason})`);
});

test('S6b Fix 4: durable permit + invented proof denies PROFILE_FENCE_STALE', async (t) => {
  const keys = makeKeyPair();
  const { governor, proof } = await setupLiveLease(t);
  const runtime = makeFenceRuntime(keys, { governor, fenceMode: 'enforce', context: null });
  const invented = { ...proof, fenceId: 'fence_ffffffffffffffff' };
  const r = await runtime.enforceRequestAsync({
    method: 'browser_navigate', params: navigateParams(invented),
    permit: buildSignedDurablePermit({ keys }), profileId: 'interactive-profile', targetOrigin: 'https://example.test',
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'PROFILE_FENCE_STALE');
});

// ── Fix 2: observe semantics at the verifier layer ───────────────────────────

test('S6b Fix 2: fence decisions are labelled by fenceMode, not the interactive mode', () => {
  const keys = makeKeyPair();
  const context = buildSignedContext({ keys, fenceEpoch: 2 });
  const observeVerifier = new GatewayVerifier({
    publicKey: keys.publicKey, permitStore: new PermitStore(), mode: 'enforce', fenceMode: 'observe',
  });
  const rObserve = observeVerifier.verifyRequest({
    tool: 'browser_navigate', params: navigateParams(undefined),
    permit: buildSignedPermit({ keys }), context,
  });
  assert.equal(rObserve.decision, 'would-deny', `fence-observe must label would-deny (got ${rObserve.decision})`);
  assert.equal(rObserve.reason, 'PROFILE_FENCE_REQUIRED');
  assert.equal(rObserve.fenceLayer, true, 'fence verdicts must carry the fence-layer marker');

  const enforceVerifier = new GatewayVerifier({
    publicKey: keys.publicKey, permitStore: new PermitStore(), mode: 'enforce', fenceMode: 'enforce',
  });
  const rEnforce = enforceVerifier.verifyRequest({
    tool: 'browser_navigate', params: navigateParams(undefined),
    permit: buildSignedPermit({ keys }), context,
  });
  assert.equal(rEnforce.decision, 'deny');
  assert.equal(rEnforce.reason, 'PROFILE_FENCE_REQUIRED');
  assert.equal(rEnforce.fenceLayer, true);
});

test('S6b Fix 2: batch preserves the fence-layer observe label instead of relabelling by interactive mode', () => {
  const keys = makeKeyPair();
  const context = buildSignedContext({ keys, fenceEpoch: 2 });
  const verifier = new GatewayVerifier({
    publicKey: keys.publicKey, permitStore: new PermitStore(), mode: 'enforce', fenceMode: 'observe',
  });
  const r = verifier.verifyBatch({
    tool: 'browser_batch',
    params: { actions: [{ method: 'browser_navigate', params: { url: 'https://example.test/page' } }] },
    permit: buildSignedPermit({ keys, actionClasses: ['browser.navigate', 'browser.batch'] }),
    targetOrigin: 'https://example.test',
    profileId: 'interactive-profile',
    context,
  });
  assert.equal(r.decision, 'would-deny', `fence-observe batch child deny must stay would-deny (got ${r.decision})`);
  assert.equal(r.reason, 'PROFILE_FENCE_REQUIRED');
  assert.equal(r.fenceLayer, true);
});

// ── Fix 2: server-level observe pass-through vs enforce block ────────────────

function makeFakeExtension(port, profileId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const forwarded = [];
  ws.on('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', method: 'extensionReady',
      params: { name: 'fake-s6b-ext', version: '1.0.0', profileId, capabilities: ['navigate'] },
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
  const dir = tmpDir(`a3-s6b-server-${fenceMode}-`);
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
    token: 's6b-token',
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

async function postApi(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s6b-token' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('S6b Fix 2 (server): enforce blocks the unfenced mutating request typed; observe forwards it', async (t) => {
  const enforced = await runFenceModeServer(t, 'enforce');
  drainFenceDivergences();
  const rBlock = await postApi(enforced.port, {
    method: 'browser_navigate', params: { url: 'https://example.test/page' },
    profileId: 'interactive-profile', permit: buildSignedPermit({ keys: enforced.keys }),
  });
  assert.equal(rBlock.status, 403, `enforce must block unfenced mutating request (got ${rBlock.status})`);
  assert.equal(rBlock.body.reason, 'PROFILE_FENCE_REQUIRED');
  assert.equal(enforced.fakeExt.forwarded.length, 0, 'blocked request must never forward');

  const observed = await runFenceModeServer(t, 'observe');
  drainFenceDivergences();
  const rPass = await postApi(observed.port, {
    method: 'browser_navigate', params: { url: 'https://example.test/page' },
    profileId: 'interactive-profile', permit: buildSignedPermit({ keys: observed.keys }),
  });
  assert.equal(observed.fakeExt.forwarded.length, 1, 'observe must forward the same unfenced request instead of blocking');
  assert.equal(rPass.status, 200, `observe must not block the unfenced request (got ${rPass.status})`);
  const diverged = drainFenceDivergences();
  assert.ok(diverged.length >= 1, 'observe must log fence divergence for the passed-through request');
  assert.ok(diverged.some((d) => d.reason === 'PROFILE_FENCE_REQUIRED'));
});
