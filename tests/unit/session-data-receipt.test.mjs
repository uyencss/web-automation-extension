import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('session-data receipt schema contains only digests/counts, never values', () => {
  const receipt = loadJson(path.join(ROOT, 'schemas/webmcp-session-data-receipt.schema.json'));
  assert.equal(receipt.properties.schema.const, 'webmcp-session-data-receipt/1');
  const rawFields = ['cookieValue', 'storageValue', 'recordValue', 'plainText'];
  const str = JSON.stringify(receipt);
  for (const f of rawFields) assert.ok(!str.includes(f), `receipt schema must not contain ${f}`);
  assert.ok(receipt.required.includes('scopeDigest'));
  assert.ok(receipt.properties.counts.required.includes('uses'));
});

test('session-data receipt vectors are synthetic', () => {
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/session-data-scope-vectors.json'));
  // ensure at least the metadata isolation vectors exist for receipt tests
  const ids = vectors.vectors.map((v) => v.id);
  assert.ok(ids.includes('metadata-no-values'));
});

test('RED: receipt generation and redacted evidence is missing', () => {
  const impl = path.join(ROOT, 'server/session-data/receipt.mjs');
  const alt = path.join(ROOT, 'server/session-data/grant.mjs');
  const found = existsSync(impl) || existsSync(alt);
  assert.ok(
    found,
    `RED: missing session-data receipt capability — expected ${impl} (or ${alt}) to exist. ` +
      `Expected: per-use receipt with grantId/runId/leaseId/fenceEpoch/mode/surface/scopeDigest/purpose/destination/taint, ` +
      `counts uses/rows/sourceBytes/encodedBytes, complete/truncated/consistency, typedOutcome, revocation; ` +
      `export receipt additionally artifactDigest/retention; no values/PII/fence token, per D5 retention.`
  );
});

test('RED: budget-truncated semantics must not report complete', () => {
  const impl = path.join(ROOT, 'server/session-data/scope-validator.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing budget-truncated contract — ${impl} not found. ` +
      `Expected: maxRows/maxBytes max limits stop before overrun, scoped read may return bounded page with truncated:true + opaque cursor, ` +
      `export requiring completeness must fail/quarantine not silent truncate. Vector budget-max-rows-enforced.`
  );
});

test('RED: cursor is opaque, short-lived, grant-bound and stale after fence loss', () => {
  const impl = path.join(ROOT, 'server/session-data/query.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing IndexedDB cursor binding — ${impl} not found. ` +
      `Expected: opaque cursor short-lived single-grant query-digest-bound, binds origin/database/store/index/range/projection/fence, ` +
      `expires/context change yields SESSION_DATA_CURSOR_STALE, per-page budget/fence check. See capability-browser-session-data-access §13.5.`
  );
});
