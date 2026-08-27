import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('session-data grant schema isolates mode and destination', () => {
  const schema = loadJson(path.join(ROOT, 'schemas/webmcp-session-data-grant.schema.json'));
  assert.equal(schema.properties.schema.const, 'webmcp-session-data-grant/1');
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('origin') && schema.required.includes('surface') && schema.required.includes('mode'));
  assert.ok(schema.properties.mode.enum.includes('metadata-only') && schema.properties.mode.enum.includes('scoped-values'));
  assert.ok(schema.properties.destination.enum.includes('trusted-step'));
});

test('session-data scope vectors are synthetic and cover origin/domain/path/budgets', () => {
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/session-data-scope-vectors.json'));
  assert.equal(vectors.schema, 'webmcp-session-data-scope-vectors/1');
  const ids = vectors.vectors.map((v) => v.id);
  assert.ok(ids.includes('cookie-host-only-exact'));
  assert.ok(ids.includes('cookie-domain-mismatch-denied'));
  assert.ok(ids.includes('indexeddb-wrong-store-denied'));
  assert.ok(ids.includes('budget-max-rows-enforced'));
  assert.ok(ids.includes('lease-fence-loss-abort-mid-query'));
});

test('session-data canonical vectors prove JCS digest binding (D1 provisional)', () => {
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/session-data-canonical-vectors.json'));
  assert.equal(vectors.schema, 'webmcp-session-data-canonical-vectors/1');
  assert.equal(vectors.domainLabels.binding, 'webmcp-digest-v1:binding');
  const grantVec = vectors.vectors.find((v) => v.id === 'canonical-grant-scope');
  assert.ok(grantVec && grantVec.canonicalJson.includes('"origin"'), 'grant canonical vector must exist');
  const mutated = vectors.vectors.find((v) => v.id === 'canonical-mutation-protects-field');
  assert.ok(mutated.mutated.expectMismatch, 'mutation must change digest');
});

test('RED: exact scope enforcement for cookies/storage/IndexedDB is missing', () => {
  const candidates = [
    path.join(ROOT, 'server/session-data/scope-validator.mjs'),
    path.join(ROOT, 'server/session-data/query.mjs'),
  ];
  const found = candidates.filter((p) => existsSync(p));
  assert.ok(
    found.length === 2,
    `RED: missing session-data scope validator — expected ${candidates.join(' and ')} to exist. ` +
      `Expected: exact origin/domain/path/name, origin+keys, db/store/index/range/projection enforcement, ` +
      `same origin vs cross-origin frame, partitioned cookie handling, JCS digest verified, no wildcard defaults. ` +
      `Vectors cookie-host-only-exact .. indexeddb-keyrange-projection-enforced in session-data-scope-vectors.json. ` +
      `A1 must not create these files; this RED proves gap.`
  );
});

test('RED: row/byte/time/use caps and lease/fence loss abort are missing', () => {
  const impl = path.join(ROOT, 'server/session-data/scope-validator.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing budget + fence abort — ${impl} not found. ` +
      `Expected: TTL/maxUses/maxRows/maxBytes/depth/pages/duration hard caps, truncated page with complete:false, ` +
      `lease/fence loss aborts mid-query/export mid-page, no silent complete. Vectors budget-max-rows-enforced + lease-fence-loss-abort-mid-query.`
  );
});
