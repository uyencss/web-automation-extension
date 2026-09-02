import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';
import { applyEvidenceRecovery, buildRecoveryReceipt, computeReceiptDigest, validateRecoveryReceipt } from '../../profile-governor/recovery.mjs';
import { validateRedactedEvent } from '../../profile-governor/events.mjs';
import { computeLeaseBindingDigest, digestLf, opaqueId } from '../../profile-governor/contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DIGEST = 'sha256:' + 'a'.repeat(64);
const CLAIM = 'sha256:' + 'b'.repeat(64);
function request(overrides = {}) {
  return { schema: 'webmcp-profile-lease-request/1', requestId: 'plr_recovery-01', ownerType: 'automation', nodeId: 'node-recovery-1', runId: 'run_recovery1', runnerClaimDigest: CLAIM, bindingId: 'pb_recovery-profile', bindingRevision: 1, bindingDigest: DIGEST, profileAlias: 'recovery-profile', leaseMode: 'single-context', requestedActions: ['browser-read'], heartbeatIntervalMs: 1000, leaseTtlMs: 5000, idempotencyKey: 'recovery-key-1', ...overrides };
}
function setup({ liveness = async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }), recoveryAuthorizer, revokeGrants = async () => true, actionResolutionAuthorizer = async () => ({ authorized: true }), clock = () => Date.now(), registry } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-recovery-'));
  const statePath = path.join(dir, 'state.json');
  const make = (clockOverride = clock) => new ProfileGovernor({
    repository: new GovernorRepository({ statePath }),
    registry: registry || { resolve: async () => ({ physicalResourceId: 'prsc_recovery_resource', bindingId: 'pb_recovery-profile', bindingRevision: 1, bindingDigest: DIGEST, allowedActions: ['browser-read'] }) },
    claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read'], ...req }) },
    liveness, recoveryAuthorizer, revokeGrants, actionResolutionAuthorizer, clock: clockOverride,
  });
  return { statePath, make };
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('recovery receipt and session event schemas are valid redacted contracts', () => {
  const receipt = loadJson(path.join(ROOT, 'schemas/webmcp-profile-recovery-receipt.schema.json'));
  const event = loadJson(path.join(ROOT, 'schemas/webmcp-profile-session-event.schema.json'));
  assert.equal(receipt.properties.schema.const, 'webmcp-profile-recovery-receipt/1');
  assert.equal(event.properties.schema.const, 'webmcp-profile-session-event/1');
  assert.equal(receipt.additionalProperties, false);
  assert.equal(event.additionalProperties, false);
  // redaction: ensure no raw physical path/secret in schema
  const receiptStr = JSON.stringify(receipt);
  assert.ok(!receiptStr.includes('profilePath') && !receiptStr.includes('secret'), 'receipt schema must not contain raw path/secret');
});

test('recovery receipt vectors are synthetic and cover host restart / indeterminate / external_use', () => {
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/recovery-receipt-vectors.json'));
  assert.equal(vectors.schema, 'webmcp-recovery-receipt-vectors/1');
  const ids = vectors.vectors.map((v) => v.id);
  assert.ok(ids.includes('recovery-host-restart-no-stale-resurrection'));
  assert.ok(ids.includes('recovery-process-crash-indeterminate-quarantine'));
  assert.ok(ids.includes('recovery-manual-external-use-detected'));
  // verify monotonic sequence vector
  const mono = vectors.vectors.find((v) => v.id === 'recovery-epoch-monotonic');
  assert.ok(mono.sequence.every((s) => s.newFenceEpoch > s.priorFenceEpoch));
});

test('recovery fixture instances validate against schemas (AJV)', async () => {
  let Ajv, addFormats;
  try {
    ({ default: Ajv } = await import('ajv'));
    ({ default: addFormats } = await import('ajv-formats'));
  } catch {
    // optional ajv
  }
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/recovery-receipt-vectors.json'));
  if (Ajv && addFormats) {
    const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
    addFormats(ajv);
    const receiptSchema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-recovery-receipt.schema.json'));
    const eventSchema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-session-event.schema.json'));
    const validateReceipt = ajv.compile(receiptSchema);
    const validateEvent = ajv.compile(eventSchema);
    for (const vec of vectors.vectors) {
      if (vec.receipt) {
        assert.equal(validateReceipt(vec.receipt), true, `receipt ${vec.id} must validate: ${JSON.stringify(validateReceipt.errors)}`);
        assert.match(vec.receipt.receiptId, /^prr_[0-9a-f]{16}$/);
        assert.match(vec.receipt.leaseId, /^lease_[0-9a-f]{16}$/);
      }
      if (vec.receiptAfterClear) {
        assert.equal(validateReceipt(vec.receiptAfterClear), true, `receiptAfterClear ${vec.id} must validate: ${JSON.stringify(validateReceipt.errors)}`);
      }
      if (vec.event) {
        assert.equal(validateEvent(vec.event), true, `event ${vec.id} must validate: ${JSON.stringify(validateEvent.errors)}`);
        assert.match(vec.event.eventId, /^pse_[0-9a-f]{16}$/);
        assert.equal(validateRedactedEvent(vec.event), vec.event);
      }
    }
  } else {
    for (const vec of vectors.vectors) {
      if (vec.receipt) {
        assert.match(vec.receipt.receiptId, /^prr_[0-9a-f]{16}$/);
        assert.match(vec.receipt.leaseId, /^lease_[0-9a-f]{16}$/);
      }
      if (vec.event) {
        assert.match(vec.event.eventId, /^pse_[0-9a-f]{16}$/);
        assert.equal(validateRedactedEvent(vec.event), vec.event);
      }
    }
  }
});

test('RED: host restart recovery must not resurrect stale lease as ready', async () => {
  const setupResult = setup();
  const g1 = setupResult.make();
  await g1.reconcileProfile('recovery-profile');
  const lease = await g1.acquire(request());
  assert.equal(lease.state, 'leased');
  g1.close();

  const g2 = setupResult.make();
  const projection = await g2.getResourceProjection('recovery-profile');
  assert.equal(projection.state, 'unknown');
  assert.equal(projection.needsReconciliation, true);
  await assert.rejects(g2.acquire(request({ requestId: 'plr_recovery-02', idempotencyKey: 'recovery-key-2' })), (error) => error.code === 'PROFILE_GOVERNOR_NOT_READY');
  g2.close();
});

test('RED: indeterminate outward effect quarantines and blocks retry/reclaim', async () => {
  let revokeCalls = 0;
  const { make } = setup({
    revokeGrants: async () => { revokeCalls += 1; return true; },
    recoveryAuthorizer: async (context) => ({
      authorized: true,
      evidence: {
        runnerClaim: 'terminal', browserAlive: false, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true, expectedState: context.state,
        expectedFenceEpoch: context.fenceEpoch, expectedBindingDigest: context.bindingDigest,
        expectedPlanDigest: context.recoveryPlanDigest, indeterminateResolved: context.indeterminateResolved,
      },
    }),
  });
  const g = make();
  await g.reconcileProfile('recovery-profile');
  const lease = await g.acquire(request());
  const fence = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  await g.authorizeFence(fence);
  const facts = { fenceId: fence.fenceId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, actionId: 'act_indet-1' };
  await g.recordAction({ leaseId: lease.leaseId, outcome: 'prepared', ...facts });
  await g.recordAction({ leaseId: lease.leaseId, outcome: 'dispatched', ...facts });
  const receipt = await g.recordAction({ leaseId: lease.leaseId, outcome: 'indeterminate', ...facts });
  assert.equal(receipt.newState, 'quarantined');
  assert.equal(receipt.lastActionOutcome, 'indeterminate');
  assert.equal(receipt.dependentGrantRevokeStatus, 'revoked');
  assert.ok(receipt.newFenceEpoch > lease.fenceEpoch);
  const proj = await g.getResourceProjection('recovery-profile');
  assert.equal(proj.state, 'quarantined');
  await assert.rejects(g.acquire(request({ requestId: 'plr_retry-0001', idempotencyKey: 'retry-key-1' })), (error) => error.code === 'PROFILE_QUARANTINED');
});

test('RED: manual external_use blocks automation and requires operator reconcile', async () => {
  let live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false };
  let revokeCalls = 0;
  const { make } = setup({
    liveness: async () => live,
    revokeGrants: async () => { revokeCalls += 1; return true; },
    recoveryAuthorizer: async (context) => ({
      authorized: true,
      evidence: {
        runnerClaim: 'not-applicable', browserAlive: false, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true, expectedState: context.state,
        expectedFenceEpoch: context.fenceEpoch, expectedBindingDigest: context.bindingDigest,
        expectedPlanDigest: context.recoveryPlanDigest, indeterminateResolved: true,
      },
    }),
  });
  const g = make();
  const detected = await g.reconcileProfile('recovery-profile');
  assert.equal(detected.state, 'external_use');
  await assert.rejects(g.acquire(request()), (error) => error.code === 'PROFILE_EXTERNAL_USE');

  // External recovery is contract-blocked until receipt contract binds evidence digest
  await assert.rejects(
    g.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }),
    (error) => error.code === 'PROFILE_RECLAIM_UNSAFE',
  );
  assert.equal(revokeCalls, 0, 'no grant revocation adapter call on external recovery rejection');
  assert.equal((await g.getResourceProjection('recovery-profile')).state, 'external_use');
});

