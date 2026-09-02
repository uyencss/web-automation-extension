import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';
import { PROFILE_ERROR_CODES, ProfileGovernorError } from '../../profile-governor/errors.mjs';
import { createLocalGovernorServer } from '../../profile-governor/ipc-server.mjs';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { validateLeaseRequest, computeLeaseBindingDigest } from '../../profile-governor/contracts.mjs';
import { validateRedactedEvent } from '../../profile-governor/events.mjs';
import { buildRecoveryReceipt, computeReceiptDigest, validateRecoveryReceipt } from '../../profile-governor/recovery.mjs';

const DIGEST_A = 'sha256:' + 'a'.repeat(64);
const CLAIM_A = 'sha256:' + 'b'.repeat(64);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeRequest(overrides = {}) {
  return {
    schema: 'webmcp-profile-lease-request/1',
    requestId: 'plr_core-request-01',
    ownerType: 'automation',
    nodeId: 'node-test-1',
    runId: 'run_core111x',
    runnerClaimDigest: CLAIM_A,
    bindingId: 'pb_test-profile',
    bindingRevision: 1,
    bindingDigest: DIGEST_A,
    profileAlias: 'test-profile',
    leaseMode: 'single-context',
    requestedActions: ['browser-read'],
    heartbeatIntervalMs: 1000,
    leaseTtlMs: 5000,
    idempotencyKey: 'claim-core-1',
    ...overrides,
  };
}

function makeGovernor({ aliases = { 'test-profile': 'prsc_test_resource' }, current = {}, registryActions = ['browser-read', 'browser-write'], claimActions = ['browser-read', 'browser-write'], claimControl = { active: true }, liveness = async () => ({
  governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true,
}), recoveryAuthorizer, revokeGrants = async () => true, clock = () => Date.now(), cooldownMs = 0 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-'));
  const repository = new GovernorRepository({ statePath: path.join(dir, 'state.json') });
  const registry = {
    async resolve(profileAlias) {
      const currentBinding = current[profileAlias] || {};
      return {
        physicalResourceId: aliases[profileAlias],
        bindingId: currentBinding.bindingId || 'pb_test-profile',
        bindingRevision: currentBinding.bindingRevision ?? 1,
        bindingDigest: currentBinding.bindingDigest || DIGEST_A,
        allowedActions: registryActions,
      };
    },
  };
  const claims = {
    async validate(request) {
      return {
        valid: true,
        active: claimControl.active,
        runId: request.runId,
        nodeId: request.nodeId,
        runnerClaimDigest: request.runnerClaimDigest,
        bindingId: request.bindingId,
        bindingRevision: request.bindingRevision,
        bindingDigest: request.bindingDigest,
        allowedActions: claimActions,
      };
    },
  };
  return new ProfileGovernor({ repository, registry, claims, liveness, recoveryAuthorizer, revokeGrants, clock, cooldownMs, maxTabs: 2 });
}

test('core validates the request strictly and returns stable PROFILE errors', async () => {
  const governor = makeGovernor();
  await assert.rejects(
    governor.acquire({ ...makeRequest(), unexpected: true }),
    (error) => error instanceof ProfileGovernorError && error.code === 'PROFILE_REQUEST_INVALID',
  );
  await assert.rejects(
    governor.acquire(makeRequest({ leaseTtlMs: 1 })),
    (error) => error.code === 'PROFILE_REQUEST_INVALID',
  );
  await assert.rejects(governor.acquire(makeRequest({ requestedActions: undefined })), (error) => error.code === 'PROFILE_REQUEST_INVALID');
  for (const code of ['PROFILE_GOVERNOR_STATE_INVALID', 'PROFILE_GOVERNOR_MULTI_WRITER', 'PROFILE_GOVERNOR_UNAVAILABLE', 'PROFILE_ACTION_DENIED', 'PROFILE_AUTH_REQUIRED', 'PROFILE_CHALLENGE_REQUIRED', 'PROFILE_RATE_LIMITED', 'PROFILE_OUTWARD_EFFECT_INDETERMINATE']) assert.ok(PROFILE_ERROR_CODES.includes(code), code);
});

test('request contract permits frozen-schema optional actions while acquire requires an explicit action scope', async () => {
  const schemaValid = validateLeaseRequest(makeRequest({ requestedActions: undefined }));
  assert.equal(Object.hasOwn(schemaValid, 'requestedActions'), false);
  assert.throws(
    () => validateLeaseRequest(makeRequest({ requestedActions: undefined }), { requireRequestedActions: true }),
    (error) => error.code === 'PROFILE_REQUEST_INVALID' && /required for acquire/.test(error.message),
  );
  const governor = makeGovernor();
  await assert.rejects(governor.acquire(makeRequest({ requestedActions: undefined })), (error) => error.code === 'PROFILE_REQUEST_INVALID');
});

test('automation acquire is blocked until reconciliation and authoritative claim/binding checks pass', async () => {
  const governor = makeGovernor();
  await assert.rejects(governor.acquire(makeRequest()), (error) => ['PROFILE_GOVERNOR_NOT_READY', 'PROFILE_LIVENESS_UNKNOWN'].includes(error.code));
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  assert.equal(lease.state, 'leased');
  assert.match(lease.leaseBindingDigest, /^sha256:[0-9a-f]{64}$/);

  const stale = makeGovernor({ current: { 'test-profile': { bindingRevision: 2, bindingDigest: 'sha256:' + 'c'.repeat(64) } } });
  await stale.reconcileProfile('test-profile');
  await assert.rejects(stale.acquire(makeRequest()), (error) => error.code === 'PROFILE_BINDING_STALE');
});

test('idempotent reacquire is exact and the safe projection redacts private state', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  const first = await governor.acquire(makeRequest());
  const second = await governor.acquire(makeRequest());
  assert.deepEqual(second, first);
  const text = JSON.stringify(first);
  assert.doesNotMatch(text, /prsc_test_resource|fenceSecret|physicalResourceId|claim token/i);
  await assert.rejects(
    governor.acquire(makeRequest({ requestedActions: ['browser-write'] })),
    (error) => error.code === 'PROFILE_LEASE_CONFLICT',
  );
});

