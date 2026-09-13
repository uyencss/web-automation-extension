// A3b activation (B3) — behavioral choke-point (S1 RED).
//
// Replaces tests/integration/a3-mutating-entry-invariant.test.mjs (the old
// file-substring invariant): mutating catalog commands are enumerated AT
// RUNTIME via the catalog module and driven through the real
// InteractiveRuntime/GatewayVerifier. No catalog/source text is read.
//
// One test stays RED until the wire lane retires the old invariant file (see
// the replacement plan in S1-writer-report.md); the behavioral core pins the
// already-wired fence choke-point per entry.
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
import { mkdtempSync } from 'node:fs';
import { sign } from 'node:crypto';
import catalog from '../../catalog/command-catalog.js';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';
import { PermitStore } from '../../server/gateway/permit-store.mjs';
import { classifyTool, isMutatingAction } from '../../server/gateway/verifier.mjs';
import { InteractiveRuntime } from '../../server/gateway/interactive-runtime.mjs';
import { canonicalJson, digestCanonical, SCHEMAS } from '../../server/gateway/trusted-context-schema.mjs';
import * as A3H from './a3-helpers.mjs';

const DIGEST = (ch) => `sha256:${ch.repeat(64)}`;
const DIGEST_A = DIGEST('a');
const CLAIM_A = DIGEST('b');
const PAGE_URL = 'https://example.test/page';
const PAGE_ORIGIN = 'https://example.test';
const PROFILE = 'interactive-profile';

// Composite / escape-hatch entries are NOT leaf side effects: the batch outer
// call is exempt by design (children authorize per boundary — pinned below)
// and browser_raw_command needs a method param to classify (fail-closed
// without one — pinned below). Everything else mutating is driven as a leaf.
const COMPOSITE_EXEMPT = new Set(['batch', 'browser_raw_command']);

function enumerateMutating() {
  return catalog.listCommands()
    .map((command) => ({ name: command.name, actionClass: classifyTool(command.name, {}) }))
    .filter((entry) => isMutatingAction(entry.actionClass) && !COMPOSITE_EXEMPT.has(entry.name));
}

function channelWith(context) {
  return { getContext: () => context, start: async () => {}, stop: async () => {} };
}

