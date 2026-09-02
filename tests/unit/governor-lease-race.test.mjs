import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chmodSync, mkdtempSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DIGEST = 'sha256:' + 'a'.repeat(64);
const CLAIM_A = 'sha256:' + 'b'.repeat(64);
const CLAIM_B = 'sha256:' + 'c'.repeat(64);

function request(overrides = {}) {
  return {
    schema: 'webmcp-profile-lease-request/1', requestId: 'plr_race-0001', ownerType: 'automation',
    nodeId: 'node-test-1', runId: 'run_race111x', runnerClaimDigest: CLAIM_A,
    bindingId: 'pb_test-profile', bindingRevision: 1, bindingDigest: DIGEST,
    profileAlias: 'test-profile', leaseMode: 'single-context', requestedActions: ['browser-read'],
    heartbeatIntervalMs: 1000, leaseTtlMs: 5000, idempotencyKey: 'race-a', ...overrides,
  };
}

function governor(aliases = { 'test-profile': 'prsc_shared_resource' }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-race-'));
  const repository = new GovernorRepository({ statePath: path.join(dir, 'state.json') });
  return new ProfileGovernor({
    repository,
    registry: { resolve: async (alias) => ({ physicalResourceId: aliases[alias], bindingId: 'pb_test-profile', bindingRevision: 1, bindingDigest: DIGEST, allowedActions: ['browser-read'] }) },
    claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read'], ...req }) },
    liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }),
    revokeGrants: async () => true,
    maxTabs: 2,
  });
}

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

test('governor lease fixture instances validate against schemas (AJV)', async () => {
  let Ajv, addFormats;
  try {
    ({ default: Ajv } = await import('ajv'));
    ({ default: addFormats } = await import('ajv-formats'));
  } catch {
    // optional ajv
  }
  const vectors = loadJson(path.join(ROOT, 'tests/fixtures/governor-lease-vectors.json'));
  const happy = vectors.vectors.find((v) => v.id === 'lease-happy-single-context');
  assert.ok(happy, 'happy vector must exist');
  if (Ajv && addFormats) {
    const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
    addFormats(ajv);
    const leaseSchema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-lease.schema.json'));
    const requestSchema = loadJson(path.join(ROOT, 'schemas/webmcp-profile-lease-request.schema.json'));
    const validateLease = ajv.compile(leaseSchema);
    const validateRequest = ajv.compile(requestSchema);
    assert.equal(validateLease(happy.expectedLease), true, `expectedLease must validate: ${JSON.stringify(validateLease.errors)}`);
    assert.equal(validateRequest(happy.request), true, `request must validate: ${JSON.stringify(validateRequest.errors)}`);
    for (const vec of vectors.vectors) {
      if (vec.requests) {
        for (const req of vec.requests) {
          assert.equal(validateRequest(req), true, `request ${req.requestId} must validate: ${JSON.stringify(validateRequest.errors)}`);
        }
      }
    }
  }
  // Ensure synthetic IDs are lowercase hex
  assert.match(happy.expectedLease.leaseId, /^lease_[0-9a-f]{16}$/);
});

test('RED: Governor exclusive acquire — two processes same physical resource yields exactly one winner', async () => {
  const g = governor({ alpha: 'prsc_shared_resource', beta: 'prsc_shared_resource' });
  await g.reconcileProfile('alpha');
  const [a, b] = await Promise.allSettled([
    g.acquire(request({ requestId: 'plr_race-win-01', profileAlias: 'alpha', runId: 'run_race111x', idempotencyKey: 'race-win-a', runnerClaimDigest: CLAIM_A })),
    g.acquire(request({ requestId: 'plr_race-win-02', profileAlias: 'beta', runId: 'run_race222x', idempotencyKey: 'race-win-b', runnerClaimDigest: CLAIM_B })),
  ]);
  const winner = [a, b].find((x) => x.status === 'fulfilled');
  const loser = [a, b].find((x) => x.status === 'rejected');
  assert.ok(winner && loser, 'exactly one winner and one loser');
  assert.equal(loser.reason.code, 'PROFILE_LEASE_CONFLICT');
  assert.equal(winner.value.state, 'leased');
});

test('atomic acquire serializes two claimants and conflicts across aliases for one physical resource', async () => {
  const g = governor({ alpha: 'prsc_shared_resource', beta: 'prsc_shared_resource' });
  await g.reconcileProfile('alpha');
  const [a, b] = await Promise.allSettled([
    g.acquire(request({ profileAlias: 'alpha', runId: 'run_race111x', idempotencyKey: 'race-a', runnerClaimDigest: CLAIM_A })),
    g.acquire(request({ profileAlias: 'beta', runId: 'run_race222x', idempotencyKey: 'race-b', runnerClaimDigest: CLAIM_B })),
  ]);
  assert.equal([a, b].filter((x) => x.status === 'fulfilled').length, 1);
  const rejected = [a, b].find((x) => x.status === 'rejected');
  assert.equal(rejected.reason.code, 'PROFILE_LEASE_CONFLICT');
});

