import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';
import { PROFILE_ERROR_CODES, ProfileGovernorError } from '../../profile-governor/errors.mjs';
import { createLocalGovernorServer } from '../../profile-governor/ipc-server.mjs';
import { GovernorRepository } from '../../profile-governor/repository.mjs';

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
  await assert.rejects(governor.acquire(makeRequest()), (error) => error.code === 'PROFILE_EXTERNAL_USE');
  assert.doesNotMatch(readFileSync(governor.repository.statePath, 'utf8'), /fenceSecret|claimToken|account|credential/i);
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

test('package closure remains an explicit blocker because package files omit profile-governor', () => {
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.files.some((entry) => entry === 'profile-governor/' || entry.startsWith('profile-governor/')), false);
});
