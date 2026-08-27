import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('interaction policy stopConditions include fence/budget/challenge', () => {
  const schema = loadJson(path.join(ROOT, 'schemas/webmcp-interaction-policy.schema.json'));
  const stops = schema.properties.stopConditions.items.enum;
  assert.ok(stops.includes('PROFILE_LEASE_LOST'));
  assert.ok(stops.includes('INTERACTION_BUDGET_EXCEEDED'));
  assert.ok(stops.includes('CHALLENGE_DETECTED'));
  assert.ok(stops.includes('PROFILE_AUTH_REQUIRED'));
});

test('fence vectors provide abort injection points for interaction', () => {
  const fenceVectors = loadJson(path.join(ROOT, 'tests/fixtures/fence-proof-vectors.json'));
  assert.ok(fenceVectors.vectors.some((v) => v.id === 'fence-stale-epoch-rejected'));
  const interactionVectors = loadJson(path.join(ROOT, 'tests/fixtures/interaction-unicode-vectors.json'));
  // ensure at least one long-text vector exists for between-chunks abort test
  assert.ok(interactionVectors.vectors.some((v) => v.id === 'vi-nfc-precomposed'));
});

test('interaction/fence fixture instances validate (AJV)', async () => {
  const { default: Ajv } = await import('ajv');
  const { default: addFormats } = await import('ajv-formats');
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
  addFormats(ajv);
  const fenceSchema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-action-fence.schema.json'));
  const validateFence = ajv.compile(fenceSchema);
  const fenceVectors = loadJson(path.join(ROOT, 'tests/fixtures/fence-proof-vectors.json'));
  const happy = fenceVectors.vectors.find((v) => v.id === 'fence-happy-browser-read');
  assert.equal(validateFence(happy.proof), true, `fence proof must validate: ${JSON.stringify(validateFence.errors)}`);
  const unicode = loadJson(path.join(ROOT, 'tests/fixtures/interaction-unicode-vectors.json'));
  assert.ok(unicode.vectors.some((v) => v.id === 'vi-nfc-precomposed' && v.expectChunks === 'grapheme-safe'));
});

test('RED: fence check between chunks aborts interaction and reports partial effect — missing', () => {
  const candidates = [
    path.join(ROOT, 'lib/interaction/fence-abort.mjs'),
    path.join(ROOT, 'server/interaction/fence-integration.mjs'),
    path.join(ROOT, 'server/profile-governor/fence.mjs'),
  ];
  const found = candidates.filter((p) => existsSync(p));
  assert.ok(
    found.length > 0,
    `RED: missing fence-between-chunks abort — none of ${candidates.join(', ')} exists. ` +
      `Expected: paced action split into grapheme-safe chunks, fence/abort checked between chunks, ` +
      `lost lease/auth/challenge/rate-limit/budget stops next chunk, partial outcome with applied count ` +
      `and effect none/partial/observed/indeterminate, no auto-submit/key cleanup after fence loss, ` +
      `no retry when outward indeterminate. Vectors fence-stale-epoch-rejected + vi-nfc-precomposed chunked.`
  );
});

test('RED: challenge/auth/rate-limit typed stop is missing', () => {
  const impl = path.join(ROOT, 'lib/interaction/fence-abort.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing typed stop for challenge/auth/rate-limit — ${impl} not found. ` +
      `Expected: CHALLENGE_DETECTED (CAPTCHA/passkey/push), PROFILE_AUTH_REQUIRED, RATE_LIMITED ` +
      `all stop typed, not collapsed to generic timeout, mid-debounce/mid-scroll/mid-IME also abort, ` +
      `evidence contains typed code not raw capture. See capability-human-compatible-interaction §8.2.`
  );
});

test('RED: postcondition mismatch fails even when motion completed — missing', () => {
  const impl = path.join(ROOT, 'lib/interaction/policy.mjs');
  const alt = path.join(ROOT, 'lib/interaction/pace.mjs');
  const found = existsSync(impl) || existsSync(alt);
  assert.ok(
    found,
    `RED: missing postcondition verification — expected ${impl} or ${alt} to exist. ` +
      `Expected: clicked/typed/DOM quiet not success; postcondition/read-back (value-equivalent, element-visible, dom-stable) ` +
      `must pass via real app state (React/Vue), otherwise INTERACTION_POSTCONDITION_FAILED, ` +
      `sensitive value absent from evidence (valueSource brokered).`
  );
});
