// A3b activation (B1) — governor registry adapter acceptance harness (S5 fix).
//
// Pins: PINS.md (browser-kit 86e104d, vault-kit 0538a80).
// The adapter mirrors the REAL `webmcp-dispatcher-config/3` contract defined
// by server/gateway/dispatcher-route-resolver.mjs: resources carry
// `profileId` (not `physicalResourceId`), bindings require an approved review
// receipt, and gateway projection coherence decides. `physicalResourceId`
// and `bindingDigest` are adapter-derived (verbatim only when explicitly
// present) via the exported `derivePhysicalResourceId` /
// `deriveBindingDigest` helpers — the quarantine seed below uses those same
// helpers so seeded facts equal adapter-derived facts.
//
// Run: A3_FENCE_MODE=enforce node --test tests/integration/a3b-*.test.mjs
// from source/packages/webmcp-browser-kit.
process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';
import { createGatewayServer, resetGatewayGovernorSingleton } from '../../server/gateway_server.js';

const ADAPTER_SPEC = '../../server/gateway/governor-registry-adapter.mjs';

// REAL v3 shape (mirrors the e4-physical-routing fixture): gateways +
// profiles map + profileResources { gateway, profileId, resourceRevision,
// status } + profileBindings { schema webmcp-profile-binding/3, bindingId,
// bindingRevision, profileAlias, profileResourceRef, status, review }. No
// invented fields: physicalResourceId/bindingDigest are derived, and
// allowedActions falls back to the conservative default. bindingId keeps the
// Governor-compatible `pb_[a-z0-9-]+` shape so seeded leases reconcile.
const ALIAS = 'interactive-profile';
const GATEWAY = 'local';
const RESOURCE_REF = 'prf_local_01';
const PROFILE_ID = 'opaque-physical-interactive-profile-xyz123';
const BINDING_ID = 'pb_a3b-reg-01';
const BINDING_REVISION = 1;
const REVIEW_DIGEST = `sha256:${'b'.repeat(64)}`;
const CLAIM_DIGEST = `sha256:${'b'.repeat(64)}`;
const VERBATIM_PHYSICAL_ID = 'prsc_a3b-reg-01';
const VERBATIM_BINDING_DIGEST = `sha256:${'d'.repeat(64)}`;

function validConfig() {
  return {
    schema: 'webmcp-dispatcher-config/3',
    registryRevision: 1,
    defaultGateway: GATEWAY,
    gateways: {
      [GATEWAY]: {
        apiUrl: 'http://127.0.0.1:7865/api',
        profiles: { [ALIAS]: PROFILE_ID },
      },
    },
    profileResources: {
      [RESOURCE_REF]: {
        gateway: GATEWAY,
        profileId: PROFILE_ID,
        resourceRevision: 1,
        status: 'enabled',
      },
    },
    profileBindings: {
      [ALIAS]: {
        schema: 'webmcp-profile-binding/3',
        bindingId: BINDING_ID,
        bindingRevision: BINDING_REVISION,
        profileAlias: ALIAS,
        profileResourceRef: RESOURCE_REF,
        status: 'enabled',
        review: { decision: 'approved', receiptDigest: REVIEW_DIGEST },
      },
    },
  };
}

function expectedFacts(mod) {
  return {
    physicalResourceId: mod.derivePhysicalResourceId(GATEWAY, PROFILE_ID),
    bindingDigest: mod.deriveBindingDigest({
      bindingId: BINDING_ID,
      bindingRevision: BINDING_REVISION,
      profileAlias: ALIAS,
      profileResourceRef: RESOURCE_REF,
    }),
  };
}

// Dynamic import with a RED capability failure (assert.fail), never a crash.
async function requireAdapterModule() {
  try {
    return await import(ADAPTER_SPEC);
  } catch (error) {
    assert.fail(
      `RED: governor-registry-adapter module not implemented yet ` +
      `(${ADAPTER_SPEC} missing; wire lane must create it): ${error?.code ?? error?.message ?? error}`,
    );
  }
}