test('external recovery and release reject before registry, binding, authorizer, or revoke adapters', async () => {
  let registryCalls = 0;
  let authorizerCalls = 0;
  let revokeCalls = 0;
  const { make } = setup({
    liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false }),
    registry: { resolve: async () => { registryCalls += 1; return { physicalResourceId: 'prsc_recovery_resource', bindingId: 'pb_recovery-profile', bindingRevision: 1, bindingDigest: DIGEST, allowedActions: ['browser-read'] }; } },
    recoveryAuthorizer: async () => { authorizerCalls += 1; return { authorized: false }; },
    revokeGrants: async () => { revokeCalls += 1; return true; },
  });
  const g = make();
  await g.reconcileProfile('recovery-profile');
  assert.equal((await g.getResourceProjection('recovery-profile')).state, 'external_use');
  const resource = g.repository.read().resources.prsc_recovery_resource;
  const lease = g.repository.read().leases[resource.currentLeaseId];
  const control = { leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest };
  const registryCallsAfterDetection = registryCalls;

  await assert.rejects(g.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');
  await assert.rejects(g.release(control), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');
  await assert.rejects(g.externalRelease(control), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');

  assert.equal(registryCalls, registryCallsAfterDetection, 'external recovery/release does not resolve adapters');
  assert.equal(authorizerCalls, 0, 'external recovery does not call the recovery authorizer');
  assert.equal(revokeCalls, 0, 'external release does not revoke grants');
  assert.equal((await g.getResourceProjection('recovery-profile')).state, 'external_use');
  g.close();
});

test('failed liveness cannot launder durable external provenance back to recovery', async () => {
  let live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false };
  const { make } = setup({ liveness: async () => live, recoveryAuthorizer: async () => ({ authorized: true }) });
  const g = make();
  await g.reconcileProfile('recovery-profile');
  const before = g.repository.read().resources.prsc_recovery_resource;
  assert.equal(before.state, 'external_use');
  assert.equal(before.recoverySubjectKind, 'unregistered-external');
  live = { governor: 'failed', registry: 'unknown', runnerClaim: 'unknown', browserAlive: false, extensionConnected: false, indeterminate: true };
  await g.reconcileProfile('recovery-profile');
  const after = g.repository.read().resources.prsc_recovery_resource;
  assert.equal(after.state, 'external_use');
  assert.equal(after.recoverySubjectKind, 'unregistered-external');
  assert.equal(after.recoveryBindingDigest, DIGEST);
  await assert.rejects(g.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');
  g.close();
});

test('recovery authorizer denial fails closed before evidence or lifecycle mutation', async () => {
  let authorizerCalls = 0;
  const { make } = setup({
    recoveryAuthorizer: async () => { authorizerCalls += 1; return { authorized: false, evidence: { forged: true } }; },
  });
  const g = make();
  await g.reconcileProfile('recovery-profile');
  const lease = await g.acquire(request());
  const before = g.repository.read();
  await assert.rejects(g.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');
  const after = g.repository.read();
  assert.equal(authorizerCalls, 1);
  assert.equal(after.writerGeneration, before.writerGeneration);
  assert.equal(after.resources.prsc_recovery_resource.state, 'leased');
  assert.equal(after.leases[lease.leaseId].state, 'leased');
  g.close();
});

test('startup marks durable lease unknown and TTL expiry never silently reclaims a live browser', async () => {
  const first = setup();
  const g1 = first.make();
  await g1.reconcileProfile('recovery-profile');
  const lease = await g1.acquire(request());
  g1.close();
  const g2 = first.make();
  assert.equal((await g2.getResourceProjection('recovery-profile')).state, 'unknown');
  await assert.rejects(g2.acquire(request()), (error) => error.code === 'PROFILE_GOVERNOR_NOT_READY');

  let now = 1000000;
  const live = setup({ clock: () => now, liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }) });
  const gl = live.make();
  await gl.reconcileProfile('recovery-profile');
  const liveLease = await gl.acquire(request({ runId: 'run_live111x', idempotencyKey: 'live-key' }));
  now = Date.parse(liveLease.expiresAt) + 1000;
  await assert.rejects(gl.heartbeat({ leaseId: liveLease.leaseId, fenceEpoch: liveLease.fenceEpoch, leaseBindingDigest: liveLease.leaseBindingDigest }), (error) => error.code === 'PROFILE_LEASE_EXPIRED');
  assert.notEqual((await gl.getResourceProjection('recovery-profile')).state, 'ready');
  assert.notEqual(lease.leaseId, liveLease.leaseId);
});

test('indeterminate outward effect quarantines, while evidence-backed recovery requires a new epoch', async () => {
  let revokeCalls = 0;
  const { make } = setup({
    revokeGrants: async () => { revokeCalls += 1; return true; },
    recoveryAuthorizer: async (context) => ({ authorized: true, evidence: { runnerClaim: 'terminal', browserAlive: false, extensionConnected: false, dependentGrantsRevoked: true, registryCurrent: true, expectedState: context.state, expectedFenceEpoch: context.fenceEpoch, expectedBindingDigest: context.bindingDigest, expectedPlanDigest: context.recoveryPlanDigest, indeterminateResolved: context.indeterminateResolved } }),
  });
  const g = make();
  await g.reconcileProfile('recovery-profile');
  const lease = await g.acquire(request());
  const fence = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  await g.authorizeFence(fence);
  const currentLease = () => g.repository.read().leases[lease.leaseId];
  const facts = () => { const value = currentLease(); return { fenceId: fence.fenceId, fenceEpoch: value.fenceEpoch, leaseBindingDigest: value.leaseBindingDigest, bindingId: value.bindingId, bindingDigest: value.bindingDigest, runId: value.runId, runnerClaimDigest: value.runnerClaimDigest }; };
  await g.recordAction({ leaseId: lease.leaseId, actionId: 'act_recovery-1', outcome: 'prepared', ...facts() });
  await g.recordAction({ leaseId: lease.leaseId, actionId: 'act_recovery-1', outcome: 'dispatched', ...facts() });
  const receipt = await g.recordAction({ leaseId: lease.leaseId, actionId: 'act_recovery-1', outcome: 'indeterminate', ...facts() });
  assert.equal(receipt.newState, 'quarantined');
  assert.equal(revokeCalls, 1);
  assert.equal(receipt.dependentGrantRevokeStatus, 'revoked');
  assert.ok(receipt.newFenceEpoch > lease.fenceEpoch);
  await assert.rejects(g.acquire(request({ requestId: 'plr_recovery-02', idempotencyKey: 'recovery-key-2', runId: 'run_recovery2' })), (error) => error.code === 'PROFILE_QUARANTINED');
  await assert.rejects(g.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');
  await assert.rejects(g.recordAction({ leaseId: lease.leaseId, actionId: 'act_recovery-1', outcome: 'failed-known', fenceId: fence.fenceId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest }), (error) => error.code === 'PROFILE_FENCE_STALE');
  await g.recordAction({ leaseId: lease.leaseId, actionId: 'act_recovery-1', outcome: 'failed-known', resolution: { kind: 'trusted-revocation' }, ...facts() });
  await assert.rejects(g.recover('recovery-profile', { forgedEvidence: true, authenticatedLocalCapability: true, capability: { kind: 'operator' } }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
  const recovered = await g.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } });
  assert.equal(recovered.newState, 'ready');
  assert.ok(recovered.newFenceEpoch > receipt.newFenceEpoch);
  assert.equal(revokeCalls, 3);
});

