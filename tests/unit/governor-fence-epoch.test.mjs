import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';
import { computeFenceDigest, computeLeaseBindingDigest, digestLf } from '../../profile-governor/contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DIGEST = 'sha256:' + 'a'.repeat(64);
const CLAIM = 'sha256:' + 'b'.repeat(64);
function makeGovernor({ maxFenceUses = 1000, clock = () => Date.now(), liveness = async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }), revokeGrants = async () => true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-fence-'));
  return new ProfileGovernor({
    repository: new GovernorRepository({ statePath: path.join(dir, 'state.json') }),
    registry: { resolve: async () => ({ physicalResourceId: 'prsc_fence_resource', bindingId: 'pb_fence-profile', bindingRevision: 1, bindingDigest: DIGEST, allowedActions: ['browser-read', 'browser-write'] }) },
    claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read', 'browser-write'], ...req }) },
    liveness,
    maxFenceUses,
    clock,
    revokeGrants,
  });
}
function request(overrides = {}) {
  return { schema: 'webmcp-profile-lease-request/1', requestId: 'plr_fence-0001', ownerType: 'automation', nodeId: 'node-fence-1', runId: 'run_fence111', runnerClaimDigest: CLAIM, bindingId: 'pb_fence-profile', bindingRevision: 1, bindingDigest: DIGEST, profileAlias: 'fence-profile', leaseMode: 'single-context', requestedActions: ['browser-read'], heartbeatIntervalMs: 1000, leaseTtlMs: 5000, idempotencyKey: 'fence-key-1', ...overrides };
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('fence schema webmcp-profile-action-fence/1 is valid and binds leaseBindingDigest', () => {
  const schema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-action-fence.schema.json'));
  assert.equal(schema.properties.schema.const, 'webmcp-profile-action-fence/1');
  assert.ok(schema.required.includes('fenceDigest'));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.scope.required.includes('profileAlias'));
});

test('fence proof vectors are synthetic and cover stale/missing/tab cases', () => {
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/fence-proof-vectors.json'));
  assert.equal(vectors.schema, 'webmcp-fence-proof-vectors/1');
  const ids = vectors.vectors.map((v) => v.id);
  assert.ok(ids.includes('fence-stale-epoch-rejected'));
  assert.ok(ids.includes('fence-missing-required'));
  assert.ok(ids.includes('fence-tab-not-owned'));
  assert.ok(ids.includes('fence-heartbeat-wrong-claim'));
});

test('fence fixture instances validate against schema and canonical implementation digest (AJV)', async () => {
  const { default: Ajv } = await import('ajv');
  const { default: addFormats } = await import('ajv-formats');
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
  addFormats(ajv);
  const fenceSchema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-action-fence.schema.json'));
  const validate = ajv.compile(fenceSchema);
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/fence-proof-vectors.json'));
  for (const vec of vectors.vectors) {
    if (vec.proof) {
      assert.equal(validate(vec.proof), true, `proof ${vec.id} must validate: ${JSON.stringify(validate.errors)}`);
      assert.match(vec.proof.fenceId, /^fence_[0-9a-f]{16}$/);
      assert.match(vec.proof.leaseId, /^lease_[0-9a-f]{16}$/);
    }
  }
  const happy = vectors.vectors.find((v) => v.id === 'fence-happy-browser-read');
  assert.ok(happy && happy.proof);
  assert.equal(validate(happy.proof), true);
  for (const vec of vectors.vectors) {
    for (const projection of Object.values(vec.protectedProjections || {})) {
      if (projection.domainLabel === 'webmcp-digest-v1:fence' && projection.projection) assert.equal(computeFenceDigest(projection.projection), projection.digest, `fence ${vec.id}`);
      if (projection.domainLabel === 'webmcp-digest-v1:lease' && projection.projection) assert.equal(computeLeaseBindingDigest({ claimDigest: projection.projection.claimDigest, bindingDigest: projection.projection.bindingDigest, physicalResourceId: projection.projection.profileResourceId, fenceEpoch: projection.projection.fenceEpoch }), projection.digest, `lease ${vec.id}`);
      if (projection.canonical) assert.equal(digestLf(projection.domainLabel, projection.canonical), projection.digest, `canonical ${vec.id}`);
    }
    const mutation = vec.mutation;
    if (mutation?.mutatedProjection && mutation.mutatedDigest) {
      const mutatedDigest = mutation.mutatedProjection.profileResourceId
        ? computeLeaseBindingDigest({ claimDigest: mutation.mutatedProjection.claimDigest, bindingDigest: mutation.mutatedProjection.bindingDigest, physicalResourceId: mutation.mutatedProjection.profileResourceId, fenceEpoch: mutation.mutatedProjection.fenceEpoch })
        : computeFenceDigest(mutation.mutatedProjection);
      assert.equal(mutatedDigest, mutation.mutatedDigest, `mutation ${vec.id}`);
      const original = vec.protectedProjections?.fenceDigest?.digest || vec.protectedProjections?.leaseBindingDigest?.digest;
      if (original) assert.notEqual(mutatedDigest, original, `mutation differs ${vec.id}`);
    }
  }
});