test('B1: buildGovernorRegistryFromConfig accepts the real v3 shape with derived facts', async () => {
  const mod = await requireAdapterModule();
  assert.equal(typeof mod.buildGovernorRegistryFromConfig, 'function', 'RED: adapter must export buildGovernorRegistryFromConfig');
  assert.equal(typeof mod.derivePhysicalResourceId, 'function', 'adapter must export derivePhysicalResourceId');
  assert.equal(typeof mod.deriveBindingDigest, 'function', 'adapter must export deriveBindingDigest');
  const expected = expectedFacts(mod);
  assert.match(expected.physicalResourceId, /^prsc_[0-9a-f]{32}$/, 'derived physicalResourceId must be prsc_ + 32 hex chars');
  assert.match(expected.bindingDigest, /^sha256:[0-9a-f]{64}$/, 'derived bindingDigest must be sha256: + 64 hex chars');
  const result = await mod.buildGovernorRegistryFromConfig(validConfig());
  assert.equal(result.ok, true, `conforming real-shape config must build ok:true (got ${JSON.stringify(result)})`);
  assert.ok(result.aliases && typeof result.aliases === 'object', 'build result must carry aliases');
  const entry = result.aliases[ALIAS];
  assert.equal(entry?.physicalResourceId, expected.physicalResourceId, 'alias must resolve the derived physicalResourceId');
  assert.equal(entry?.bindingId, BINDING_ID, 'alias must carry bindingId');
  assert.equal(entry?.bindingRevision, BINDING_REVISION, 'alias must carry bindingRevision');
  assert.equal(entry?.bindingDigest, expected.bindingDigest, 'alias must carry the derived bindingDigest');
  assert.deepEqual(entry?.allowedActions, ['browser-read'], 'absent allowedActions must default to conservative [browser-read]');
  assert.deepEqual(result.listAliases(), [ALIAS], 'listAliases must enumerate the enabled alias');
});

test('B1: explicit physicalResourceId + bindingDigest are used verbatim', async () => {
  const mod = await requireAdapterModule();
  const raw = validConfig();
  raw.profileResources[RESOURCE_REF].physicalResourceId = VERBATIM_PHYSICAL_ID;
  raw.profileBindings[ALIAS].bindingDigest = VERBATIM_BINDING_DIGEST;
  const result = await mod.buildGovernorRegistryFromConfig(raw);
  assert.equal(result.ok, true, `verbatim-field variant must build ok:true (got ${JSON.stringify(result)})`);
  assert.equal(result.aliases[ALIAS]?.physicalResourceId, VERBATIM_PHYSICAL_ID, 'explicit physicalResourceId must be used verbatim');
  assert.equal(result.aliases[ALIAS]?.bindingDigest, VERBATIM_BINDING_DIGEST, 'explicit bindingDigest must be used verbatim');
});

test('B1: explicit allowedActions are carried through when valid', async () => {
  const mod = await requireAdapterModule();
  const raw = validConfig();
  raw.profileBindings[ALIAS].allowedActions = ['browser-read', 'browser-write'];
  const result = await mod.buildGovernorRegistryFromConfig(raw);
  assert.equal(result.ok, true, `valid allowedActions must still build (got ${JSON.stringify(result)})`);
  assert.deepEqual(
    result.aliases[ALIAS]?.allowedActions, ['browser-read', 'browser-write'],
    'valid allowedActions must be carried through',
  );
});

// Fail-safe matrix: every violation must yield ok:false with a reason (no
// invention). The case function returns the raw config to build.
const INVALID_CASES = [
  ['non-object config', () => null],
  ['wrong schema version', () => ({ ...validConfig(), schema: 'webmcp-dispatcher-config/2' })],
  ['missing gateways object', () => { const c = validConfig(); delete c.gateways; return c; }],
  ['disabled binding', () => { const c = validConfig(); c.profileBindings[ALIAS].status = 'suspended'; return c; }],
  ['binding profileAlias mismatch', () => { const c = validConfig(); c.profileBindings[ALIAS].profileAlias = 'other-profile'; return c; }],
  ['missing review', () => { const c = validConfig(); delete c.profileBindings[ALIAS].review; return c; }],
  ['pending review decision', () => { const c = validConfig(); c.profileBindings[ALIAS].review = { decision: 'pending', receiptDigest: REVIEW_DIGEST }; return c; }],
  ['malformed review receiptDigest', () => { const c = validConfig(); c.profileBindings[ALIAS].review = { decision: 'approved', receiptDigest: 'sha256:xyz' }; return c; }],
  ['dangling profileResourceRef', () => { const c = validConfig(); c.profileBindings[ALIAS].profileResourceRef = 'res-missing'; return c; }],
  ['disabled resource', () => { const c = validConfig(); c.profileResources[RESOURCE_REF].status = 'suspended'; return c; }],
  ['empty profileId', () => { const c = validConfig(); c.profileResources[RESOURCE_REF].profileId = ''; return c; }],
  ['gateway projection drift', () => { const c = validConfig(); c.gateways[GATEWAY].profiles[ALIAS] = 'different-physical'; return c; }],
  ['gateway projection missing', () => { const c = validConfig(); c.gateways[GATEWAY].profiles = {}; return c; }],
  ['missing bindingId', () => { const c = validConfig(); delete c.profileBindings[ALIAS].bindingId; return c; }],
  ['bindingRevision below 1', () => { const c = validConfig(); c.profileBindings[ALIAS].bindingRevision = 0; return c; }],
  ['malformed explicit bindingDigest', () => { const c = validConfig(); c.profileBindings[ALIAS].bindingDigest = 'sha256:xyz'; return c; }],
  ['malformed explicit physicalResourceId', () => { const c = validConfig(); c.profileResources[RESOURCE_REF].physicalResourceId = 'phys-01'; return c; }],
  ['invalid allowedActions entry', () => { const c = validConfig(); c.profileBindings[ALIAS].allowedActions = ['browser-read', 'browser-everything']; return c; }],
];