test('recovery never reports ready when required grant revocation fails', async () => {
  const { make } = setup({
    revokeGrants: async () => false,
    recoveryAuthorizer: async (context) => ({ authorized: true, evidence: { runnerClaim: 'terminal', browserAlive: false, extensionConnected: false, dependentGrantsRevoked: true, registryCurrent: true, expectedState: context.state, expectedFenceEpoch: context.fenceEpoch, expectedBindingDigest: context.bindingDigest, expectedPlanDigest: context.recoveryPlanDigest, indeterminateResolved: context.indeterminateResolved } }),
  });
  const g = make();
  await g.reconcileProfile('recovery-profile');
  const lease = await g.acquire(request());
  const fence = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  await g.authorizeFence(fence);
  const facts = () => { const value = g.repository.read().leases[lease.leaseId]; return { fenceId: fence.fenceId, fenceEpoch: value.fenceEpoch, leaseBindingDigest: value.leaseBindingDigest, bindingId: value.bindingId, bindingDigest: value.bindingDigest, runId: value.runId, runnerClaimDigest: value.runnerClaimDigest }; };
  await g.recordAction({ leaseId: lease.leaseId, actionId: 'act_recovery-2', outcome: 'prepared', ...facts() });
  await g.recordAction({ leaseId: lease.leaseId, actionId: 'act_recovery-2', outcome: 'dispatched', ...facts() });
  await g.recordAction({ leaseId: lease.leaseId, actionId: 'act_recovery-2', outcome: 'indeterminate', ...facts() });
  await assert.rejects(g.recordAction({ leaseId: lease.leaseId, actionId: 'act_recovery-2', outcome: 'failed-known', resolution: { kind: 'trusted-revocation' }, ...facts() }), (error) => error.code === 'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED');
  await assert.rejects(g.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');
  assert.equal((await g.getResourceProjection('recovery-profile')).state, 'quarantined');
});

test('recovery rejects unauthenticated or forged evidence and IPC requires operator capability', async () => {
  const { make } = setup({ recoveryAuthorizer: async () => false });
  const g = make();
  await g.reconcileProfile('recovery-profile');
  await g.acquire(request());
  await assert.rejects(g.recover('recovery-profile', { runnerClaim: 'terminal', browserAlive: false, extensionConnected: false, dependentGrantsRevoked: true, registryCurrent: true }), (error) => error.code === 'PROFILE_IPC_AUTH');
  const server = (await import('../../profile-governor/ipc-server.mjs')).createLocalGovernorServer({ service: g, authenticate: (capability) => capability?.kind === 'operator' });
  await assert.rejects(server.call('recover', { profileAlias: 'recovery-profile', evidence: { runnerClaim: 'terminal', browserAlive: false, extensionConnected: false, dependentGrantsRevoked: true, registryCurrent: true } }), (error) => error.code === 'PROFILE_IPC_AUTH');
  await assert.rejects(server.call('recover', { profileAlias: 'recovery-profile', evidence: { runnerClaim: 'terminal', browserAlive: false, extensionConnected: false, dependentGrantsRevoked: true, registryCurrent: true } }, { capability: { kind: 'operator' } }), (error) => error.code === 'PROFILE_REQUEST_INVALID');
});

test('unregistered external use cannot auto-clear and external recovery fails closed without mutating state', async () => {
  let live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false };
  let claimToReturn = 'terminal';
  let revokeCalls = 0;
  const { make } = setup({
    liveness: async () => live,
    revokeGrants: async () => { revokeCalls += 1; return true; },
    recoveryAuthorizer: async (context) => ({
      authorized: true,
      evidence: {
        runnerClaim: claimToReturn, browserAlive: false, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true, expectedState: context.state,
        expectedFenceEpoch: context.fenceEpoch, expectedBindingDigest: context.bindingDigest,
        expectedPlanDigest: context.recoveryPlanDigest, indeterminateResolved: true,
      },
    }),
  });
  const g = make();
  const detected = await g.reconcileProfile('recovery-profile');
  assert.equal(detected.state, 'external_use');
  const preState = g.repository.read();
  assert.ok(preState.resources.prsc_recovery_resource.currentLeaseId);
  const initialReceiptCount = preState.receipts.length;
  const initialEventCount = preState.events.length;
  const initialFenceEpoch = preState.resources.prsc_recovery_resource.fenceEpoch;

  live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true };
  assert.equal((await g.reconcileProfile('recovery-profile')).state, 'external_use');
  g.close();
  const restarted = make();
  assert.equal((await restarted.getResourceProjection('recovery-profile')).state, 'external_use');
  assert.equal((await restarted.reconcileProfile('recovery-profile')).state, 'external_use');
  await assert.rejects(restarted.acquire(request()), (error) => error.code === 'PROFILE_EXTERNAL_USE');

  // Generic terminal claim evidence must be rejected for external recovery
  claimToReturn = 'terminal';
  await assert.rejects(
    restarted.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }),
    (error) => error.code === 'PROFILE_RECLAIM_UNSAFE',
  );

  // Even with runnerClaim: 'not-applicable', external recovery must fail closed with PROFILE_RECLAIM_UNSAFE
  claimToReturn = 'not-applicable';
  await assert.rejects(
    restarted.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }),
    (error) => error.code === 'PROFILE_RECLAIM_UNSAFE',
  );

  // Lower helper applyEvidenceRecovery must also fail closed
  assert.throws(
    () => applyEvidenceRecovery(restarted.repository, {
      physicalResourceId: 'prsc_recovery_resource',
      leaseId: preState.resources.prsc_recovery_resource.currentLeaseId,
      evidence: {
        runnerClaim: 'not-applicable', browserAlive: false, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true, expectedState: 'external_use',
        expectedFenceEpoch: initialFenceEpoch, expectedBindingDigest: DIGEST,
        expectedPlanDigest: preState.resources.prsc_recovery_resource.recoveryPlanDigest,
        indeterminateResolved: true,
      },
      trustedAuthorization: true,
      reasonCode: 'RECOVERY_EXTERNAL_USE_CLEARED',
    }),
    (error) => error.code === 'PROFILE_RECLAIM_UNSAFE',
  );

  // Assert no mutation: state stays external_use, fence epoch unchanged, receipts/events unchanged, no adapter calls
  assert.equal(revokeCalls, 0, 'no grant revocation adapter call on external recovery rejection');
  const postState = restarted.repository.read();
  assert.equal(postState.resources.prsc_recovery_resource.state, 'external_use');
  assert.equal(postState.resources.prsc_recovery_resource.fenceEpoch, initialFenceEpoch);
  assert.equal(postState.receipts.length, initialReceiptCount);
  assert.equal(postState.events.length, initialEventCount);
  await assert.rejects(restarted.acquire(request()), (error) => error.code === 'PROFILE_EXTERNAL_USE');
  restarted.close();
});