test('RED: Governor same-run multi-tab uses one lease/fence (bounded handles)', async () => {
  const g = governor();
  await g.reconcileProfile('test-profile');
  const lease = await g.acquire(request({ requestId: 'plr_tab-test-01', idempotencyKey: 'tab-test-1' }));
  const tab1 = await g.openTab({ leaseId: lease.leaseId, runId: lease.runId });
  const tab2 = await g.openTab({ leaseId: lease.leaseId, runId: lease.runId });
  assert.match(tab1.tabHandle, /^tab_[a-z0-9-]{4,}$/);
  assert.match(tab2.tabHandle, /^tab_[a-z0-9-]{4,}$/);
  assert.notEqual(tab1.tabHandle, tab2.tabHandle);
  await assert.rejects(g.openTab({ leaseId: lease.leaseId, runId: 'run_child-0001' }), (error) => error.code === 'PROFILE_TAB_NOT_OWNED');
  await assert.rejects(g.openTab({ leaseId: lease.leaseId, runId: lease.runId }), (error) => error.code === 'PROFILE_TAB_LIMIT');
});

test('same-run tabs share one bounded lease and child runs cannot join', async () => {
  const g = governor();
  await g.reconcileProfile('test-profile');
  const lease = await g.acquire(request());
  const first = await g.openTab({ leaseId: lease.leaseId, runId: lease.runId });
  const second = await g.openTab({ leaseId: lease.leaseId, runId: lease.runId });
  assert.match(first.tabHandle, /^tab_[a-z0-9-]{4,}$/);
  assert.notEqual(first.tabHandle, second.tabHandle);
  await assert.rejects(g.openTab({ leaseId: lease.leaseId, runId: 'run_child999' }), (error) => error.code === 'PROFILE_TAB_NOT_OWNED');
  await assert.rejects(g.openTab({ leaseId: lease.leaseId, runId: lease.runId }), (error) => error.code === 'PROFILE_TAB_LIMIT');
});

test('duplicate Governor repositories are rejected while the writer is live and dead writer locks are recoverable', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-writer-'));
  const statePath = path.join(dir, 'state.json');
  const first = new GovernorRepository({ statePath });
  assert.throws(() => new GovernorRepository({ statePath }), (error) => error.code === 'PROFILE_GOVERNOR_MULTI_WRITER');
  first.close();
  const staleLock = `${statePath}.writer`;
  mkdirSync(staleLock, { mode: 0o700 });
  writeFileSync(path.join(staleLock, 'owner.json'), JSON.stringify({ pid: 999999, writerId: 'dead-writer' }), { mode: 0o600 });
  const recovered = new GovernorRepository({ statePath });
  recovered.close();
});

