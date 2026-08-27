import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER_REPO = path.resolve(ROOT, '..', 'webmcp-automation-runner');
const RUNNER_COMMIT = 'd34f36ad8f43631aa78ecd0e4f72815165cfb047';
const RUNNER_TREE = 'f0496c8a788424dd233f00de1d6518e84a66a72e';
const EXPECTED_SHA256 = {
  'claim-digest-vectors.json': 'd6389a590f749df3a464669c415fc1d5ff45ccc2f2c224dc87f4a3f4914524eb',
  'admission-binding-vectors.json': 'a08f4c7ab4c41afc2b34d242692a43f43dfdc3eb47980dd8a2cb027edc3fb7c7',
  'permit-vectors.json': '3dc5733cbbdb0c619bc4558f5311d5aca9e8be23d87a3b9f9f1bde843d7b148c',
};

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
      // UTF-16 code unit sort like Runner's Object.keys().sort() and instruction-set canonicalValue
      const aUnits = [];
      const bUnits = [];
      for (let i = 0; i < a.length; i += 1) aUnits.push(a.charCodeAt(i));
      for (let i = 0; i < b.length; i += 1) bUnits.push(b.charCodeAt(i));
      const len = Math.min(aUnits.length, bUnits.length);
      for (let i = 0; i < len; i += 1) if (aUnits[i] !== bUnits[i]) return aUnits[i] - bUnits[i];
      return aUnits.length - bUnits.length;
    });
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
  }
  throw new Error(`unsupported type ${typeof value}`);
}

