import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER_FIXTURE_ROOT = path.resolve(ROOT, '..', 'webmcp-automation-runner', 'tests', 'fixtures');

function jcs(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) throw new Error('lone surrogate');
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('lone surrogate');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    if (Object.is(value, -0)) return '0';
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((e) => jcs(e)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => {
      const au = [...a].map((c) => c.codePointAt(0));
      const bu = [...b].map((c) => c.codePointAt(0));
      // For surrogate pairs, compare UTF-16 code units like Runner does
      const aUnits = [];
      const bUnits = [];
      for (let i = 0; i < a.length; i += 1) {
        const c = a.charCodeAt(i);
        aUnits.push(c);
      }
      for (let i = 0; i < b.length; i += 1) {
        const c = b.charCodeAt(i);
        bUnits.push(c);
      }
      const len = Math.min(aUnits.length, bUnits.length);
      for (let i = 0; i < len; i += 1) {
        if (aUnits[i] !== bUnits[i]) return aUnits[i] - bUnits[i];
      }
      return aUnits.length - bUnits.length;
    });
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
  }
  throw new Error(`unsupported type ${typeof value}`);
}

// Use exact LF framing per D1: domainLabel + LF + JCS(protected)
function digestLf(domainLabel, protectedProjection) {
  const payload = `${domainLabel}\n${jcs(protectedProjection)}`;
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function fileSha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// Shared fixtures byte identity
test('parity: shared fixtures are byte-identical to Runner copies', () => {
  const shared = ['claim-digest-vectors.json', 'admission-binding-vectors.json', 'permit-vectors.json'];
  for (const name of shared) {
    const browserPath = path.join(ROOT, 'tests', 'fixtures', name);
    const runnerPath = path.join(RUNNER_FIXTURE_ROOT, name);
    const browserHash = fileSha256(browserPath);
    const runnerHash = fileSha256(runnerPath);
    assert.equal(browserHash, runnerHash, `shared fixture ${name} must be byte-identical: browser ${browserHash} vs runner ${runnerHash}`);
    // Also verify file is valid JSON
    const data = readJson(browserPath);
    assert.ok(typeof data.schema === 'string');
    assert.ok(Array.isArray(data.vectors));
  }
});

// Recompute shared digests without importing runtime
test('parity: claim-digest shared vectors recompute with LF framing and D1 domain labels', () => {
  const data = readJson(path.join(ROOT, 'tests', 'fixtures', 'claim-digest-vectors.json'));
  assert.equal(data.schema, 'webmcp-fixture-vectors/1');
  for (const vec of data.vectors) {
    if (vec.canonical && vec.digest && vec.domainSeparation) {
      // jcs of value/projection must equal canonical
      const value = vec.value ?? vec.projection;
      // For mutation vector, check separately
      if (vec.name === 'mutation-proves-digest-fails') {
        assert.ok(vec.baseDigest);
        assert.ok(vec.mutatedDigest);
        assert.equal(digestLf(vec.domainSeparation, vec.baseValue), vec.baseDigest);
        assert.equal(digestLf(vec.domainSeparation, vec.mutatedValue), vec.mutatedDigest);
        assert.notEqual(vec.baseDigest, vec.mutatedDigest);
        // Also check canonicals
        assert.equal(jcs(vec.baseValue), vec.baseCanonical);
        assert.equal(jcs(vec.mutatedValue), vec.mutatedCanonical);
        continue;
      }
      const projected = vec.value;
      assert.equal(jcs(projected), vec.canonical, `canonical mismatch for ${vec.name}`);
      const recomputed = digestLf(vec.domainSeparation, projected);
      assert.equal(recomputed, vec.digest, `digest mismatch for ${vec.name}: expected ${vec.digest} got ${recomputed}`);
      // Domain label must be one of D1 exact set
      const validDomains = new Set(['webmcp-digest-v1:binding', 'webmcp-digest-v1:claim', 'webmcp-digest-v1:lease', 'webmcp-digest-v1:fence', 'webmcp-digest-v1:grant', 'webmcp-digest-v1:permit', 'webmcp-digest-v1:terminal', 'webmcp-digest-v1:tool-receipt']);
      assert.ok(validDomains.has(vec.domainSeparation), `unexpected domain ${vec.domainSeparation} for ${vec.name}`);
    }
  }
});

test('parity: admission-binding shared vectors recompute with LF and excluded field handling', () => {
  const data = readJson(path.join(ROOT, 'tests', 'fixtures', 'admission-binding-vectors.json'));
  assert.equal(data.contract, 'webmcp-profile-admission-binding/1');
  for (const vec of data.vectors) {
    assert.match(vec.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(typeof vec.canonical, 'string');
    // protected projection is vec.projection (excludes createdAt), not vec.value
    const protectedProjection = vec.projection ?? (() => {
      const { createdAt, ...rest } = vec.value;
      return rest;
    })();
    assert.equal(jcs(protectedProjection), vec.canonical, `canonical mismatch for ${vec.name}`);
    const recomputed = digestLf(vec.domainSeparation, protectedProjection);
    assert.equal(recomputed, vec.digest, `digest mismatch for ${vec.name}`);
    assert.equal(vec.domainSeparation, 'webmcp-digest-v1:binding');
    assert.ok(Array.isArray(vec.excludedFromDigest) && vec.excludedFromDigest.includes('createdAt'));
  }
});

test('parity: permit shared vectors recompute with LF and detached signature exclusion', () => {
  const data = readJson(path.join(ROOT, 'tests', 'fixtures', 'permit-vectors.json'));
  assert.equal(data.contract, 'webmcp-execution-permit/1');
  for (const vec of data.vectors) {
    assert.match(vec.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(vec.signatureExcluded, true);
    // projection excludes signature
    const protectedProjection = vec.projection;
    assert.ok(!('signature' in protectedProjection), `projection must not contain signature for ${vec.name}`);
    assert.equal(jcs(protectedProjection), vec.canonical, `canonical mismatch for ${vec.name}`);
    const recomputed = digestLf(vec.domainSeparation, protectedProjection);
    assert.equal(recomputed, vec.digest, `digest mismatch for ${vec.name}`);
    assert.equal(vec.domainSeparation, 'webmcp-digest-v1:permit');
    // Mutated nonce must change digest
    if (vec.name === 'valid-permit-ttl-60s') {
      const sibling = data.vectors.find((v) => v.name === 'permit-replay-sibling-nonce');
      assert.ok(sibling);
      assert.notEqual(vec.digest, sibling.digest);
      assert.notEqual(vec.value.nonce, sibling.value.nonce);
    }
  }
});

test('parity: browser local fixtures use D1 LF framing and one exact domain-label set', () => {
  const validDomains = new Set(['webmcp-digest-v1:binding', 'webmcp-digest-v1:claim', 'webmcp-digest-v1:lease', 'webmcp-digest-v1:fence', 'webmcp-digest-v1:grant', 'webmcp-digest-v1:permit', 'webmcp-digest-v1:terminal', 'webmcp-digest-v1:tool-receipt']);
  // Check governor
  const gov = readJson(path.join(ROOT, 'tests', 'fixtures', 'governor-lease-vectors.json'));
  for (const vec of gov.vectors) {
    if (vec.protectedProjections) {
      for (const [key, proj] of Object.entries(vec.protectedProjections)) {
        assert.ok(validDomains.has(proj.domainLabel), `gov vector ${vec.id} has invalid domain ${proj.domainLabel}`);
        if (proj.projection) {
          assert.equal(jcs(proj.projection), proj.canonical);
          assert.equal(digestLf(proj.domainLabel, proj.projection), proj.digest);
        } else {
          // projection omitted when it is the same as canonical's parsed JSON; verify via canonical bytes directly
          const recomputed = `sha256:${createHash('sha256').update(`${proj.domainLabel}\n${proj.canonical}`, 'utf8').digest('hex')}`;
          assert.equal(recomputed, proj.digest, `digest mismatch for gov ${vec.id}.${key} via canonical`);
        }
        assert.match(proj.digest, /^sha256:[0-9a-f]{64}$/);
        // No placeholder
        assert.ok(!/^sha256:(a{64}|b{64}|c{64}|d{64}|e{64}|f{64}|0{64}|1{64})$/.test(proj.digest));
      }
    }
    if (vec.mutation && vec.mutation.mutatedDigest) {
      assert.notEqual(vec.mutation.mutatedDigest, vec.protectedProjections?.leaseBindingDigest?.digest ?? vec.protectedProjections?.bindingDigest?.digest);
    }
  }
  // Check fence
  const fence = readJson(path.join(ROOT, 'tests', 'fixtures', 'fence-proof-vectors.json'));
  for (const vec of fence.vectors) {
    if (vec.protectedProjections) {
      for (const proj of Object.values(vec.protectedProjections)) {
        assert.ok(validDomains.has(proj.domainLabel));
        assert.match(proj.digest, /^sha256:[0-9a-f]{64}$/);
        if (proj.projection && proj.canonical) {
          assert.equal(jcs(proj.projection), proj.canonical);
          assert.equal(digestLf(proj.domainLabel, proj.projection), proj.digest);
        } else if (proj.canonical) {
          const recomputed = `sha256:${createHash('sha256').update(`${proj.domainLabel}\n${proj.canonical}`, 'utf8').digest('hex')}`;
          assert.equal(recomputed, proj.digest);
        } else {
          // Only digest available (e.g., heartbeat vector) — just check format and domain
          assert.ok(validDomains.has(proj.domainLabel));
        }
      }
    }
  }
  // Check recovery
  const recovery = readJson(path.join(ROOT, 'tests', 'fixtures', 'recovery-receipt-vectors.json'));
  for (const vec of recovery.vectors) {
    if (vec.protectedProjections) {
      for (const proj of Object.values(vec.protectedProjections)) {
        assert.ok(validDomains.has(proj.domainLabel));
        if (proj.digest) assert.match(proj.digest, /^sha256:[0-9a-f]{64}$/);
        if (proj.canonical) {
          if (proj.projection) assert.equal(jcs(proj.projection), proj.canonical);
          if (proj.digest) {
            const expected = proj.projection ? digestLf(proj.domainLabel, proj.projection) : `sha256:${createHash('sha256').update(`${proj.domainLabel}\n${proj.canonical}`, 'utf8').digest('hex')}`;
            assert.equal(expected, proj.digest);
          }
        }
      }
    }
    if (vec.sequence) {
      for (const s of vec.sequence) {
        if (s.digest || s.receiptDigest) {
          const d = s.digest ?? s.receiptDigest;
          assert.match(d, /^sha256:[0-9a-f]{64}$/);
        }
      }
    }
  }
  // Check canonical
  const canonical = readJson(path.join(ROOT, 'tests', 'fixtures', 'session-data-canonical-vectors.json'));
  assert.ok(canonical.domainLabels.binding === 'webmcp-digest-v1:binding');
  for (const vec of canonical.vectors) {
    if (vec.domainLabel) {
      assert.ok(validDomains.has(vec.domainLabel), `canonical vector ${vec.id} invalid domain ${vec.domainLabel}`);
      if (vec.protectedProjection) {
        assert.equal(jcs(vec.protectedProjection), vec.canonicalJson);
        assert.equal(digestLf(vec.domainLabel, vec.protectedProjection), vec.digest);
      }
    }
    if (vec.mutation && vec.mutation.mutatedDigest) {
      assert.notEqual(vec.digest, vec.mutation.mutatedDigest);
    }
  }
});

test('parity: all computed digests are lowercase hex and no placeholder aaaa/bbbb remain for computed digests', () => {
  // Only computed digest fields (digest, bindingDigest, claimDigest etc when they are the vector's primary digest) are checked; input canary digests like approvalDigest may remain synthetic placeholder per Runner parity but must not be the vector's primary digest.
  const filesAndFields = [
    ['governor-lease-vectors.json', (j) => {
      const digests = [];
      for (const vec of j.vectors) {
        if (vec.expectedLease) digests.push(vec.expectedLease.bindingDigest, vec.expectedLease.runnerClaimDigest, vec.expectedLease.leaseBindingDigest);
        if (vec.protectedProjections) for (const p of Object.values(vec.protectedProjections)) if (p.digest) digests.push(p.digest);
        if (vec.mutation && vec.mutation.mutatedDigest) digests.push(vec.mutation.mutatedDigest);
      }
      return digests;
    }],
    ['fence-proof-vectors.json', (j) => {
      const digests = [];
      for (const vec of j.vectors) if (vec.proof) digests.push(vec.proof.fenceDigest, vec.proof.leaseBindingDigest);
      for (const vec of j.vectors) if (vec.protectedProjections) for (const p of Object.values(vec.protectedProjections)) digests.push(p.digest);
      return digests;
    }],
    ['recovery-receipt-vectors.json', (j) => {
      const digests = [];
      for (const vec of j.vectors) {
        if (vec.receipt) digests.push(vec.receipt.receiptDigest);
        if (vec.receiptAfterClear) digests.push(vec.receiptAfterClear.receiptDigest);
        if (vec.protectedProjections) for (const p of Object.values(vec.protectedProjections)) if (p.digest) digests.push(p.digest);
        if (vec.sequence) for (const s of vec.sequence) digests.push(s.receiptDigest);
      }
      return digests;
    }],
    ['session-data-canonical-vectors.json', (j) => j.vectors.filter((v) => v.digest).map((v) => v.digest).concat(j.vectors.filter((v) => v.mutation).map((v) => v.mutation.mutatedDigest).filter(Boolean))],
    ['claim-digest-vectors.json', (j) => j.vectors.map((v) => v.digest).concat(j.vectors.filter((v) => v.mutatedDigest).map((v) => v.mutatedDigest)).concat(j.vectors.filter((v) => v.baseDigest).map((v) => v.baseDigest))],
    ['admission-binding-vectors.json', (j) => j.vectors.map((v) => v.digest)],
    ['permit-vectors.json', (j) => j.vectors.map((v) => v.digest)],
  ];
  for (const [name, extractor] of filesAndFields) {
    const j = readJson(path.join(ROOT, 'tests', 'fixtures', name));
    const digests = extractor(j).filter(Boolean);
    for (const d of digests) {
      assert.match(d, /^sha256:[0-9a-f]{64}$/, `computed digest not lowercase hex in ${name}: ${d}`);
      const hex = d.split(':')[1];
      assert.ok(!/^a{64}$/.test(hex) && !/^b{64}$/.test(hex) && !/^c{64}$/.test(hex) && !/^d{64}$/.test(hex) && !/^e{64}$/.test(hex) && !/^f{64}$/.test(hex) && !/^0{64}$/.test(hex), `placeholder computed digest ${d} in ${name}`);
    }
  }
});

test('parity: synthetic IDs are prefixed lowercase hex with 16 hex chars', () => {
  const check = (id, pattern) => assert.match(id, pattern, `ID ${id} must match ${pattern}`);
  const gov = readJson(path.join(ROOT, 'tests', 'fixtures', 'governor-lease-vectors.json'));
  for (const vec of gov.vectors) {
    if (vec.expectedLease) check(vec.expectedLease.leaseId, /^lease_[0-9a-f]{16}$/);
    if (vec.lease && vec.lease.leaseId) check(vec.lease.leaseId, /^lease_[0-9a-f]{16}$/);
    if (vec.newLeaseAfterReclaim) check(vec.newLeaseAfterReclaim.leaseId, /^lease_[0-9a-f]{16}$/);
    if (vec.leaseId) check(vec.leaseId, /^lease_[0-9a-f]{16}$/);
  }
  const fence = readJson(path.join(ROOT, 'tests', 'fixtures', 'fence-proof-vectors.json'));
  for (const vec of fence.vectors) {
    if (vec.proof && vec.proof.fenceId) check(vec.proof.fenceId, /^fence_[0-9a-f]{16}$/);
    if (vec.proof && vec.proof.leaseId) check(vec.proof.leaseId, /^lease_[0-9a-f]{16}$/);
  }
  const recovery = readJson(path.join(ROOT, 'tests', 'fixtures', 'recovery-receipt-vectors.json'));
  for (const vec of recovery.vectors) {
    if (vec.receipt) check(vec.receipt.receiptId, /^prr_[0-9a-f]{16}$/);
    if (vec.receiptAfterClear) check(vec.receiptAfterClear.receiptId, /^prr_[0-9a-f]{16}$/);
    if (vec.event) check(vec.event.eventId, /^pse_[0-9a-f]{16}$/);
  }
});