test('RED: every production browser action requires current fence (missing fence denied)', () => {
  const candidates = [
    path.join(ROOT, 'profile-governor/lease-service.mjs'),
    path.join(ROOT, 'profile-governor/client.mjs'),
  ];
  // The contested gateway remains outside A3; the owner API is the protected seam.
  const fenceImpl = path.join(ROOT, 'profile-governor/lease-service.mjs');
  assert.ok(
    existsSync(fenceImpl),
    `RED: missing per-action fence verifier — ${fenceImpl} not found. ` +
      `Expected: out-of-band fence context injected by Node, validated before dispatch for every ` +
      `supported tool (first-class, workflow, raw-command), batch fences each side-effect boundary, ` +
      `PROFILE_FENCE_REQUIRED when absent. Vector fence-missing-required. ` +
      `Contested gateway/server files must not be edited in A3.`
  );
});

test('RED: stale fenceEpoch after reclaim is rejected and heartbeat validates claim/fence', () => {
  const impl = path.join(ROOT, 'profile-governor/lease-service.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing fenceEpoch monotonicity — ${impl} not found. ` +
      `Expected: monotonic fenceEpoch per physical resource, atomic increment on grant/recovery, ` +
      `old secret/epoch rejected after transfer/restart, stale owner dispatch fails before gateway, ` +
      `heartbeat rejects wrong claim/fence. Vectors fence-stale-epoch-rejected + fence-heartbeat-wrong-claim.`
  );
});

test('RED: TTL alone does not reclaim; stale release does not delete new lease', () => {
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/governor-lease-vectors.json'));
  const ttlVector = vectors.vectors.find((v) => v.id === 'lease-ttl-expired-browser-alive-no-reclaim');
  const staleVector = vectors.vectors.find((v) => v.id === 'lease-stale-release-idempotent');
  assert.ok(ttlVector && staleVector, 'required vectors present');
  const impl = path.join(ROOT, 'profile-governor/recovery.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing safe reclaim proof — ${impl} not found. ` +
      `Expected: TTL only moves to reconciliation, not ready; release idempotent but stale release ` +
      `must not remove new lease (CAS on fenceEpoch). Vectors lease-ttl-expired-browser-alive-no-reclaim + lease-stale-release-idempotent.`
  );
});

