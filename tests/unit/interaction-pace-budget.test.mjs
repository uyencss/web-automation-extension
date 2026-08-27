import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('interaction policy schema enforces direct default and bounded budgets', () => {
  const schema = loadJson(path.join(ROOT, 'schemas/webmcp-interaction-policy.schema.json'));
  assert.equal(schema.properties.schema.const, 'webmcp-interaction-policy/1');
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('budgets'));
  assert.ok(schema.properties.mode.enum.includes('direct') && schema.properties.mode.enum.includes('paced'));
  assert.ok(schema.properties.budgets.required.includes('timeoutMs'));
  assert.ok(schema.properties.budgets.properties.maxChunks.maximum === 256);
});

test('interaction unicode vectors are synthetic and grapheme-safe', () => {
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/interaction-unicode-vectors.json'));
  assert.equal(vectors.schema, 'webmcp-interaction-unicode-vectors/1');
  const ids = vectors.vectors.map((v) => v.id);
  assert.ok(ids.includes('vi-nfc-precomposed'));
  assert.ok(ids.includes('emoji-zwj-family'));
  assert.ok(ids.includes('ime-composition'));
  assert.ok(ids.includes('react-controlled'));
  const vi = vectors.vectors.find((v) => v.id === 'vi-nfc-precomposed');
  assert.equal(vi.expectChunks, 'grapheme-safe');
  const zwj = vectors.vectors.find((v) => v.id === 'emoji-zwj-family');
  assert.ok(zwj.codepoints.includes('U+200D'));
});

test('interaction policy determinism fields are provisional but bounded', () => {
  const schema = loadJson(path.join(ROOT, 'schemas/webmcp-interaction-policy.schema.json'));
  assert.ok('timing' in schema.properties);
  assert.ok(schema.properties.timing.properties.seed.pattern.includes('seed_'));
  assert.ok(schema.properties.timing.properties.deterministic.type === 'boolean');
});

test('RED: paced interaction requires opt-in and total budget enforcement is missing', () => {
  // Future: lib/interaction/pace.mjs or extension pacing handler. A1 must stay RED.
  const candidates = [
    path.join(ROOT, 'lib/interaction/pace.mjs'),
    path.join(ROOT, 'server/interaction/policy.mjs'),
    path.join(ROOT, 'webmcp-extension/dist/bg/handlers/cdp-input.js'),
  ];
  // cdp-input.js exists but does not yet implement paced budgets deterministically; check dedicated file
  const paceImpl = path.join(ROOT, 'lib/interaction/pace.mjs');
  assert.ok(
    existsSync(paceImpl),
    `RED: missing paced interaction capability — ${paceImpl} not found (also searched ${candidates.slice(1).join(', ')}). ` +
      `Expected: direct default, paced only with explicit validated requirement, ` +
      `every action/stage has bounded elapsed/chunk/scroll/retry budgets, ` +
      `timing min/max with global cap, deterministic seed replay, ` +
      `postcondition/read-back drives success not DOM quiet. Vectors interaction-unicode-vectors.json + budgets/timeoutMs. ` +
      `Do not touch contested gateway handlers in A1.`
  );
});

test('RED: Vietnamese/emoji/IME/contenteditable conformance matrix is missing', () => {
  const impl = path.join(ROOT, 'lib/interaction/pace.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing interaction conformance — ${impl} not found. ` +
      `Expected: NFC/NFD combining, emoji ZWJ/variation, IME compositionstart/update/end, ` +
      `contenteditable caret/selection, React/Vue controlled inputs verified via app state not DOM attribute, ` +
      `bounded settle, no fake delay proof. Vectors vi-nfc-precomposed .. react-controlled .. ime-composition.`
  );
});

test('RED: deterministic seed derivation is missing (seed must not derive from secret/claim/fence)', () => {
  const impl = path.join(ROOT, 'lib/interaction/pace.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing deterministic replay — ${impl} not found. ` +
      `Expected: xoshiro128/splitmix64 pinned algorithm, seed fixed per admitted attempt, ` +
      `effective delays logged bounded, replay same policy/seed gives same timing sequence, ` +
      `seed never derived from secret/claimToken/fenceToken.`
  );
});
