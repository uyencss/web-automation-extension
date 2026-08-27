import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('governor lease schema webmcp-profile-lease/2 is fixture-only valid JSON schema', () => {
  const schema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-lease.schema.json'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.schema.const, 'webmcp-profile-lease/2');
  assert.equal(schema.additionalProperties, false);
  assert.ok(Array.isArray(schema.required) && schema.required.includes('leaseBindingDigest'));
});

test('governor lease request schema is valid and rejects unknown fields', () => {
  const schema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-lease-request.schema.json'));
  assert.equal(schema.properties.schema.const, 'webmcp-profile-lease-request/1');
  assert.equal(schema.additionalProperties, false);
});

test('governor lease vectors are well-formed synthetic fixtures', () => {
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/governor-lease-vectors.json'));
  assert.equal(vectors.schema, 'webmcp-governor-lease-vectors/1');
  assert.ok(vectors.vectors.length >= 5);
  for (const v of vectors.vectors) {
    assert.ok(typeof v.id === 'string' && v.id.length > 0);
    assert.ok(typeof v.expect === 'string');
  }
  const race = vectors.vectors.find((v) => v.id === 'lease-race-two-processes-same-physical');
  assert.ok(race, 'race vector must exist');
  assert.equal(race.requests.length, 2);
});

test('RED: Governor exclusive acquire — two processes same physical resource yields exactly one winner', () => {
  // A1 is RED-only: runtime must not exist yet. This test proves the missing capability,
  // not malformed setup, by asserting the future Governor lease service exists.
  const candidates = [
    path.join(ROOT, 'server/profile-governor/lease-service.mjs'),
    path.join(ROOT, 'server/profile-governor/repository.mjs'),
    path.join(ROOT, 'server/profile-governor/state-machine.mjs'),
  ];
  const found = candidates.filter((p) => existsSync(p));
  assert.ok(
    found.length > 0,
    `RED: missing Governor lease race capability — none of ${candidates.join(', ')} exists. ` +
      `Expected: cross-process exclusive acquire keyed by physical resource (not alias), ` +
      `same trust domain still conflicts, idempotent exact re-acquire, and PROFILE_LEASE_CONFLICT for loser. ` +
      `Vectors: tests/fixtures/governor-lease-vectors.json#lease-race-two-processes-same-physical. ` +
      `Do not implement in A1; this RED must fail until server/profile-governor/* is landed.`
  );
});

test('RED: Governor same-run multi-tab uses one lease/fence (bounded handles)', () => {
  const impl = path.join(ROOT, 'server/profile-governor/lease-service.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing Governor same-run multi-tab capability — ${impl} not found. ` +
      `Expected: one run/claim/lease/fence with opaque tab handles under maxTabs, ` +
      `tabHandle validated per action, child run cannot join. Vector lease-same-run-multi-tab-one-lease.`
  );
});
