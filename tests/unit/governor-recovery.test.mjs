import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DIGEST = 'sha256:' + 'a'.repeat(64);
const CLAIM = 'sha256:' + 'b'.repeat(64);
function request(overrides = {}) {
  return { schema: 'webmcp-profile-lease-request/1', requestId: 'plr_recovery-01', ownerType: 'automation', nodeId: 'node-recovery-1', runId: 'run_recovery1', runnerClaimDigest: CLAIM, bindingId: 'pb_recovery-profile', bindingRevision: 1, bindingDigest: DIGEST, profileAlias: 'recovery-profile', leaseMode: 'single-context', requestedActions: ['browser-read'], heartbeatIntervalMs: 1000, leaseTtlMs: 5000, idempotencyKey: 'recovery-key-1', ...overrides };
}
function setup({ liveness = async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }), recoveryAuthorizer, revokeGrants, actionResolutionAuthorizer = async () => ({ authorized: true }) } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-recovery-'));
  const statePath = path.join(dir, 'state.json');
  const make = () => new ProfileGovernor({
    repository: new GovernorRepository({ statePath }),
    registry: { resolve: async () => ({ physicalResourceId: 'prsc_recovery_resource', bindingId: 'pb_recovery-profile', bindingRevision: 1, bindingDigest: DIGEST, allowedActions: ['browser-read'] }) },
    claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read'], ...req }) },
    liveness, recoveryAuthorizer, revokeGrants, actionResolutionAuthorizer,
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
  const { default: Ajv } = await import('ajv');
  const { default: addFormats } = await import('ajv-formats');
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
  addFormats(ajv);
  const receiptSchema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-recovery-receipt.schema.json'));
  const eventSchema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-session-event.schema.json'));
  const validateReceipt = ajv.compile(receiptSchema);
  const validateEvent = ajv.compile(eventSchema);
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/recovery-receipt-vectors.json'));
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
    }
  }
});

test('RED: host restart recovery must not resurrect stale lease as ready', () => {
  const impl = path.join(ROOT, 'profile-governor/recovery.mjs');
  const eventImpl = path.join(ROOT, 'profile-governor/events.mjs');
  const found = [impl, eventImpl].filter((p) => existsSync(p));
  assert.ok(
    found.length === 2,
    `RED: missing Governor recovery capability — expected both ${impl} and ${eventImpl} to exist. ` +
      `Expected: service restart loads durable state, marks potentially active resources unknown until reconciliation, ` +
      `client reconnect proves claim/lease via protected IPC (no reissue), corrupt DB fails closed, ` +
      `no stale resurrection. Vector recovery-host-restart-no-stale-resurrection.`
  );
});

test('RED: indeterminate outward effect quarantines and blocks retry/reclaim', () => {
  const impl = path.join(ROOT, 'profile-governor/recovery.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing indeterminate-effect quarantine — ${impl} not found. ` +
      `Expected: dispatched->confirmed/failed-known/indeterminate journal; outward indeterminate quarantines, ` +
      `retry blocked, dependent Vault grants revoked, recovery receipt persisted with lastActionOutcome, ` +
      `new monotonic epoch before next owner. Vector recovery-process-crash-indeterminate-quarantine.`
  );
});

test('RED: manual external_use blocks automation and requires operator reconcile', () => {
  const impl = path.join(ROOT, 'profile-governor/recovery.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing external_use lifecycle — ${impl} not found. ` +
      `Expected: external.acquire/heartbeat/release/detect/adopt, registered manual lease exclusive, ` +
      `unregistered detection yields PROFILE_EXTERNAL_USE, scheduled automation fails typed, ` +
      `no automatic adopt. Vector recovery-manual-external-use-detected. D6 provisional owner is Governor.`
  );
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

  const live = setup({ liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }) });
  const gl = live.make();
  await gl.reconcileProfile('recovery-profile');
  const liveLease = await gl.acquire(request({ runId: 'run_live111x', idempotencyKey: 'live-key' }));
  await assert.rejects(gl.heartbeat({ leaseId: liveLease.leaseId, fenceEpoch: liveLease.fenceEpoch, leaseBindingDigest: liveLease.leaseBindingDigest, now: Date.now() + 10000 }), (error) => error.code === 'PROFILE_LEASE_EXPIRED');
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
  const recovered = await g.recover('recovery-profile', { forgedEvidence: true, authenticatedLocalCapability: true, capability: { kind: 'operator' } });
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
  await assert.rejects(server.call('recover', { profileAlias: 'recovery-profile', evidence: { runnerClaim: 'terminal', browserAlive: false, extensionConnected: false, dependentGrantsRevoked: true, registryCurrent: true } }, { capability: { kind: 'operator' } }), (error) => error.code === 'PROFILE_RECLAIM_UNSAFE');
});
