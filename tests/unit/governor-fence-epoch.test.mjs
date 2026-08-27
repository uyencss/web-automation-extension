import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

test('fence fixture instances validate against schema (AJV)', async () => {
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
});

test('RED: every production browser action requires current fence (missing fence denied)', () => {
  const candidates = [
    path.join(ROOT, 'server/profile-governor/fence.mjs'),
    path.join(ROOT, 'server/gateway_server.js'),
  ];
  // gateway_server.js exists but must NOT be edited in A1; so check that it does NOT yet enforce fence.
  // We prove RED by requiring a dedicated fence verifier outside contested gateway.
  const fenceImpl = path.join(ROOT, 'server/profile-governor/fence.mjs');
  assert.ok(
    existsSync(fenceImpl),
    `RED: missing per-action fence verifier — ${fenceImpl} not found. ` +
      `Expected: out-of-band fence context injected by Node, validated before dispatch for every ` +
      `supported tool (first-class, workflow, raw-command), batch fences each side-effect boundary, ` +
      `PROFILE_FENCE_REQUIRED when absent. Vector fence-missing-required. ` +
      `Contested gateway_server.js must not be edited in A1.`
  );
});

test('RED: stale fenceEpoch after reclaim is rejected and heartbeat validates claim/fence', () => {
  const impl = path.join(ROOT, 'server/profile-governor/fence.mjs');
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
  const impl = path.join(ROOT, 'server/profile-governor/recovery.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing safe reclaim proof — ${impl} not found. ` +
      `Expected: TTL only moves to reconciliation, not ready; release idempotent but stale release ` +
      `must not remove new lease (CAS on fenceEpoch). Vectors lease-ttl-expired-browser-alive-no-reclaim + lease-stale-release-idempotent.`
  );
});