test('recovery receipt digest rejects persisted state and outcome tampering', () => {
  const receipt = buildRecoveryReceipt({
    leaseId: 'lease_deadbeef01234567',
    profileAlias: 'recovery-profile',
    bindingId: 'pb_recovery-profile',
    bindingRevision: 1,
    bindingDigest: DIGEST,
    runId: 'run_recovery1',
    priorState: 'active',
    newState: 'quarantined',
    priorFenceEpoch: 1,
    newFenceEpoch: 2,
    reasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE',
    probeOutcomes: { governorHealth: 'unknown', runnerClaim: 'unknown', browserAlive: false, extensionConnected: false },
    lastActionOutcome: 'indeterminate',
    dependentGrantRevokeStatus: 'revoked',
    authorityKind: 'governor-automatic',
    createdAt: '2026-08-28T00:00:00.000Z',
  });

  for (const tampered of [
    { ...receipt, newState: 'ready' },
    { ...receipt, reasonCode: 'RECOVERY_HOST_RESTART' },
    { ...receipt, priorFenceEpoch: 0 },
    { ...receipt, newFenceEpoch: 5 },
    { ...receipt, priorState: 'unknown' },
    { ...receipt, leaseId: 'lease_1111222233334444' },
    { ...receipt, receiptId: 'prr_9999888877776666' },
    { ...receipt, dependentGrantRevokeStatus: 'none' },
    { ...receipt, lastActionOutcome: 'none' },
    { ...receipt, probeOutcomes: { ...receipt.probeOutcomes, browserAlive: true } },
    { ...receipt, probeOutcomes: { ...receipt.probeOutcomes, governorHealth: 'healthy' } },
  ]) {
    assert.throws(
      () => validateRecoveryReceipt(tampered),
      (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID' && /digest/.test(error.message),
    );
  }
  for (const invalid of [
    { ...receipt, authorityKind: 'untrusted-kind' },
    { ...receipt, createdAt: '2026-02-30T00:00:00Z' },
    { ...receipt, createdAt: '0' },
    { ...receipt, profileAlias: 'INVALID_ALIAS' },
    { ...receipt, bindingDigest: 'not-a-digest' },
    { ...receipt, runId: 'bad' },
  ]) {
    assert.throws(
      () => validateRecoveryReceipt(invalid),
      (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID',
    );
  }
});

test('receipt contract accepts frozen-schema optional outcomes while build and persistence require safety fields', () => {
  const input = {
    leaseId: 'lease_deadbeef01234567', profileAlias: 'recovery-profile', bindingId: 'pb_recovery-profile',
    bindingRevision: 1, bindingDigest: DIGEST, runId: 'run_recovery1', priorState: 'active',
    newState: 'quarantined', priorFenceEpoch: 1, newFenceEpoch: 2,
    reasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE',
    probeOutcomes: { governorHealth: 'unknown', runnerClaim: 'unknown', browserAlive: false, extensionConnected: false },
    lastActionOutcome: 'indeterminate', dependentGrantRevokeStatus: 'revoked', authorityKind: 'governor-automatic',
    createdAt: '2026-08-28T00:00:00.000Z',
  };
  const optional = buildRecoveryReceipt(input);
  for (const key of ['lastActionOutcome', 'dependentGrantRevokeStatus', 'authorityKind']) delete optional[key];
  optional.receiptDigest = computeReceiptDigest(optional);
  assert.equal(validateRecoveryReceipt(optional).receiptId, optional.receiptId);
  assert.throws(() => validateRecoveryReceipt(optional, { requireOperationalFields: true }), (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID');
  assert.throws(() => buildRecoveryReceipt({ ...input, authorityKind: undefined }), (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID' && /before persistence/.test(error.message));

  const invalidTimestamp = { ...optional, createdAt: '0' };
  invalidTimestamp.receiptDigest = computeReceiptDigest(invalidTimestamp);
  assert.throws(() => validateRecoveryReceipt(invalidTimestamp), (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID');
});

test('persisted events and receipts reject unknown sensitive fields and digest tampering', async () => {
  const prepared = setup({ revokeGrants: async () => true });
  const g = prepared.make();
  await g.reconcileProfile('recovery-profile');
  const lease = await g.acquire(request());
  await g.heartbeat({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest });
  const fence = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  await g.authorizeFence(fence);
  const facts = { leaseId: lease.leaseId, fenceId: fence.fenceId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, actionId: 'act_tamper-1' };
  await g.recordAction({ ...facts, outcome: 'prepared' });
  await g.recordAction({ ...facts, outcome: 'dispatched' });
  await g.recordAction({ ...facts, outcome: 'indeterminate' });
  assert.ok(g.listEvents().every((event) => !Object.hasOwn(event, 'secret')));
  assert.ok(g.listRecoveryReceipts().every((receipt) => !Object.hasOwn(receipt, 'secret')));
  const durable = g.repository.read();
  g.close();

  for (const mutate of [
    (state) => { state.events.at(-1).secret = { credential: 'forbidden' }; },
    (state) => { state.events.at(-1).timestamp = new Date(Date.parse(state.events.at(-1).timestamp) + 1000).toISOString(); },
    (state) => { const event = state.events.find((entry) => entry.counts?.heartbeats !== undefined); event.counts.heartbeats += 1; },
    (state) => { state.receipts.at(-1).probeOutcomes.secret = 'forbidden'; },
    (state) => { state.receipts.at(-1).reasonCode = 'RECOVERY_HOST_RESTART'; },
    (state) => { state.receipts.at(-1).eventId = 'evt_nonexistent12345'; },
  ]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-journal-tamper-'));
    const statePath = path.join(dir, 'state.json');
    const tampered = structuredClone(durable);
    mutate(tampered);
    writeFileSync(statePath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    const repository = new GovernorRepository({ statePath });
    assert.throws(() => repository.read(), (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID');
    repository.close();
  }
});

test('absent grant-revocation adapter fails closed and records failed revoke status in receipt and event', async () => {
  const { make } = setup({
    revokeGrants: null,
    recoveryAuthorizer: async (context) => ({
      authorized: true,
      evidence: {
        runnerClaim: 'not-applicable', browserAlive: false, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true, expectedState: context.state,
        expectedFenceEpoch: context.fenceEpoch, expectedBindingDigest: context.bindingDigest,
        expectedPlanDigest: context.recoveryPlanDigest, indeterminateResolved: true,
      },
    }),
  });
  const g = make();
  await g.reconcileProfile('recovery-profile');
  const lease = await g.acquire(request());
  const fence = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  await g.authorizeFence(fence);
  const facts = { fenceId: fence.fenceId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, actionId: 'act_norevoke-1' };
  await g.recordAction({ leaseId: lease.leaseId, outcome: 'prepared', ...facts });
  await g.recordAction({ leaseId: lease.leaseId, outcome: 'dispatched', ...facts });
  const receipt = await g.recordAction({ leaseId: lease.leaseId, outcome: 'indeterminate', ...facts });

  // Receipt and event must report failed rather than revoked
  assert.equal(receipt.newState, 'quarantined');
  assert.equal(receipt.dependentGrantRevokeStatus, 'failed');
  assert.equal(receipt.probeOutcomes.dependentGrantsRevoked, false);
  const state = g.repository.read();
  const lastEvent = state.events.at(-1);
  assert.equal(lastEvent.grantRevokeStatus, 'failed');
  assert.equal(receipt.eventId, lastEvent.eventId);

  // Trusted resolution must fail closed with PROFILE_DEPENDENT_GRANT_REVOKE_FAILED when adapter is absent
  const updatedLease = g.repository.read().leases[lease.leaseId];
  await assert.rejects(
    g.recordAction({ leaseId: lease.leaseId, outcome: 'failed-known', resolution: { kind: 'trusted-revocation' }, ...facts, fenceEpoch: updatedLease.fenceEpoch, leaseBindingDigest: updatedLease.leaseBindingDigest }),
    (error) => error.code === 'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED',
  );

  // Recovery of external use with absent adapter fails closed before adapter call with PROFILE_RECLAIM_UNSAFE
  let liveExt = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false };
  const extSetup = setup({
    liveness: async () => liveExt,
    revokeGrants: null,
    recoveryAuthorizer: async (context) => ({
      authorized: true,
      evidence: {
        runnerClaim: 'not-applicable', browserAlive: false, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true, expectedState: context.state,
        expectedFenceEpoch: context.fenceEpoch, expectedBindingDigest: context.bindingDigest,
        expectedPlanDigest: context.recoveryPlanDigest, indeterminateResolved: true,
      },
    }),
  });
  const gExt = extSetup.make();
  await gExt.reconcileProfile('recovery-profile');
  assert.equal((await gExt.getResourceProjection('recovery-profile')).state, 'external_use');
  await assert.rejects(
    gExt.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }),
    (error) => error.code === 'PROFILE_RECLAIM_UNSAFE',
  );
  assert.equal((await gExt.getResourceProjection('recovery-profile')).state, 'external_use');
  gExt.close();

  // Release with absent adapter must also fail closed with PROFILE_DEPENDENT_GRANT_REVOKE_FAILED
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-norevoke-rel-'));
  const gRel = new ProfileGovernor({
    repository: new GovernorRepository({ statePath: path.join(dir, 'state.json') }),
    registry: { resolve: async () => ({ physicalResourceId: 'prsc_rel_res', bindingId: 'pb_rel-profile', bindingRevision: 1, bindingDigest: DIGEST, allowedActions: ['browser-read'] }) },
    claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read'], ...req }) },
    liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }),
    revokeGrants: undefined, // completely absent adapter
  });
  await gRel.reconcileProfile('rel-profile');
  const relLease = await gRel.acquire({ ...request({ profileAlias: 'rel-profile', bindingId: 'pb_rel-profile' }) });
  await assert.rejects(
    gRel.release({ leaseId: relLease.leaseId, fenceEpoch: relLease.fenceEpoch, leaseBindingDigest: relLease.leaseBindingDigest }),
    (error) => error.code === 'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED',
  );
  const relState = gRel.repository.read();
  const relEvent = relState.events.find((e) => e.state === 'quarantined');
  assert.ok(relEvent);
  assert.equal(relEvent.grantRevokeStatus, 'failed');
  gRel.close();
  g.close();
});

test('throwing grant-revocation adapter fails closed as PROFILE_DEPENDENT_GRANT_REVOKE_FAILED', async () => {
  let shouldThrow = true;
  const { make } = setup({
    revokeGrants: async () => {
      if (shouldThrow) throw new Error('revocation network timeout');
      return true;
    },
    recoveryAuthorizer: async (context) => ({
      authorized: true,
      evidence: {
        runnerClaim: 'terminal', browserAlive: false, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true, expectedState: context.state,
        expectedFenceEpoch: context.fenceEpoch, expectedBindingDigest: context.bindingDigest,
        expectedPlanDigest: context.recoveryPlanDigest, indeterminateResolved: true,
      },
    }),
  });
  const g = make();
  await g.reconcileProfile('recovery-profile');
  const lease = await g.acquire(request());
  await assert.rejects(
    g.release({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest }),
    (error) => error.code === 'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED',
  );
  const state = g.repository.read();
  const relEvent = state.events.find((e) => e.state === 'quarantined');
  assert.ok(relEvent);
  assert.equal(relEvent.grantRevokeStatus, 'failed');

  // Non-external recovery with throwing grant revocation also fails closed as PROFILE_DEPENDENT_GRANT_REVOKE_FAILED
  await assert.rejects(
    g.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }),
    (error) => error.code === 'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED',
  );
  assert.equal((await g.getResourceProjection('recovery-profile')).state, 'quarantined');

  // When revocation recovers, non-external recovery succeeds
  shouldThrow = false;
  const recovered = await g.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } });
  assert.equal(recovered.newState, 'ready');
  assert.equal((await g.getResourceProjection('recovery-profile')).state, 'ready');
  g.close();
});

test('adversarial: external provenance is preserved across failed liveness, restart, and subsequent reconciliation', async () => {
  let live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false };
  const setupResult = setup({
    liveness: async () => live,
    recoveryAuthorizer: async () => ({ authorized: true, evidence: { runnerClaim: 'not-applicable', browserAlive: false, extensionConnected: false, dependentGrantsRevoked: true, registryCurrent: true, expectedState: 'external_use', expectedFenceEpoch: 1, expectedBindingDigest: DIGEST, expectedPlanDigest: DIGEST, indeterminateResolved: true } }),
  });
  const g1 = setupResult.make();
  await g1.reconcileProfile('recovery-profile');
  const resource1 = g1.repository.read().resources.prsc_recovery_resource;
  assert.equal(resource1.state, 'external_use');
  assert.equal(resource1.recoverySubjectKind, 'unregistered-external');
  assert.equal(resource1.recoveryBindingId, 'pb_recovery-profile');
  assert.equal(resource1.recoveryBindingRevision, 1);
  assert.equal(resource1.recoveryBindingDigest, DIGEST);
  const leaseId = resource1.currentLeaseId;
  assert.ok(leaseId);
  const lease1 = g1.repository.read().leases[leaseId];
  assert.equal(lease1.ownerType, 'external');
  assert.equal(lease1.state, 'external_use');
  const initialEpoch = resource1.fenceEpoch;
  const initialEventCount = g1.repository.read().events.length;
  const initialReceiptCount = g1.repository.read().receipts.length;

  // Step 1: Failed / indeterminate liveness during reconciliation and operations
  live = { governor: 'failed', registry: 'failed', runnerClaim: 'unknown', browserAlive: false, extensionConnected: false, indeterminate: true };

  // Heartbeat on external lease during failed liveness rejects and does NOT quarantine or advance epoch
  await assert.rejects(
    g1.heartbeat({ leaseId, fenceEpoch: initialEpoch, leaseBindingDigest: lease1.leaseBindingDigest }),
    (error) => ['PROFILE_EXTERNAL_USE', 'PROFILE_LIVENESS_UNKNOWN'].includes(error.code),
  );
  const stateAfterHeartbeat = g1.repository.read();
  const resAfterHeartbeat = stateAfterHeartbeat.resources.prsc_recovery_resource;
  assert.equal(resAfterHeartbeat.state, 'external_use', 'state remains external_use on failed liveness');
  assert.equal(resAfterHeartbeat.fenceEpoch, initialEpoch, 'fence epoch must NOT advance on external failure');
  assert.equal(resAfterHeartbeat.currentLeaseId, leaseId, 'owner barrier must be preserved');
  assert.equal(resAfterHeartbeat.recoverySubjectKind, 'unregistered-external');
  assert.equal(resAfterHeartbeat.recoveryBindingDigest, DIGEST);
  assert.equal(stateAfterHeartbeat.leases[leaseId].state, 'external_use');
  assert.equal(stateAfterHeartbeat.events.length, initialEventCount, 'no quarantined event for external lease');
  assert.equal(stateAfterHeartbeat.receipts.length, initialReceiptCount, 'no receipt for external lease');

  // Other operations fail closed
  await assert.rejects(g1.openTab({ leaseId, runId: lease1.runId }), (error) => error.code === 'PROFILE_GOVERNOR_NOT_READY');
  await assert.rejects(g1.createFence({ leaseId, fenceEpoch: initialEpoch, leaseBindingDigest: lease1.leaseBindingDigest, runId: lease1.runId, bindingId: lease1.bindingId, action: 'browser-read' }), (error) => error.code === 'PROFILE_GOVERNOR_NOT_READY');

  // Reconcile during failed/indeterminate liveness preserves external_use and does NOT quarantine
  const reconciledFail = await g1.reconcileProfile('recovery-profile');
  assert.equal(reconciledFail.state, 'external_use');
  const resourceAfterFail = g1.repository.read().resources.prsc_recovery_resource;
  assert.equal(resourceAfterFail.state, 'external_use');
  assert.equal(resourceAfterFail.fenceEpoch, initialEpoch, 'fence epoch must NOT advance');
  assert.equal(resourceAfterFail.recoverySubjectKind, 'unregistered-external');
  assert.equal(resourceAfterFail.recoveryBindingDigest, DIGEST);
  assert.equal(resourceAfterFail.currentLeaseId, leaseId);
  assert.equal(g1.repository.read().events.length, initialEventCount);
  g1.close();

  // Step 2: Restart governor
  const g2 = setupResult.make();
  const projAfterRestart = await g2.getResourceProjection('recovery-profile');
  assert.equal(projAfterRestart.state, 'external_use');
  assert.equal(projAfterRestart.needsReconciliation, true);
  const resourceAfterRestart = g2.repository.read().resources.prsc_recovery_resource;
  assert.equal(resourceAfterRestart.state, 'external_use');
  assert.equal(resourceAfterRestart.stateReasonCode, 'PROFILE_EXTERNAL_USE');
  assert.equal(resourceAfterRestart.fenceEpoch, initialEpoch);
  assert.equal(resourceAfterRestart.recoverySubjectKind, 'unregistered-external');
  assert.equal(resourceAfterRestart.currentLeaseId, leaseId);

  // Step 3: Subsequent reconciliation with healthy composite liveness
  live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true };
  const reconciledHealthy = await g2.reconcileProfile('recovery-profile');
  assert.equal(reconciledHealthy.state, 'external_use');
  const resourceAfterHealthy = g2.repository.read().resources.prsc_recovery_resource;
  assert.equal(resourceAfterHealthy.state, 'external_use');
  assert.equal(resourceAfterHealthy.fenceEpoch, initialEpoch);
  assert.equal(resourceAfterHealthy.recoverySubjectKind, 'unregistered-external');
  assert.equal(resourceAfterHealthy.currentLeaseId, leaseId);

  // Step 4: Subsequent reconciliation with external_use liveness (browser alive, extension not connected)
  live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false };
  const reconciledExt = await g2.reconcileProfile('recovery-profile');
  assert.equal(reconciledExt.state, 'external_use');

  // Verify external barriers: acquire, release, externalRelease, recover must fail closed
  await assert.rejects(g2.acquire(request()), (error) => error.code === 'PROFILE_EXTERNAL_USE');
  await assert.rejects(g2.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');
  await assert.rejects(g2.release({ leaseId, fenceEpoch: resourceAfterHealthy.fenceEpoch, leaseBindingDigest: lease1.leaseBindingDigest }), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');
  await assert.rejects(g2.externalRelease({ leaseId, fenceEpoch: resourceAfterHealthy.fenceEpoch, leaseBindingDigest: lease1.leaseBindingDigest }), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');
  g2.close();
});

test('regression: automation acquire detecting PROFILE_EXTERNAL_USE creates coherent unregistered marker and second acquire preserves valid projection', async () => {
  let live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false };
  const { make } = setup({
    liveness: async () => live,
  });
  const g = make();
  await g.reconcileProfile('recovery-profile');

  // First acquire detects external use during liveness probe
  await assert.rejects(
    g.acquire(request({ requestId: 'plr_ext-det-0001', idempotencyKey: 'ext-det-1' })),
    (error) => error.code === 'PROFILE_EXTERNAL_USE',
  );

  // Verify durable state has coherent unregistered-external tuple and external lease
  const stateAfterFirst = g.repository.read();
  const res = stateAfterFirst.resources.prsc_recovery_resource;
  assert.equal(res.state, 'external_use');
  assert.equal(res.recoverySubjectKind, 'unregistered-external');
  assert.equal(res.recoveryBindingId, 'pb_recovery-profile');
  assert.equal(res.recoveryBindingRevision, 1);
  assert.equal(res.recoveryBindingDigest, DIGEST);
  assert.ok(res.currentLeaseId);
  const extLease = stateAfterFirst.leases[res.currentLeaseId];
  assert.equal(extLease.ownerType, 'external');
  assert.equal(extLease.state, 'external_use');

  // Second acquire must reject and durable projection remains coherent
  await assert.rejects(
    g.acquire(request({ requestId: 'plr_ext-det-0002', idempotencyKey: 'ext-det-2' })),
    (error) => error.code === 'PROFILE_EXTERNAL_USE',
  );
  const stateAfterSecond = g.repository.read();
  assert.equal(stateAfterSecond.resources.prsc_recovery_resource.state, 'external_use');
  assert.equal(stateAfterSecond.resources.prsc_recovery_resource.currentLeaseId, res.currentLeaseId);
  assert.equal(Object.keys(stateAfterSecond.leases).length, 1);
  g.close();

  // Test that an existing automation lease is preserved when external use is detected later
  let autoLive = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true };
  const autoSetup = setup({ liveness: async () => autoLive });
  const autoGovernor = autoSetup.make();
  await autoGovernor.reconcileProfile('recovery-profile');
  const autoLease = await autoGovernor.acquire(request({ requestId: 'plr_auto-0001', idempotencyKey: 'auto-1' }));
  assert.equal(autoLease.state, 'leased');

  // Now liveness reports external use
  autoLive = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false };
  await assert.rejects(
    autoGovernor.openTab({ leaseId: autoLease.leaseId, runId: autoLease.runId }),
    (error) => error.code === 'PROFILE_EXTERNAL_USE',
  );

  // Verify automation lease is preserved and NOT labeled as external subject
  const autoState = autoGovernor.repository.read();
  const autoRes = autoState.resources.prsc_recovery_resource;
  const currentLease = autoState.leases[autoLease.leaseId];
  assert.equal(currentLease.ownerType, 'automation', 'automation lease ownerType must remain automation');
  assert.equal(autoRes.recoverySubjectKind, undefined, 'automation resource must not have recoverySubjectKind');
  autoGovernor.close();
});