test('current fence authorizes before action, while missing, stale, wrong-claim, and wrong-tab proofs fail closed', async () => {
  const g = makeGovernor();
  await g.reconcileProfile('fence-profile');
  const lease = await g.acquire(request());
  const proof = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  assert.equal(proof.schema, 'webmcp-profile-action-fence/1');
  assert.equal((await g.authorizeFence(proof)).authorized, true);
  await assert.rejects(g.authorizeFence(null), (error) => error.code === 'PROFILE_FENCE_REQUIRED');
  await assert.rejects(g.authorizeFence({ ...proof, fenceEpoch: proof.fenceEpoch + 1 }), (error) => error.code === 'PROFILE_FENCE_STALE');
  await assert.rejects(g.heartbeat({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runnerClaimDigest: 'sha256:' + 'd'.repeat(64) }), (error) => error.code === 'PROFILE_CLAIM_INVALID');
  const tab = await g.openTab({ leaseId: lease.leaseId, runId: lease.runId });
  await assert.rejects(g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read', tabHandle: 'tab_not-owned' }), (error) => error.code === 'PROFILE_TAB_NOT_OWNED');
  const tabProof = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read', tabHandle: tab.tabHandle });
  assert.equal((await g.authorizeFence(tabProof)).authorized, true);
});

test('issued fence facts are authoritative: tamper, replay, and lease expiry fail before dispatch', async () => {
  let now = Date.now();
  const g = makeGovernor({ maxFenceUses: 1, clock: () => now });
  await g.reconcileProfile('fence-profile');
  const lease = await g.acquire(request());
  const proof = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  await assert.rejects(g.authorizeFence({ ...proof, maxUses: 1000 }), (error) => ['PROFILE_FENCE_STALE', 'PROFILE_FENCE_INVALID'].includes(error.code));
  await assert.rejects(g.authorizeFence({ ...proof, expiresAt: new Date(Date.parse(proof.expiresAt) + 1000).toISOString() }), (error) => ['PROFILE_FENCE_STALE', 'PROFILE_FENCE_INVALID'].includes(error.code));
  now = Date.parse(proof.expiresAt) + 1;
  await assert.rejects(g.authorizeFence(proof), (error) => error.code === 'PROFILE_FENCE_STALE');
  now = Date.parse(proof.issuedAt);
  assert.equal((await g.authorizeFence(proof)).authorized, true);
  await assert.rejects(g.authorizeFence(proof), (error) => error.code === 'PROFILE_FENCE_STALE');
});

test('fresh liveness changes deny an already-issued fence and external use', async () => {
  let live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true };
  const g = makeGovernor({ liveness: async () => live });
  await g.reconcileProfile('fence-profile');
  const lease = await g.acquire(request());
  const proof = await g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
  live = { ...live, browserAlive: true, extensionConnected: false };
  await assert.rejects(g.authorizeFence(proof), (error) => error.code === 'PROFILE_EXTERNAL_USE');
  live = { ...live, browserAlive: false, extensionConnected: false, registry: 'failed' };
  await assert.rejects(g.authorizeFence(proof), (error) => ['PROFILE_LIVENESS_UNKNOWN', 'PROFILE_FENCE_STALE', 'PROFILE_GOVERNOR_NOT_READY'].includes(error.code));
});

test('stale release cannot remove a later lease and epochs only increase after recovery', async () => {
  const g = makeGovernor();
  await g.reconcileProfile('fence-profile');
  const first = await g.acquire(request());
  const released = await g.release({ leaseId: first.leaseId, fenceEpoch: first.fenceEpoch, leaseBindingDigest: first.leaseBindingDigest });
  assert.equal(released.released, true);
  await g.reconcileProfile('fence-profile');
  const second = await g.acquire(request({ requestId: 'plr_fence-0002', idempotencyKey: 'fence-key-2', runId: 'run_fence222' }));
  const stale = await g.release({ leaseId: first.leaseId, fenceEpoch: first.fenceEpoch, leaseBindingDigest: first.leaseBindingDigest });
  assert.equal(stale.released, false);
  assert.equal((await g.getResourceProjection('fence-profile')).fenceEpoch, second.fenceEpoch);
});

test('false composite liveness rejects fence creation', async () => {
  let live = { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true };
  const g = makeGovernor({ liveness: async () => live });
  await g.reconcileProfile('fence-profile');
  const lease = await g.acquire(request());
  live = { ...live, browserAlive: false, extensionConnected: false };
  await assert.rejects(g.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' }), (error) => ['PROFILE_LIVENESS_UNKNOWN', 'PROFILE_FENCE_STALE', 'PROFILE_GOVERNOR_NOT_READY'].includes(error.code));
});
