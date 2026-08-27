import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

test('RED: host restart recovery must not resurrect stale lease as ready', () => {
  const impl = path.join(ROOT, 'server/profile-governor/recovery.mjs');
  const eventImpl = path.join(ROOT, 'server/profile-governor/events.mjs');
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
  const impl = path.join(ROOT, 'server/profile-governor/recovery.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing indeterminate-effect quarantine — ${impl} not found. ` +
      `Expected: dispatched->confirmed/failed-known/indeterminate journal; outward indeterminate quarantines, ` +
      `retry blocked, dependent Vault grants revoked, recovery receipt persisted with lastActionOutcome, ` +
      `new monotonic epoch before next owner. Vector recovery-process-crash-indeterminate-quarantine.`
  );
});

test('RED: manual external_use blocks automation and requires operator reconcile', () => {
  const impl = path.join(ROOT, 'server/profile-governor/recovery.mjs');
  assert.ok(
    existsSync(impl),
    `RED: missing external_use lifecycle — ${impl} not found. ` +
      `Expected: external.acquire/heartbeat/release/detect/adopt, registered manual lease exclusive, ` +
      `unregistered detection yields PROFILE_EXTERNAL_USE, scheduled automation fails typed, ` +
      `no automatic adopt. Vector recovery-manual-external-use-detected. D6 provisional owner is Governor.`
  );
});