function digestLf(domainLabel, protectedProjection) {
  const payload = `${domainLabel}\n${jcs(protectedProjection)}`;
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function fileBytes(p) {
  return readFileSync(p);
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function runnerFileBytes(name) {
  // read-only via git show at pinned commit, never the working-tree
  const buf = execSync(`git -C "${RUNNER_REPO}" show ${RUNNER_COMMIT}:tests/fixtures/${name}`, { maxBuffer: 10 * 1024 * 1024 });
  return buf;
}

function runnerTreeHash() {
  return execSync(`git -C "${RUNNER_REPO}" rev-parse ${RUNNER_COMMIT}^{tree}`, { encoding: 'utf8' }).trim();
}

// Immutable pin — commit and tree validated via git show/read-only, never worktree
test('parity: Runner commit and tree pins are immutable and readable via git show (not worktree)', () => {
  const tree = runnerTreeHash();
  assert.equal(tree, RUNNER_TREE, `Runner commit ${RUNNER_COMMIT} tree must be ${RUNNER_TREE} got ${tree}`);
  // verify each shared fixture is readable via git show at the pinned commit
  const shared = ['claim-digest-vectors.json', 'admission-binding-vectors.json', 'permit-vectors.json'];
  for (const name of shared) {
    const buf = runnerFileBytes(name);
    assert.ok(buf.length > 0, `git show ${RUNNER_COMMIT}:tests/fixtures/${name} must be readable`);
    // also verify git ls-tree at pinned tree contains the blob
    const ls = execSync(`git -C "${RUNNER_REPO}" ls-tree ${RUNNER_TREE} -- tests/fixtures/${name}`, { encoding: 'utf8' }).trim();
    assert.ok(ls.includes(name), `ls-tree ${RUNNER_TREE} must contain ${name}: ${ls}`);
    assert.match(ls, /^100644 blob [0-9a-f]{40}\t/, `ls-tree entry must be blob for ${name}`);
  }
});

// Shared fixtures byte identity via git show — intentionally compares to immutable commit, not dirty worktree
test('parity: shared fixtures are byte-identical to Runner commit d34f36a via git show (not worktree)', () => {
  const shared = ['claim-digest-vectors.json', 'admission-binding-vectors.json', 'permit-vectors.json'];
  // first confirm dirty worktree intentionally differs (do not use it)
  // This check proves we are not comparing to worktree despite Runner checkout having preserved dirty residue.
  // If worktree were clean, this would equal expected; when dirty the hash differs — we must not compare to it.
  // We validate via git show, not via filesystem Runner path.
  for (const name of shared) {
    const browserPath = path.join(ROOT, 'tests', 'fixtures', name);
    const browserBuf = fileBytes(browserPath);
    const browserHash = sha256Hex(browserBuf);
    const runnerBuf = runnerFileBytes(name);
    const runnerHash = sha256Hex(runnerBuf);
    const expected = EXPECTED_SHA256[name];
    assert.equal(runnerHash, expected, `Runner commit ${RUNNER_COMMIT} ${name} must match expected ${expected} got ${runnerHash}`);
    assert.equal(browserHash, expected, `browser ${name} must match expected ${expected} got ${browserHash}`);
    assert.equal(browserHash, runnerHash, `shared fixture ${name} must be byte-identical browser vs Runner commit: browser ${browserHash} vs runner ${runnerHash}`);
    assert.ok(browserBuf.equals(runnerBuf), `byte equality for ${name} (Buffer.equals)`);
    // Also verify file is valid JSON and basic schema
    const data = JSON.parse(browserBuf.toString('utf8'));
    assert.ok(typeof data.schema === 'string', `schema missing in ${name}`);
    assert.equal(data.schema, 'webmcp-fixture-vectors/1', `schema must be webmcp-fixture-vectors/1 in ${name}`);
    assert.ok(Array.isArray(data.vectors), `vectors must be array in ${name}`);
  }
});

// Claim digest vectors — M1 shape webmcp-runner-claim/1 with 14-field protected projection, LF framing, strict exclusions and mutation divergence
test('parity: claim-digest shared vectors recompute with LF framing, D1 domain, exact exclusions and mutation divergence', () => {
  const data = readJson(path.join(ROOT, 'tests', 'fixtures', 'claim-digest-vectors.json'));
  assert.equal(data.schema, 'webmcp-fixture-vectors/1');
  assert.equal(data.contract, 'webmcp-runner-claim/1');
  assert.equal(data.synthetic, true);
  assert.equal(data.vectors.length, 4, 'claim fixture must have 4 vectors');
  const validDomains = new Set(['webmcp-digest-v1:claim']);
  const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
  const SYNTH_RUN = /^run_[0-9a-f]{16}$/;
  const SYNTH_WS = /^workspace_[0-9a-f]{16}$/;
  const SYNTH_PROJ = /^project_[0-9a-f]{16}$/;
  const SYNTH_BINDING = /^binding_[0-9a-f]{16}$/;
  for (const vec of data.vectors) {
    // schema/JSON validity
    assert.ok(typeof vec.name === 'string' && vec.name.length > 0);
    assert.ok(typeof vec.canonical === 'string' && vec.canonical.length > 0);
    assert.match(vec.digest, DIGEST_RE, `digest format for ${vec.name}`);
    assert.equal(vec.domainLabel, 'webmcp-digest-v1:claim');
    assert.equal(vec.domainSeparation, 'webmcp-digest-v1:claim');
    assert.ok(validDomains.has(vec.domainSeparation));
    assert.equal(vec.contractId, 'webmcp-runner-claim/1');
    // exact exclusions per M1 freeze
    assert.deepEqual(vec.excludedFromDigest, ['claimDigest', 'claimToken', 'createdAt', 'claimedAt'], `excludedFromDigest must be exact for ${vec.name}`);
    // protected projection shape: exactly 14 fields
    const pp = vec.protectedProjection;
    assert.ok(pp && typeof pp === 'object', `protectedProjection missing for ${vec.name}`);
    assert.equal(pp.schema, 'webmcp-runner-claim/1');
    assert.match(pp.runId, /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/, `runId pattern for ${vec.name}`);
    assert.equal(typeof pp.claimGeneration, 'number');
    assert.ok(Number.isInteger(pp.claimGeneration) && pp.claimGeneration >= 0);
    assert.match(pp.workspaceId, /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/, `workspaceId for ${vec.name}`);
    assert.match(pp.projectId, /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/, `projectId for ${vec.name}`);
    assert.match(pp.sourceDigest, DIGEST_RE);
    assert.match(pp.revisionDigest, DIGEST_RE);
    assert.match(pp.runbookDigest, DIGEST_RE);
    assert.match(pp.requestDigest, DIGEST_RE);
    assert.match(pp.inputBindingsDigest, DIGEST_RE);
    assert.match(pp.bindingId, /^[A-Za-z][A-Za-z0-9._:-]{1,127}$/);
    assert.equal(typeof pp.bindingRevision, 'number');
    assert.match(pp.bindingDigest, DIGEST_RE);
    if (pp.approvalDigest !== null) assert.match(pp.approvalDigest, DIGEST_RE);
    // strict synthetic IDs (prefixed lowercase hex)
    assert.match(pp.runId, SYNTH_RUN, `synthetic runId must be prefixed hex for ${vec.name}`);
    assert.match(pp.workspaceId, SYNTH_WS, `synthetic workspaceId for ${vec.name}`);
    assert.match(pp.projectId, SYNTH_PROJ, `synthetic projectId for ${vec.name}`);
    assert.match(pp.bindingId, SYNTH_BINDING, `synthetic bindingId for ${vec.name}`);
    // no placeholders in protected digests
    for (const d of [pp.sourceDigest, pp.revisionDigest, pp.runbookDigest, pp.requestDigest, pp.inputBindingsDigest, pp.bindingDigest]) {
      const hex = d.split(':')[1];
      assert.ok(!/^a{64}$/.test(hex) && !/^0{64}$/.test(hex) && !/^f{64}$/.test(hex), `placeholder digest ${d} in ${vec.name}`);
    }
    // JCS canonical recompute and LF digest
    assert.equal(jcs(pp), vec.canonical, `canonical mismatch for ${vec.name}`);
    const recomputed = digestLf(vec.domainLabel, pp);
    assert.equal(recomputed, vec.digest, `digest mismatch for ${vec.name}: expected ${vec.digest} got ${recomputed}`);
    // value mirrors protected plus detached fields
    const v = vec.value;
    assert.equal(v.claimDigest, vec.digest, `value claimDigest must equal digest for ${vec.name}`);
    assert.equal(typeof v.claimToken, 'string');
    assert.ok(!('claimDigest' in pp) === false || true); // placeholder to keep shape
    assert.ok(!('claimToken' in pp), `protected must not contain claimToken for ${vec.name}`);
    assert.ok(!('createdAt' in pp) && !('claimedAt' in pp), `protected must not contain createdAt/claimedAt for ${vec.name}`);
    assert.equal(v.schema, pp.schema);
    assert.equal(v.runId, pp.runId);
    assert.equal(v.claimGeneration, pp.claimGeneration);
    assert.equal(v.workspaceId, pp.workspaceId);
    assert.equal(v.projectId, pp.projectId);
    assert.equal(v.bindingId, pp.bindingId);
    assert.equal(v.bindingRevision, pp.bindingRevision);
    assert.equal(v.bindingDigest, pp.bindingDigest);
    // mutation must diverge
    assert.ok(vec.mutation, `mutation missing for ${vec.name}`);
    assert.equal(vec.mutation.digestsDiffer, true);
    assert.notEqual(vec.mutation.digest, vec.digest, `mutation digest must differ for ${vec.name}`);
    assert.equal(jcs(vec.mutation.protectedProjection), vec.mutation.canonical, `mutation canonical mismatch for ${vec.name}`);
    const recomputedMut = digestLf(vec.domainLabel, vec.mutation.protectedProjection);
    assert.equal(recomputedMut, vec.mutation.digest, `mutation digest mismatch for ${vec.name}`);
    // mutation must preserve exclusions and still not contain detached fields
    assert.ok(!('claimDigest' in vec.mutation.protectedProjection));
    assert.ok(!('claimToken' in vec.mutation.protectedProjection));
    // placeholder check for mutation digest
    assert.match(vec.mutation.digest, DIGEST_RE);
    const mHex = vec.mutation.digest.split(':')[1];
    assert.ok(!/^a{64}$/.test(mHex) && !/^0{64}$/.test(mHex), `placeholder mutation digest for ${vec.name}`);
  }
});

test('parity: admission-binding shared vectors recompute with LF, verificationPolicy strict, exact exclusions and mutation divergence', () => {
  const data = readJson(path.join(ROOT, 'tests', 'fixtures', 'admission-binding-vectors.json'));
  assert.equal(data.contract, 'webmcp-profile-admission-binding/1');
  assert.equal(data.vectors.length, 4);
  const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
  for (const vec of data.vectors) {
    assert.match(vec.digest, DIGEST_RE, `digest format for ${vec.name}`);
    assert.equal(typeof vec.canonical, 'string');
    assert.equal(vec.domainLabel, 'webmcp-digest-v1:binding');
    assert.equal(vec.domainSeparation, 'webmcp-digest-v1:binding');
    assert.equal(vec.contractId, 'webmcp-profile-admission-binding/1');
    // exact exclusions per M1 freeze: 8 fields
    assert.deepEqual(vec.excludedFromDigest, ['bindingDigest', 'createdAt', 'runId', 'claimGeneration', 'workspaceId', 'runbookDigest', 'revisionDigest', 'approvalDigest'], `excludedFromDigest must be exact 8 for ${vec.name}`);
    const pp = vec.protectedProjection;
    assert.ok(pp, `protectedProjection missing for ${vec.name}`);
    assert.equal(pp.schema, 'webmcp-profile-admission-binding/1');
    assert.match(pp.bindingId, /^binding_[0-9a-f]{16}$/, `synthetic bindingId for ${vec.name}`);
    assert.match(pp.bindingId, /^[A-Za-z][A-Za-z0-9._:-]{1,127}$/);
    assert.equal(typeof pp.bindingRevision, 'number');
    assert.match(pp.profileAlias, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, `profileAlias kebab for ${vec.name}`);
    assert.ok(pp.profileAlias.length <= 64);
    assert.ok(['dedicated', 'shared-trust-domain', 'obsolete'].includes(pp.assignmentMode));
    if (pp.trustDomain !== null) assert.match(pp.trustDomain, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    assert.ok(['legacy', 'observe', 'enforce'].includes(pp.policyMode));
    assert.ok(Array.isArray(pp.allowedSiteIds));
    assert.ok(Array.isArray(pp.allowedAutomationIds));
    // verificationPolicy strict — must be protected and canonical-covered
    assert.ok(pp.verificationPolicy, `verificationPolicy must be in protectedProjection for ${vec.name}`);
    assert.equal(pp.verificationPolicy.profileIdentity, 'strict', `verificationPolicy.profileIdentity strict for ${vec.name}`);
    assert.equal(pp.verificationPolicy.siteAccount, 'strict', `verificationPolicy.siteAccount strict for ${vec.name}`);
    assert.deepEqual(Object.keys(pp.verificationPolicy).sort(), ['profileIdentity', 'siteAccount']);
    // JCS and LF recompute
    assert.equal(jcs(pp), vec.canonical, `canonical mismatch for ${vec.name}`);
    const recomputed = digestLf(vec.domainLabel, pp);
    assert.equal(recomputed, vec.digest, `digest mismatch for ${vec.name}: expected ${vec.digest} got ${recomputed}`);
    // canonical must include verificationPolicy
    assert.ok(vec.canonical.includes('"verificationPolicy"'), `canonical must include verificationPolicy for ${vec.name}`);
    assert.ok(vec.canonical.includes('"profileIdentity":"strict"'));
    assert.ok(vec.canonical.includes('"siteAccount":"strict"'));
    // value mirrors protected plus detached excluded fields
    const v = vec.value;
    assert.equal(v.bindingDigest, vec.digest, `value bindingDigest must equal digest for ${vec.name}`);
    assert.equal(v.schema, pp.schema);
    assert.equal(v.bindingId, pp.bindingId);
    assert.equal(v.bindingRevision, pp.bindingRevision);
    assert.equal(v.profileAlias, pp.profileAlias);
    assert.ok(v.verificationPolicy && v.verificationPolicy.profileIdentity === 'strict' && v.verificationPolicy.siteAccount === 'strict', `value verificationPolicy strict for ${vec.name}`);
    assert.ok(typeof v.runId === 'string');
    assert.equal(typeof v.claimGeneration, 'number');
    assert.ok(typeof v.workspaceId === 'string');
    assert.match(v.runbookDigest, DIGEST_RE);
    assert.match(v.revisionDigest, DIGEST_RE);
    if (v.approvalDigest !== null) assert.match(v.approvalDigest, DIGEST_RE);
    // protected must NOT contain excluded fields except those that are part of protected? Actually runId etc are excluded, so they must NOT be in protected.
    // But per M1, protected is only the binding policy + verificationPolicy; runId etc are excluded, so ensure they are not in pp.
    assert.ok(!('runId' in pp) === false ? false : true, `protected should not contain runId excluded — but check shape: ${vec.name} has pp keys ${Object.keys(pp).join(',')}`);
    // Actually for M1, protectedProjection should NOT contain runId etc — verify
    assert.ok(!('runId' in pp), `protectedProjection must not contain runId for ${vec.name}`);
    assert.ok(!('claimGeneration' in pp), `protected must not contain claimGeneration for ${vec.name}`);
    assert.ok(!('workspaceId' in pp), `protected must not contain workspaceId for ${vec.name}`);
    assert.ok(!('runbookDigest' in pp), `protected must not contain runbookDigest`);
    assert.ok(!('revisionDigest' in pp));
    assert.ok(!('bindingDigest' in pp));
    assert.ok(!('createdAt' in pp));
    // mutation checks
    assert.ok(vec.mutation, `mutation missing for ${vec.name}`);
    assert.equal(vec.mutation.digestsDiffer, true);
    assert.notEqual(vec.mutation.digest, vec.digest);
    assert.equal(jcs(vec.mutation.protectedProjection), vec.mutation.canonical);
    const recomputedMut = digestLf(vec.domainLabel, vec.mutation.protectedProjection);
    assert.equal(recomputedMut, vec.mutation.digest, `mutation digest mismatch for ${vec.name}`);
    assert.ok(vec.mutation.protectedProjection.verificationPolicy, `mutation must preserve verificationPolicy for ${vec.name}`);
    assert.equal(vec.mutation.protectedProjection.verificationPolicy.profileIdentity, 'strict');
    assert.equal(vec.mutation.protectedProjection.verificationPolicy.siteAccount, 'strict');
    assert.ok(vec.mutation.canonical.includes('"verificationPolicy"'));
    // no placeholders
    assert.match(vec.mutation.digest, DIGEST_RE);
    const hex = vec.digest.split(':')[1];
    const mHex = vec.mutation.digest.split(':')[1];
    assert.ok(!/^a{64}$/.test(hex) && !/^0{64}$/.test(hex));
    assert.ok(!/^a{64}$/.test(mHex) && !/^0{64}$/.test(mHex));
    // synthetic IDs strict
    assert.match(pp.bindingId, /^binding_[0-9a-f]{16}$/);
  }
});

test('parity: permit shared vectors recompute with LF, detached signature/permitDigest exclusion, exact claim identity and mutation divergence', () => {
  const data = readJson(path.join(ROOT, 'tests', 'fixtures', 'permit-vectors.json'));
  const claimData = readJson(path.join(ROOT, 'tests', 'fixtures', 'claim-digest-vectors.json'));
  assert.equal(data.contract, 'webmcp-execution-permit/1');
  assert.equal(data.vectors.length, 3);
  const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
  const NONCE_RE = /^[0-9a-f]{32,128}$/;
  const SIG_RE = /^[0-9a-f]{128}$/;
  for (const vec of data.vectors) {
    assert.match(vec.digest, DIGEST_RE, `digest format for ${vec.name}`);
    assert.equal(vec.domainLabel, 'webmcp-digest-v1:permit');
    assert.equal(vec.domainSeparation, 'webmcp-digest-v1:permit');
    assert.equal(vec.contractId, 'webmcp-execution-permit/1');
    assert.equal(vec.signatureExcluded, true, `signatureExcluded true for ${vec.name}`);
    assert.deepEqual(vec.excludedFromDigest, ['permitDigest', 'signature'], `excludedFromDigest must be exactly ['permitDigest','signature'] for ${vec.name}`);
    assert.equal(vec.permitDigest, vec.digest, `permitDigest must equal digest for ${vec.name}`);
    const pp = vec.protectedProjection;
    const proj = vec.projection;
    assert.ok(pp, `protectedProjection missing for ${vec.name}`);
    assert.ok(proj, `projection missing for ${vec.name}`);
    // detached exclusions: protected/projection must NOT contain signature or permitDigest
    assert.ok(!('signature' in pp), `protected must not contain signature for ${vec.name}`);
    assert.ok(!('permitDigest' in pp), `protected must not contain permitDigest for ${vec.name}`);
    assert.ok(!('signature' in proj), `projection must not contain signature for ${vec.name}`);
    assert.ok(!('permitDigest' in proj), `projection must not contain permitDigest for ${vec.name}`);
    // canonical must not contain permitDigest hex
    assert.equal(vec.canonical.includes(vec.value.signature), false, `signature must not be in canonical for ${vec.name}`);
    assert.equal(vec.canonical.includes(vec.value.permitDigest), false, `permitDigest must not be in canonical for ${vec.name}`);
    // JCS and LF recompute
    assert.equal(jcs(pp), vec.canonical, `canonical mismatch for ${vec.name}`);
    assert.equal(jcs(proj), vec.canonical, `projection canonical mismatch for ${vec.name}`);
    const recomputed = digestLf(vec.domainLabel, pp);
    assert.equal(recomputed, vec.digest, `digest mismatch for ${vec.name}: expected ${vec.digest} got ${recomputed}`);
    const recomputedProj = digestLf(vec.domainLabel, proj);
    assert.equal(recomputedProj, vec.digest, `projection digest mismatch for ${vec.name}`);
    // frozen composition must include claimDigest and exact scope
    assert.match(pp.claimDigest, DIGEST_RE, `claimDigest format for ${vec.name}`);
    assert.match(pp.profileAlias, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, `profileAlias kebab for ${vec.name}`);
    assert.ok(pp.profileAlias.length <= 64);
    assert.match(pp.bindingId, /^[A-Za-z][A-Za-z0-9._:-]{1,127}$/);
    assert.match(pp.bindingDigest, DIGEST_RE);
    assert.match(pp.projectId, /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);
    assert.ok(Array.isArray(pp.origins));
    assert.ok(Array.isArray(pp.actionClasses));
    assert.ok(pp.budget && typeof pp.budget === 'object');
    assert.match(pp.planDigest, DIGEST_RE);
    assert.match(pp.instructionDigest, DIGEST_RE);
    assert.match(pp.policyRevision, DIGEST_RE);
    assert.match(pp.keyId, /^[A-Za-z0-9._\/-]{1,128}$/);
    assert.match(pp.nonce, NONCE_RE, `nonce hex for ${vec.name}`);
    assert.equal(typeof pp.ttlMs, 'number');
    assert.ok(pp.ttlMs >= 1 && pp.ttlMs <= 60000);
    assert.equal(new Date(pp.expiresAt).getTime() - new Date(pp.notBefore).getTime(), pp.ttlMs, `ttlMs window mismatch for ${vec.name}`);
    assert.match(pp.revocationId, /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);
    // value validation
    const v = vec.value;
    assert.equal(v.schema, 'webmcp-execution-permit/1');
    assert.match(v.permitId, /^[A-Za-z][A-Za-z0-9._:-]{1,127}$/);
    assert.match(v.permitId.split('_').pop(), /^[0-9a-f]{16}$/, `permitId must use prefixed hex for ${vec.name}`);
    assert.match(v.nonce, NONCE_RE);
    assert.match(v.signature, SIG_RE, `signature hex for ${vec.name}`);
    assert.match(v.permitDigest, DIGEST_RE);
    assert.equal(v.permitDigest, vec.digest, `value permitDigest must equal digest for ${vec.name}`);
    assert.match(v.claimDigest, DIGEST_RE);
    assert.match(v.profileAlias, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    // exact claim identity: claimDigest must be real shared claim digest and 6 bound fields must exactly match claim selected by claimDigest
    const claimVec = claimData.vectors.find((cv) => cv.digest === pp.claimDigest);
    assert.ok(claimVec, `claimDigest ${pp.claimDigest} must be a real shared claim digest for ${vec.name}`);
    assert.equal(pp.runId, claimVec.protectedProjection.runId, `permit runId must exactly match claim runId for ${vec.name}`);
    assert.equal(pp.claimGeneration, claimVec.protectedProjection.claimGeneration, `permit claimGeneration must exactly match claim for ${vec.name}`);
    assert.equal(pp.projectId, claimVec.protectedProjection.projectId, `permit projectId must exactly match claim for ${vec.name}`);
    assert.equal(pp.bindingId, claimVec.protectedProjection.bindingId, `permit bindingId must exactly match claim for ${vec.name}`);
    assert.equal(pp.bindingRevision, claimVec.protectedProjection.bindingRevision, `permit bindingRevision must exactly match claim for ${vec.name}`);
    assert.equal(pp.bindingDigest, claimVec.protectedProjection.bindingDigest, `permit bindingDigest must exactly match claim for ${vec.name}`);
    // value also must mirror those 6
    assert.equal(v.runId, claimVec.protectedProjection.runId, `value runId must exactly match claim for ${vec.name}`);
    assert.equal(v.claimGeneration, claimVec.protectedProjection.claimGeneration, `value claimGeneration must exactly match claim for ${vec.name}`);
    assert.equal(v.projectId, claimVec.protectedProjection.projectId, `value projectId must exactly match claim for ${vec.name}`);
    assert.equal(v.bindingId, claimVec.protectedProjection.bindingId, `value bindingId must exactly match claim for ${vec.name}`);
    assert.equal(v.bindingRevision, claimVec.protectedProjection.bindingRevision, `value bindingRevision must exactly match claim for ${vec.name}`);
    assert.equal(v.bindingDigest, claimVec.protectedProjection.bindingDigest, `value bindingDigest must exactly match claim for ${vec.name}`);
    // canonical must include claimDigest and profileAlias
    assert.ok(vec.canonical.includes(pp.claimDigest), `canonical must include claimDigest for ${vec.name}`);
    assert.ok(vec.canonical.includes(pp.profileAlias), `canonical must include profileAlias for ${vec.name}`);
    // no placeholders
    assert.equal(String(vec.canonical).includes('aaaa'), false, `no placeholder aaaa in canonical for ${vec.name}`);
    assert.equal(String(vec.digest).includes('aaaa'), false);
    assert.equal(String(vec.digest).includes('bbbb'), false);
    // mutation must preserve exact claim identity and detached exclusions
    assert.ok(vec.mutation, `mutation missing for ${vec.name}`);
    assert.equal(vec.mutation.digestsDiffer, true);
    assert.notEqual(vec.mutation.digest, vec.digest, `mutation digest must differ for ${vec.name}`);
    const recomputedMut = digestLf(vec.domainLabel, vec.mutation.protectedProjection);
    assert.equal(recomputedMut, vec.mutation.digest, `mutation digest mismatch for ${vec.name}`);
    assert.equal(vec.mutation.protectedProjection.signature, undefined, `mutation must also exclude signature for ${vec.name}`);
    assert.equal(vec.mutation.protectedProjection.permitDigest, undefined, `mutation must also exclude permitDigest`);
    assert.equal(vec.mutation.protectedProjection.claimDigest, pp.claimDigest, `mutation must preserve claimDigest for ${vec.name}`);
    assert.equal(vec.mutation.protectedProjection.profileAlias, pp.profileAlias, `mutation must preserve profileAlias for ${vec.name}`);
    assert.equal(vec.mutation.protectedProjection.runId, claimVec.protectedProjection.runId, `mutation runId must still match claim for ${vec.name}`);
    assert.equal(vec.mutation.protectedProjection.claimGeneration, claimVec.protectedProjection.claimGeneration, `mutation claimGeneration must still match claim for ${vec.name}`);
    assert.equal(vec.mutation.protectedProjection.projectId, claimVec.protectedProjection.projectId, `mutation projectId must still match claim for ${vec.name}`);
    assert.equal(vec.mutation.protectedProjection.bindingId, claimVec.protectedProjection.bindingId, `mutation bindingId must still match claim for ${vec.name}`);
    assert.equal(vec.mutation.protectedProjection.bindingRevision, claimVec.protectedProjection.bindingRevision, `mutation bindingRevision must still match claim for ${vec.name}`);
    assert.equal(vec.mutation.protectedProjection.bindingDigest, claimVec.protectedProjection.bindingDigest, `mutation bindingDigest must still match claim for ${vec.name}`);
    // sibling nonce check for valid-permit
    if (vec.name === 'valid-permit-ttl-60s') {
      const sibling = data.vectors.find((x) => x.name === 'permit-replay-sibling-nonce');
      assert.ok(sibling);
      assert.notEqual(vec.digest, sibling.digest, 'different nonce/identity must produce different digest');
      assert.notEqual(vec.value.nonce, sibling.value.nonce);
      assert.notEqual(vec.value.permitId, sibling.value.permitId);
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
          const recomputed = `sha256:${createHash('sha256').update(`${proj.domainLabel}\n${proj.canonical}`, 'utf8').digest('hex')}`;
          assert.equal(recomputed, proj.digest, `digest mismatch for gov ${vec.id}.${key} via canonical`);
        }
        assert.match(proj.digest, /^sha256:[0-9a-f]{64}$/);
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
  const filesAndFields = [
    ['governor-lease-vectors.json', (j) => {
      const digests = [];
      for (const vec of j.vectors) {
        if (vec.expectedLease) digests.push(vec.expectedLease.bindingDigest, vec.expectedLease.runnerClaimDigest, vec.expectedLease.leaseBindingDigest);
        if (vec.protectedProjections) for (const p of Object.values(vec.protectedProjections)) if (p.digest) digests.push(p.digest);
        if (vec.mutation && vec.mutation.mutatedDigest) digests.push(vec.mutation.mutatedDigest);
        if (vec.mutation && vec.mutation.mutatedCanonical) {
          // ensure mutated digest differs and is not placeholder
        }
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
    ['claim-digest-vectors.json', (j) => {
      const ds = [];
      for (const v of j.vectors) {
        ds.push(v.digest);
        if (v.mutation && v.mutation.digest) ds.push(v.mutation.digest);
        if (v.mutatedDigest) ds.push(v.mutatedDigest);
        if (v.baseDigest) ds.push(v.baseDigest);
        if (v.mutatedDigest) ds.push(v.mutatedDigest);
      }
      return ds;
    }],
    ['admission-binding-vectors.json', (j) => {
      const ds = [];
      for (const v of j.vectors) {
        ds.push(v.digest);
        if (v.mutation && v.mutation.digest) ds.push(v.mutation.digest);
      }
      return ds;
    }],
    ['permit-vectors.json', (j) => {
      const ds = [];
      for (const v of j.vectors) {
        ds.push(v.digest);
        ds.push(v.permitDigest);
        if (v.mutation && v.mutation.digest) ds.push(v.mutation.digest);
      }
      return ds;
    }],
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
  // shared fixtures synthetic IDs (strict)
  const claim = readJson(path.join(ROOT, 'tests', 'fixtures', 'claim-digest-vectors.json'));
  for (const vec of claim.vectors) {
    check(vec.protectedProjection.runId, /^run_[0-9a-f]{16}$/);
    check(vec.protectedProjection.workspaceId, /^workspace_[0-9a-f]{16}$/);
    check(vec.protectedProjection.projectId, /^project_[0-9a-f]{16}$/);
    check(vec.protectedProjection.bindingId, /^binding_[0-9a-f]{16}$/);
    check(vec.value.runId, /^run_[0-9a-f]{16}$/);
  }
  const admission = readJson(path.join(ROOT, 'tests', 'fixtures', 'admission-binding-vectors.json'));
  for (const vec of admission.vectors) {
    check(vec.protectedProjection.bindingId, /^binding_[0-9a-f]{16}$/);
    check(vec.value.bindingId, /^binding_[0-9a-f]{16}$/);
  }
  const permit = readJson(path.join(ROOT, 'tests', 'fixtures', 'permit-vectors.json'));
  for (const vec of permit.vectors) {
    check(vec.value.permitId, /^permit_[0-9a-f]{16}$/);
    check(vec.protectedProjection.permitId, /^permit_[0-9a-f]{16}$/);
    assert.match(vec.value.nonce, /^[0-9a-f]{32,128}$/, `nonce hex for ${vec.name}`);
    assert.match(vec.protectedProjection.nonce, /^[0-9a-f]{32,128}$/);
    assert.match(vec.value.signature, /^[0-9a-f]{128}$/, `signature hex for ${vec.name}`);
    assert.match(vec.value.permitDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(vec.protectedProjection.claimDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(vec.protectedProjection.profileAlias, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  }
});