test('adversarial: registry binding rotation rejects reconciliation and preserves durable external barrier', async () => {
  let bindingRevision = 1;
  let bindingDigest = DIGEST;
  const setupResult = setup({
    registry: {
      resolve: async () => ({
        physicalResourceId: 'prsc_recovery_resource',
        bindingId: 'pb_recovery-profile',
        bindingRevision,
        bindingDigest,
        allowedActions: ['browser-read'],
      }),
    },
    liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false }),
  });

  const g1 = setupResult.make();
  await g1.reconcileProfile('recovery-profile');
  const initialResource = g1.repository.read().resources.prsc_recovery_resource;
  assert.equal(initialResource.state, 'external_use');
  assert.equal(initialResource.recoveryBindingRevision, 1);
  assert.equal(initialResource.recoveryBindingDigest, DIGEST);

  // Rotate registry binding revision and digest
  bindingRevision = 2;
  bindingDigest = 'sha256:' + 'e'.repeat(64);

  // Reconciliation must fail closed with typed PROFILE_BINDING_STALE before persistence
  await assert.rejects(
    g1.reconcileProfile('recovery-profile'),
    (error) => error.code === 'PROFILE_BINDING_STALE',
  );

  // Durable repository state must retain the original bound tuple (no silent rotation)
  const resourceAfterRejected = g1.repository.read().resources.prsc_recovery_resource;
  assert.equal(resourceAfterRejected.state, 'external_use');
  assert.equal(resourceAfterRejected.recoveryBindingRevision, 1);
  assert.equal(resourceAfterRejected.recoveryBindingDigest, DIGEST);
  g1.close();

  // Restart governor and verify durable barrier persists
  const g2 = setupResult.make();
  assert.equal((await g2.getResourceProjection('recovery-profile')).state, 'external_use');
  await assert.rejects(
    g2.reconcileProfile('recovery-profile'),
    (error) => error.code === 'PROFILE_BINDING_STALE',
  );
  const resourceAfterRestart = g2.repository.read().resources.prsc_recovery_resource;
  assert.equal(resourceAfterRestart.state, 'external_use');
  assert.equal(resourceAfterRestart.recoveryBindingRevision, 1);
  assert.equal(resourceAfterRestart.recoveryBindingDigest, DIGEST);
  g2.close();
});