test('local seam is dependency-injected and does not create a network listener', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  const server = createLocalGovernorServer({
    service: governor,
    authenticate: (capability) => capability?.kind === 'operator',
  });
  const started = await server.start();
  assert.equal(started.networkListener, false);
  assert.equal(started.transport, 'dependency-injected-local');
  await assert.rejects(server.call('reconcileProfile', 'test-profile'), (error) => error.code === 'PROFILE_IPC_AUTH');
  await assert.rejects(server.call('acquire', makeRequest()), (error) => error.code === 'PROFILE_IPC_AUTH');
  const externalRequest = makeRequest({ ownerType: 'external', requestId: 'plr_external-01', idempotencyKey: 'external-1' });
  await assert.rejects(server.call('acquire', externalRequest), (error) => error.code === 'PROFILE_IPC_AUTH');
  const external = await server.call('acquire', externalRequest, { capability: { kind: 'operator' } });
  assert.equal(external.ownerType, 'external');
  for (const method of ['getResourceProjection', 'listEvents', 'listRecoveryReceipts']) {
    const args = method === 'getResourceProjection' ? { profileAlias: 'test-profile' } : {};
    await assert.rejects(server.call(method, args), (error) => error.code === 'PROFILE_IPC_AUTH');
  }
  assert.equal((await server.call('getResourceProjection', { profileAlias: 'test-profile' }, { capability: { kind: 'operator' } })).state, 'external_use');
  assert.ok(Array.isArray(await server.call('listEvents', {}, { capability: { kind: 'operator' } })));
  assert.deepEqual(await server.call('listRecoveryReceipts', {}, { capability: { kind: 'operator' } }), []);
  await assert.rejects(server.call('listEvents', { extra: true }, { capability: { kind: 'operator' } }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
  await assert.rejects(governor.acquire(makeRequest()), (error) => error.code === 'PROFILE_EXTERNAL_USE');
  assert.doesNotMatch(readFileSync(governor.repository.statePath, 'utf8'), /fenceSecret|claimToken|account|credential/i);
});

test('all lease, tab, fence, action, and transition operations reject unknown fields', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  const leaseFacts = { leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest };
  await assert.rejects(governor.heartbeat({ ...leaseFacts, extra: true }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
  await assert.rejects(governor.release({ ...leaseFacts, extra: true }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
  await assert.rejects(governor.openTab({ leaseId: lease.leaseId, runId: lease.runId, extra: true }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
  const fenceInput = { ...leaseFacts, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' };
  await assert.rejects(governor.createFence({ ...fenceInput, extra: true }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
  const fence = await governor.createFence(fenceInput);
  await assert.rejects(governor.authorizeFence({ ...fence, extra: true }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
  const actionFacts = { ...leaseFacts, fenceId: fence.fenceId, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, actionId: 'act_closed-1', outcome: 'prepared' };
  await assert.rejects(governor.recordAction({ ...actionFacts, extra: true }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
  await assert.rejects(governor.recordAction({ ...actionFacts, resolution: { kind: 'trusted-revocation', secret: 'no' } }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
  const transitionInput = { ...leaseFacts, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, to: 'auth_required', reasonCode: 'PROFILE_AUTH_REQUIRED' };
  await assert.rejects(governor.transition({ ...transitionInput, extra: true }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
});

test('openTab revalidates Registry, Runner claim, expiry, state, and composite liveness', async () => {
  const current = { 'test-profile': {} };
  const claimControl = { active: true };
  let live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true };
  let now = Date.now();
  const governor = makeGovernor({ current, claimControl, liveness: async () => live, clock: () => now });
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  current['test-profile'].bindingRevision = 2;
  await assert.rejects(governor.openTab({ leaseId: lease.leaseId, runId: lease.runId }), (error) => error.code === 'PROFILE_BINDING_STALE');

  const changedClaim = { active: true };
  const claimGovernor = makeGovernor({ claimControl: changedClaim });
  await claimGovernor.reconcileProfile('test-profile');
  const claimLease = await claimGovernor.acquire(makeRequest());
  changedClaim.active = false;
  await assert.rejects(claimGovernor.openTab({ leaseId: claimLease.leaseId, runId: claimLease.runId }), (error) => error.code === 'PROFILE_CLAIM_INVALID');

  const livenessGovernor = makeGovernor({ liveness: async () => live });
  live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true };
  await livenessGovernor.reconcileProfile('test-profile');
  const liveLease = await livenessGovernor.acquire(makeRequest());
  live = { ...live, browserAlive: true, extensionConnected: false };
  await assert.rejects(livenessGovernor.openTab({ leaseId: liveLease.leaseId, runId: liveLease.runId }), (error) => error.code === 'PROFILE_EXTERNAL_USE');

  const expiryGovernor = makeGovernor({ clock: () => now });
  await expiryGovernor.reconcileProfile('test-profile');
  const expiring = await expiryGovernor.acquire(makeRequest());
  now = Date.parse(expiring.expiresAt) + 1;
  await assert.rejects(expiryGovernor.openTab({ leaseId: expiring.leaseId, runId: expiring.runId }), (error) => error.code === 'PROFILE_LEASE_EXPIRED');
});

test('heartbeat revalidates Registry binding and release still reaches revocation after claim loss', async () => {
  const current = { 'test-profile': {} };
  let revokeCalls = 0;
  const claimControl = { active: true };
  const governor = makeGovernor({ current, claimControl, revokeGrants: async () => { revokeCalls += 1; return true; } });
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  current['test-profile'].bindingRevision = 2;
  await assert.rejects(governor.heartbeat({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest }), (error) => error.code === 'PROFILE_BINDING_STALE');
  current['test-profile'].bindingRevision = 1;
  claimControl.active = false;
  const currentLease = governor.repository.read().leases[lease.leaseId];
  await assert.rejects(governor.release({ leaseId: lease.leaseId, fenceEpoch: currentLease.fenceEpoch, leaseBindingDigest: currentLease.leaseBindingDigest }), (error) => error.code === 'PROFILE_CLAIM_INVALID');
  assert.equal(revokeCalls, 2);
});

test('cooldown remains unavailable until cooldownUntil', async () => {
  let now = 1000000;
  const governor = makeGovernor({ clock: () => now, cooldownMs: 1000 });
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  await governor.release({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest });
  assert.equal((await governor.reconcileProfile('test-profile')).state, 'cooldown');
  await assert.rejects(governor.acquire(makeRequest({ requestId: 'plr_core-request-02', idempotencyKey: 'claim-core-2' })), (error) => error.code === 'PROFILE_GOVERNOR_NOT_READY');
  now += 1001;
  assert.equal((await governor.reconcileProfile('test-profile')).state, 'ready');
});

test('acquire requires the intersection of authoritative Registry and Runner claim action scopes', async () => {
  const governor = makeGovernor({ registryActions: ['browser-read', 'browser-write'], claimActions: ['browser-read'] });
  await governor.reconcileProfile('test-profile');
  await assert.rejects(
    governor.acquire(makeRequest({ requestedActions: ['browser-write'] })),
    (error) => error.code === 'PROFILE_ACTION_DENIED',
  );
});

test('failed liveness never transitions to ready or permits acquisition', async () => {
  const governor = makeGovernor({ liveness: async () => ({ governor: 'healthy', registry: 'failed', runnerClaim: 'active', browserAlive: false, extensionConnected: false }) });
  const projection = await governor.reconcileProfile('test-profile');
  assert.equal(projection.state, 'unknown');
  await assert.rejects(governor.acquire(makeRequest()), (error) => ['PROFILE_GOVERNOR_NOT_READY', 'PROFILE_LIVENESS_UNKNOWN'].includes(error.code));
});

test('auth, challenge, and rate lifecycle gates return canonical typed errors', async () => {
  for (const [probe, code] of [['auth_required', 'PROFILE_AUTH_REQUIRED'], ['challenge', 'PROFILE_CHALLENGE_REQUIRED'], ['rate_limited', 'PROFILE_RATE_LIMITED']]) {
    const governor = makeGovernor({ liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true, registry: probe }) });
    await governor.reconcileProfile('test-profile');
    await assert.rejects(governor.acquire(makeRequest()), (error) => error.code === code);
  }
  let registrySignal = 'healthy';
  const activeGovernor = makeGovernor({ liveness: async () => ({ governor: 'healthy', registry: registrySignal, runnerClaim: 'active', browserAlive: true, extensionConnected: true }) });
  await activeGovernor.reconcileProfile('test-profile');
  const lease = await activeGovernor.acquire(makeRequest());
  registrySignal = 'auth_required';
  await assert.rejects(activeGovernor.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' }), (error) => error.code === 'PROFILE_AUTH_REQUIRED');
  assert.equal((await activeGovernor.getResourceProjection('test-profile')).state, 'auth_required');
});

test('composite liveness requires browser and extension and establishes a barrier', async () => {
  const governor = makeGovernor({ liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: false, extensionConnected: false }) });
  assert.equal((await governor.reconcileProfile('test-profile')).state, 'unknown');
  await assert.rejects(governor.acquire(makeRequest()), (error) => ['PROFILE_GOVERNOR_NOT_READY', 'PROFILE_LIVENESS_UNKNOWN'].includes(error.code));
  assert.equal((await governor.getResourceProjection('test-profile')).state, 'unknown');
});

test('claim loss and grant-revocation failure invalidate active state and issued fences', async () => {
  const claimControl = { active: true };
  let revokeCalls = 0;
  const governor = makeGovernor({ claimControl, revokeGrants: async () => { revokeCalls += 1; return true; } });
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  const fence = await governor.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  await governor.authorizeFence(fence);
  claimControl.active = false;
  await assert.rejects(governor.authorizeFence(fence), (error) => error.code === 'PROFILE_CLAIM_INVALID');
  assert.equal(revokeCalls, 1);
  assert.notEqual((await governor.getResourceProjection('test-profile')).state, 'active');
  await assert.rejects(governor.authorizeFence(fence), (error) => error.code === 'PROFILE_FENCE_STALE' || error.code === 'PROFILE_GOVERNOR_NOT_READY');

  const failed = makeGovernor({ revokeGrants: async () => false });
  await failed.reconcileProfile('test-profile');
  const failedLease = await failed.acquire(makeRequest());
  const failedFence = await failed.createFence({ leaseId: failedLease.leaseId, fenceEpoch: failedLease.fenceEpoch, leaseBindingDigest: failedLease.leaseBindingDigest, runId: failedLease.runId, bindingId: failedLease.bindingId, action: 'browser-read' });
  await assert.rejects(failed.release({ leaseId: failedLease.leaseId, fenceEpoch: failedLease.fenceEpoch, leaseBindingDigest: failedLease.leaseBindingDigest }), (error) => error.code === 'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED');
  assert.notEqual((await failed.getResourceProjection('test-profile')).state, 'active');
  await assert.rejects(failed.authorizeFence(failedFence), (error) => error.code === 'PROFILE_FENCE_STALE' || error.code === 'PROFILE_GOVERNOR_NOT_READY');
});

test('release quarantines unresolved dispatched effects and never makes them ready', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  const fence = await governor.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  await governor.authorizeFence(fence);
  const facts = { leaseId: lease.leaseId, fenceId: fence.fenceId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest };
  await governor.recordAction({ ...facts, actionId: 'act_release-1', outcome: 'prepared' });
  await governor.recordAction({ ...facts, actionId: 'act_release-1', outcome: 'dispatched' });
  await assert.rejects(governor.release({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest }), (error) => error.code === 'PROFILE_OUTWARD_EFFECT_INDETERMINATE');
  assert.equal((await governor.reconcileProfile('test-profile')).state, 'quarantined');
  await assert.rejects(governor.acquire(makeRequest({ requestId: 'plr_core-release-2', idempotencyKey: 'release-retry-2', runId: 'run_release222' })), (error) => error.code === 'PROFILE_QUARANTINED');
});

test('corrupt persisted resource state is rejected before any grant', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  await governor.acquire(makeRequest());
  const statePath = governor.repository.statePath;
  governor.close();
  const raw = JSON.parse(readFileSync(statePath, 'utf8'));
  raw.resources.prsc_test_resource.fenceEpoch = -1;
  writeFileSync(statePath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
  const corrupted = new GovernorRepository({ statePath });
  assert.throws(() => corrupted.read(), (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID');
  corrupted.close();
});

test('journal mutations require current binding/run/fence facts and ordered outcomes', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  const fence = await governor.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  await governor.authorizeFence(fence);
  const facts = { leaseId: lease.leaseId, fenceId: fence.fenceId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, actionId: 'act_cas-1' };
  await assert.rejects(governor.recordAction({ ...facts, outcome: 'confirmed' }), (error) => error.code === 'PROFILE_TRANSITION_INVALID');
  await assert.rejects(governor.recordAction({ ...facts, bindingId: 'pb_other-profile', outcome: 'prepared' }), (error) => error.code === 'PROFILE_BINDING_STALE');
  await assert.rejects(governor.recordAction({ ...facts, runId: 'run_other999', outcome: 'prepared' }), (error) => error.code === 'PROFILE_CLAIM_INVALID');
});

test('authenticated local transition persists canonical lifecycle state', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  const server = createLocalGovernorServer({ service: governor, authenticate: (capability) => capability?.kind === 'operator' });
  const input = { leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, to: 'auth_required', reasonCode: 'PROFILE_AUTH_REQUIRED' };
  await assert.rejects(server.call('transition', input), (error) => error.code === 'PROFILE_IPC_AUTH');
  const result = await server.call('transition', input, { capability: { kind: 'operator' } });
  assert.equal(result.state, 'auth_required');
  assert.equal(result.stateReasonCode, 'PROFILE_AUTH_REQUIRED');
});

test('package closure includes profile-governor for distribution', () => {
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.files.some((entry) => entry === 'profile-governor/' || entry.startsWith('profile-governor/')), true);
});

test('adversarial time: caller supplying earlier timestamp cannot keep an expired lease alive', async () => {
  let clockTime = 1000000;
  const governor = makeGovernor({ clock: () => clockTime });
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest({ leaseTtlMs: 5000 }));
  assert.equal(lease.state, 'leased');

  // Advance governor trusted clock past expiry
  clockTime = 1010000;

  // Attacker attempts to pass a past timestamp (now = 1002000, which is before initial expiresAt)
  await assert.rejects(
    governor.heartbeat({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      now: 1002000,
    }),
    (error) => error.code === 'PROFILE_LEASE_EXPIRED',
  );

  // Attacker attempts to pass renew with now = 0
  await assert.rejects(
    governor.renew({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      now: 0,
    }),
    (error) => error.code === 'PROFILE_LEASE_EXPIRED',
  );

  // Resource must require reconciliation and not be ready or leased
  const projection = await governor.getResourceProjection('test-profile');
  assert.notEqual(projection.state, 'ready');
  assert.notEqual(projection.state, 'leased');
  assert.equal(projection.needsReconciliation, true);
});

test('adversarial time: caller supplying future timestamp cannot extend lease or spoof expiry', async () => {
  let clockTime = 1000000;
  const governor = makeGovernor({ clock: () => clockTime });
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest({ leaseTtlMs: 5000 }));
  assert.equal(lease.state, 'leased');

  // Attacker attempts to pass a future timestamp (now = 999999999) to extend lease
  const renewed = await governor.heartbeat({
    leaseId: lease.leaseId,
    fenceEpoch: lease.fenceEpoch,
    leaseBindingDigest: lease.leaseBindingDigest,
    now: 999999999,
  });

  // Lease expiry must be bounded by governor trusted clock (1000000 + 5000), NOT caller's 999999999
  assert.equal(Date.parse(renewed.expiresAt), 1000000 + 5000);

  // When trusted clock advances past the real expiry (1006000), renewal must fail
  clockTime = 1006000;
  await assert.rejects(
    governor.heartbeat({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      now: 999999999,
    }),
    (error) => error.code === 'PROFILE_LEASE_EXPIRED',
  );
});

test('adversarial time: time advancing during async checks is re-read at final mutation boundary', async () => {
  let clockTime = 1000000;
  let advanceOnProbe = false;
  const governor = makeGovernor({
    clock: () => clockTime,
    liveness: async () => {
      if (advanceOnProbe) {
        // Simulate time passing during async liveness check past TTL
        clockTime = 1006000;
      }
      return { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true };
    },
  });
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest({ leaseTtlMs: 5000 }));

  // Heartbeat starts with clockTime = 1000000, but during async liveness probe clock advances to 1006000
  advanceOnProbe = true;
  await assert.rejects(
    governor.heartbeat({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
    }),
    (error) => error.code === 'PROFILE_LEASE_EXPIRED',
  );
});

test('adversarial time: release mutation rereads trusted clock after async grant revocation', async () => {
  let clockTime = 1000000;
  const governor = makeGovernor({
    clock: () => clockTime,
    revokeGrants: async () => {
      // Clock advances during async grant revocation
      clockTime = 1000500;
      return true;
    },
  });
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  const releaseResult = await governor.release({
    leaseId: lease.leaseId,
    fenceEpoch: lease.fenceEpoch,
    leaseBindingDigest: lease.leaseBindingDigest,
  });
  assert.equal(releaseResult.released, true);
  const state = governor.repository.read();
  const currentLease = state.leases[lease.leaseId];
  assert.equal(Date.parse(currentLease.releasedAt), 1000500);
});

test('semantically truthful reason codes: no HEARTBEAT_OK on acquire or fence activation', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());

  // Acquire for automation should not invent a fake HEARTBEAT_OK reason or event
  const stateAfterAcquire = governor.repository.read();
  const resourceAfterAcquire = stateAfterAcquire.resources.prsc_test_resource;
  assert.equal(resourceAfterAcquire.stateReasonCode, undefined);
  assert.ok(!stateAfterAcquire.events.some((e) => e.stateReasonCode === 'HEARTBEAT_OK'));

  // Fence creation (transitioning leased -> active) should not emit HEARTBEAT_OK
  const fence = await governor.createFence({
    leaseId: lease.leaseId,
    fenceEpoch: lease.fenceEpoch,
    leaseBindingDigest: lease.leaseBindingDigest,
    runId: lease.runId,
    bindingId: lease.bindingId,
    action: 'browser-read',
  });
  assert.ok(fence);
  const stateAfterFence = governor.repository.read();
  const resourceAfterFence = stateAfterFence.resources.prsc_test_resource;
  assert.equal(resourceAfterFence.state, 'active');
  assert.equal(resourceAfterFence.stateReasonCode, undefined);
  assert.ok(!stateAfterFence.events.some((e) => e.stateReasonCode === 'HEARTBEAT_OK'));

  // validateRedactedEvent must reject HEARTBEAT_OK if no heartbeat occurred
  assert.throws(
    () => validateRedactedEvent({
      schema: 'https://webmcp.org/schemas/v1/profile-session-event.json',
      eventId: 'evt_0123456789abcdef',
      leaseId: lease.leaseId,
      profileAlias: 'test-profile',
      state: 'active',
      stateReasonCode: 'HEARTBEAT_OK',
      fenceEpoch: 1,
      bindingDigest: lease.bindingDigest,
      timestamp: new Date().toISOString(),
      counts: { actions: 1 },
    }),
    (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID',
  );

  // Heartbeat does truthfully emit HEARTBEAT_OK
  await governor.heartbeat({
    leaseId: lease.leaseId,
    fenceEpoch: lease.fenceEpoch,
    leaseBindingDigest: lease.leaseBindingDigest,
    bindingId: lease.bindingId,
    bindingDigest: lease.bindingDigest,
    runId: lease.runId,
    runnerClaimDigest: lease.runnerClaimDigest,
  });
  const stateAfterHb = governor.repository.read();
  const hbEvent = stateAfterHb.events.find((e) => e.stateReasonCode === 'HEARTBEAT_OK');
  assert.ok(hbEvent);
  assert.equal(hbEvent.counts?.heartbeats, 1);
});

test('hardening: lease binding digest binds profile alias and resource identity; wrong alias/profile rejected', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  // digest must include profileAlias - different alias gives different digest
  const same = computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: 'prsc_test_resource', fenceEpoch: lease.fenceEpoch, profileAlias: 'test-profile' });
  const diff = computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: 'prsc_test_resource', fenceEpoch: lease.fenceEpoch, profileAlias: 'evil-profile' });
  assert.notEqual(same, diff);
  assert.equal(lease.leaseBindingDigest, same);
  // repository rejects lease with mismatched alias
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-alias-'));
  const repoPath = path.join(dir, 'state.json');
  const repo = new GovernorRepository({ statePath: repoPath });
  const g2 = new ProfileGovernor({ repository: repo, registry: { resolve: async () => ({ physicalResourceId: 'prsc_test_resource', bindingId: 'pb_test-profile', bindingRevision: 1, bindingDigest: DIGEST_A, allowedActions: ['browser-read'] }) }, claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read'], ...req }) }, liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }) });
  await g2.reconcileProfile('test-profile');
  await g2.acquire(makeRequest());
  g2.close();
  repo.close();
  // tamper resource aliases to not include lease profileAlias - should be rejected on read
  const raw = JSON.parse(readFileSync(repoPath, 'utf8'));
  raw.resources.prsc_test_resource.aliases = ['other-alias'];
  writeFileSync(repoPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
  const badRepo = new GovernorRepository({ statePath: repoPath });
  assert.throws(() => badRepo.read(), (e) => e.code === 'PROFILE_GOVERNOR_STATE_INVALID');
  badRepo.close();
});

test('hardening: receipt digest covers authorityKind and createdAt; tampering changes digest', () => {
  const base = buildRecoveryReceipt({
    leaseId: 'lease_deadbeef01234567', profileAlias: 'test-profile', bindingId: 'pb_test-profile', bindingRevision: 1, bindingDigest: DIGEST_A, runId: 'run_core111x', priorState: 'active', newState: 'quarantined', priorFenceEpoch: 1, newFenceEpoch: 2, reasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', probeOutcomes: { governorHealth: 'unknown', runnerClaim: 'unknown', browserAlive: false, extensionConnected: false }, lastActionOutcome: 'indeterminate', dependentGrantRevokeStatus: 'revoked', authorityKind: 'governor-automatic', createdAt: '2026-08-28T00:00:00.000Z',
  });
  const tamperedKind = { ...base, authorityKind: 'operator-approved' };
  tamperedKind.receiptDigest = base.receiptDigest;
  assert.throws(() => validateRecoveryReceipt(tamperedKind), (e) => e.code === 'PROFILE_GOVERNOR_STATE_INVALID');
  const tamperedTime = { ...base, createdAt: '2026-08-28T00:01:00.000Z' };
  tamperedTime.receiptDigest = base.receiptDigest;
  assert.throws(() => validateRecoveryReceipt(tamperedTime), (e) => e.code === 'PROFILE_GOVERNOR_STATE_INVALID');
  const goodDigest = computeReceiptDigest(base);
  assert.equal(goodDigest, base.receiptDigest);
  const diffDigest = computeReceiptDigest({ ...base, authorityKind: 'operator-approved' });
  assert.notEqual(goodDigest, diffDigest);
});

test('hardening: hostile unknown field names are not reflected in error output', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  const evilField = '__proto__';
  const lease = await governor.acquire(makeRequest());
  const facts = { leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest };
  try {
    await governor.heartbeat({ ...facts, [evilField]: 'x' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'PROFILE_REQUEST_INVALID');
    assert.ok(!String(e.message).includes(evilField), 'error message must not reflect attacker field');
    if (e.details) assert.ok(!JSON.stringify(e.details).includes(evilField), 'details must not reflect attacker field');
  }
  try {
    await governor.acquire({ ...makeRequest(), [evilField]: 'x', extraSecretPath: '/etc/passwd' });
    assert.fail();
  } catch (e) {
    assert.equal(e.code, 'PROFILE_REQUEST_INVALID');
    assert.ok(!e.message.includes(evilField));
    assert.ok(!e.message.includes('/etc/passwd'));
  }
});

test('hardening: duplicate event ID and duplicate digest pair are rejected (replay)', async () => {
  const governor = makeGovernor();
  await governor.reconcileProfile('test-profile');
  const lease = await governor.acquire(makeRequest());
  const state = governor.repository.read();
  const dupEvent = { ...state.events[0] };
  // try to append duplicate via transact
  assert.throws(() => governor.repository.transact((s) => { s.events.push(dupEvent); s.eventIntegrityDigests.push(s.eventIntegrityDigests[0]); }), (e) => e.code === 'PROFILE_GOVERNOR_STATE_INVALID');
  // also duplicate digest with different eventId
  const other = { ...state.events[0], eventId: 'pse_aaaaaaaaaaaaaaaa' };
  assert.throws(() => governor.repository.transact((s) => { s.events.push(other); s.eventIntegrityDigests.push(s.eventIntegrityDigests[0]); }), (e) => e.code === 'PROFILE_GOVERNOR_STATE_INVALID');
});

test('hardening: legacy state without eventIntegrityDigests fails closed and remains recoverable', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-legacy-'));
  const statePath = path.join(dir, 'state.json');
  const repo = new GovernorRepository({ statePath });
  repo.transact((s) => { s.resources['prsc_legacy'] = { physicalResourceId: 'prsc_legacy', profileAlias: 'legacy-profile', aliases: ['legacy-profile'], state: 'unknown', fenceEpoch: 0, currentLeaseId: null, needsReconciliation: true, livenessSummary: 'unknown', cooldownUntil: null }; });
  repo.close();
  const raw = JSON.parse(readFileSync(statePath, 'utf8'));
  delete raw.eventIntegrityDigests;
  raw.schema = 'webmcp-profile-session-governor-state/1';
  writeFileSync(statePath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
  const legacyRepo = new GovernorRepository({ statePath });
  assert.throws(() => legacyRepo.read(), (e) => e.code === 'PROFILE_GOVERNOR_STATE_INVALID' && /legacy/.test(e.message.toLowerCase()));
  legacyRepo.close();
  // recoverable by removing legacy file (operator-approved reset)
  unlinkSync(statePath);
  const fresh = new GovernorRepository({ statePath });
  assert.equal(fresh.read().events.length, 0);
  assert.equal(fresh.read().schema, 'webmcp-profile-session-governor-state/1');
  fresh.close();
});
