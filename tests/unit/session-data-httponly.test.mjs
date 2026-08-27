import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('session-data grant schema has explicit HttpOnly flag and does not assume JS fallback', () => {
  const grant = loadJson(path.join(ROOT, 'schemas/webmcp-session-data-grant.schema.json'));
  assert.ok('includeHttpOnly' in grant.properties, 'grant must have includeHttpOnly boolean');
  assert.equal(grant.properties.includeHttpOnly.type, 'boolean');
  // capability says page JS must not be fallback
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/session-data-scope-vectors.json'));
  const vDenied = vectors.vectors.find((v) => v.id === 'cookie-httponly-without-flag-denied');
  const vAllowed = vectors.vectors.find((v) => v.id === 'cookie-httponly-with-flag-allowed');
  assert.equal(vDenied.expect, 'SESSION_DATA_HTTPONLY_NOT_GRANTED');
  assert.ok(vAllowed.expect.includes('allow'));
});

test('HttpOnly vectors are synthetic canaries, not real cookies', () => {
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/session-data-canonical-vectors.json'));
  const canary = vectors.vectors.find((v) => v.id === 'canary-cookie-values');
  assert.ok(canary && canary.canaries.some((c) => c.httpOnly === true && c.value.startsWith('canary_')));
});

test('HttpOnly grant instance validates (AJV) and scope vectors are not full grant instances', async () => {
  const { default: Ajv } = await import('ajv');
  const { default: addFormats } = await import('ajv-formats');
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
  addFormats(ajv);
  const grantSchema = loadJson(path.join(ROOT, 'schemas/webmcp-session-data-grant.schema.json'));
  const validate = ajv.compile(grantSchema);
  // scope vectors with HttpOnly snippets are request/expectation, not full grant
  const scopeVectors = loadJson(path.join(ROOT, 'tests/fixtures/session-data-scope-vectors.json'));
  const snippet = scopeVectors.vectors.find((v) => v.id === 'cookie-httponly-without-flag-denied').grant;
  assert.equal(validate(snippet), false, 'HttpOnly scope snippet should not validate as full grant instance');
});

test('RED: HttpOnly cookie value read via CDP/Chrome API requires explicit grant is missing', () => {
  const impl = path.join(ROOT, 'server/session-data/http-only-handler.mjs');
  const fallback = path.join(ROOT, 'server/session-data/scope-validator.mjs');
  const found = existsSync(impl) || existsSync(fallback);
  assert.ok(
    found && existsSync(impl),
    `RED: missing HttpOnly grant enforcement — expected ${impl} to exist (fallback ${fallback} also missing). ` +
      `Expected: HttpOnly value MAY be read only via CDP/Chrome Network.getCookies path when runtime permission passes, ` +
      `grant has scoped-values/export, exact selector + explicit includeHttpOnly passes, destination/transcript approval passes, ` +
      `active fence valid; page JS fallback is forbidden; otherwise SESSION_DATA_HTTPONLY_NOT_GRANTED / PERMISSION_UNAVAILABLE. ` +
      `Vectors cookie-httponly-without-flag-denied vs cookie-httponly-with-flag-allowed. D3 approval provisional.`
  );
});

test('RED: HttpOnly export still requires high-risk explicit grant per D3 provisional', () => {
  const impl = path.join(ROOT, 'server/session-data/grant.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing high-risk HttpOnly export gate — ${impl} not found. ` +
      `Expected: full cookie value and HttpOnly require high-risk explicit grant with human approval covering exact scope+purpose+TTL+maxUses+destination (D3 provisional: Fleet/human/both still open), ` +
      `artifact export is separate class from read and not implied, Vault vs session-data cookie are different authorities.`
  );
});