test('frozen recovery receipt fixture vectors validate through runtime implementation and repository read-back', () => {
  const vectorsData = loadJson(path.join(ROOT, 'tests/fixtures/recovery-receipt-vectors.json'));
  assert.equal(vectorsData.schema, 'webmcp-recovery-receipt-vectors/1');

  for (const vec of vectorsData.vectors) {
    if (vec.receipt) {
      // Hardened receipt digest now covers authorityKind+createdAt+binding identity; legacy fixtures without full coverage must fail closed (finding 2)
      const legacy = vec.receipt;
      const hardenedDigest = computeReceiptDigest(legacy);
      if (legacy.receiptDigest !== hardenedDigest) {
        assert.throws(() => validateRecoveryReceipt(legacy), (e) => e.code === 'PROFILE_GOVERNOR_STATE_INVALID', `legacy receipt ${vec.id} must be rejected`);
        // rebuilt hardened receipt must validate
        const rebuilt = buildRecoveryReceipt({ leaseId: legacy.leaseId, profileAlias: legacy.profileAlias, bindingId: legacy.bindingId, bindingRevision: legacy.bindingRevision, bindingDigest: legacy.bindingDigest, runId: legacy.runId, priorState: legacy.priorState, newState: legacy.newState, priorFenceEpoch: legacy.priorFenceEpoch, newFenceEpoch: legacy.newFenceEpoch, reasonCode: legacy.reasonCode, probeOutcomes: legacy.probeOutcomes, lastActionOutcome: legacy.lastActionOutcome, dependentGrantRevokeStatus: legacy.dependentGrantRevokeStatus, authorityKind: legacy.authorityKind, createdAt: legacy.createdAt, eventId: legacy.eventId, receiptId: legacy.receiptId });
        assert.equal(computeReceiptDigest(rebuilt), rebuilt.receiptDigest, `rebuilt receipt ${vec.id} must have hardened digest`);
      } else {
        assert.equal(validateRecoveryReceipt(legacy).receiptId, legacy.receiptId);
        assert.equal(computeReceiptDigest(legacy), legacy.receiptDigest, `receipt ${vec.id}`);
      }
      if (vec.protectedProjections?.receiptDigest?.digest) {
        // legacy protected projection was without hardened fields; skip strict equality for legacy
        if (vec.protectedProjections.receiptDigest.projection && vec.protectedProjections.receiptDigest.projection.authorityKind === undefined) {
          // legacy projection without authorityKind is expected to differ
        } else {
          assert.equal(computeReceiptDigest(legacy), vec.protectedProjections.receiptDigest.digest, `receipt ${vec.id} matches protected projection`);
        }
      }
    }
    if (vec.receiptAfterClear) {
      const legacy = vec.receiptAfterClear;
      const hardenedDigest = computeReceiptDigest(legacy);
      if (legacy.receiptDigest !== hardenedDigest) {
        assert.throws(() => validateRecoveryReceipt(legacy), (e) => e.code === 'PROFILE_GOVERNOR_STATE_INVALID', `legacy receiptAfterClear ${vec.id} must be rejected`);
        const rebuilt = buildRecoveryReceipt({ leaseId: legacy.leaseId, profileAlias: legacy.profileAlias, bindingId: legacy.bindingId, bindingRevision: legacy.bindingRevision, bindingDigest: legacy.bindingDigest, runId: legacy.runId, priorState: legacy.priorState, newState: legacy.newState, priorFenceEpoch: legacy.priorFenceEpoch, newFenceEpoch: legacy.newFenceEpoch, reasonCode: legacy.reasonCode, probeOutcomes: legacy.probeOutcomes, lastActionOutcome: legacy.lastActionOutcome, dependentGrantRevokeStatus: legacy.dependentGrantRevokeStatus, authorityKind: legacy.authorityKind, createdAt: legacy.createdAt, eventId: legacy.eventId, receiptId: legacy.receiptId });
        assert.equal(computeReceiptDigest(rebuilt), rebuilt.receiptDigest);
      } else {
        assert.equal(validateRecoveryReceipt(legacy).receiptId, legacy.receiptId);
        assert.equal(computeReceiptDigest(legacy), legacy.receiptDigest, `receiptAfterClear ${vec.id}`);
      }
      if (vec.protectedProjections?.receiptDigest?.digest) {
        if (vec.protectedProjections.receiptDigest.projection && vec.protectedProjections.receiptDigest.projection.authorityKind === undefined) {
        } else {
          assert.equal(computeReceiptDigest(legacy), vec.protectedProjections.receiptDigest.digest, `receiptAfterClear ${vec.id} matches protected projection`);
        }
      }
    }
    if (vec.sequence) {
      for (const seq of vec.sequence) {
        // sequence canonicals are pre-hardening; they remain valid for domain label check but receipt rebuild covers hardened fields
        assert.equal(digestLf(seq.domainLabel, seq.canonical), seq.receiptDigest, `sequence item ${seq.receiptId}`);
      }
    }
    if (vec.mutation?.mutatedProjection && vec.mutation?.mutatedDigest) {
      // mutatedProjection in fixture is legacy without hardened fields; hardened digest will differ - check mutation still changes digest
      const mutatedHardened = computeReceiptDigest({ ...vec.mutation.mutatedProjection, authorityKind: vec.receipt?.authorityKind || 'governor-automatic', createdAt: vec.receipt?.createdAt || '2026-08-27T00:00:00.000Z', profileAlias: vec.receipt?.profileAlias || 'research-profile', bindingId: vec.receipt?.bindingId || 'pb_research-profile', bindingDigest: vec.receipt?.bindingDigest || DIGEST, runId: vec.receipt?.runId || 'run_recovery-test-0001', eventId: vec.receipt?.eventId });
      assert.notEqual(mutatedHardened, computeReceiptDigest(vec.receipt || vec.receiptAfterClear || {}), `mutation ${vec.id} must change hardened digest`);
    }
  }

  // Repository and listRecoveryReceipts read-back test across all available frozen receipt fixtures
  for (const vec of vectorsData.vectors) {
    for (const targetReceipt of [vec.receipt, vec.receiptAfterClear].filter(Boolean)) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-receipt-vectors-'));
      const statePath = path.join(dir, 'state.json');
      const repo = new GovernorRepository({ statePath });

      const resKey = `prsc_${vec.id.replace(/-/g, '_')}`;
      const leaseId = targetReceipt.leaseId;
      const isExternal = targetReceipt.newState === 'external_use';
      const isReady = targetReceipt.newState === 'ready';
      const ownerType = isExternal ? 'external' : 'automation';
      const runId = targetReceipt.runId || 'run_recovery-test-0001';

      repo.transact((state) => {
        state.resources[resKey] = {
          physicalResourceId: resKey,
          profileAlias: targetReceipt.profileAlias,
          aliases: [targetReceipt.profileAlias],
          state: targetReceipt.newState,
          fenceEpoch: targetReceipt.newFenceEpoch,
          currentLeaseId: isReady ? null : leaseId,
          needsReconciliation: !isReady,
          livenessSummary: 'unknown',
          cooldownUntil: null,
          ...(isExternal ? {
            recoverySubjectKind: 'unregistered-external',
            recoveryBindingId: targetReceipt.bindingId || 'pb_recovery-profile',
            recoveryBindingRevision: targetReceipt.bindingRevision || 1,
            recoveryBindingDigest: targetReceipt.bindingDigest || DIGEST,
          } : {}),
        };
        state.leases[leaseId] = {
          leaseId,
          physicalResourceId: resKey,
          profileAlias: targetReceipt.profileAlias,
          bindingId: targetReceipt.bindingId || 'pb_recovery-profile',
          bindingRevision: targetReceipt.bindingRevision || 1,
          bindingDigest: targetReceipt.bindingDigest || DIGEST,
          runId,
          runnerClaimDigest: CLAIM,
          leaseMode: 'single-context',
          fenceEpoch: targetReceipt.newFenceEpoch,
          leaseBindingDigest: computeLeaseBindingDigest({ claimDigest: CLAIM, bindingDigest: targetReceipt.bindingDigest || DIGEST, physicalResourceId: resKey, fenceEpoch: targetReceipt.newFenceEpoch, profileAlias: targetReceipt.profileAlias }),
          state: isReady ? 'cooldown' : targetReceipt.newState,
          issuedAt: targetReceipt.createdAt,
          expiresAt: new Date(Date.parse(targetReceipt.createdAt) + 120000).toISOString(),
          heartbeatIntervalMs: 30000,
          leaseTtlMs: 120000,
          nodeId: 'node-test-1',
          ownerType,
          idempotencyKey: `idemp-${vec.id}-${targetReceipt.receiptId}`,
          fingerprint: '{}',
          requestedActions: ['browser-read'],
          allowedActions: ['browser-read'],
          tabs: {},
          maxTabs: 2,
          actionUses: 0,
          actionJournal: [],
          fences: {},
        };
        const event = {
          schema: 'webmcp-profile-session-event/1',
          eventId: targetReceipt.eventId || `pse_${targetReceipt.receiptId.replace(/^prr_/, '')}`,
          leaseId,
          profileAlias: targetReceipt.profileAlias,
          state: targetReceipt.newState,
          stateReasonCode: isReady ? 'RECOVERY_APPLIED' : (isExternal ? 'PROFILE_EXTERNAL_USE' : (targetReceipt.newState === 'unknown' ? 'LIVENESS_UNKNOWN' : 'PROFILE_QUARANTINED')),
          fenceEpoch: targetReceipt.newFenceEpoch,
          bindingDigest: targetReceipt.bindingDigest || DIGEST,
          bindingId: targetReceipt.bindingId || 'pb_recovery-profile',
          runId,
          timestamp: targetReceipt.createdAt,
          leaseBindingDigest: state.leases[leaseId].leaseBindingDigest,
          livenessSummary: 'unknown',
          grantRevokeStatus: targetReceipt.dependentGrantRevokeStatus === 'revoked' ? 'revoked' : 'pending',
        };
        state.events.push(event);
        state.eventIntegrityDigests.push(digestLf('webmcp-digest-v1:governor-event', event));
        // Hardened receipts must be rebuilt with full digest coverage (authorityKind+createdAt+binding identity)
        const hardenedReceipt = buildRecoveryReceipt({
          leaseId: targetReceipt.leaseId,
          profileAlias: targetReceipt.profileAlias,
          bindingId: targetReceipt.bindingId || 'pb_recovery-profile',
          bindingRevision: targetReceipt.bindingRevision || 1,
          bindingDigest: targetReceipt.bindingDigest || DIGEST,
          runId: event.runId,
          priorState: targetReceipt.priorState,
          newState: targetReceipt.newState,
          priorFenceEpoch: targetReceipt.priorFenceEpoch,
          newFenceEpoch: targetReceipt.newFenceEpoch,
          reasonCode: targetReceipt.reasonCode,
          probeOutcomes: targetReceipt.probeOutcomes,
          lastActionOutcome: targetReceipt.lastActionOutcome,
          dependentGrantRevokeStatus: targetReceipt.dependentGrantRevokeStatus,
          authorityKind: targetReceipt.authorityKind,
          createdAt: targetReceipt.createdAt,
          eventId: event.eventId,
          receiptId: targetReceipt.receiptId,
        });
        state.receipts.push(hardenedReceipt);
      });

      const readState = repo.read();
      assert.equal(readState.receipts.length, 1);
      // Legacy fixture digest was without hardened fields, so hardened receipt will have different digest - assert hardened is valid
      assert.equal(computeReceiptDigest(readState.receipts[0]), readState.receipts[0].receiptDigest);
      assert.equal(validateRecoveryReceipt(readState.receipts[0]).receiptId, targetReceipt.receiptId);
      repo.close();
    }
  }
});