for (const [label, makeRaw] of INVALID_CASES) {
  test(`B1: buildGovernorRegistryFromConfig rejects ${label}`, async () => {
    const mod = await requireAdapterModule();
    const result = await mod.buildGovernorRegistryFromConfig(makeRaw());
    assert.equal(result?.ok, false, `${label} must fail safe with ok:false (got ${JSON.stringify(result)})`);
    assert.ok(typeof result?.reason === 'string' && result.reason.length > 0, `${label} must carry a string reason`);
  });
}

test('B1: loadGovernorRegistry reports missing/unreadable file as ok:false', async (t) => {
  const mod = await requireAdapterModule();
  const prev = process.env.WEBMCP_DISPATCHER_CONFIG;
  delete process.env.WEBMCP_DISPATCHER_CONFIG;
  t.after(() => {
    if (prev === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG;
    else process.env.WEBMCP_DISPATCHER_CONFIG = prev;
  });
  const result = mod.loadGovernorRegistry({ configPath: path.join(os.tmpdir(), `a3b-reg-absent-${Date.now()}.json`) });
  const resolved = result && typeof result.then === 'function' ? await result : result;
  assert.equal(resolved?.ok, false, `missing config file must load as ok:false (got ${JSON.stringify(resolved)})`);
  assert.ok(typeof resolved?.reason === 'string' && resolved.reason.length > 0, 'missing config file must carry a string reason');
});

test('B1: loadGovernorRegistry falls back to WEBMCP_DISPATCHER_CONFIG', async (t) => {
  const mod = await requireAdapterModule();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a3b-reg-fallback-'));
  const configPath = path.join(dir, 'dispatcher.config.json');
  writeFileSync(configPath, JSON.stringify(validConfig()));
  const prev = process.env.WEBMCP_DISPATCHER_CONFIG;
  process.env.WEBMCP_DISPATCHER_CONFIG = configPath;
  t.after(() => {
    if (prev === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG;
    else process.env.WEBMCP_DISPATCHER_CONFIG = prev;
  });
  const result = await mod.loadGovernorRegistry();
  assert.equal(result?.ok, true, `WEBMCP_DISPATCHER_CONFIG fallback must load ok:true (got ${JSON.stringify(result)})`);
});

test('B1: adapter resolves aliases and rejects unknown with PROFILE_REGISTRY_UNAVAILABLE', async (t) => {
  const mod = await requireAdapterModule();
  const expected = expectedFacts(mod);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a3b-reg-adapter-'));
  const configPath = path.join(dir, 'dispatcher.config.json');
  writeFileSync(configPath, JSON.stringify(validConfig()));
  const adapter = await mod.createGovernorRegistryAdapter({ configPath });
  assert.equal(typeof adapter?.listAliases, 'function', 'adapter must expose listAliases()');
  assert.equal(typeof adapter?.resolve, 'function', 'adapter must expose resolve(alias)');
  assert.equal(typeof adapter?.status, 'function', 'adapter must expose status()');
  const status = adapter.status();
  assert.equal(status?.ok, true, `adapter status must be ok:true on a conforming config (got ${JSON.stringify(status)})`);
  assert.deepEqual(adapter.listAliases(), [ALIAS], 'adapter listAliases must enumerate the enabled alias');
  const resolved = await adapter.resolve(ALIAS);
  assert.equal(resolved?.physicalResourceId, expected.physicalResourceId, 'adapter resolve must return the derived physicalResourceId');
  assert.equal(resolved?.bindingId, BINDING_ID, 'adapter resolve must return bindingId');
  assert.equal(resolved?.bindingRevision, BINDING_REVISION, 'adapter resolve must return bindingRevision');
  assert.equal(resolved?.bindingDigest, expected.bindingDigest, 'adapter resolve must return the derived bindingDigest');
  assert.deepEqual(resolved?.allowedActions, ['browser-read'], 'adapter resolve must return the fallback allowedActions');
  t.after(() => { try { adapter.close?.(); } catch {} });
  await assert.rejects(
    adapter.resolve('no-such-profile'),
    (error) => error?.code === 'PROFILE_REGISTRY_UNAVAILABLE',
    'adapter resolve on an unknown alias must reject with code PROFILE_REGISTRY_UNAVAILABLE',
  );
});

test('B1: adapter build does not mutate the raw config', async () => {
  const mod = await requireAdapterModule();
  const raw = validConfig();
  const snapshot = JSON.stringify(raw);
  const result = await mod.buildGovernorRegistryFromConfig(raw);
  assert.equal(result?.ok, true, `conforming config must build ok:true (got ${JSON.stringify(result)})`);
  assert.equal(JSON.stringify(raw), snapshot, 'build must not mutate the raw config');
});

test('B1: adapter on unavailable config reports status and rejects resolves', async () => {
  const mod = await requireAdapterModule();
  const prev = process.env.WEBMCP_DISPATCHER_CONFIG;
  delete process.env.WEBMCP_DISPATCHER_CONFIG;
  try {
    const adapter = await mod.createGovernorRegistryAdapter({
      configPath: path.join(os.tmpdir(), `a3b-reg-absent-${Date.now()}.json`),
    });
    const status = adapter.status();
    assert.equal(status?.ok, false, `adapter status must be ok:false when config is unavailable (got ${JSON.stringify(status)})`);
    await assert.rejects(
      adapter.resolve(ALIAS),
      (error) => error?.code === 'PROFILE_REGISTRY_UNAVAILABLE',
      'adapter resolve when unavailable must reject with code PROFILE_REGISTRY_UNAVAILABLE',
    );
  } finally {
    if (prev === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG;
    else process.env.WEBMCP_DISPATCHER_CONFIG = prev;
  }
});

test('B1: adapter claims never allow acquires (always PROFILE_CLAIM_REQUIRED)', async () => {
  const mod = await requireAdapterModule();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a3b-reg-claims-'));
  const configPath = path.join(dir, 'dispatcher.config.json');
  writeFileSync(configPath, JSON.stringify(validConfig()));
  const adapter = await mod.createGovernorRegistryAdapter({ configPath });
  assert.ok(adapter.claims, 'adapter must expose a claims seam (acquires stay claim-gated)');
  assert.equal(
    typeof adapter.claims?.validate, 'function',
    'adapter claims must expose validate() mirroring the Governor claims convention',
  );
  await assert.rejects(
    adapter.claims.validate({ profileAlias: ALIAS }),
    (error) => error?.code === 'PROFILE_CLAIM_REQUIRED',
    'adapter claims.validate must always reject with code PROFILE_CLAIM_REQUIRED (no acquires via the registry)',
  );
});

// Seeds a "crash orphan": a lease acquired pre-crash by a permissive governor,
// left behind when its process died. Seeded facts come from the adapter's own
// derivation helpers so they equal the adapter-derived facts and post-wire
// reconciliation binds.
let seedCounter = 0;
async function seedCrashOrphan(statePath) {
  seedCounter += 1;
  const mod = await requireAdapterModule();
  const { physicalResourceId, bindingDigest } = expectedFacts(mod);
  const repository = new GovernorRepository({ statePath });
  const governor = new ProfileGovernor({
    repository,
    registry: {
      resolve: async () => ({
        physicalResourceId,
        bindingId: BINDING_ID,
        bindingRevision: BINDING_REVISION,
        bindingDigest,
        allowedActions: ['browser-read', 'browser-write'],
      }),
    },
    claims: {
      validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read', 'browser-write'], ...req }),
    },
    liveness: async () => ({
      governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true,
    }),
    revokeGrants: async () => true,
  });
  await governor.reconcileProfile(ALIAS);
  const lease = await governor.acquire({
    schema: 'webmcp-profile-lease-request/1',
    requestId: `plr_a3b-seed-${String(seedCounter).padStart(4, '0')}`,
    ownerType: 'automation',
    nodeId: 'node-a3b-1',
    runId: 'run_a3b-seed01',
    runnerClaimDigest: CLAIM_DIGEST,
    bindingId: BINDING_ID,
    bindingRevision: BINDING_REVISION,
    bindingDigest,
    profileAlias: ALIAS,
    leaseMode: 'single-context',
    requestedActions: ['browser-read', 'browser-write'],
    heartbeatIntervalMs: 1000,
    leaseTtlMs: 60000,
    idempotencyKey: `a3b-seed-key-${seedCounter}`,
  });
  governor.close();
  return lease;
}

function withA3bServerEnv(t, { registryOn, configPath, statePath }) {
  const prev = {
    A3_GOVERNOR_REGISTRY: process.env.A3_GOVERNOR_REGISTRY,
    WEBMCP_DISPATCHER_CONFIG: process.env.WEBMCP_DISPATCHER_CONFIG,
    WEBMCP_GOVERNOR_STATE: process.env.WEBMCP_GOVERNOR_STATE,
  };
  if (registryOn) process.env.A3_GOVERNOR_REGISTRY = '1';
  else delete process.env.A3_GOVERNOR_REGISTRY;
  if (configPath) process.env.WEBMCP_DISPATCHER_CONFIG = configPath;
  else delete process.env.WEBMCP_DISPATCHER_CONFIG;
  process.env.WEBMCP_GOVERNOR_STATE = statePath;
  resetGatewayGovernorSingleton();
  t.after(() => {
    resetGatewayGovernorSingleton();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function readGovernorStateFile(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

test('B1 wiring: A3_GOVERNOR_REGISTRY=1 reconciles via registry aliases and quarantines a pre-seeded crash orphan', async (t) => {
  const mod = await requireAdapterModule(); // RED gate: adapter module (and its server wiring) not implemented yet.
  const { physicalResourceId } = expectedFacts(mod);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a3b-reg-wire-'));
  const statePath = path.join(dir, 'governor-state.json');
  const configPath = path.join(dir, 'dispatcher.config.json');
  writeFileSync(configPath, JSON.stringify(validConfig()));
  const lease = await seedCrashOrphan(statePath);
  withA3bServerEnv(t, { registryOn: true, configPath, statePath });

  // Real server, no browser/extension: dead extension liveness must turn the
  // orphan into quarantine with a recovery receipt at start() time.
  const app = createGatewayServer({ port: 0, allowTestSeams: true });
  t.after(async () => { await app.close(); });
  await app.start();

  const state = readGovernorStateFile(statePath);
  const resource = state.resources?.[physicalResourceId];
  assert.ok(resource, 'start() must reconcile via registry aliases (seeded physical resource not reconciled; A3_GOVERNOR_REGISTRY wiring not implemented)');
  assert.equal(
    resource.state, 'quarantined',
    `start() must quarantine the pre-seeded crash orphan (got state=${resource.state}; A3_GOVERNOR_REGISTRY wiring not implemented)`,
  );
  const receipts = (state.receipts ?? []).filter((r) => r?.leaseId === lease.leaseId && r?.newState === 'quarantined');
  assert.ok(
    receipts.length >= 1,
    'quarantining the crash orphan must write a recovery receipt (none found for the seeded lease)',
  );
});

test('B1 wiring: default off (no A3_GOVERNOR_REGISTRY) skips registry reconcile as today', async (t) => {
  const mod = await requireAdapterModule();
  const { physicalResourceId } = expectedFacts(mod);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a3b-reg-off-'));
  const statePath = path.join(dir, 'governor-state.json');
  await seedCrashOrphan(statePath);
  withA3bServerEnv(t, { registryOn: false, configPath: null, statePath });

  const app = createGatewayServer({ port: 0, allowTestSeams: true });
  t.after(async () => { await app.close(); });
  await app.start();

  const state = readGovernorStateFile(statePath);
  const resource = state.resources?.[physicalResourceId];
  assert.ok(resource, 'seeded orphan resource must still be present in governor state');
  assert.notEqual(resource.state, 'quarantined', `default-off start() must skip registry reconcile (got state=${resource.state})`);
  assert.equal(state.receipts?.length ?? 0, 0, 'default-off start() must not write recovery receipts');
});