async function setupLiveLease(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a3b-choke-'));
  const repository = new GovernorRepository({ statePath: path.join(dir, 'governor-state.json') });
  const governor = new ProfileGovernor({
    repository,
    registry: {
      resolve: async () => ({
        physicalResourceId: 'prsc_a3b-choke',
        bindingId: 'pb_test-profile',
        bindingRevision: 1,
        bindingDigest: DIGEST_A,
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
  t.after(() => { try { governor.close(); } catch {} });
  await governor.reconcileProfile(PROFILE);
  const lease = await governor.acquire({
    schema: 'webmcp-profile-lease-request/1',
    requestId: 'plr_a3b-choke-0001',
    ownerType: 'automation',
    nodeId: 'node-a3b-1',
    runId: 'run_a3b-choke-01',
    runnerClaimDigest: CLAIM_A,
    bindingId: 'pb_test-profile',
    bindingRevision: 1,
    bindingDigest: DIGEST_A,
    profileAlias: PROFILE,
    leaseMode: 'single-context',
    requestedActions: ['browser-read', 'browser-write'],
    heartbeatIntervalMs: 1000,
    leaseTtlMs: 60000,
    idempotencyKey: 'a3b-choke-key-1',
  });
  const fenceArgs = (action, actionKind) => ({
    leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest,
    bindingId: lease.bindingId, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest,
    action, actionKind,
  });
  const writeProof = await governor.createFence(fenceArgs('browser-write', 'click'));
  const readProof = await governor.createFence(fenceArgs('browser-read', 'read'));
  return { governor, lease, writeProof, readProof };
}

// Synthetic permit mirroring the a3-helpers.mjs builders, extended per entry:
// helpers pin actionClasses to ['browser.navigate'] with budget 5, which
// cannot cover the enumerated surface; each driven entry needs a fresh nonce
// (replay), its own action class (scope), and shared budget headroom.
let chokeNonce = 0;
function buildChokePermit(keys, context, actionClasses) {
  const nonce = `nonce_a3bchoke_${chokeNonce++}`;
  const base = {
    schema: SCHEMAS.PERMIT, permitId: `permit_a3bchoke_${nonce}`, runId: context.runId,
    claimGeneration: context.claimGeneration, claimDigest: context.claimDigest, projectId: context.projectId,
    profileAlias: context.profileAlias, profileId: context.profileId, bindingId: context.bindingId,
    bindingRevision: context.bindingRevision, bindingDigest: context.bindingDigest,
    automationStoreRevision: context.automationStoreRevision, automationStoreDigest: context.automationStoreDigest,
    siteStoreRevision: context.siteStoreRevision, siteStoreDigest: context.siteStoreDigest, phaseId: context.phaseId,
    origins: [PAGE_ORIGIN], actionClasses: [...actionClasses], budget: { maxCalls: 500 },
    stateVersion: context.stateVersion, planRevision: context.planRevision, planDigest: context.planDigest,
    instructionDigest: context.instructionDigest, policyRevision: context.policyRevision,
    keyId: keys.keyId, nonce, issuedAt: new Date().toISOString(),
    notBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString(),
    ttlMs: 30000, revocationId: 'rev_a3bchoke_001',
  };
  const canonical = canonicalJson(base);
  const signature = sign(null, Buffer.from(`webmcp-digest-v1:permit\n${canonical}`, 'utf8'), keys.privateKey).toString('hex');
  return { ...base, signature, permitDigest: digestCanonical('webmcp-digest-v1:permit', base) };
}

function makeRuntime(keys, governor, context) {
  return new InteractiveRuntime({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    permitStore: new PermitStore(),
    trustedContextChannel: channelWith(context),
    mode: 'enforce',
    allowTestSeams: true,
    governor,
    fenceMode: 'enforce',
  });
}

// Routing proof: every driven entry must pass through the verifier (spy on
// the instance classifier used by both the async fence path and the sync
// verifier path).
function armRoutingProof(runtime) {
  const seen = new Set();
  const original = runtime.verifier.classifyTool.bind(runtime.verifier);
  runtime.verifier.classifyTool = (tool, params) => {
    const actionClass = original(tool, params);
    seen.add(`${tool}=>${actionClass}`);
    return actionClass;
  };
  return seen;
}

test('B3: mutating commands are enumerated at runtime (seed entries covered)', () => {
  const driven = enumerateMutating();
  assert.ok(driven.length >= 10, `runtime enumeration must yield the mutating surface (got ${driven.length})`);
  const names = driven.map((entry) => entry.name);
  for (const seed of ['evaluateJS', 'dispatchClick', 'webmcp.invokeTool', 'waitForStable']) {
    assert.ok(names.includes(seed), `enumerated mutating set must include seed entry ${seed}`);
  }
});

test('B3: helpers seam sanity — a3-helpers permit+context deny fenceless navigate', async (t) => {
  const keys = A3H.makeA3KeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const context = A3H.buildA3Context(keys, { fenceEpoch: lease.fenceEpoch, runId: 'run_a3b-choke-01' });
  const runtime = makeRuntime(keys, governor, context);
  const result = await runtime.enforceRequestAsync({
    method: 'browser_navigate',
    params: { url: PAGE_URL },
    permit: A3H.buildA3Permit(keys, { fenceEpoch: lease.fenceEpoch, runId: 'run_a3b-choke-01' }),
    profileId: PROFILE,
    targetOrigin: PAGE_ORIGIN,
  });
  assert.equal(result.decision, 'deny', `verbatim helper permit+context without proof must deny (got ${result.decision})`);
  assert.equal(result.reason, 'PROFILE_FENCE_REQUIRED', `fenceless denial must be typed PROFILE_FENCE_REQUIRED (got ${result.reason})`);
});

test('B3: every enumerated mutating entry denies without a fence proof', async (t) => {
  const keys = A3H.makeA3KeyPair();
  const { governor, lease } = await setupLiveLease(t);
  const context = A3H.buildA3Context(keys, { fenceEpoch: lease.fenceEpoch, runId: 'run_a3b-choke-01' });
  const runtime = makeRuntime(keys, governor, context);
  const seen = armRoutingProof(runtime);
  const driven = enumerateMutating();
  const classes = [...new Set(driven.map((entry) => entry.actionClass)), 'browser.batch'];
  const failures = [];
  for (const entry of driven) {
    const result = await runtime.enforceRequestAsync({
      method: entry.name,
      params: { url: PAGE_URL },
      permit: buildChokePermit(keys, context, classes),
      profileId: PROFILE,
      targetOrigin: PAGE_ORIGIN,
    });
    if (result.decision !== 'deny' || result.reason !== 'PROFILE_FENCE_REQUIRED') {
      failures.push(`${entry.name}=>${entry.actionClass} (got ${result.decision}/${result.reason ?? 'no-reason'})`);
    }
  }
  assert.deepEqual(failures, [], `every mutating entry must route through the fence choke-point (typed PROFILE_FENCE_REQUIRED, no caller bypass): ${failures.join('; ')}`);
  const missing = driven
    .filter((entry) => ![...seen].some((key) => key.startsWith(`${entry.name}=>`)))
    .map((entry) => entry.name);
  assert.deepEqual(missing, [], `routing proof: the verifier must have seen every driven entry (missing: ${missing.join(', ')})`);
});

test('B3: every enumerated mutating entry allows with a valid issued fence proof', async (t) => {
  const keys = A3H.makeA3KeyPair();
  const { governor, lease, writeProof } = await setupLiveLease(t);
  const context = A3H.buildA3Context(keys, { fenceEpoch: lease.fenceEpoch, runId: 'run_a3b-choke-01' });
  const runtime = makeRuntime(keys, governor, context);
  const seen = armRoutingProof(runtime);
  const driven = enumerateMutating();
  const classes = [...new Set(driven.map((entry) => entry.actionClass)), 'browser.batch'];
  const failures = [];
  for (const entry of driven) {
    const result = await runtime.enforceRequestAsync({
      method: entry.name,
      params: { url: PAGE_URL, fenceProof: writeProof },
      permit: buildChokePermit(keys, context, classes),
      profileId: PROFILE,
      targetOrigin: PAGE_ORIGIN,
    });
    if (result.decision !== 'allow') {
      failures.push(`${entry.name}=>${entry.actionClass} (got ${result.decision}/${result.reason ?? 'no-reason'})`);
    }
  }
  assert.deepEqual(failures, [], `every mutating entry must allow with a valid issued fence proof: ${failures.join('; ')}`);
  const missing = driven
    .filter((entry) => ![...seen].some((key) => key.startsWith(`${entry.name}=>`)))
    .map((entry) => entry.name);
  assert.deepEqual(missing, [], `routing proof: the verifier must have seen every driven entry (missing: ${missing.join(', ')})`);
});

test('B3: composite batch gates per child (outer fenceless batch is not a leaf side effect)', async (t) => {
  const keys = A3H.makeA3KeyPair();
  const { governor, lease, writeProof } = await setupLiveLease(t);
  const context = A3H.buildA3Context(keys, { fenceEpoch: lease.fenceEpoch, runId: 'run_a3b-choke-01' });
  const runtime = makeRuntime(keys, governor, context);
  const classes = ['browser.navigate', 'browser.batch'];
  const fenceless = await runtime.enforceRequestAsync({
    method: 'batch',
    params: { actions: [{ method: 'browser_navigate', params: { url: PAGE_URL } }] },
    permit: buildChokePermit(keys, context, classes),
    profileId: PROFILE,
    targetOrigin: PAGE_ORIGIN,
  });
  assert.equal(fenceless.decision, 'deny', `batch with a fenceless mutating child must deny (got ${fenceless.decision})`);
  assert.equal(fenceless.reason, 'PROFILE_FENCE_REQUIRED', `fenceless batch child must be typed PROFILE_FENCE_REQUIRED (got ${fenceless.reason})`);
  const proven = await runtime.enforceRequestAsync({
    method: 'batch',
    params: { actions: [{ method: 'browser_navigate', params: { url: PAGE_URL, fenceProof: writeProof } }] },
    permit: buildChokePermit(keys, context, classes),
    profileId: PROFILE,
    targetOrigin: PAGE_ORIGIN,
  });
  assert.equal(proven.decision, 'allow', `batch with proven children must allow (got ${proven.decision}/${proven.reason ?? 'no-reason'})`);
});

test('B3: raw escape hatch fail-closes unknown and gates known methods', async (t) => {
  const keys = A3H.makeA3KeyPair();
  const { governor, lease, writeProof } = await setupLiveLease(t);
  const context = A3H.buildA3Context(keys, { fenceEpoch: lease.fenceEpoch, runId: 'run_a3b-choke-01' });
  const runtime = makeRuntime(keys, governor, context);
  const unknown = await runtime.enforceRequestAsync({
    method: 'browser_raw_command',
    params: { url: PAGE_URL, fenceProof: writeProof },
    permit: buildChokePermit(keys, context, ['browser.raw.*']),
    profileId: PROFILE,
    targetOrigin: PAGE_ORIGIN,
  });
  assert.equal(unknown.decision, 'deny', `raw command without a known method must deny (got ${unknown.decision})`);
  assert.equal(unknown.reason, 'TOOL_ACTION_NOT_ALLOWED', `unknown raw method must be typed TOOL_ACTION_NOT_ALLOWED (got ${unknown.reason})`);
  const gated = await runtime.enforceRequestAsync({
    method: 'browser_raw_command',
    params: { method: 'navigate', url: PAGE_URL },
    permit: buildChokePermit(keys, context, ['browser.raw.*']),
    profileId: PROFILE,
    targetOrigin: PAGE_ORIGIN,
  });
  assert.equal(gated.decision, 'deny', `raw navigate without proof must deny (got ${gated.decision})`);
  assert.equal(gated.reason, 'PROFILE_FENCE_REQUIRED', `raw navigate without proof must be typed PROFILE_FENCE_REQUIRED (got ${gated.reason})`);
  const allowed = await runtime.enforceRequestAsync({
    method: 'browser_raw_command',
    params: { method: 'navigate', url: PAGE_URL, fenceProof: writeProof },
    permit: buildChokePermit(keys, context, ['browser.raw.*']),
    profileId: PROFILE,
    targetOrigin: PAGE_ORIGIN,
  });
  assert.equal(allowed.decision, 'allow', `raw navigate with a valid issued proof must allow (got ${allowed.decision}/${allowed.reason ?? 'no-reason'})`);
});

test('B3: read-only boundary — write proof is scope-bound, read proof allows reads', async (t) => {
  const keys = A3H.makeA3KeyPair();
  const { governor, lease, writeProof, readProof } = await setupLiveLease(t);
  const context = A3H.buildA3Context(keys, { fenceEpoch: lease.fenceEpoch, runId: 'run_a3b-choke-01' });
  const runtime = makeRuntime(keys, governor, context);
  const scoped = await runtime.enforceRequestAsync({
    method: 'browser_page_text',
    params: { url: PAGE_URL, fenceProof: writeProof },
    permit: buildChokePermit(keys, context, ['browser.getPageText']),
    profileId: PROFILE,
    targetOrigin: PAGE_ORIGIN,
  });
  assert.equal(scoped.decision, 'deny', `write-scoped proof on a read-only call must deny (got ${scoped.decision})`);
  assert.equal(scoped.reason, 'PROFILE_FENCE_STALE', `scope mismatch must be typed PROFILE_FENCE_STALE (got ${scoped.reason})`);
  const allowed = await runtime.enforceRequestAsync({
    method: 'browser_page_text',
    params: { url: PAGE_URL, fenceProof: readProof },
    permit: buildChokePermit(keys, context, ['browser.getPageText']),
    profileId: PROFILE,
    targetOrigin: PAGE_ORIGIN,
  });
  assert.equal(allowed.decision, 'allow', `read-scoped proof on a read-only call must allow (got ${allowed.decision}/${allowed.reason ?? 'no-reason'})`);
});

test('B3: full catalog coverage — driven, composite-exempt, and read-only partition everything', () => {
  const all = catalog.listCommands().map((command) => command.name);
  const driven = new Set(enumerateMutating().map((entry) => entry.name));
  const readOnly = all.filter((name) => !isMutatingAction(classifyTool(name, {})));
  assert.ok(readOnly.length >= 1, 'the catalog must expose a read-only boundary');
  assert.ok(readOnly.includes('getPageText'), 'read-only boundary must include getPageText');
  const uncovered = all.filter((name) => !driven.has(name) && !COMPOSITE_EXEMPT.has(name) && !readOnly.includes(name));
  assert.deepEqual(uncovered, [], `every catalog command must be partitioned (uncovered: ${uncovered.join(', ')})`);
});

test('B3: harness never reads catalog/source text (runtime enumeration only)', () => {
  const self = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const reads = [...self.matchAll(/readFileSync\(([^)]*)\)/g)].map((match) => match[1]);
  for (const target of reads) {
    assert.ok(
      !target.includes('catalog') && !target.includes('server/') && !target.includes('profile-governor'),
      `new choke-point test must not read catalog/source text (found readFileSync(${target}))`,
    );
  }
});

test('B3 replaces the file-substring invariant: old test retired or rewritten behaviorally', () => {
  let oldText = null;
  try {
    oldText = fs.readFileSync(new URL('./a3-mutating-entry-invariant.test.mjs', import.meta.url), 'utf8');
  } catch {
    oldText = null; // Deleted by the wire lane: the planned end state.
  }
  if (oldText === null) return;
  const stillSubstring = oldText.includes('readFileSync') && oldText.includes('command-catalog');
  assert.ok(
    !stillSubstring,
    'RED: tests/integration/a3-mutating-entry-invariant.test.mjs still enforces the file-substring invariant; ' +
    'the wire lane must delete/replace it (this behavioral choke-point supersedes it)',
  );
});