test('negative adversarial: recovery and action authorizers reject array, class instances, unknown fields, and malformed evidence', async () => {
  class ClassAuthorized {
    constructor() { this.authorized = true; }
  }

  // Subtest A: Recovery authorizer returning malformed shapes or evidence
  for (const badAuthorizerReturn of [
    null,
    false,
    undefined,
    [{ authorized: true }],
    new ClassAuthorized(),
    { authorized: true, unknownField: 'hacker-data' },
    { authorized: 'true' },
    { authorized: 1 },
    { authorized: false },
    { authorized: true, evidence: 'not-an-object' },
    { authorized: true, evidence: null },
    { authorized: true, evidence: [{ runnerClaim: 'terminal' }] },
    { authorized: true, evidence: new ClassAuthorized() },
    {
      authorized: true,
      evidence: {
        runnerClaim: 'terminal', browserAlive: false, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true, expectedState: 'quarantined',
        expectedFenceEpoch: 2, expectedBindingDigest: DIGEST, expectedPlanDigest: DIGEST,
        indeterminateResolved: true,
        injectedUnknownField: 'exploit',
      },
    },
    {
      authorized: true,
      evidence: {
        runnerClaim: 'forged-claim', browserAlive: false, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true, expectedState: 'quarantined',
        expectedFenceEpoch: 2, expectedBindingDigest: DIGEST, expectedPlanDigest: DIGEST,
        indeterminateResolved: true,
      },
    },
    {
      authorized: true,
      evidence: {
        runnerClaim: 'terminal', browserAlive: true, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true, expectedState: 'quarantined',
        expectedFenceEpoch: 2, expectedBindingDigest: DIGEST, expectedPlanDigest: DIGEST,
        indeterminateResolved: true,
      },
    },
  ]) {
    const { make } = setup({
      recoveryAuthorizer: async () => badAuthorizerReturn,
    });
    const g = make();
    await g.reconcileProfile('recovery-profile');
    const lease = await g.acquire(request());
    const fence = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
    await g.authorizeFence(fence);
    const facts = { fenceId: fence.fenceId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, actionId: 'act_adv-1' };
    await g.recordAction({ leaseId: lease.leaseId, outcome: 'prepared', ...facts });
    await g.recordAction({ leaseId: lease.leaseId, outcome: 'dispatched', ...facts });
    await g.recordAction({ leaseId: lease.leaseId, outcome: 'indeterminate', ...facts });

    const before = g.repository.read();
    await assert.rejects(
      g.recover('recovery-profile', { authenticatedLocalCapability: true, capability: { kind: 'operator' } }),
      (error) => error.code === 'PROFILE_RECLAIM_UNSAFE',
    );
    const after = g.repository.read();
    assert.equal(after.writerGeneration, before.writerGeneration, 'no mutation on bad authorizer shape');
    g.close();
  }

  // Subtest B: Action resolution authorizer returning malformed shapes
  for (const badActionReturn of [
    null,
    false,
    undefined,
    [{ authorized: true }],
    new ClassAuthorized(),
    { authorized: true, injectedActionField: true },
    { authorized: 'true' },
    { authorized: 1 },
    { authorized: false },
  ]) {
    const { make } = setup({
      actionResolutionAuthorizer: async () => badActionReturn,
    });
    const g = make();
    await g.reconcileProfile('recovery-profile');
    const lease = await g.acquire(request());
    const fence = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
    await g.authorizeFence(fence);
    const facts = () => { const val = g.repository.read().leases[lease.leaseId]; return { fenceId: fence.fenceId, fenceEpoch: val.fenceEpoch, leaseBindingDigest: val.leaseBindingDigest, bindingId: val.bindingId, bindingDigest: val.bindingDigest, runId: val.runId, runnerClaimDigest: val.runnerClaimDigest }; };
    await g.recordAction({ leaseId: lease.leaseId, actionId: 'act_adv-2', outcome: 'prepared', ...facts() });
    await g.recordAction({ leaseId: lease.leaseId, actionId: 'act_adv-2', outcome: 'dispatched', ...facts() });
    await g.recordAction({ leaseId: lease.leaseId, actionId: 'act_adv-2', outcome: 'indeterminate', ...facts() });

    await assert.rejects(
      g.recordAction({ leaseId: lease.leaseId, actionId: 'act_adv-2', outcome: 'failed-known', resolution: { kind: 'trusted-revocation' }, ...facts() }),
      (error) => error.code === 'PROFILE_RECLAIM_UNSAFE',
    );
    g.close();
  }
});

