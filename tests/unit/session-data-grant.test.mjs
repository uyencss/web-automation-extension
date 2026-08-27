import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('session-data grant and receipt schemas are versioned and redacted', () => {
  const grant = loadJson(path.join(ROOT, 'schemas/webmcp-session-data-grant.schema.json'));
  const receipt = loadJson(path.join(ROOT, 'schemas/webmcp-session-data-receipt.schema.json'));
  assert.equal(grant.properties.schema.const, 'webmcp-session-data-grant/1');
  assert.equal(receipt.properties.schema.const, 'webmcp-session-data-receipt/1');
  assert.equal(grant.additionalProperties, false);
  assert.equal(receipt.additionalProperties, false);
  // receipts must not contain values
  const grantStr = JSON.stringify(grant);
  const receiptStr = JSON.stringify(receipt);
  assert.ok(!grantStr.includes('cookieValue') && !receiptStr.includes('cookieValue'), 'schemas must not expose raw values');
  assert.ok(receipt.properties.scopeDigest.pattern.includes('sha256'), 'receipt uses digest not raw scope');
});

test('session-data scope vectors prove read≠export and metadata-only isolation', () => {
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/session-data-scope-vectors.json'));
  const readNotExport = vectors.vectors.find((v) => v.id === 'read-not-export');
  const metadata = vectors.vectors.find((v) => v.id === 'metadata-no-values');
  assert.ok(readNotExport && readNotExport.expect === 'SESSION_DATA_EXPORT_APPROVAL_REQUIRED');
  assert.ok(metadata && metadata.expect === 'SESSION_DATA_MODE_VIOLATION');
});

test('RED: session-data grant minting is missing (admission-bound, fence-bound)', () => {
  const impl = path.join(ROOT, 'server/session-data/grant.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing session-data grant service — ${impl} not found. ` +
      `Expected: effective grant mints short-lived credential binding claimDigest+bindingDigest+profileResourceId+fenceEpoch, ` +
      `exact canonical origins, surfaces/selectors, mode/destination/purpose/TTL/maxUses budgets, taint, approvalDigest, ` +
      `grantDigest = H(leaseBinding+purpose+exactScope+TTL+maxUses+approvalDigest) (D1 provisional), ` +
      `intersects Store request with local policy (smallest budget wins). Vectors session-data-canonical-vectors.json.`
  );
});

test('RED: destination and transcript exposure contract is missing (D2/D3 provisional)', () => {
  const impl = path.join(ROOT, 'server/session-data/grant.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing destination/transcript gate — ${impl} not found. ` +
      `Expected: trusted-step vs agent-tool-result vs transcript vs artifact isolation; ` +
      `if host lacks non-persistent channel, transcriptExposure:true + signed approval required or fail closed; ` +
      `read grant does not imply export; vector read-not-export. D2 host channel + D3 high-risk grant for full value.`
  );
});

test('RED: cross-profile and origin mismatch correctly blocks', () => {
  const impl = path.join(ROOT, 'server/session-data/scope-validator.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing cross-profile guard — ${impl} not found. ` +
      `Expected: cross-profile lease mismatch and cross-origin without explicit iframe origin both yield ` +
      `SESSION_DATA_SCOPE_VIOLATION; navigation between resolve/read yields stale typed error. Vector cross-profile-rejected + storage-wrong-origin-denied.`
  );
});