test('state and writer inspection fail closed on dangling symlinks and permissive non-regular files', () => {
  const danglingStateDir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-dangling-state-'));
  const danglingStatePath = path.join(danglingStateDir, 'state.json');
  symlinkSync('missing-state.json', danglingStatePath);
  const danglingState = new GovernorRepository({ statePath: danglingStatePath });
  assert.throws(() => danglingState.read(), (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID');
  danglingState.close();

  const permissiveDir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-permissive-state-'));
  const permissivePath = path.join(permissiveDir, 'state.json');
  writeFileSync(permissivePath, '{}', { mode: 0o644 });
  chmodSync(permissivePath, 0o644);
  const permissive = new GovernorRepository({ statePath: permissivePath });
  assert.throws(() => permissive.read(), (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID');
  permissive.close();

  const danglingLockDir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-dangling-lock-'));
  const danglingLockState = path.join(danglingLockDir, 'state.json');
  symlinkSync('missing-writer', `${danglingLockState}.writer`);
  assert.throws(() => new GovernorRepository({ statePath: danglingLockState }), (error) => error.code === 'PROFILE_GOVERNOR_MULTI_WRITER');

  const ownerDir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-permissive-owner-'));
  const ownerState = path.join(ownerDir, 'state.json');
  mkdirSync(`${ownerState}.writer`, { mode: 0o700 });
  writeFileSync(path.join(`${ownerState}.writer`, 'owner.json'), JSON.stringify({ pid: 999999, writerId: 'dead-writer' }), { mode: 0o644 });
  chmodSync(path.join(`${ownerState}.writer`, 'owner.json'), 0o644);
  assert.throws(() => new GovernorRepository({ statePath: ownerState }), (error) => error.code === 'PROFILE_GOVERNOR_MULTI_WRITER');
});

test('persisted state requires writer fields and all collections and rejects duplicate JSON keys', () => {
  const sourceDir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-strict-state-source-'));
  const sourcePath = path.join(sourceDir, 'state.json');
  const source = new GovernorRepository({ statePath: sourcePath });
  source.transact(() => undefined);
  source.close();
  const durable = JSON.parse(readFileSync(sourcePath, 'utf8'));

  const assertStateRejected = (content) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-strict-state-'));
    const statePath = path.join(dir, 'state.json');
    writeFileSync(statePath, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`, { mode: 0o600 });
    const repository = new GovernorRepository({ statePath });
    assert.throws(() => repository.read(), (error) => error.code === 'PROFILE_GOVERNOR_STATE_INVALID');
    repository.close();
  };

  for (const missing of ['serviceGeneration', 'writerGeneration', 'writerId', 'resources', 'leases', 'events', 'eventIntegrityDigests', 'receipts']) {
    const candidate = structuredClone(durable);
    delete candidate[missing];
    assertStateRejected(candidate);
  }
  assertStateRejected({ ...durable, unexpected: true });

  const duplicateState = JSON.stringify(durable).replace('"writerGeneration":1', '"writerGeneration":0,"writerGeneration":1');
  assert.notEqual(duplicateState, JSON.stringify(durable));
  assertStateRejected(duplicateState);

  const duplicateNestedState = JSON.stringify(durable).replace('"resources":{}', '"resources":{"a":1,"a":2}');
  assertStateRejected(duplicateNestedState);

  const ownerDir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-duplicate-owner-'));
  const ownerState = path.join(ownerDir, 'state.json');
  mkdirSync(`${ownerState}.writer`, { mode: 0o700 });
  writeFileSync(path.join(`${ownerState}.writer`, 'owner.json'), '{"pid":999998,"pid":999999,"writerId":"dead-writer"}', { mode: 0o600 });
  assert.throws(() => new GovernorRepository({ statePath: ownerState }), (error) => error.code === 'PROFILE_GOVERNOR_MULTI_WRITER');
});

test('a real exited writer leaves recoverable ownership without corrupting durable state', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-crash-'));
  const statePath = path.join(dir, 'state.json');
  const moduleUrl = pathToFileURL(path.join(ROOT, 'profile-governor/repository.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { GovernorRepository } from ${JSON.stringify(moduleUrl)}; new GovernorRepository({ statePath: ${JSON.stringify(statePath)} });`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const recovered = new GovernorRepository({ statePath });
  recovered.transact(() => undefined);
  assert.equal(statSync(statePath).isFile(), true);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(recovered.read().schema, 'webmcp-profile-session-governor-state/1');
  recovered.close();
});

test('a child process cannot open a duplicate writer for acquire authority', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-child-writer-'));
  const statePath = path.join(dir, 'state.json');
  const first = new GovernorRepository({ statePath });
  const moduleUrl = pathToFileURL(path.join(ROOT, 'profile-governor/repository.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { GovernorRepository } from ${JSON.stringify(moduleUrl)}; try { new GovernorRepository({ statePath: ${JSON.stringify(statePath)} }); process.exit(3); } catch (error) { process.stdout.write(error.code); }`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'PROFILE_GOVERNOR_MULTI_WRITER');
  first.close();
});

test('a child process can acquire durably and its crashed writer can be recovered', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'webmcp-governor-child-acquire-'));
  const statePath = path.join(dir, 'state.json');
  const repositoryUrl = pathToFileURL(path.join(ROOT, 'profile-governor/repository.mjs')).href;
  const serviceUrl = pathToFileURL(path.join(ROOT, 'profile-governor/lease-service.mjs')).href;
  const childRequest = request({ requestId: 'plr_child-0001', idempotencyKey: 'child-acquire-1', runId: 'run_child111' });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { GovernorRepository } from ${JSON.stringify(repositoryUrl)}; import { ProfileGovernor } from ${JSON.stringify(serviceUrl)}; const repository = new GovernorRepository({ statePath: ${JSON.stringify(statePath)} }); const governor = new ProfileGovernor({ repository, registry: { resolve: async () => ({ physicalResourceId: 'prsc_shared_resource', bindingId: 'pb_test-profile', bindingRevision: 1, bindingDigest: ${JSON.stringify(DIGEST)}, allowedActions: ['browser-read'] }) }, claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read'], ...req }) }, liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }), revokeGrants: async () => true }); await governor.reconcileProfile('test-profile'); const lease = await governor.acquire(${JSON.stringify(childRequest)}); process.stdout.write(lease.leaseId);`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^lease_[0-9a-f]{16}$/);
  const recovered = new GovernorRepository({ statePath });
  const state = recovered.read();
  assert.equal(state.leases[child.stdout].runId, 'run_child111');
  assert.equal(state.leases[child.stdout].state, 'leased');
  recovered.close();
});