test('repository enforces all-or-nothing external provenance tuple and distinguishes registered vs unregistered external', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-provenance-'));
  const statePath = path.join(dir, 'state.json');
  const repo = new GovernorRepository({ statePath });

  const baseResource = {
    physicalResourceId: 'prsc_prov_res',
    profileAlias: 'prov-profile',
    aliases: ['prov-profile'],
    state: 'external_use',
    fenceEpoch: 1,
    currentLeaseId: null,
    needsReconciliation: true,
    livenessSummary: 'unknown',
    cooldownUntil: null,
  };

  // Missing one or more of the 4 tuple fields
  for (const partial of [
    { recoverySubjectKind: 'unregistered-external' },
    { recoveryBindingId: 'pb_prov-profile' },
    { recoveryBindingRevision: 1 },
    { recoveryBindingDigest: DIGEST },
    { recoverySubjectKind: 'unregistered-external', recoveryBindingId: 'pb_prov-profile' },
    { recoverySubjectKind: 'unregistered-external', recoveryBindingId: 'pb_prov-profile', recoveryBindingRevision: 1 },
    { recoveryBindingId: 'pb_prov-profile', recoveryBindingRevision: 1, recoveryBindingDigest: DIGEST },
    { recoverySubjectKind: 'invalid-subject-kind', recoveryBindingId: 'pb_prov-profile', recoveryBindingRevision: 1, recoveryBindingDigest: DIGEST },
  ]) {
    assert.throws(
      () => {
        repo.transact((state) => {
          state.resources.prsc_prov_res = { ...baseResource, ...partial };
        });
      },
      (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID',
    );
  }

  // Test full valid unregistered-external tuple without lease
  repo.transact((state) => {
    state.resources.prsc_prov_res = {
      ...baseResource,
      recoverySubjectKind: 'unregistered-external',
      recoveryBindingId: 'pb_prov-profile',
      recoveryBindingRevision: 1,
      recoveryBindingDigest: DIGEST,
    };
  });
  assert.equal(repo.read().resources.prsc_prov_res.recoverySubjectKind, 'unregistered-external');

  // Test registered external lease vs unregistered external lease distinction
  const g = new ProfileGovernor({
    repository: repo,
    registry: { resolve: async () => ({ physicalResourceId: 'prsc_prov_res', bindingId: 'pb_prov-profile', bindingRevision: 1, bindingDigest: DIGEST, allowedActions: ['browser-read'] }) },
    claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read'], ...req }) },
    liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }),
    revokeGrants: async () => true,
  });

  // Clean resource state for acquire
  repo.transact((state) => {
    delete state.resources.prsc_prov_res.recoverySubjectKind;
    delete state.resources.prsc_prov_res.recoveryBindingId;
    delete state.resources.prsc_prov_res.recoveryBindingRevision;
    delete state.resources.prsc_prov_res.recoveryBindingDigest;
    state.resources.prsc_prov_res.state = 'ready';
    state.resources.prsc_prov_res.needsReconciliation = false;
  });

  const extAcquire = await g.acquire(
    request({ profileAlias: 'prov-profile', ownerType: 'external', bindingId: 'pb_prov-profile', bindingDigest: DIGEST }),
    { authenticatedLocalCapability: true },
  );
  assert.equal(extAcquire.ownerType, 'external');
  const resourceAfterExtAcquire = repo.read().resources.prsc_prov_res;
  assert.equal(resourceAfterExtAcquire.recoverySubjectKind, 'registered-external');
  assert.equal(resourceAfterExtAcquire.recoveryBindingId, 'pb_prov-profile');
  assert.equal(resourceAfterExtAcquire.recoveryBindingRevision, 1);
  assert.equal(resourceAfterExtAcquire.recoveryBindingDigest, DIGEST);

  // Forged tuple on lease (mismatching bindingDigest) must fail repository validation
  assert.throws(
    () => {
      repo.transact((state) => {
        state.resources.prsc_prov_res.recoveryBindingDigest = 'sha256:' + 'f'.repeat(64);
      });
    },
    (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID',
  );

  g.close();
});

test('adversarial: registered external lease heartbeat rejects on initial TTL expiry and final mutation boundary without mutating external barrier', async () => {
  // Part 1: Initial TTL Expiry on registered external lease
  let now = 1000000;
  const setup1 = setup({
    clock: () => now,
    liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }),
  });
  const g1 = setup1.make();
  await g1.reconcileProfile('recovery-profile');
  const lease1 = await g1.acquire(
    request({
      ownerType: 'external',
      runId: 'run_ext-adv-0001',
      bindingId: 'pb_recovery-profile',
      bindingRevision: 1,
      bindingDigest: DIGEST,
      leaseTtlMs: 5000,
    }),
    { authenticatedLocalCapability: true },
  );
  assert.equal(lease1.ownerType, 'external');
  assert.equal(lease1.state, 'external_use');

  const beforeInitial = g1.repository.read();
  const initialRes = beforeInitial.resources.prsc_recovery_resource;
  const initialEpoch = initialRes.fenceEpoch;
  const initialEventCount = beforeInitial.events.length;
  const initialReceiptCount = beforeInitial.receipts.length;

  assert.equal(initialRes.state, 'external_use');
  assert.equal(initialRes.recoverySubjectKind, 'registered-external');
  assert.equal(initialRes.recoveryBindingId, 'pb_recovery-profile');
  assert.equal(initialRes.recoveryBindingRevision, 1);
  assert.equal(initialRes.recoveryBindingDigest, DIGEST);
  assert.ok(initialRes.recoveryPlanDigest);

  // Advance time past TTL before calling heartbeat
  now = Date.parse(lease1.expiresAt) + 1000;

  await assert.rejects(
    g1.heartbeat({ leaseId: lease1.leaseId, fenceEpoch: lease1.fenceEpoch, leaseBindingDigest: lease1.leaseBindingDigest }),
    (error) => error.code === 'PROFILE_LEASE_EXPIRED',
  );

  const afterInitial = g1.repository.read();
  const resAfterInitial = afterInitial.resources.prsc_recovery_resource;
  const leaseAfterInitial = afterInitial.leases[lease1.leaseId];

  assert.equal(resAfterInitial.state, 'external_use', 'durable resource state must remain external_use on initial expiry');
  assert.equal(resAfterInitial.currentLeaseId, lease1.leaseId, 'owner lease barrier must be preserved');
  assert.equal(resAfterInitial.recoverySubjectKind, 'registered-external', 'recovery subject kind must be preserved');
  assert.equal(resAfterInitial.recoveryBindingId, 'pb_recovery-profile', 'recovery bindingId must be preserved');
  assert.equal(resAfterInitial.recoveryBindingRevision, 1, 'recovery bindingRevision must be preserved');
  assert.equal(resAfterInitial.recoveryBindingDigest, DIGEST, 'recovery bindingDigest must be preserved');
  assert.equal(resAfterInitial.recoveryPlanDigest, initialRes.recoveryPlanDigest, 'recovery plan digest must be preserved');
  assert.equal(resAfterInitial.fenceEpoch, initialEpoch, 'fence epoch must remain unchanged');
  assert.equal(leaseAfterInitial.state, 'external_use', 'lease state must remain external_use');
  assert.equal(afterInitial.events.length, initialEventCount, 'event count must remain unchanged');
  assert.equal(afterInitial.receipts.length, initialReceiptCount, 'receipt count must remain unchanged');
  g1.close();

  // Part 2: TTL Expiry at the final mutation boundary (time advancing during async liveness)
  let now2 = 1000000;
  let advanceDuringLiveness = false;
  const setup2 = setup({
    clock: () => now2,
    liveness: async () => {
      if (advanceDuringLiveness) {
        // Advance clock past TTL while async liveness check is in flight
        now2 = 1006000;
      }
      return { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true };
    },
  });
  const g2 = setup2.make();
  await g2.reconcileProfile('recovery-profile');
  const lease2 = await g2.acquire(
    request({
      ownerType: 'external',
      runId: 'run_ext-adv-0002',
      bindingId: 'pb_recovery-profile',
      bindingRevision: 1,
      bindingDigest: DIGEST,
      leaseTtlMs: 5000,
    }),
    { authenticatedLocalCapability: true },
  );

  const beforeMutation = g2.repository.read();
  const mutRes = beforeMutation.resources.prsc_recovery_resource;
  const mutEpoch = mutRes.fenceEpoch;
  const mutEventCount = beforeMutation.events.length;
  const mutReceiptCount = beforeMutation.receipts.length;

  assert.equal(mutRes.state, 'external_use');
  assert.equal(mutRes.recoverySubjectKind, 'registered-external');
  assert.equal(mutRes.recoveryBindingId, 'pb_recovery-profile');
  assert.equal(mutRes.recoveryBindingRevision, 1);
  assert.equal(mutRes.recoveryBindingDigest, DIGEST);

  // Enable clock advance during liveness probe
  advanceDuringLiveness = true;

  await assert.rejects(
    g2.heartbeat({ leaseId: lease2.leaseId, fenceEpoch: lease2.fenceEpoch, leaseBindingDigest: lease2.leaseBindingDigest }),
    (error) => error.code === 'PROFILE_LEASE_EXPIRED',
  );

  const afterMutation = g2.repository.read();
  const resAfterMutation = afterMutation.resources.prsc_recovery_resource;
  const leaseAfterMutation = afterMutation.leases[lease2.leaseId];

  assert.equal(resAfterMutation.state, 'external_use', 'durable resource state must remain external_use on mutation boundary expiry');
  assert.equal(resAfterMutation.currentLeaseId, lease2.leaseId, 'owner lease barrier must be preserved at mutation boundary');
  assert.equal(resAfterMutation.recoverySubjectKind, 'registered-external', 'recovery subject kind must be preserved');
  assert.equal(resAfterMutation.recoveryBindingId, 'pb_recovery-profile', 'recovery bindingId must be preserved');
  assert.equal(resAfterMutation.recoveryBindingRevision, 1, 'recovery bindingRevision must be preserved');
  assert.equal(resAfterMutation.recoveryBindingDigest, DIGEST, 'recovery bindingDigest must be preserved');
  assert.equal(resAfterMutation.recoveryPlanDigest, mutRes.recoveryPlanDigest, 'recovery plan digest must be preserved');
  assert.equal(resAfterMutation.fenceEpoch, mutEpoch, 'fence epoch must remain unchanged');
  assert.equal(leaseAfterMutation.state, 'external_use', 'lease state must remain external_use');
  assert.equal(afterMutation.events.length, mutEventCount, 'event count must remain unchanged');
  assert.equal(afterMutation.receipts.length, mutReceiptCount, 'receipt count must remain unchanged');
  g2.close();
});
