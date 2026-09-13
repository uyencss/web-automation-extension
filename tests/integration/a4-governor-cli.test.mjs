// A4 GREEN behavioral acceptance harness for the wired operator recovery CLI.
//
// Pins: candidate PINS.md (browser-kit `c7adcd18`, vault `bd9e6c14`);
// gap analysis `evidence/A4/gap-analysis.md`.
// Frozen contract under test — entry `bin/webmcp-browser.mjs`, wired route
// `lib/cli/commands/governor.mjs`, env `WEBMCP_GOVERNOR_STATE=<tmp state path>`:
//   governor --help | status | inspect <alias> | receipts | events |
//   reconcile <alias> | recover <alias> | release --lease-id <id>
// Auth: every IPC subcommand requires `--approve`; without it the CLI must
// fail with typed `PROFILE_IPC_AUTH`, exit code 2. `--json` failures print
// `{ok:false,error:{code,message}}` exit 2; success exit 0; typed `code`
// always preserved (e.g. unsafe recover keeps `PROFILE_RECLAIM_UNSAFE`).
// `--json=false` is an explicit non-JSON opt-out preserving typed stderr.
// Composition: wired governor CLI route backed by GovernorRepository +
// `createProfileGovernor` with an offline fail-closed `recoveryAuthorizer`
// (honest refusal: the offline CLI has no authoritative recovery context, so
// it never fabricates `evidence` and fails closed), wrapped in
// `createLocalGovernorServer({service, authenticate})` + `GovernorClient`.
// Read paths (status, inspect, receipts, events) read durable state directly
// without mutating or taking writer locks.
//
// S3 CONTRACT-CORRECTED (L2 F1): seeding mirrors
// `tests/integration/a3b-governor-registry.test.mjs` (governor modules imported
// directly) with the CLI resolving authority ONLY via a real v3 dispatcher
// fixture written to tmp (`writeDispatcherConfig`) with explicit verbatim
// `resource.physicalResourceId` (`prsc_*`) + `binding.bindingDigest`, and every
// CLI spawn sets `WEBMCP_DISPATCHER_CONFIG=<tmp>` so derive-vs-seed is
// deterministic. No durable-state registry fallback is exercised.
// Seeding uses governor modules directly (inline v3-shape stub registry — the
// A3b adapter module itself is NOT imported to avoid candidate drift), then
// the CLI is spawned as a fresh process and stdout/stderr JSON + exit codes
// are asserted. Loopback/tmp only, no browser.
//
// Run from the package dir:
//   node --test tests/integration/a4-governor-cli.test.mjs
process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';
import { computeEventIntegrityDigest } from '../../profile-governor/events.mjs';
import { computeReceiptDigest, computeRecoveryPlanDigest } from '../../profile-governor/recovery.mjs';
import { computeLeaseBindingDigest } from '../../profile-governor/contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp-browser.mjs');

// Fixture facts (inline copies of the A3b harness pattern: real v3 shape,
// approved review equivalent, `prsc_` physical id; no candidate drift import).
// S3 CONTRACT-CORRECTED: these verbatim ids are also written into the real v3
// dispatcher fixture (writeDispatcherConfig) so CLI registry authority matches
// seeded durable facts deterministically.
const ALIAS = 'a4-cli-profile';
const PHYSICAL_ID = 'prsc_a4-cli-01';
const BINDING_ID = 'pb_a4-cli-01';
const BINDING_REVISION = 1;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const CLAIM_DIGEST = `sha256:${'b'.repeat(64)}`;
const SUBCOMMANDS = ['status', 'inspect', 'receipts', 'events', 'reconcile', 'recover', 'release'];
// Real v3 dispatcher fixture dimensions (F1): gateway projection coherence
// requires gateways[<gw>].profiles[alias] === resource.profileId.
const GATEWAY = 'local';
const RESOURCE_REF = 'prf_local_a4cli_01';
const PROFILE_ID = 'opaque-physical-a4-cli-01';
const REVIEW_DIGEST = `sha256:${'c'.repeat(64)}`;

function freshState(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return { dir, statePath: path.join(dir, 'governor-state.json') };
}

// F1: real v3 dispatcher config with explicit verbatim physicalResourceId +
// bindingDigest so adapter-derived facts equal seeded facts deterministically.
function writeDispatcherConfig(dir) {
  const config = {
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
        physicalResourceId: PHYSICAL_ID,
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
        bindingDigest: DIGEST,
        allowedActions: ['browser-read'],
      },
    },
  };
  const configPath = path.join(dir, 'dispatcher.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  return configPath;
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function leaseRequest(overrides = {}) {
  return {
    schema: 'webmcp-profile-lease-request/1',
    requestId: 'plr_a4cli-0001',
    ownerType: 'automation',
    nodeId: 'node-a4cli-1',
    runId: 'run_a4cli-0001',
    runnerClaimDigest: CLAIM_DIGEST,
    bindingId: BINDING_ID,
    bindingRevision: BINDING_REVISION,
    bindingDigest: DIGEST,
    profileAlias: ALIAS,
    leaseMode: 'single-context',
    requestedActions: ['browser-read'],
    heartbeatIntervalMs: 1000,
    leaseTtlMs: 60000,
    idempotencyKey: 'a4cli-key-0001',
    ...overrides,
  };
}

// Same service shape the wire lane must compose (see header): repository on
// the state path + createProfileGovernor with an operator-accepting
// recoveryAuthorizer, healthy liveness, echo claims.
function openGovernor(statePath, { liveness, actionResolutionAuthorizer } = {}) {
  const repository = new GovernorRepository({ statePath });
  const governor = new ProfileGovernor({
    repository,
    registry: {
      resolve: async () => ({
        physicalResourceId: PHYSICAL_ID,
        bindingId: BINDING_ID,
        bindingRevision: BINDING_REVISION,
        bindingDigest: DIGEST,
        allowedActions: ['browser-read'],
      }),
    },
    claims: {
      validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read'], ...req }),
    },
    liveness: liveness ?? (async () => ({
      governor: 'healthy', registry: 'healthy', runnerClaim: 'active',
      browserAlive: true, extensionConnected: true,
    })),
    revokeGrants: async () => true,
    actionResolutionAuthorizer: actionResolutionAuthorizer ?? (async () => ({ authorized: true })),
    recoveryAuthorizer: async (context) => ({
      authorized: true,
      evidence: {
        runnerClaim: 'terminal', browserAlive: false, extensionConnected: false,
        dependentGrantsRevoked: true, registryCurrent: true,
        expectedState: context.state, expectedFenceEpoch: context.fenceEpoch,
        expectedBindingDigest: context.bindingDigest,
        expectedPlanDigest: context.recoveryPlanDigest,
        indeterminateResolved: context.indeterminateResolved,
      },
    }),
  });
  return governor;
}

async function seedLeased(statePath) {
  const governor = openGovernor(statePath);
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(leaseRequest());
    return { leaseId: lease.leaseId, epoch: lease.fenceEpoch };
  } finally {
    governor.close();
  }
}

// Seeds a crash-quarantined orphan: dispatched action with an indeterminate
// outward effect quarantines (epoch bump + receipt, fences cleared), which is
// the durable barrier the operator CLI must surface.
async function seedQuarantined(statePath) {
  const governor = openGovernor(statePath);
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(leaseRequest());
    const oldEpoch = lease.fenceEpoch;
    const fence = await governor.createFence({
      leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId,
      bindingId: lease.bindingId, action: 'browser-read',
    });
    await governor.authorizeFence(fence);
    const facts = {
      leaseId: lease.leaseId, fenceId: fence.fenceId, fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId,
      bindingDigest: lease.bindingDigest, runId: lease.runId,
      runnerClaimDigest: lease.runnerClaimDigest, actionId: 'act_a4cli-1',
    };
    await governor.recordAction({ ...facts, outcome: 'prepared' });
    await governor.recordAction({ ...facts, outcome: 'dispatched' });
    const receipt = await governor.recordAction({ ...facts, outcome: 'indeterminate' });
    return { leaseId: lease.leaseId, oldEpoch, quarantineEpoch: receipt.newFenceEpoch, fence };
  } finally {
    governor.close();
  }
}

// S3 CONTRACT-CORRECTED: CLI spawns carry WEBMCP_DISPATCHER_CONFIG so the
// registry is the real v3 fixture (F1). Pass configPath explicitly; when
// omitted the env is deleted to exercise the missing-config fail-closed path.
// WEBMCP_GATEWAY_URL points at a closed port so the honest liveness probe is
// deterministically UNKNOWN (unreachable -> omit fields) without depending on
// a local gateway.
function runCLI(args, statePath, configPath) {
  const env = { ...process.env, NODE_ENV: 'test', WEBMCP_ALLOW_TEST_SEAMS: '1', WEBMCP_GOVERNOR_STATE: statePath };
  if (configPath) env.WEBMCP_DISPATCHER_CONFIG = configPath;
  else delete env.WEBMCP_DISPATCHER_CONFIG;
  env.WEBMCP_GATEWAY_URL = 'http://127.0.0.1:9';
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
    env,
  });
}

// RED gate: while the `governor` route is unimplemented the CLI exits 1 with
// `Unknown command: governor`. Fail with the missing-capability reason (never
// a crash, never a bare exit-code assertion).
function redIfUnimplemented(result, label) {
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/Unknown command:\s*governor/.test(combined)) {
    assert.fail(
      `RED: governor CLI command not implemented yet — ${label} ` +
      `(bin/webmcp-browser.mjs has no 'governor' route; wire lane must add ` +
      `lib/cli/commands/governor.mjs + router wiring; got exit=${result.status})`,
    );
  }
}

function parseJSON(result, label) {
  for (const raw of [result.stdout, result.stderr]) {
    if (typeof raw === 'string' && raw.trim().length > 0) {
      try {
        return { parsed: JSON.parse(raw), raw };
      } catch {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) {
          try {
            const slice = raw.slice(start, end + 1);
            return { parsed: JSON.parse(slice), raw };
          } catch {}
        }
      }
    }
  }
  assert.fail(`expected JSON output for ${label} (got exit=${result.status} stdout=${result.stdout ?? ''} stderr=${result.stderr ?? ''})`);
}

function assertTypedFailure(result, label, code) {
  assert.equal(result.status, 2, `${label} must exit 2 (got ${result.status}; stdout=${result.stdout ?? ''} stderr=${result.stderr ?? ''})`);
  const { parsed } = parseJSON(result, label);
  assert.equal(parsed?.ok, false, `${label} failure must print {ok:false,...}`);
  assert.equal(parsed?.error?.code, code, `${label} must preserve typed code ${code} (got ${JSON.stringify(parsed)?.slice(0, 300)})`);
  assert.equal(typeof parsed?.error?.message, 'string', `${label} failure must carry a message`);
}

// Assert stdout is exactly ONE JSON document (F5): direct JSON.parse on stdout
// must succeed and no help text may be mixed in.
function assertExactJsonEnvelope(result, label) {
  const out = result.stdout ?? '';
  assert.ok(out.trim().length > 0, `${label} must print a JSON envelope on stdout`);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    assert.fail(`${label} stdout must be exactly one JSON document (got stdout=${out.slice(0, 500)} stderr=${result.stderr ?? ''})`);
  }
  assert.ok(!out.includes('Usage:') && !out.includes('governor —'), `${label} must not mix help text into --json stdout`);
  return parsed;
}

// --- holder child for the crash-recovery drill case --------------------------
// The child seeds + quarantines on the shared state path and hangs while
// holding the writer lock; the parent SIGKILLs it (real process crash), then
// the CLI must surface the durable quarantine barrier.
const HOLDER_SCRIPT = `
import fs from 'node:fs';
const [repositoryUrl, leaseServiceUrl, statePath, factsPath] = process.argv.slice(2);
const { GovernorRepository } = await import(repositoryUrl);
const { ProfileGovernor } = await import(leaseServiceUrl);
const DIGEST = 'sha256:' + 'a'.repeat(64);
const CLAIM = 'sha256:' + 'b'.repeat(64);
const repository = new GovernorRepository({ statePath });
const governor = new ProfileGovernor({
  repository,
  registry: { resolve: async () => ({ physicalResourceId: 'prsc_a4-cli-01', bindingId: 'pb_a4-cli-01', bindingRevision: 1, bindingDigest: DIGEST, allowedActions: ['browser-read'] }) },
  claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read'], ...req }) },
  liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }),
  revokeGrants: async () => true,
});
await governor.reconcileProfile('a4-cli-profile');
const lease = await governor.acquire({ schema: 'webmcp-profile-lease-request/1', requestId: 'plr_a4cli-hold1', ownerType: 'automation', nodeId: 'node-a4cli-1', runId: 'run_a4cli-hold1', runnerClaimDigest: CLAIM, bindingId: 'pb_a4-cli-01', bindingRevision: 1, bindingDigest: DIGEST, profileAlias: 'a4-cli-profile', leaseMode: 'single-context', requestedActions: ['browser-read'], heartbeatIntervalMs: 1000, leaseTtlMs: 60000, idempotencyKey: 'a4cli-key-hold1' });
const fence = await governor.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
await governor.authorizeFence(fence);
const facts = { leaseId: lease.leaseId, fenceId: fence.fenceId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, actionId: 'act_a4cli-hold1' };
await governor.recordAction({ ...facts, outcome: 'prepared' });
await governor.recordAction({ ...facts, outcome: 'dispatched' });
const receipt = await governor.recordAction({ ...facts, outcome: 'indeterminate' });
fs.writeFileSync(factsPath, JSON.stringify({ leaseId: lease.leaseId, oldEpoch: lease.fenceEpoch, quarantineEpoch: receipt.newFenceEpoch, fence }) + '\\n');
setInterval(() => {}, 1000); // hold the writer lock until SIGKILL (a bare never-promise trips unsettled-TLA exit)
`;

function readDurableState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

async function killHolder(child) {
  if (child.exitCode !== null || child.signalCode !== null) return child.signalCode;
  child.kill('SIGKILL');
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.signalCode), 5000);
    child.once('exit', (_exitCode, signal) => { clearTimeout(timer); resolve(signal); });
  });
  return code;
}

async function seedCrashViaSigkill(t, dir, statePath) {
  const holderPath = path.join(dir, 'a4-holder.mjs');
  const factsPath = path.join(dir, 'a4-holder-facts.json');
  fs.writeFileSync(holderPath, HOLDER_SCRIPT, { mode: 0o600 });
  const repositoryUrl = new URL(`../../profile-governor/repository.mjs`, import.meta.url).href;
  const leaseServiceUrl = new URL(`../../profile-governor/lease-service.mjs`, import.meta.url).href;
  const child = spawn(process.execPath, [holderPath, repositoryUrl, leaseServiceUrl, statePath, factsPath], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk.toString(); });
  t.after(async () => {
    try { await killHolder(child); } catch {}
    try { fs.rmSync(holderPath, { force: true }); } catch {}
  });
  const deadline = Date.now() + 15000;
  let facts = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(`crash-seed holder exited before SIGKILL (code=${child.exitCode} signal=${child.signalCode} stderr=${childStderr.slice(0, 500)})`);
    }
    try {
      facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
      if (facts?.leaseId) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(facts?.leaseId, 'crash-seed holder must quarantine the lease before SIGKILL');
  const signal = await killHolder(child);
  assert.equal(signal, 'SIGKILL', `holder must die by SIGKILL (got ${signal}; suite infra failure, not a RED)`);
  return facts;
}

// Durable read WITHOUT constructing a ProfileGovernor: construction runs
// markStartupUnknown (quarantined -> unknown), so the quarantine barrier must
// be observed via the repository alone before any CLI/governor startup.
function readDurableViaRepository(statePath) {
  const repository = new GovernorRepository({ statePath });
  try {
    return repository.read();
  } finally {
    repository.close();
  }
}

// 1. --help exit 0 + lists all subcommands, no side effects.
test('A4 CLI: governor --help exits 0, lists all subcommands, no side effects', async (t) => {
  const { statePath } = freshState(t, 'a4-cli-help-');
  const configPath = writeDispatcherConfig(path.dirname(statePath));
  const result = runCLI(['governor', '--help'], statePath, configPath);
  redIfUnimplemented(result, 'governor --help');
  assert.equal(result.status, 0, `governor --help must exit 0 (got ${result.status}; stderr=${result.stderr ?? ''})`);
  for (const sub of SUBCOMMANDS) {
    assert.match(result.stdout ?? '', new RegExp(sub), `--help must list subcommand '${sub}'`);
  }
  assert.ok(!fs.existsSync(statePath), '--help must have no side effects (state file must not be created)');
});
// 2. inspect without --approve -> PROFILE_IPC_AUTH exit 2.
test('A4 CLI: inspect without --approve fails PROFILE_IPC_AUTH exit 2', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-inspect-auth-');
  await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const result = runCLI(['governor', 'inspect', ALIAS, '--json'], statePath, configPath);
  redIfUnimplemented(result, 'inspect auth gate');
  assertTypedFailure(result, 'inspect without --approve', 'PROFILE_IPC_AUTH');
});
// 3. inspect <alias> --approve --json on seeded state -> redacted projection.
test('A4 CLI: inspect --approve returns a redacted projection', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-inspect-');
  const { epoch } = await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const result = runCLI(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(result, 'inspect --approve');
  assert.equal(result.status, 0, `inspect --approve must exit 0 (got ${result.status}; stderr=${result.stderr ?? ''})`);
  const { parsed, raw } = parseJSON(result, 'inspect --approve');
  const projection = parsed?.data ?? parsed?.projection ?? parsed;
  assert.equal(projection?.profileAlias, ALIAS, 'projection must carry the alias');
  assert.equal(typeof projection?.state, 'string', 'projection must carry a state');
  assert.equal(projection?.fenceEpoch, epoch, `projection fenceEpoch must match seeded epoch ${epoch}`);
  assert.ok(!raw.includes(PHYSICAL_ID) && !raw.includes('prsc_'), 'projection must not leak the physical resource id');
  for (const secret of ['secret', 'profilePath', 'runnerClaimDigest', 'leaseBindingDigest', 'sha256:']) {
    assert.ok(!raw.includes(secret), `projection must not leak '${secret}'`);
  }
});
// 4. receipts --json + events --json -> arrays (auth-gated).
test('A4 CLI: receipts/events return arrays with --approve, PROFILE_IPC_AUTH without', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-journals-');
  const { leaseId } = await seedQuarantined(statePath);
  const configPath = writeDispatcherConfig(dir);
  const receipts = runCLI(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(receipts, 'receipts --approve');
  assert.equal(receipts.status, 0, `receipts --approve must exit 0 (got ${receipts.status})`);
  const { parsed: receiptsJson } = parseJSON(receipts, 'receipts --approve');
  const receiptList = receiptsJson?.data ?? receiptsJson?.receipts ?? receiptsJson;
  assert.ok(Array.isArray(receiptList), 'receipts must be an array');
  assert.ok(receiptList.length >= 1, 'seeded quarantine must leave at least one receipt');
  assert.ok(receiptList.some((entry) => entry?.leaseId === leaseId), 'receipts must include the seeded lease receipt');
  const events = runCLI(['governor', 'events', '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(events, 'events --approve');
  assert.equal(events.status, 0, `events --approve must exit 0 (got ${events.status})`);
  const { parsed: eventsJson } = parseJSON(events, 'events --approve');
  const eventList = eventsJson?.data ?? eventsJson?.events ?? eventsJson;
  assert.ok(Array.isArray(eventList), 'events must be an array');
  assert.ok(eventList.length >= 1, 'seeded quarantine must leave at least one event');
  assertTypedFailure(runCLI(['governor', 'receipts', '--json'], statePath, configPath), 'receipts without --approve', 'PROFILE_IPC_AUTH');
  assertTypedFailure(runCLI(['governor', 'events', '--json'], statePath, configPath), 'events without --approve', 'PROFILE_IPC_AUTH');
});
// 5. reconcile <alias> --approve works on seeded state.
test('A4 CLI: reconcile --approve succeeds on seeded state', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-reconcile-');
  await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const result = runCLI(['governor', 'reconcile', ALIAS, '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(result, 'reconcile --approve');
  assert.equal(result.status, 0, `reconcile --approve must exit 0 (got ${result.status}; stderr=${result.stderr ?? ''})`);
  const { parsed } = parseJSON(result, 'reconcile --approve');
  assert.notEqual(parsed?.ok, false, 'reconcile --approve must succeed');
  const projection = parsed?.data ?? parsed?.projection ?? parsed;
  assert.ok(
    projection?.profileAlias === ALIAS || JSON.stringify(parsed).includes(ALIAS),
    'reconcile output must reference the reconciled alias',
  );
});

// 6. Crash-recovery drill case: SIGKILL holder -> CLI recover surfaces the
// quarantine barrier (typed PROFILE_RECLAIM_UNSAFE: indeterminate effect is
// unsafe to reclaim), epoch advanced, receipt present via receipts, and the
// pre-crash fence is stale.
// S3 CONTRACT-CORRECTED (L2 F4): the holder records the indeterminate outcome
// (which quarantines) before it is killed — the crash proves persistence +
// dead-writer takeover of that recorded indeterminate barrier, not that the
// crash itself causes quarantine. Post-recover the resource is NOT left
// quarantined: CLI startup normalization makes it `unknown` (not ready),
// recovery is refused, receipts persist, old fence stays stale.
test('A4 CLI: crash recovery — SIGKILL holder, recover keeps quarantine barrier + receipt + stale old fence', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-crash-');
  const facts = await seedCrashViaSigkill(t, dir, statePath);
  const configPath = writeDispatcherConfig(dir);
  // Durable barrier observed before any new governor startup (startup resets
  // live state to unknown; the barrier facts persist in receipts + epoch).
  const durable = readDurableViaRepository(statePath);
  const resource = durable.resources[PHYSICAL_ID];
  assert.ok(resource, 'seeded physical resource must be durable across the SIGKILL');
  assert.equal(resource.state, 'quarantined', `crash orphan must be quarantined (got ${resource.state})`);
  assert.ok(resource.fenceEpoch > facts.oldEpoch, `epoch must advance past pre-crash ${facts.oldEpoch} (got ${resource.fenceEpoch})`);
  const quarantineReceipts = (durable.receipts ?? []).filter(
    (entry) => entry?.leaseId === facts.leaseId && entry?.newState === 'quarantined',
  );
  assert.ok(quarantineReceipts.length >= 1, 'crash quarantine must write a recovery receipt');
  // Operator recover through the CLI: unsafe to reclaim while the
  // indeterminate effect is unresolved — typed code preserved, exit 2.
  const recover = runCLI(['governor', 'recover', ALIAS, '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(recover, 'crash recover --approve');
  assertTypedFailure(recover, 'crash recover --approve', 'PROFILE_RECLAIM_UNSAFE');
  // F4 STRENGTHENED: post-recover durable state read raw (no governor
  // construction): resource NOT left quarantined and NOT ready — startup
  // normalization makes it unknown; receipts persist; epoch
  // unchanged-or-advanced per core semantics; old fence stays stale.
  const postRaw = readDurableState(statePath);
  const postResource = postRaw.resources?.[PHYSICAL_ID];
  assert.ok(postResource, 'post-recover physical resource must persist');
  assert.notEqual(postResource.state, 'ready', `post-recover resource must not be ready (got ${postResource.state})`);
  assert.equal(postResource.state, 'unknown', `post-recover resource must be unknown via startup normalization (got ${postResource.state})`);
  assert.ok(
    (postRaw.receipts ?? []).some((entry) => entry?.leaseId === facts.leaseId),
    'post-recover receipts must still include the crashed lease receipt',
  );
  assert.ok(
    typeof postResource.fenceEpoch === 'number' && postResource.fenceEpoch >= resource.fenceEpoch,
    `post-recover epoch must be unchanged-or-advanced per core semantics (was ${resource.fenceEpoch}, got ${postResource.fenceEpoch})`,
  );
  // The receipt is visible through the CLI.
  const receipts = runCLI(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(receipts, 'post-crash receipts --approve');
  assert.equal(receipts.status, 0, `post-crash receipts must exit 0 (got ${receipts.status})`);
  const { parsed: receiptsJson } = parseJSON(receipts, 'post-crash receipts');
  const receiptList = receiptsJson?.data ?? receiptsJson?.receipts ?? receiptsJson;
  assert.ok(
    Array.isArray(receiptList) && receiptList.some((entry) => entry?.leaseId === facts.leaseId && entry?.newState === 'quarantined'),
    'post-crash receipts must show the quarantine receipt for the crashed lease',
  );
  // Epoch advancement is visible through the CLI.
  const inspect = runCLI(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(inspect, 'post-crash inspect --approve');
  assert.equal(inspect.status, 0, `post-crash inspect must exit 0 (got ${inspect.status})`);
  const { parsed: inspectJson } = parseJSON(inspect, 'post-crash inspect');
  const projection = inspectJson?.data ?? inspectJson?.projection ?? inspectJson;
  assert.ok(
    typeof projection?.fenceEpoch === 'number' && projection.fenceEpoch > facts.oldEpoch,
    `post-crash inspect fenceEpoch must exceed pre-crash ${facts.oldEpoch} (got ${projection?.fenceEpoch})`,
  );
  // The pre-crash fence is dead: authorizeFence rejects PROFILE_FENCE_STALE.
  const governor = openGovernor(statePath);
  try {
    await assert.rejects(
      governor.authorizeFence(facts.fence),
      (error) => error?.code === 'PROFILE_FENCE_STALE',
      `pre-crash fence must reject PROFILE_FENCE_STALE after quarantine (lease ${facts.leaseId})`,
    );
  } finally {
    governor.close();
  }
});

// 7. recover without --approve -> PROFILE_IPC_AUTH exit 2.
test('A4 CLI: recover without --approve fails PROFILE_IPC_AUTH exit 2', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-recover-auth-');
  await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const result = runCLI(['governor', 'recover', ALIAS, '--json'], statePath, configPath);
  redIfUnimplemented(result, 'recover auth gate');
  assertTypedFailure(result, 'recover without --approve', 'PROFILE_IPC_AUTH');
});

// 8. release --lease-id on a seeded external lease -> typed path (auth-gated).
test('A4 CLI: release --lease-id on an external lease keeps the typed unsafe path', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-release-');
  const configPath = writeDispatcherConfig(dir);
  const governor = openGovernor(statePath);
  let leaseId;
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(
      leaseRequest({ ownerType: 'external', requestId: 'plr_a4cli-ext1', idempotencyKey: 'a4cli-key-ext1' }),
      { authenticatedLocalCapability: true },
    );
    assert.equal(lease.state, 'external_use', 'seed must create an external_use lease');
    leaseId = lease.leaseId;
  } finally {
    governor.close();
  }
  const release = runCLI(['governor', 'release', '--lease-id', leaseId, '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(release, 'release --lease-id --approve');
  assertTypedFailure(release, 'release on external lease', 'PROFILE_RECLAIM_UNSAFE');
  assertTypedFailure(
    runCLI(['governor', 'release', '--lease-id', leaseId, '--json'], statePath, configPath),
    'release without --approve',
    'PROFILE_IPC_AUTH',
  );
});

// 9. Unknown subcommand -> usage error exit 2.
test('A4 CLI: unknown subcommand fails with usage error exit 2', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-unknown-');
  const configPath = writeDispatcherConfig(dir);
  const result = runCLI(['governor', 'frobnicate-nope', '--json'], statePath, configPath);
  redIfUnimplemented(result, 'unknown subcommand');
  assert.equal(result.status, 2, `unknown subcommand must exit 2 (got ${result.status})`);
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.ok(
    /frobnicate-nope/i.test(combined) || /unknown|usage/i.test(combined),
    'unknown subcommand must report a usage error naming the subcommand',
  );
});

// 10. status --json -> counts only, no secrets.
test('A4 CLI: status --json reports counts with no secrets', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-status-');
  await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const result = runCLI(['governor', 'status', '--json'], statePath, configPath);
  redIfUnimplemented(result, 'status --json');
  assert.equal(result.status, 0, `status --json must exit 0 (got ${result.status}; stderr=${result.stderr ?? ''})`);
  const { parsed, raw } = parseJSON(result, 'status --json');
  assert.notEqual(parsed?.ok, false, 'status --json must succeed');
  assert.ok(/:\s*\d+/.test(raw), 'status must report numeric counts');
  assert.ok(!raw.includes('prsc_'), 'status must not leak physical resource ids');
  for (const secret of ['secret', 'profilePath', 'runnerClaimDigest', 'leaseBindingDigest']) {
    assert.ok(!raw.includes(secret), `status must not leak '${secret}'`);
  }
});

// 11. ADDED (F1): missing dispatcher config fails closed with
// PROFILE_REGISTRY_UNAVAILABLE (no fabricated durable-state authority).
test('A4 CLI: ADDED missing dispatcher config fails PROFILE_REGISTRY_UNAVAILABLE', async (t) => {
  const { statePath } = freshState(t, 'a4-cli-noreg-');
  await seedLeased(statePath);
  const reconcile = runCLI(['governor', 'reconcile', ALIAS, '--approve', '--json'], statePath, undefined);
  redIfUnimplemented(reconcile, 'reconcile without registry');
  assertTypedFailure(reconcile, 'reconcile without dispatcher config', 'PROFILE_REGISTRY_UNAVAILABLE');
  const recover = runCLI(['governor', 'recover', ALIAS, '--approve', '--json'], statePath, undefined);
  redIfUnimplemented(recover, 'recover without registry');
  assertTypedFailure(recover, 'recover without dispatcher config', 'PROFILE_REGISTRY_UNAVAILABLE');
});

// 12. ADDED (F3): read paths never mutate durable state (byte-identical hash
// before/after) and never take the writer lock.
test('A4 CLI: ADDED read paths leave the state file byte-identical', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-readonly-');
  await seedQuarantined(statePath);
  const configPath = writeDispatcherConfig(dir);
  const before = sha256File(statePath);
  const reads = [
    ['governor', 'status', '--json'],
    ['governor', 'inspect', ALIAS, '--approve', '--json'],
    ['governor', 'receipts', '--approve', '--json'],
    ['governor', 'events', '--approve', '--json'],
  ];
  for (const args of reads) {
    const result = runCLI(args, statePath, configPath);
    redIfUnimplemented(result, `read-only ${args[1]}`);
    assert.equal(result.status, 0, `read path ${args[1]} must exit 0 (got ${result.status})`);
    assert.equal(sha256File(statePath), before, `read path ${args[1]} must not mutate the state file`);
  }
});

// 13. ADDED (F3): read paths on a missing state file fail typed and MUST NOT
// create the file or its parent side effects.
test('A4 CLI: ADDED read paths on missing state fail typed without creating it', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-missing-');
  const configPath = writeDispatcherConfig(dir);
  assert.ok(!fs.existsSync(statePath), 'precondition: state file must be absent');
  const cases = [
    { args: ['governor', 'status', '--json'], code: 'PROFILE_GOVERNOR_UNAVAILABLE' },
    { args: ['governor', 'inspect', ALIAS, '--approve', '--json'], code: 'PROFILE_GOVERNOR_UNAVAILABLE' },
    { args: ['governor', 'receipts', '--approve', '--json'], code: 'PROFILE_GOVERNOR_UNAVAILABLE' },
    { args: ['governor', 'events', '--approve', '--json'], code: 'PROFILE_GOVERNOR_UNAVAILABLE' },
  ];
  for (const { args, code } of cases) {
    const result = runCLI(args, statePath, configPath);
    redIfUnimplemented(result, `missing-state ${args[1]}`);
    assertTypedFailure(result, `missing-state ${args[1]}`, code);
    assert.ok(!fs.existsSync(statePath), `read path ${args[1]} must not create the state file`);
  }
});

// 14. ADDED (F5): strict per-subcommand parsing — unknown flags, duplicate
// flags, extra positionals and missing values all fail PROFILE_REQUEST_INVALID.
test('A4 CLI: ADDED strict parsing rejects unknown/duplicate/extra/missing', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-strict-');
  await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const badCases = [
    ['unknown flag', ['governor', 'status', '--bogus', '--json']],
    ['duplicate flag', ['governor', 'status', '--json', '--json']],
    ['extra positional on status', ['governor', 'status', 'extra', '--json']],
    ['extra positional on inspect', ['governor', 'inspect', ALIAS, 'extra', '--approve', '--json']],
    ['missing alias', ['governor', 'inspect', '--approve', '--json']],
    ['missing lease-id value', ['governor', 'release', '--approve', '--json']],
    ['unknown flag on release', ['governor', 'release', '--lease-id', 'lease_abcdefgh', '--bogus', '--approve', '--json']],
    ['duplicate approve', ['governor', 'receipts', '--approve', '--approve', '--json']],
  ];
  for (const [label, args] of badCases) {
    const result = runCLI(args, statePath, configPath);
    redIfUnimplemented(result, `strict parsing ${label}`);
    assertTypedFailure(result, `strict parsing ${label}`, 'PROFILE_REQUEST_INVALID');
  }
});

// 15. ADDED (F5): --lease-id syntax is validated before lookup.
test('A4 CLI: ADDED invalid --lease-id syntax fails PROFILE_REQUEST_INVALID', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-leaseid-');
  await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  for (const bad of ['not-a-lease', 'lease_SHORT', 'lease_ab', 'lease_ABCDEF12']) {
    const result = runCLI(['governor', 'release', '--lease-id', bad, '--approve', '--json'], statePath, configPath);
    redIfUnimplemented(result, `bad lease-id ${bad}`);
    assertTypedFailure(result, `bad lease-id ${bad}`, 'PROFILE_REQUEST_INVALID');
  }
});

// 16. ADDED (F5): --json stdout is exactly ONE JSON document; help text is
// never mixed in (bare `governor --json` is a single JSON error envelope).
test('A4 CLI: ADDED --json envelope is exactly one JSON document', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-envelope-');
  await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const bare = runCLI(['governor', '--json'], statePath, configPath);
  redIfUnimplemented(bare, 'bare governor --json');
  assert.equal(bare.status, 2, `bare governor --json must exit 2 (got ${bare.status})`);
  const bareParsed = assertExactJsonEnvelope(bare, 'bare governor --json');
  assert.equal(bareParsed?.ok, false, 'bare governor --json must print {ok:false,...}');
  assert.equal(bareParsed?.error?.code, 'PROFILE_REQUEST_INVALID', 'bare governor --json must be PROFILE_REQUEST_INVALID');
  const status = runCLI(['governor', 'status', '--json'], statePath, configPath);
  redIfUnimplemented(status, 'status --json envelope');
  assert.equal(status.status, 0, `status --json must exit 0 (got ${status.status})`);
  const statusParsed = assertExactJsonEnvelope(status, 'status --json');
  assert.equal(statusParsed?.ok, true, 'status --json envelope must be {ok:true,...}');
  const badFlag = runCLI(['governor', 'status', '--bogus', '--json'], statePath, configPath);
  assertTypedFailure(badFlag, 'unknown flag --json envelope', 'PROFILE_REQUEST_INVALID');
  assertExactJsonEnvelope(badFlag, 'unknown flag --json envelope');
});

// 17. ADDED (F2): live-lease (non-indeterminate) recover --approve fails closed
// with typed PROFILE_RECLAIM_UNSAFE and mints no recovery. The offline CLI
// authorizer never returns `evidence`, so the core fails closed at the
// `evidence is invalid` check (the crash case instead fails earlier at the
// indeterminate-journal rejection; test #6 covers that path unchanged).
// Durable recovery state is read raw (no governor construction): the lease
// stays held, fenceEpoch and receipts are unchanged, and the resource is NOT
// ready. (`state` itself normalizes ready->unknown via core startup
// normalization — the same semantics test #6 pins — so "unchanged" is pinned
// on the recovery-minting facts: lease, fence, receipts.)
test('A4 CLI: ADDED live-lease recover --approve fails PROFILE_RECLAIM_UNSAFE with no recovery minted', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-live-recover-');
  const { leaseId, epoch } = await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const pre = readDurableState(statePath);
  const preResource = pre.resources?.[PHYSICAL_ID];
  assert.ok(preResource, 'seeded physical resource must exist before recover');
  assert.equal(preResource.currentLeaseId, leaseId, 'seeded lease must be held before recover');
  assert.ok(pre.leases?.[leaseId], 'seeded lease record must exist before recover');
  const preReceipts = (pre.receipts ?? []).length;
  const recover = runCLI(['governor', 'recover', ALIAS, '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(recover, 'live-lease recover --approve');
  assertTypedFailure(recover, 'live-lease recover --approve', 'PROFILE_RECLAIM_UNSAFE');
  assertExactJsonEnvelope(recover, 'live-lease recover --approve');
  const post = readDurableState(statePath);
  const postResource = post.resources?.[PHYSICAL_ID];
  assert.ok(postResource, 'post-recover physical resource must persist');
  assert.equal(postResource.currentLeaseId, leaseId, 'post-recover lease must still be held (no reclaim)');
  assert.ok(post.leases?.[leaseId], 'post-recover lease record must persist (no recovery minted)');
  assert.equal(postResource.fenceEpoch, epoch, `post-recover fenceEpoch must be unchanged (was ${epoch}, got ${postResource.fenceEpoch})`);
  assert.equal((post.receipts ?? []).length, preReceipts, 'post-recover must mint no receipt');
  assert.notEqual(postResource.state, 'ready', `post-recover resource must not be ready (got ${postResource.state})`);
});

// 18. ADDED (F5): exact JSON error contract for --json ordering/variants —
// `--json status` runs status in JSON mode; `--json=true --json=true`
// (duplicate) and `--json=wat` (invalid value) each emit exactly ONE JSON
// document {ok:false,error:{code,message}} exit 2 (strict whole-stdout parse).
test('A4 CLI: ADDED --json ordering/variants keep the exact single-document envelope', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-json-order-');
  await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const leading = runCLI(['governor', '--json', 'status'], statePath, configPath);
  redIfUnimplemented(leading, 'leading --json status');
  assert.equal(leading.status, 0, `leading --json status must exit 0 (got ${leading.status}; stderr=${leading.stderr ?? ''})`);
  const leadingParsed = assertExactJsonEnvelope(leading, 'leading --json status');
  assert.equal(leadingParsed?.ok, true, 'leading --json status must print {ok:true,...}');
  const dup = runCLI(['governor', 'status', '--json=true', '--json=true'], statePath, configPath);
  redIfUnimplemented(dup, 'duplicate --json=true');
  assert.equal(dup.status, 2, `duplicate --json=true must exit 2 (got ${dup.status})`);
  const dupParsed = assertExactJsonEnvelope(dup, 'duplicate --json=true');
  assert.equal(dupParsed?.ok, false, 'duplicate --json=true must print {ok:false,...}');
  assert.equal(dupParsed?.error?.code, 'PROFILE_REQUEST_INVALID', 'duplicate --json=true must be PROFILE_REQUEST_INVALID');
  const wat = runCLI(['governor', 'status', '--json=wat'], statePath, configPath);
  redIfUnimplemented(wat, '--json=wat');
  assert.equal(wat.status, 2, `--json=wat must exit 2 (got ${wat.status})`);
  const watParsed = assertExactJsonEnvelope(wat, '--json=wat');
  assert.equal(watParsed?.ok, false, '--json=wat must print {ok:false,...}');
  assert.equal(watParsed?.error?.code, 'PROFILE_REQUEST_INVALID', '--json=wat must be PROFILE_REQUEST_INVALID');
});

// 19. ADDED (F5 early-exit): early --json=wat variants emit exact single JSON document exit 2 —
// bare governor --json=wat, unknown subcommand, help subcommand, and --help flag.
test('A4 CLI: ADDED early --json=wat cases emit exact single-document error envelope', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-early-wat-');
  const configPath = writeDispatcherConfig(dir);
  const cases = [
    ['bare --json=wat', ['governor', '--json=wat']],
    ['unknown subcommand --json=wat', ['governor', 'bogus', '--json=wat']],
    ['help subcommand --json=wat', ['governor', 'help', '--json=wat']],
    ['--help flag --json=wat', ['governor', '--help', '--json=wat']],
  ];
  for (const [label, args] of cases) {
    const result = runCLI(args, statePath, configPath);
    redIfUnimplemented(result, label);
    assert.equal(result.status, 2, `${label} must exit 2 (got ${result.status}; stderr=${result.stderr ?? ''})`);
    const parsed = assertExactJsonEnvelope(result, label);
    assert.equal(parsed?.ok, false, `${label} must print {ok:false,...}`);
    assert.equal(parsed?.error?.code, 'PROFILE_REQUEST_INVALID', `${label} must preserve typed code PROFILE_REQUEST_INVALID`);
    assert.equal(typeof parsed?.error?.message, 'string', `${label} must carry an error message`);
    assert.equal(result.stderr ?? '', '', `${label} must have empty stderr`);
  }
});

// 20. ADDED (Sol R3 F1/F2): --json=false is an explicit non-JSON opt-out —
// parse errors (duplicate --json=false) and ordinary failures (unknown flag)
// emit typed non-JSON stderr, empty stdout, and exit 2.
test('A4 CLI: ADDED --json=false explicit opt-out preserves typed non-JSON stderr and empty stdout', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-json-false-');
  await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const cases = [
    ['duplicate --json=false parse error', ['governor', 'status', '--json=false', '--json=false'], 'PROFILE_REQUEST_INVALID'],
    ['ordinary failure with --json=false', ['governor', 'status', '--bogus', '--json=false'], 'PROFILE_REQUEST_INVALID'],
    ['missing subcommand with --json=false', ['governor', '--json=false'], 'PROFILE_REQUEST_INVALID'],
  ];
  for (const [label, args, expectedCode] of cases) {
    const result = runCLI(args, statePath, configPath);
    redIfUnimplemented(result, label);
    assert.equal(result.status, 2, `${label} must exit 2 (got ${result.status}; stdout=${result.stdout ?? ''} stderr=${result.stderr ?? ''})`);
    assert.equal(result.stdout ?? '', '', `${label} must have empty stdout`);
    assert.match(result.stderr ?? '', new RegExp(`^${expectedCode}:`), `${label} must emit typed non-JSON stderr starting with ${expectedCode}`);
    assert.doesNotMatch((result.stderr ?? '').trim(), /^\{/, `${label} stderr must not be JSON`);
  }
});

// 21. ADDED (Sol R4 F2): read-only state loading fails closed on malformed durable state —
// incomplete resource, receipt with extra unexpectedSecret, and bogus event.
test('A4 CLI: ADDED read-only state loader fails closed on malformed durable state', async (t) => {
  // Case A: seeded valid state with an incomplete resource -> inspect returns PROFILE_GOVERNOR_STATE_INVALID
  {
    const { dir, statePath } = freshState(t, 'a4-cli-malformed-resource-');
    await seedLeased(statePath);
    const configPath = writeDispatcherConfig(dir);
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete durable.resources[PHYSICAL_ID].fenceEpoch;
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const result = runCLI(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
    redIfUnimplemented(result, 'inspect with incomplete resource');
    assert.equal(result.status, 2, `inspect with incomplete resource must exit 2 (got ${result.status}; stdout=${result.stdout ?? ''} stderr=${result.stderr ?? ''})`);
    const parsed = assertExactJsonEnvelope(result, 'inspect with incomplete resource');
    assert.equal(parsed?.ok, false, 'inspect with incomplete resource must return {ok:false,...}');
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'inspect with incomplete resource must fail PROFILE_GOVERNOR_STATE_INVALID');
    assert.equal(typeof parsed?.error?.message, 'string', 'must include an error message');
  }

  // Case B: seeded valid state with an extra receipt field (unexpectedSecret) -> receipts fails closed
  {
    const { dir, statePath } = freshState(t, 'a4-cli-malformed-receipt-');
    await seedQuarantined(statePath);
    const configPath = writeDispatcherConfig(dir);
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(Array.isArray(durable.receipts) && durable.receipts.length >= 1, 'precondition: state must have receipts');
    durable.receipts[0].unexpectedSecret = 'super-secret-token';
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const result = runCLI(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
    redIfUnimplemented(result, 'receipts with unexpectedSecret');
    assert.equal(result.status, 2, `receipts with unexpectedSecret must exit 2 (got ${result.status}; stdout=${result.stdout ?? ''} stderr=${result.stderr ?? ''})`);
    const parsed = assertExactJsonEnvelope(result, 'receipts with unexpectedSecret');
    assert.equal(parsed?.ok, false, 'receipts with unexpectedSecret must return {ok:false,...}');
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'receipts with unexpectedSecret must fail PROFILE_GOVERNOR_STATE_INVALID');
    assert.equal(typeof parsed?.error?.message, 'string', 'must include an error message');
    assert.ok(!result.stdout.includes('super-secret-token'), 'receipts must not leak unexpectedSecret');
  }

  // Case C: seeded valid state with a bogus event -> events fails closed
  {
    const { dir, statePath } = freshState(t, 'a4-cli-malformed-event-');
    await seedQuarantined(statePath);
    const configPath = writeDispatcherConfig(dir);
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(Array.isArray(durable.events) && durable.events.length >= 1, 'precondition: state must have events');
    durable.events[0].bogusField = 'bogus-event-data';
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const result = runCLI(['governor', 'events', '--approve', '--json'], statePath, configPath);
    redIfUnimplemented(result, 'events with bogus event');
    assert.equal(result.status, 2, `events with bogus event must exit 2 (got ${result.status}; stdout=${result.stdout ?? ''} stderr=${result.stderr ?? ''})`);
    const parsed = assertExactJsonEnvelope(result, 'events with bogus event');
    assert.equal(parsed?.ok, false, 'events with bogus event must return {ok:false,...}');
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'events with bogus event must fail PROFILE_GOVERNOR_STATE_INVALID');
    assert.equal(typeof parsed?.error?.message, 'string', 'must include an error message');
  }
});

// 22. ADDED (Sol R5 F1): receipt/event semantic cross-reference fails closed
// when event.state !== receipt.newState, even when both event integrity and
// receipt digests remain valid.
test('A4 CLI: ADDED receipt/event semantic cross-reference fails closed on state mismatch', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-receipt-event-mismatch-');
  await seedQuarantined(statePath);
  const configPath = writeDispatcherConfig(dir);
  const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(Array.isArray(durable.receipts) && durable.receipts.length >= 1, 'precondition: must have receipts');
  const receipt = durable.receipts[0];
  assert.ok(receipt.eventId, 'precondition: receipt must reference eventId');
  const eventIndex = durable.events.findIndex((e) => e.eventId === receipt.eventId);
  assert.ok(eventIndex !== -1, 'precondition: referenced event must exist');
  const event = durable.events[eventIndex];
  assert.equal(event.state, receipt.newState, 'precondition: seeded event.state must equal receipt.newState');

  // Mutate event.state so event.state !== receipt.newState, but recompute both digests
  event.state = 'cooldown';
  durable.eventIntegrityDigests[eventIndex] = computeEventIntegrityDigest(event);
  receipt.receiptDigest = computeReceiptDigest(receipt);
  fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

  // Both status and events must fail closed with PROFILE_GOVERNOR_STATE_INVALID
  for (const cmd of [
    ['governor', 'status', '--json'],
    ['governor', 'events', '--approve', '--json'],
  ]) {
    const result = runCLI(cmd, statePath, configPath);
    redIfUnimplemented(result, `${cmd[1]} with mismatched event.state`);
    assert.equal(result.status, 2, `${cmd[1]} must exit 2 on event.state !== receipt.newState`);
    const parsed = assertExactJsonEnvelope(result, `${cmd[1]} with mismatched event.state`);
    assert.equal(parsed?.ok, false, `${cmd[1]} must return {ok:false,...}`);
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', `${cmd[1]} must fail with PROFILE_GOVERNOR_STATE_INVALID`);
  }
});

// 23. ADDED (Sol R5 F2): recovery-plan digests are bound to durable facts and each other —
// mismatched valid SHA-256 values, one-sided digests, and fact mismatches fail closed.
test('A4 CLI: ADDED recovery-plan digests must match each other and durable facts', async (t) => {
  // Case A: resource and lease have different valid SHA-256 values -> inspect fails closed
  {
    const { dir, statePath } = freshState(t, 'a4-cli-plan-mismatch-');
    await seedQuarantined(statePath);
    const configPath = writeDispatcherConfig(dir);
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const res = durable.resources[PHYSICAL_ID];
    const lease = durable.leases[res.currentLeaseId];
    assert.ok(res.recoveryPlanDigest, 'precondition: resource must have recoveryPlanDigest');
    assert.ok(lease.recoveryPlanDigest, 'precondition: lease must have recoveryPlanDigest');

    res.recoveryPlanDigest = `sha256:${'1'.repeat(64)}`;
    lease.recoveryPlanDigest = `sha256:${'2'.repeat(64)}`;
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const result = runCLI(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
    redIfUnimplemented(result, 'inspect with mismatched recovery-plan digests');
    assert.equal(result.status, 2, 'inspect must exit 2 on mismatched recovery-plan digests');
    const parsed = assertExactJsonEnvelope(result, 'inspect with mismatched recovery-plan digests');
    assert.equal(parsed?.ok, false, 'inspect must return {ok:false,...}');
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'inspect must fail with PROFILE_GOVERNOR_STATE_INVALID');
  }

  // Case B: one-sided recovery-plan digest (resource has digest, lease does not) -> status fails closed
  {
    const { dir, statePath } = freshState(t, 'a4-cli-plan-onesided-');
    await seedQuarantined(statePath);
    const configPath = writeDispatcherConfig(dir);
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const res = durable.resources[PHYSICAL_ID];
    const lease = durable.leases[res.currentLeaseId];
    delete lease.recoveryPlanDigest;
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const result = runCLI(['governor', 'status', '--json'], statePath, configPath);
    redIfUnimplemented(result, 'status with one-sided recovery-plan digest');
    assert.equal(result.status, 2, 'status must exit 2 on one-sided recovery-plan digest');
    const parsed = assertExactJsonEnvelope(result, 'status with one-sided recovery-plan digest');
    assert.equal(parsed?.ok, false, 'status must return {ok:false,...}');
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'status must fail with PROFILE_GOVERNOR_STATE_INVALID');
  }

  // Case C: matching digests that do not match the computed recovery facts -> receipts fails closed
  {
    const { dir, statePath } = freshState(t, 'a4-cli-plan-unproven-');
    await seedQuarantined(statePath);
    const configPath = writeDispatcherConfig(dir);
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const res = durable.resources[PHYSICAL_ID];
    const lease = durable.leases[res.currentLeaseId];
    const bogusDigest = `sha256:${'3'.repeat(64)}`;
    res.recoveryPlanDigest = bogusDigest;
    lease.recoveryPlanDigest = bogusDigest;
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const result = runCLI(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
    redIfUnimplemented(result, 'receipts with unproven recovery-plan digest');
    assert.equal(result.status, 2, 'receipts must exit 2 on unproven recovery-plan digest');
    const parsed = assertExactJsonEnvelope(result, 'receipts with unproven recovery-plan digest');
    assert.equal(parsed?.ok, false, 'receipts must return {ok:false,...}');
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'receipts must fail with PROFILE_GOVERNOR_STATE_INVALID');

    const statusResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
    redIfUnimplemented(statusResult, 'status with unproven recovery-plan digest');
    assert.equal(statusResult.status, 2, 'status must exit 2 on unproven recovery-plan digest');
    const statusParsed = assertExactJsonEnvelope(statusResult, 'status with unproven recovery-plan digest');
    assert.equal(statusParsed?.ok, false, 'status must return {ok:false,...}');
    assert.equal(statusParsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'status must fail with PROFILE_GOVERNOR_STATE_INVALID');
  }

  // Case D: syntactically valid matching digests computed with a reason absent from resource, lease, and event history -> fails closed
  {
    const { dir, statePath } = freshState(t, 'a4-cli-plan-absent-reason-');
    await seedQuarantined(statePath);
    const configPath = writeDispatcherConfig(dir);
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const res = durable.resources[PHYSICAL_ID];
    const lease = durable.leases[res.currentLeaseId];

    // Compute a syntactically valid digest using a reason code absent from durable resource, lease, and events
    const absentReasonDigest = computeRecoveryPlanDigest({
      leaseId: lease.leaseId,
      bindingDigest: lease.bindingDigest,
      fenceEpoch: res.fenceEpoch,
      reasonCode: 'PROFILE_RELEASE',
    });
    res.recoveryPlanDigest = absentReasonDigest;
    lease.recoveryPlanDigest = absentReasonDigest;
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const result = runCLI(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
    redIfUnimplemented(result, 'receipts with absent-reason recovery-plan digest');
    assert.equal(result.status, 2, 'receipts must exit 2 on absent-reason recovery-plan digest');
    const parsed = assertExactJsonEnvelope(result, 'receipts with absent-reason recovery-plan digest');
    assert.equal(parsed?.ok, false, 'receipts must return {ok:false,...}');
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'receipts must fail with PROFILE_GOVERNOR_STATE_INVALID');

    const statusResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
    redIfUnimplemented(statusResult, 'status with absent-reason recovery-plan digest');
    assert.equal(statusResult.status, 2, 'status must exit 2 on absent-reason recovery-plan digest');
    const statusParsed = assertExactJsonEnvelope(statusResult, 'status with absent-reason recovery-plan digest');
    assert.equal(statusParsed?.ok, false, 'status must return {ok:false,...}');
    assert.equal(statusParsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'status must fail with PROFILE_GOVERNOR_STATE_INVALID');
  }
});

// 24. ADDED (Sol R5 low residual): private regular file guard —
// symlinks, non-regular files (/dev/null), and non-0600 files fail closed
// with PROFILE_GOVERNOR_STATE_INVALID without mutating the target file.
test('A4 CLI: ADDED symlink and non-regular state sources fail closed without mutation', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-source-guard-');
  await seedLeased(statePath);
  const configPath = writeDispatcherConfig(dir);
  const preSha = sha256File(statePath);

  // Case A: symlink to state file -> status fails closed with PROFILE_GOVERNOR_STATE_INVALID
  const symlinkPath = path.join(dir, 'state-symlink.json');
  fs.symlinkSync(statePath, symlinkPath);
  const symlinkResult = runCLI(['governor', 'status', '--json'], symlinkPath, configPath);
  redIfUnimplemented(symlinkResult, 'status on symlink state');
  assert.equal(symlinkResult.status, 2, 'status on symlink state must exit 2');
  const symlinkParsed = assertExactJsonEnvelope(symlinkResult, 'status on symlink state');
  assert.equal(symlinkParsed?.ok, false, 'symlink state must return {ok:false,...}');
  assert.equal(symlinkParsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'symlink state must fail with PROFILE_GOVERNOR_STATE_INVALID');
  assert.equal(sha256File(statePath), preSha, 'state file must not be mutated by symlink rejection');

  // Case B: non-regular device (/dev/null) -> status fails closed with PROFILE_GOVERNOR_STATE_INVALID
  const devNullResult = runCLI(['governor', 'status', '--json'], '/dev/null', configPath);
  redIfUnimplemented(devNullResult, 'status on /dev/null');
  assert.equal(devNullResult.status, 2, 'status on /dev/null must exit 2');
  const devNullParsed = assertExactJsonEnvelope(devNullResult, 'status on /dev/null');
  assert.equal(devNullParsed?.ok, false, '/dev/null must return {ok:false,...}');
  assert.equal(devNullParsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', '/dev/null must fail with PROFILE_GOVERNOR_STATE_INVALID');

  // Case C: non-0600 mode (0644) -> status fails closed with PROFILE_GOVERNOR_STATE_INVALID
  const nonPrivatePath = path.join(dir, 'state-0644.json');
  fs.copyFileSync(statePath, nonPrivatePath);
  fs.chmodSync(nonPrivatePath, 0o644);
  const nonPrivatePreSha = sha256File(nonPrivatePath);
  const nonPrivateResult = runCLI(['governor', 'status', '--json'], nonPrivatePath, configPath);
  redIfUnimplemented(nonPrivateResult, 'status on non-0600 state');
  assert.equal(nonPrivateResult.status, 2, 'status on non-0600 state must exit 2');
  const nonPrivateParsed = assertExactJsonEnvelope(nonPrivateResult, 'status on non-0600 state');
  assert.equal(nonPrivateParsed?.ok, false, 'non-0600 state must return {ok:false,...}');
  assert.equal(nonPrivateParsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'non-0600 state must fail with PROFILE_GOVERNOR_STATE_INVALID');
  assert.equal(sha256File(nonPrivatePath), nonPrivatePreSha, 'non-0600 file must not be mutated');

  // Case D: oversized file (> 2MB MAX_STATE_BYTES) -> status fails closed with PROFILE_GOVERNOR_STATE_INVALID without mutation
  const oversizedPath = path.join(dir, 'state-oversized.json');
  const oversizedData = Buffer.alloc(2 * 1024 * 1024 + 16, ' ');
  fs.writeFileSync(oversizedPath, oversizedData, { mode: 0o600 });
  const oversizedPreSha = sha256File(oversizedPath);
  const oversizedResult = runCLI(['governor', 'status', '--json'], oversizedPath, configPath);
  redIfUnimplemented(oversizedResult, 'status on oversized state');
  assert.equal(oversizedResult.status, 2, 'status on oversized state must exit 2');
  const oversizedParsed = assertExactJsonEnvelope(oversizedResult, 'status on oversized state');
  assert.equal(oversizedParsed?.ok, false, 'oversized state must return {ok:false,...}');
  assert.equal(oversizedParsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'oversized state must fail with PROFILE_GOVERNOR_STATE_INVALID');
  assert.equal(sha256File(oversizedPath), oversizedPreSha, 'oversized file must not be mutated');
});

// 25. ADDED (Sol R5 compatibility): read paths accept valid retained historical recovery-plan state —
// core applyEvidenceRecovery moves resource to ready, clears currentLeaseId, moves lease to cooldown,
// and retains historical recovery-plan digest in both records.
test('A4 CLI: ADDED read paths accept valid retained historical recovery-plan state', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-recovered-plan-');
  const configPath = writeDispatcherConfig(dir);

  const governor = openGovernor(statePath);
  let leaseId;
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(leaseRequest());
    leaseId = lease.leaseId;
    const fence = await governor.createFence({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      runId: lease.runId,
      bindingId: lease.bindingId,
      action: 'browser-read',
    });
    await governor.authorizeFence(fence);
    const facts = () => {
      const current = governor.repository.read().leases[lease.leaseId];
      return {
        fenceId: fence.fenceId,
        fenceEpoch: current.fenceEpoch,
        leaseBindingDigest: current.leaseBindingDigest,
        bindingId: current.bindingId,
        bindingDigest: current.bindingDigest,
        runId: current.runId,
        runnerClaimDigest: current.runnerClaimDigest,
      };
    };
    await governor.recordAction({ leaseId: lease.leaseId, actionId: 'act_a4cli-1', outcome: 'prepared', ...facts() });
    await governor.recordAction({ leaseId: lease.leaseId, actionId: 'act_a4cli-1', outcome: 'dispatched', ...facts() });
    const qReceipt = await governor.recordAction({ leaseId: lease.leaseId, actionId: 'act_a4cli-1', outcome: 'indeterminate', ...facts() });
    assert.equal(qReceipt.newState, 'quarantined');

    // Resolve indeterminate action through the existing core test seam:
    await governor.recordAction({
      leaseId: lease.leaseId,
      actionId: 'act_a4cli-1',
      outcome: 'failed-known',
      resolution: { kind: 'trusted-revocation' },
      ...facts(),
    });

    // Apply valid evidence recovery to ready/cooldown:
    const recReceipt = await governor.recover(ALIAS, { authenticatedLocalCapability: true, capability: { kind: 'operator' } });
    assert.equal(recReceipt.newState, 'ready');
  } finally {
    governor.close();
  }

  // Preconditions on persisted durable state:
  const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const res = durable.resources[PHYSICAL_ID];
  const recoveredLease = durable.leases[leaseId];
  assert.equal(res.state, 'ready', 'precondition: resource must be ready');
  assert.equal(res.currentLeaseId, null, 'precondition: currentLeaseId must be null');
  assert.ok(res.recoveryPlanDigest, 'precondition: resource must retain historical recoveryPlanDigest');
  assert.equal(recoveredLease.state, 'cooldown', 'precondition: lease must be in cooldown');
  assert.ok(recoveredLease.recoveryPlanDigest, 'precondition: lease must retain historical recoveryPlanDigest');
  assert.equal(res.recoveryPlanDigest, recoveredLease.recoveryPlanDigest, 'precondition: digests must match');

  // Both read-only CLI commands (status and receipts) succeed with typed response
  const statusResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
  redIfUnimplemented(statusResult, 'status on valid recovered state');
  assert.equal(statusResult.status, 0, 'status must exit 0 on valid recovered state');
  const statusParsed = assertExactJsonEnvelope(statusResult, 'status on valid recovered state');
  assert.equal(statusParsed?.ok, true, 'status must return {ok:true,...}');
  assert.equal(statusParsed?.data?.profiles, 1);
  assert.equal(statusParsed?.data?.leases, 1);

  const receiptsResult = runCLI(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(receiptsResult, 'receipts on valid recovered state');
  assert.equal(receiptsResult.status, 0, 'receipts must exit 0 on valid recovered state');
  const receiptsParsed = assertExactJsonEnvelope(receiptsResult, 'receipts on valid recovered state');
  assert.equal(receiptsParsed?.ok, true, 'receipts must return {ok:true,...}');
  assert.ok(Array.isArray(receiptsParsed?.data), 'receipts must return an array');
  assert.ok(receiptsParsed.data.some((entry) => entry?.newState === 'ready' && entry?.leaseId === leaseId), 'receipts must include ready recovery receipt');

  // Multi-cooldown selection: add a second cooldown lease for the same physical resource without recovery-plan digest
  const secondLeaseId = 'lease_1111222233334444';
  const secondLease = {
    ...recoveredLease,
    leaseId: secondLeaseId,
    fenceEpoch: 1,
    leaseBindingDigest: computeLeaseBindingDigest({
      claimDigest: recoveredLease.runnerClaimDigest,
      bindingDigest: recoveredLease.bindingDigest,
      physicalResourceId: recoveredLease.physicalResourceId,
      fenceEpoch: 1,
      profileAlias: recoveredLease.profileAlias,
    }),
    releasedAt: new Date().toISOString(),
    state: 'cooldown',
  };
  delete secondLease.recoveryPlanDigest;
  const multiDurable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  multiDurable.leases[secondLeaseId] = secondLease;
  fs.writeFileSync(statePath, `${JSON.stringify(multiDurable, null, 2)}\n`);

  const multiResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
  assert.equal(multiResult.status, 0, 'status must exit 0 with multi-cooldown leases');
  const multiParsed = assertExactJsonEnvelope(multiResult, 'status with multi-cooldown leases');
  assert.equal(multiParsed?.ok, true);
  assert.equal(multiParsed?.data?.leases, 2, 'reports 2 leases in multi-cooldown state');

  // Negative case: detached historical cooldown with unproven recovery-plan digest fails closed
  const unprovenHistoricalDigest = computeRecoveryPlanDigest({
    leaseId: recoveredLease.leaseId,
    bindingDigest: recoveredLease.bindingDigest,
    fenceEpoch: 2,
    reasonCode: 'PROFILE_RELEASE',
  });
  const unprovenDurable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  unprovenDurable.resources[PHYSICAL_ID].recoveryPlanDigest = unprovenHistoricalDigest;
  unprovenDurable.leases[leaseId].recoveryPlanDigest = unprovenHistoricalDigest;
  fs.writeFileSync(statePath, `${JSON.stringify(unprovenDurable, null, 2)}\n`);

  const unprovenStatusResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
  assert.equal(unprovenStatusResult.status, 2, 'status must exit 2 on unproven historical recovery digest');
  const unprovenStatusParsed = assertExactJsonEnvelope(unprovenStatusResult, 'status with unproven historical recovery digest');
  assert.equal(unprovenStatusParsed?.ok, false);
  assert.equal(unprovenStatusParsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID');
});

// 26. ADDED (S11 fix): a re-barriered already-quarantined lease with a valid paired digest
// bound to the second barrier is accepted by read-only status/receipts.
test('A4 CLI: ADDED re-barriered already-quarantined lease with valid paired digest is accepted', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-rebarrier-');
  const configPath = writeDispatcherConfig(dir);

  const governor = openGovernor(statePath);
  let leaseId;
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(leaseRequest());
    leaseId = lease.leaseId;
    const fence = await governor.createFence({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      runId: lease.runId,
      bindingId: lease.bindingId,
      action: 'browser-read',
    });
    await governor.authorizeFence(fence);
    const facts = {
      leaseId: lease.leaseId,
      fenceId: fence.fenceId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      bindingId: lease.bindingId,
      bindingDigest: lease.bindingDigest,
      runId: lease.runId,
      runnerClaimDigest: lease.runnerClaimDigest,
      actionId: 'act_a4cli-1',
    };
    await governor.recordAction({ ...facts, outcome: 'prepared' });
    await governor.recordAction({ ...facts, outcome: 'dispatched' });
    const qReceipt = await governor.recordAction({ ...facts, outcome: 'indeterminate' });
    assert.equal(qReceipt.newState, 'quarantined');
    assert.equal(qReceipt.newFenceEpoch, 2);

    // Re-barrier the already-quarantined lease via core lease-service method
    const currentLease = governor.repository.read().leases[leaseId];
    await governor._establishRevocationBarrier(currentLease, { reasonCode: 'PROFILE_RECLAIM_UNSAFE' });
  } finally {
    governor.close();
  }

  // Verify durable state facts after re-barrier:
  const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const res = durable.resources[PHYSICAL_ID];
  const lease = durable.leases[leaseId];
  assert.equal(res.state, 'quarantined');
  assert.equal(res.fenceEpoch, 3, 'fenceEpoch must be bumped to 3');
  assert.equal(lease.fenceEpoch, 3);
  // Resource retained the old stateReasonCode while paired digest was recomputed for second barrier:
  assert.equal(res.stateReasonCode, 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', 'resource retains historical reason');
  assert.ok(res.recoveryPlanDigest, 'resource has recoveryPlanDigest');
  assert.equal(res.recoveryPlanDigest, lease.recoveryPlanDigest, 'paired digests must match');
  assert.ok(
    durable.events.some((e) => e.leaseId === leaseId && e.state === 'quarantined' && e.fenceEpoch === 2),
    'durable events include earlier quarantine at lower epoch'
  );
  assert.ok(
    durable.events.some((e) => e.leaseId === leaseId && e.state === 'quarantined' && e.fenceEpoch === 3 && e.stateReasonCode === 'PROFILE_RECLAIM_UNSAFE'),
    'durable events include current-epoch quarantine event with exact reason'
  );

  // Read-only status succeeds with 0 and expected counts:
  const statusResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
  redIfUnimplemented(statusResult, 'status on re-barriered quarantine');
  assert.equal(statusResult.status, 0, 'status must exit 0 on re-barriered quarantine');
  const statusParsed = assertExactJsonEnvelope(statusResult, 'status on re-barriered quarantine');
  assert.equal(statusParsed?.ok, true, 'status must return {ok:true,...}');
  assert.equal(statusParsed?.data?.profiles, 1);
  assert.equal(statusParsed?.data?.leases, 1);

  // Read-only receipts succeeds with 0 and returns receipts array:
  const receiptsResult = runCLI(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(receiptsResult, 'receipts on re-barriered quarantine');
  assert.equal(receiptsResult.status, 0, 'receipts must exit 0 on re-barriered quarantine');
  const receiptsParsed = assertExactJsonEnvelope(receiptsResult, 'receipts on re-barriered quarantine');
  assert.equal(receiptsParsed?.ok, true, 'receipts must return {ok:true,...}');
  assert.ok(Array.isArray(receiptsParsed?.data), 'receipts must return an array');
});

// 27. ADDED (S11 fix): malformed releasedAt fails PROFILE_GOVERNOR_STATE_INVALID
test('A4 CLI: ADDED malformed releasedAt fails closed with PROFILE_GOVERNOR_STATE_INVALID', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-released-at-');
  const configPath = writeDispatcherConfig(dir);
  const { leaseId } = await seedLeased(statePath);

  // Case A: malformed non-RFC3339 releasedAt string -> status fails closed
  {
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    durable.leases[leaseId].releasedAt = 'not-a-valid-timestamp';
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const result = runCLI(['governor', 'status', '--json'], statePath, configPath);
    redIfUnimplemented(result, 'status with malformed releasedAt string');
    assert.equal(result.status, 2, 'status must exit 2 on malformed releasedAt string');
    const parsed = assertExactJsonEnvelope(result, 'status with malformed releasedAt string');
    assert.equal(parsed?.ok, false, 'status must return {ok:false,...}');
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'status must fail with PROFILE_GOVERNOR_STATE_INVALID');
  }

  // Case B: malformed non-string releasedAt -> inspect fails closed
  {
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    durable.leases[leaseId].releasedAt = 123456789;
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const result = runCLI(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
    redIfUnimplemented(result, 'inspect with non-string releasedAt');
    assert.equal(result.status, 2, 'inspect must exit 2 on non-string releasedAt');
    const parsed = assertExactJsonEnvelope(result, 'inspect with non-string releasedAt');
    assert.equal(parsed?.ok, false, 'inspect must return {ok:false,...}');
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'inspect must fail with PROFILE_GOVERNOR_STATE_INVALID');
  }

  // Case C: valid RFC3339 releasedAt -> status succeeds
  {
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    durable.leases[leaseId].releasedAt = new Date().toISOString();
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const result = runCLI(['governor', 'status', '--json'], statePath, configPath);
    redIfUnimplemented(result, 'status with valid releasedAt');
    assert.equal(result.status, 0, 'status must exit 0 on valid releasedAt');
    const parsed = assertExactJsonEnvelope(result, 'status with valid releasedAt');
    assert.equal(parsed?.ok, true, 'status must return {ok:true,...}');
  }
});

// 28. ADDED (S13 fix): governor --help status / -h status is clean help and does not swallow status.
test('A4 CLI: ADDED --help status is clean help and does not swallow status', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-help-status-');
  const configPath = writeDispatcherConfig(dir);

  // governor --help status: clean human help without JSON, does not swallow status
  const helpResult = runCLI(['governor', '--help', 'status'], statePath, configPath);
  redIfUnimplemented(helpResult, 'governor --help status');
  assert.equal(helpResult.status, 0, `governor --help status must exit 0 (got ${helpResult.status}; stderr=${helpResult.stderr ?? ''})`);
  assert.match(helpResult.stdout ?? '', /Usage:/, '--help status must show usage');
  assert.match(helpResult.stdout ?? '', /webmcp-browser governor/, '--help status must show header');
  assert.match(helpResult.stdout ?? '', /status/, '--help status must include status subcommand in help');
  assert.doesNotMatch((helpResult.stdout ?? '').trim(), /^\{/, '--help status must not emit JSON');
  assert.equal(helpResult.stderr ?? '', '', '--help status must have empty stderr');
  assert.ok(!fs.existsSync(statePath), '--help status must not create state file');

  // governor -h status: clean human help
  const shortResult = runCLI(['governor', '-h', 'status'], statePath, configPath);
  redIfUnimplemented(shortResult, 'governor -h status');
  assert.equal(shortResult.status, 0, 'governor -h status must exit 0');
  assert.match(shortResult.stdout ?? '', /Usage:/, '-h status must show usage');
  assert.match(shortResult.stdout ?? '', /webmcp-browser governor/, '-h status must show header');
  assert.match(shortResult.stdout ?? '', /status/, '-h status must include status subcommand in help');
  assert.doesNotMatch((shortResult.stdout ?? '').trim(), /^\{/, '-h status must not emit JSON');
  assert.equal(shortResult.stderr ?? '', '', '-h status must have empty stderr');
  assert.ok(!fs.existsSync(statePath), '-h status must not create state file');

  // governor -h status --json: rejects help with --json as PROFILE_REQUEST_INVALID
  const shortJsonResult = runCLI(['governor', '-h', 'status', '--json'], statePath, configPath);
  redIfUnimplemented(shortJsonResult, 'governor -h status --json');
  assertTypedFailure(shortJsonResult, 'governor -h status --json', 'PROFILE_REQUEST_INVALID');
  assertExactJsonEnvelope(shortJsonResult, 'governor -h status --json');

  // governor --help status --json: rejects help with --json as PROFILE_REQUEST_INVALID
  const jsonResult = runCLI(['governor', '--help', 'status', '--json'], statePath, configPath);
  redIfUnimplemented(jsonResult, 'governor --help status --json');
  assertTypedFailure(jsonResult, 'governor --help status --json', 'PROFILE_REQUEST_INVALID');
  assertExactJsonEnvelope(jsonResult, 'governor --help status --json');
});

// 29. ADDED (S13 fix): valid historical ready/cooldown state remains readable
// after its quarantine proof event is removed/trimmed, while paired digest mismatch still fails.
test('A4 CLI: ADDED valid historical ready/cooldown state remains readable after quarantine event trimmed', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-trimmed-history-');
  const configPath = writeDispatcherConfig(dir);

  const governor = openGovernor(statePath);
  let leaseId;
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(leaseRequest());
    leaseId = lease.leaseId;
    const fence = await governor.createFence({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      runId: lease.runId,
      bindingId: lease.bindingId,
      action: 'browser-read',
    });
    await governor.authorizeFence(fence);
    const facts = () => {
      const current = governor.repository.read().leases[lease.leaseId];
      return {
        fenceId: fence.fenceId,
        fenceEpoch: current.fenceEpoch,
        leaseBindingDigest: current.leaseBindingDigest,
        bindingId: current.bindingId,
        bindingDigest: current.bindingDigest,
        runId: current.runId,
        runnerClaimDigest: current.runnerClaimDigest,
      };
    };
    await governor.recordAction({ leaseId: lease.leaseId, actionId: 'act_a4cli-1', outcome: 'prepared', ...facts() });
    await governor.recordAction({ leaseId: lease.leaseId, actionId: 'act_a4cli-1', outcome: 'dispatched', ...facts() });
    await governor.recordAction({ leaseId: lease.leaseId, actionId: 'act_a4cli-1', outcome: 'indeterminate', ...facts() });
    await governor.recordAction({
      leaseId: lease.leaseId,
      actionId: 'act_a4cli-1',
      outcome: 'failed-known',
      resolution: { kind: 'trusted-revocation' },
      ...facts(),
    });
    await governor.recover(ALIAS, { authenticatedLocalCapability: true, capability: { kind: 'operator' } });
  } finally {
    governor.close();
  }

  // Precondition check
  const preDurable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const res = preDurable.resources[PHYSICAL_ID];
  const recLease = preDurable.leases[leaseId];
  assert.equal(res.state, 'ready');
  assert.equal(res.currentLeaseId, null);
  assert.equal(recLease.state, 'cooldown');
  assert.ok(res.recoveryPlanDigest);
  assert.equal(res.recoveryPlanDigest, recLease.recoveryPlanDigest);

  // Case A: Trim only the quarantine proof event from event journal
  {
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    durable.events = durable.events.filter((e) => e.state !== 'quarantined');
    durable.eventIntegrityDigests = durable.events.map(computeEventIntegrityDigest);
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const statusResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
    assert.equal(statusResult.status, 0, 'status must exit 0 after quarantine event trimmed');
    const statusParsed = assertExactJsonEnvelope(statusResult, 'status after quarantine event trimmed');
    assert.equal(statusParsed?.ok, true);

    const inspectResult = runCLI(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
    assert.equal(inspectResult.status, 0, 'inspect must exit 0 after quarantine event trimmed');
    const inspectParsed = assertExactJsonEnvelope(inspectResult, 'inspect after quarantine event trimmed');
    assert.equal(inspectParsed?.ok, true);
    assert.equal(inspectParsed?.data?.state, 'ready');
    assert.ok(!JSON.stringify(inspectParsed).includes(PHYSICAL_ID), 'inspect must not expose physical ID');
    assert.ok(!JSON.stringify(inspectParsed).includes(res.recoveryPlanDigest), 'inspect must not expose recovery digest');
  }

  // Case B: Trim BOTH the quarantine proof event AND the quarantine receipt (all proof records trimmed)
  {
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    durable.events = durable.events.filter((e) => e.state !== 'quarantined');
    durable.eventIntegrityDigests = durable.events.map(computeEventIntegrityDigest);
    durable.receipts = durable.receipts.filter((r) => r.newState !== 'quarantined');
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const statusResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
    assert.equal(statusResult.status, 0, 'status must exit 0 after all quarantine proof records trimmed');
    const statusParsed = assertExactJsonEnvelope(statusResult, 'status after all quarantine proof records trimmed');
    assert.equal(statusParsed?.ok, true);

    const receiptsResult = runCLI(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
    assert.equal(receiptsResult.status, 0, 'receipts must exit 0 after quarantine proof records trimmed');
    const receiptsParsed = assertExactJsonEnvelope(receiptsResult, 'receipts after quarantine proof records trimmed');
    assert.equal(receiptsParsed?.ok, true);
    assert.ok(Array.isArray(receiptsParsed?.data));

    const eventsResult = runCLI(['governor', 'events', '--approve', '--json'], statePath, configPath);
    assert.equal(eventsResult.status, 0, 'events must exit 0 after quarantine proof records trimmed');
    const eventsParsed = assertExactJsonEnvelope(eventsResult, 'events after quarantine proof records trimmed');
    assert.equal(eventsParsed?.ok, true);
    assert.ok(Array.isArray(eventsParsed?.data));
  }

  // Case C: Paired digest mismatch still fails closed even when proof records are trimmed
  {
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    durable.events = durable.events.filter((e) => e.state !== 'quarantined');
    durable.eventIntegrityDigests = durable.events.map(computeEventIntegrityDigest);
    durable.receipts = durable.receipts.filter((r) => r.newState !== 'quarantined');
    // Mutate lease digest so it does not match resource digest:
    durable.leases[leaseId].recoveryPlanDigest = `sha256:${'9'.repeat(64)}`;
    fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

    const mismatchResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
    assert.equal(mismatchResult.status, 2, 'status must exit 2 on paired digest mismatch');
    const mismatchParsed = assertExactJsonEnvelope(mismatchResult, 'status on paired digest mismatch');
    assert.equal(mismatchParsed?.ok, false);
    assert.equal(mismatchParsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID');

    const inspectMismatch = runCLI(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
    assert.equal(inspectMismatch.status, 2, 'inspect must exit 2 on paired digest mismatch');
    const inspectMismatchParsed = assertExactJsonEnvelope(inspectMismatch, 'inspect on paired digest mismatch');
    assert.equal(inspectMismatchParsed?.ok, false);
    assert.equal(inspectMismatchParsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID');
  }
});

// 30. ADDED (S13 fix): multiple cooldown leases select the digest-matching lease
test('A4 CLI: ADDED multiple cooldown leases select the digest-matching lease', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-multi-cooldown-digests-');
  const configPath = writeDispatcherConfig(dir);

  const governor = openGovernor(statePath);
  let primaryLeaseId;
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(leaseRequest());
    primaryLeaseId = lease.leaseId;
    const fence = await governor.createFence({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      runId: lease.runId,
      bindingId: lease.bindingId,
      action: 'browser-read',
    });
    await governor.authorizeFence(fence);
    const facts = () => {
      const current = governor.repository.read().leases[lease.leaseId];
      return {
        fenceId: fence.fenceId,
        fenceEpoch: current.fenceEpoch,
        leaseBindingDigest: current.leaseBindingDigest,
        bindingId: current.bindingId,
        bindingDigest: current.bindingDigest,
        runId: current.runId,
        runnerClaimDigest: current.runnerClaimDigest,
      };
    };
    await governor.recordAction({ leaseId: lease.leaseId, actionId: 'act_a4cli-1', outcome: 'prepared', ...facts() });
    await governor.recordAction({ leaseId: lease.leaseId, actionId: 'act_a4cli-1', outcome: 'dispatched', ...facts() });
    await governor.recordAction({ leaseId: lease.leaseId, actionId: 'act_a4cli-1', outcome: 'indeterminate', ...facts() });
    await governor.recordAction({
      leaseId: lease.leaseId,
      actionId: 'act_a4cli-1',
      outcome: 'failed-known',
      resolution: { kind: 'trusted-revocation' },
      ...facts(),
    });
    await governor.recover(ALIAS, { authenticatedLocalCapability: true, capability: { kind: 'operator' } });
  } finally {
    governor.close();
  }

  const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const primaryLease = durable.leases[primaryLeaseId];

  // Add a second cooldown lease with its OWN different valid recoveryPlanDigest
  const secondLeaseId = 'lease_aaaa1111bbbb2222';
  const secondDigest = computeRecoveryPlanDigest({
    leaseId: secondLeaseId,
    bindingDigest: primaryLease.bindingDigest,
    fenceEpoch: 1,
    reasonCode: 'PROFILE_OUTWARD_EFFECT_INDETERMINATE',
  });
  durable.leases[secondLeaseId] = {
    ...primaryLease,
    leaseId: secondLeaseId,
    fenceEpoch: 1,
    leaseBindingDigest: computeLeaseBindingDigest({
      claimDigest: primaryLease.runnerClaimDigest,
      bindingDigest: primaryLease.bindingDigest,
      physicalResourceId: primaryLease.physicalResourceId,
      fenceEpoch: 1,
      profileAlias: primaryLease.profileAlias,
    }),
    releasedAt: new Date().toISOString(),
    state: 'cooldown',
    recoveryPlanDigest: secondDigest,
  };

  // Add a third cooldown lease without any recoveryPlanDigest
  const thirdLeaseId = 'lease_cccc3333dddd4444';
  const thirdLease = {
    ...primaryLease,
    leaseId: thirdLeaseId,
    fenceEpoch: 1,
    leaseBindingDigest: computeLeaseBindingDigest({
      claimDigest: primaryLease.runnerClaimDigest,
      bindingDigest: primaryLease.bindingDigest,
      physicalResourceId: primaryLease.physicalResourceId,
      fenceEpoch: 1,
      profileAlias: primaryLease.profileAlias,
    }),
    releasedAt: new Date().toISOString(),
    state: 'cooldown',
  };
  delete thirdLease.recoveryPlanDigest;
  durable.leases[thirdLeaseId] = thirdLease;

  fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

  // Multiple cooldown leases select the digest-matching lease; unrelated cooldown leases
  // are not forced to match the resource's current historical digest
  const statusResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
  redIfUnimplemented(statusResult, 'status with multiple cooldown leases');
  assert.equal(statusResult.status, 0, 'status must exit 0 with multiple cooldown leases');
  const statusParsed = assertExactJsonEnvelope(statusResult, 'status with multiple cooldown leases');
  assert.equal(statusParsed?.ok, true);
  assert.equal(statusParsed?.data?.leases, 3, 'status reports 3 leases');

  const inspectResult = runCLI(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(inspectResult, 'inspect with multiple cooldown leases');
  assert.equal(inspectResult.status, 0, 'inspect must exit 0 with multiple cooldown leases');
  const inspectParsed = assertExactJsonEnvelope(inspectResult, 'inspect with multiple cooldown leases');
  assert.equal(inspectParsed?.ok, true);
  assert.equal(inspectParsed?.data?.state, 'ready');

  const receiptsResult = runCLI(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(receiptsResult, 'receipts with multiple cooldown leases');
  assert.equal(receiptsResult.status, 0, 'receipts must exit 0 with multiple cooldown leases');
  const receiptsParsed = assertExactJsonEnvelope(receiptsResult, 'receipts with multiple cooldown leases');
  assert.equal(receiptsParsed?.ok, true);
});

// 31. ADDED (S13 fix): valid re-barrier whose raw reason is represented only through
// durable receipt/event facts remains readable; unproven single-barrier fails closed.
test('A4 CLI: ADDED valid re-barrier whose raw reason is represented only through durable receipt/event facts remains readable', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-rebarrier-raw-');
  const configPath = writeDispatcherConfig(dir);

  const governor = openGovernor(statePath);
  let leaseId;
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(leaseRequest());
    leaseId = lease.leaseId;
    const fence = await governor.createFence({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      runId: lease.runId,
      bindingId: lease.bindingId,
      action: 'browser-read',
    });
    await governor.authorizeFence(fence);
    const facts = {
      leaseId: lease.leaseId,
      fenceId: fence.fenceId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      bindingId: lease.bindingId,
      bindingDigest: lease.bindingDigest,
      runId: lease.runId,
      runnerClaimDigest: lease.runnerClaimDigest,
      actionId: 'act_a4cli-1',
    };
    await governor.recordAction({ ...facts, outcome: 'prepared' });
    await governor.recordAction({ ...facts, outcome: 'dispatched' });
    const qReceipt = await governor.recordAction({ ...facts, outcome: 'indeterminate' });
    assert.equal(qReceipt.newState, 'quarantined');
    assert.equal(qReceipt.newFenceEpoch, 2);

    // Re-barrier with PROFILE_BINDING_STALE (maps to public event reason PROFILE_LEASE_REVOKED)
    const currentLease = governor.repository.read().leases[leaseId];
    await governor._establishRevocationBarrier(currentLease, { reasonCode: 'PROFILE_BINDING_STALE' });
  } finally {
    governor.close();
  }

  const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const res = durable.resources[PHYSICAL_ID];
  const lease = durable.leases[leaseId];
  assert.equal(res.state, 'quarantined');
  assert.equal(res.fenceEpoch, 3);
  assert.equal(res.stateReasonCode, 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', 'resource retains historical reason');

  // Verify the re-barrier event exists with mapped reason PROFILE_LEASE_REVOKED
  assert.ok(
    durable.events.some((e) => e.leaseId === leaseId && e.state === 'quarantined' && e.fenceEpoch === 3 && e.stateReasonCode === 'PROFILE_LEASE_REVOKED'),
    'current-epoch quarantine event has mapped reason PROFILE_LEASE_REVOKED'
  );
  assert.ok(
    durable.events.some((e) => e.leaseId === leaseId && e.state === 'quarantined' && e.fenceEpoch === 2),
    'earlier quarantine event at lower epoch exists'
  );

  // Read paths succeed via re-barrier compatibility (earlier quarantine event + current-epoch quarantine event)
  const statusResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
  redIfUnimplemented(statusResult, 'status on re-barrier with mapped event reason');
  assert.equal(statusResult.status, 0, 'status must exit 0 on re-barrier with mapped event reason');
  const statusParsed = assertExactJsonEnvelope(statusResult, 'status on re-barrier with mapped event reason');
  assert.equal(statusParsed?.ok, true);

  const inspectResult = runCLI(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(inspectResult, 'inspect on re-barrier with mapped event reason');
  assert.equal(inspectResult.status, 0, 'inspect must exit 0 on re-barrier with mapped event reason');
  const inspectParsed = assertExactJsonEnvelope(inspectResult, 'inspect on re-barrier with mapped event reason');
  assert.equal(inspectParsed?.ok, true);
  assert.equal(inspectParsed?.data?.fenceEpoch, 3);

  // Now also verify that when a matching recovery receipt carries the raw reasonCode,
  // candidate reasons directly proves the exact match
  const rawReasonReceipt = {
    schema: 'webmcp-profile-recovery-receipt/1',
    receiptId: 'prr_0123456789abcdef',
    leaseId,
    profileAlias: ALIAS,
    bindingId: BINDING_ID,
    bindingRevision: BINDING_REVISION,
    bindingDigest: DIGEST,
    runId: lease.runId,
    priorState: 'quarantined',
    newState: 'quarantined',
    priorFenceEpoch: 2,
    newFenceEpoch: 3,
    reasonCode: 'PROFILE_RECLAIM_UNSAFE',
    probeOutcomes: {
      governorHealth: 'unknown',
      runnerClaim: 'unknown',
      browserAlive: false,
      extensionConnected: false,
      dependentGrantsRevoked: false,
      registryCurrent: true,
    },
    lastActionOutcome: 'none',
    dependentGrantRevokeStatus: 'pending',
    authorityKind: 'governor-automatic',
    createdAt: new Date().toISOString(),
  };
  rawReasonReceipt.receiptDigest = computeReceiptDigest(rawReasonReceipt);
  durable.receipts.push(rawReasonReceipt);

  // Update digest to match rawReasonReceipt's reasonCode PROFILE_RECLAIM_UNSAFE
  const receiptProvenDigest = computeRecoveryPlanDigest({
    leaseId,
    bindingDigest: DIGEST,
    fenceEpoch: 3,
    reasonCode: 'PROFILE_RECLAIM_UNSAFE',
  });
  durable.resources[PHYSICAL_ID].recoveryPlanDigest = receiptProvenDigest;
  durable.leases[leaseId].recoveryPlanDigest = receiptProvenDigest;
  fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

  const receiptProvenStatus = runCLI(['governor', 'status', '--json'], statePath, configPath);
  assert.equal(receiptProvenStatus.status, 0, 'status must exit 0 when digest proved via receipt raw reasonCode');
  const receiptProvenParsed = assertExactJsonEnvelope(receiptProvenStatus, 'status when digest proved via receipt');
  assert.equal(receiptProvenParsed?.ok, true);

  const receiptsResult = runCLI(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
  assert.equal(receiptsResult.status, 0, 'receipts must exit 0');
  const receiptsParsed = assertExactJsonEnvelope(receiptsResult, 'receipts with raw reason receipt');
  assert.equal(receiptsParsed?.ok, true);
  assert.ok(receiptsParsed.data.some((r) => r?.receiptId === 'prr_0123456789abcdef'));
  const foundReceipt = receiptsParsed.data.find((r) => r?.receiptId === 'prr_0123456789abcdef');
  assert.match(foundReceipt.receiptId, /^prr_[0-9a-f]{16}$/, 'receiptId matches existing schema');
});

// 32. ADDED (Sol S15 finding 1): earlier + current-epoch quarantine events with
// an arbitrary recovery-plan digest must still fail closed — no fail-open
// escape when both proof generations are present.
test('A4 CLI: ADDED earlier+current quarantine with arbitrary digest still fails closed', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-s15-f1-');
  const configPath = writeDispatcherConfig(dir);

  const governor = openGovernor(statePath);
  let leaseId;
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(leaseRequest());
    leaseId = lease.leaseId;
    const fence = await governor.createFence({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      runId: lease.runId,
      bindingId: lease.bindingId,
      action: 'browser-read',
    });
    await governor.authorizeFence(fence);
    const facts = {
      leaseId: lease.leaseId,
      fenceId: fence.fenceId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      bindingId: lease.bindingId,
      bindingDigest: lease.bindingDigest,
      runId: lease.runId,
      runnerClaimDigest: lease.runnerClaimDigest,
      actionId: 'act_a4cli-1',
    };
    await governor.recordAction({ ...facts, outcome: 'prepared' });
    await governor.recordAction({ ...facts, outcome: 'dispatched' });
    const qReceipt = await governor.recordAction({ ...facts, outcome: 'indeterminate' });
    assert.equal(qReceipt.newState, 'quarantined');
    const currentLease = governor.repository.read().leases[leaseId];
    await governor._establishRevocationBarrier(currentLease, { reasonCode: 'PROFILE_RECLAIM_UNSAFE' });
  } finally {
    governor.close();
  }

  const validDurable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const validRes = validDurable.resources[PHYSICAL_ID];
  assert.equal(validRes.state, 'quarantined');
  assert.equal(validRes.fenceEpoch, 3, 're-barrier must advance to epoch 3');
  assert.ok(
    validDurable.events.some((e) => e.leaseId === leaseId && e.state === 'quarantined' && e.fenceEpoch === 2),
    'precondition: earlier quarantine event at epoch 2 must exist',
  );
  assert.ok(
    validDurable.events.some((e) => e.leaseId === leaseId && e.state === 'quarantined' && e.fenceEpoch === 3),
    'precondition: current-epoch quarantine event at epoch 3 must exist',
  );

  // Overwrite with an arbitrary integrity-shaped digest that proves no durable
  // reason/fact (the fail-open escape would have accepted mere event presence).
  const arbitraryDigest = `sha256:${'4'.repeat(64)}`;
  assert.notEqual(validRes.recoveryPlanDigest, arbitraryDigest, 'precondition: arbitrary digest must differ from the valid paired digest');
  validDurable.resources[PHYSICAL_ID].recoveryPlanDigest = arbitraryDigest;
  validDurable.leases[leaseId].recoveryPlanDigest = arbitraryDigest;
  fs.writeFileSync(statePath, `${JSON.stringify(validDurable, null, 2)}\n`);

  // Event integrity + receipt digests remain valid; only the recovery binding is unproven.
  for (const args of [
    ['governor', 'status', '--json'],
    ['governor', 'inspect', ALIAS, '--approve', '--json'],
  ]) {
    const result = runCLI(args, statePath, configPath);
    redIfUnimplemented(result, `S15F1 ${args[1]} with arbitrary digest`);
    assert.equal(result.status, 2, `${args[1]} must exit 2 on arbitrary digest despite earlier+current quarantine events`);
    const parsed = assertExactJsonEnvelope(result, `${args[1]} with arbitrary digest`);
    assert.equal(parsed?.ok, false, `${args[1]} must return {ok:false,...}`);
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', `${args[1]} must fail PROFILE_GOVERNOR_STATE_INVALID`);
  }
});

// 33. ADDED (Sol S15 finding 2): contradictory current pair — resource `active`
// with current lease `quarantined` — fails closed even when every other record
// is integrity-valid.
test('A4 CLI: ADDED contradictory active resource with quarantined current lease fails closed', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-s15-f2-');
  await seedQuarantined(statePath);
  const configPath = writeDispatcherConfig(dir);
  const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const res = durable.resources[PHYSICAL_ID];
  const leaseId = res.currentLeaseId;
  const lease = durable.leases[leaseId];
  assert.equal(res.state, 'quarantined', 'precondition: resource must be quarantined');
  assert.equal(lease.state, 'quarantined', 'precondition: lease must be quarantined');
  assert.equal(res.fenceEpoch, lease.fenceEpoch, 'precondition: epochs must agree');

  // Flip only the resource state: every identity/epoch/digest fact stays paired.
  res.state = 'active';
  fs.writeFileSync(statePath, `${JSON.stringify(durable, null, 2)}\n`);

  const mutated = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(mutated.resources[PHYSICAL_ID].state, 'active');
  assert.equal(mutated.leases[leaseId].state, 'quarantined');
  assert.equal(mutated.resources[PHYSICAL_ID].currentLeaseId, leaseId);
  assert.equal(mutated.resources[PHYSICAL_ID].fenceEpoch, mutated.leases[leaseId].fenceEpoch);

  for (const args of [
    ['governor', 'status', '--json'],
    ['governor', 'inspect', ALIAS, '--approve', '--json'],
  ]) {
    const result = runCLI(args, statePath, configPath);
    redIfUnimplemented(result, `S15F2 ${args[1]} with contradictory pair`);
    assert.equal(result.status, 2, `${args[1]} must exit 2 on active/quarantined contradiction`);
    const parsed = assertExactJsonEnvelope(result, `${args[1]} with contradictory pair`);
    assert.equal(parsed?.ok, false, `${args[1]} must return {ok:false,...}`);
    assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', `${args[1]} must fail PROFILE_GOVERNOR_STATE_INVALID`);
  }
});

// 34. ADDED (Sol S15 finding 3): malformed writer operands fail before
// GovernorRepository/client construction can run startup mutation — typed
// PROFILE_REQUEST_INVALID with state file + registry untouched.
test('A4 CLI: ADDED malformed writer operands fail before startup mutation without touching state or registry', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-s15-f3-');
  await seedQuarantined(statePath);
  const configPath = writeDispatcherConfig(dir);
  const preSha = sha256File(statePath);
  const preConfigSha = sha256File(configPath);
  const preRaw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(preRaw.resources[PHYSICAL_ID].state, 'quarantined', 'precondition: resource must be quarantined (startup would normalize to unknown)');
  const writerLockPath = `${statePath}.writer`;

  const badCases = [
    ['bad release lease-id', ['governor', 'release', '--lease-id', 'not-a-lease', '--approve', '--json']],
    ['short release lease-id', ['governor', 'release', '--lease-id', 'lease_SHORT', '--approve', '--json']],
    ['bad reconcile alias', ['governor', 'reconcile', 'BAD_ALIAS!!', '--approve', '--json']],
    ['uppercase reconcile alias', ['governor', 'reconcile', 'UPPERCASE', '--approve', '--json']],
    ['bad recover alias', ['governor', 'recover', 'BAD_ALIAS!!', '--approve', '--json']],
    ['single-char recover alias', ['governor', 'recover', 'x', '--approve', '--json']],
  ];
  for (const [label, args] of badCases) {
    const result = runCLI(args, statePath, configPath);
    redIfUnimplemented(result, `S15F3 ${label}`);
    assertTypedFailure(result, `S15F3 ${label}`, 'PROFILE_REQUEST_INVALID');
    assertExactJsonEnvelope(result, `S15F3 ${label}`);
    assert.equal(sha256File(statePath), preSha, `${label} must leave the state file byte-identical (no startup mutation)`);
    assert.equal(sha256File(configPath), preConfigSha, `${label} must leave the registry fixture untouched`);
    assert.ok(!fs.existsSync(writerLockPath), `${label} must not leave a writer lock behind`);
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(raw.resources[PHYSICAL_ID].state, 'quarantined', `${label} must not run startup normalization (resource stays quarantined)`);
  }

  // Missing-file probe: malformed writer operands must not create state via
  // GovernorRepository construction (which would transact markStartupUnknown).
  {
    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-cli-s15-f3-missing-'));
    t.after(() => { try { fs.rmSync(missingDir, { recursive: true, force: true }); } catch {} });
    const missingState = path.join(missingDir, 'governor-state.json');
    const missingConfig = writeDispatcherConfig(missingDir);
    assert.ok(!fs.existsSync(missingState), 'precondition: missing state file must be absent');
    const missingCases = [
      ['missing-state bad release', ['governor', 'release', '--lease-id', 'not-a-lease', '--approve', '--json']],
      ['missing-state bad reconcile', ['governor', 'reconcile', 'BAD_ALIAS!!', '--approve', '--json']],
      ['missing-state bad recover', ['governor', 'recover', 'BAD_ALIAS!!', '--approve', '--json']],
    ];
    for (const [label, args] of missingCases) {
      const result = runCLI(args, missingState, missingConfig);
      redIfUnimplemented(result, `S15F3 ${label}`);
      assertTypedFailure(result, `S15F3 ${label}`, 'PROFILE_REQUEST_INVALID');
      assert.ok(!fs.existsSync(missingState), `${label} must not create the state file`);
      assert.ok(!fs.existsSync(`${missingState}.writer`), `${label} must not create a writer lock`);
    }
  }
});

// 35. ADDED (S16 finding 1): a detached historical resource whose durable
// public quarantine event stores the mapped reason PROFILE_LEASE_REVOKED while
// the retained recovery-plan digest binds the raw barrier reason
// PROFILE_BINDING_STALE must remain readable via the bounded
// rawReasonsBoundToEvent mapping (events retained; the only quarantine receipt
// proves an earlier epoch/reason, so the event mapping carries the proof).
test('A4 CLI: ADDED detached historical digest bound to raw PROFILE_BINDING_STALE with mapped event reason stays readable', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-historical-mapped-');
  const configPath = writeDispatcherConfig(dir);

  const governor = openGovernor(statePath);
  let leaseId;
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(leaseRequest());
    leaseId = lease.leaseId;
    const fence = await governor.createFence({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      runId: lease.runId,
      bindingId: lease.bindingId,
      action: 'browser-read',
    });
    await governor.authorizeFence(fence);
    const facts = {
      leaseId: lease.leaseId,
      fenceId: fence.fenceId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      bindingId: lease.bindingId,
      bindingDigest: lease.bindingDigest,
      runId: lease.runId,
      runnerClaimDigest: lease.runnerClaimDigest,
      actionId: 'act_a4cli-1',
    };
    await governor.recordAction({ ...facts, outcome: 'prepared' });
    await governor.recordAction({ ...facts, outcome: 'dispatched' });
    const qReceipt = await governor.recordAction({ ...facts, outcome: 'indeterminate' });
    assert.equal(qReceipt.newState, 'quarantined');
    assert.equal(qReceipt.newFenceEpoch, 2);
    // Re-barrier with PROFILE_BINDING_STALE: the core mints the digest with
    // the raw reason while the durable event stores PROFILE_LEASE_REVOKED.
    const currentLease = governor.repository.read().leases[leaseId];
    await governor._establishRevocationBarrier(currentLease, { reasonCode: 'PROFILE_BINDING_STALE' });
  } finally {
    governor.close();
  }

  // Detach into historical ready/cooldown history: clear the current-lease
  // pointer, rest the resource, and retire the lease — digests, events, and
  // receipts are left exactly as the core persisted them.
  const detached = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const res = detached.resources[PHYSICAL_ID];
  const histLease = detached.leases[leaseId];
  assert.equal(res.state, 'quarantined', 'precondition: resource must be quarantined after re-barrier');
  assert.equal(res.fenceEpoch, 3, 'precondition: re-barrier must advance to epoch 3');
  assert.ok(
    detached.events.some((e) => e.leaseId === leaseId && e.state === 'quarantined' && e.fenceEpoch === 3 && e.stateReasonCode === 'PROFILE_LEASE_REVOKED'),
    'precondition: current-epoch quarantine event must carry the mapped public reason PROFILE_LEASE_REVOKED',
  );
  assert.ok(
    !detached.events.some((e) => e.leaseId === leaseId && e.stateReasonCode === 'PROFILE_BINDING_STALE'),
    'precondition: no durable event may carry the raw reason verbatim (the mapping path must be exercised)',
  );
  const expectedDigest = computeRecoveryPlanDigest({
    leaseId,
    bindingDigest: DIGEST,
    fenceEpoch: 3,
    reasonCode: 'PROFILE_BINDING_STALE',
  });
  assert.equal(res.recoveryPlanDigest, expectedDigest, 'precondition: resource digest must bind the raw barrier reason');
  assert.equal(histLease.recoveryPlanDigest, expectedDigest, 'precondition: lease digest must bind the raw barrier reason');
  res.currentLeaseId = null;
  res.state = 'ready';
  histLease.state = 'cooldown';
  histLease.releasedAt = new Date().toISOString();
  fs.writeFileSync(statePath, `${JSON.stringify(detached, null, 2)}\n`);

  const statusResult = runCLI(['governor', 'status', '--json'], statePath, configPath);
  redIfUnimplemented(statusResult, 'status on detached mapped historical state');
  assert.equal(statusResult.status, 0, `status must exit 0 on detached mapped historical state (got ${statusResult.status}; stderr=${statusResult.stderr ?? ''})`);
  const statusParsed = assertExactJsonEnvelope(statusResult, 'status on detached mapped historical state');
  assert.equal(statusParsed?.ok, true, 'status must return {ok:true,...}');

  const inspectResult = runCLI(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(inspectResult, 'inspect on detached mapped historical state');
  assert.equal(inspectResult.status, 0, `inspect must exit 0 on detached mapped historical state (got ${inspectResult.status}; stderr=${inspectResult.stderr ?? ''})`);
  const inspectParsed = assertExactJsonEnvelope(inspectResult, 'inspect on detached mapped historical state');
  assert.equal(inspectParsed?.ok, true, 'inspect must return {ok:true,...}');
  assert.equal(inspectParsed?.data?.state, 'ready', 'inspect must report the detached ready state');
  assert.ok(!JSON.stringify(inspectParsed).includes(PHYSICAL_ID), 'inspect must not expose the physical resource id');
  assert.ok(!JSON.stringify(inspectParsed).includes(expectedDigest), 'inspect must not expose the recovery digest');
});

// 36. ADDED (S16 finding 1, event-retained/receipt-trimmed path): the same
// detached historical state with all quarantine receipts trimmed must remain
// read-only (reads exit 0 without mutating the file) and the writer must never
// authorize reclaim — recover fails closed with PROFILE_RECLAIM_UNSAFE while
// the retired lease stays in cooldown with no reclaim minted.
test('A4 CLI: ADDED detached historical state with receipts trimmed stays read-only and never authorizes reclaim', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-historical-trimmed-');
  const configPath = writeDispatcherConfig(dir);

  const governor = openGovernor(statePath);
  let leaseId;
  try {
    await governor.reconcileProfile(ALIAS);
    const lease = await governor.acquire(leaseRequest());
    leaseId = lease.leaseId;
    const fence = await governor.createFence({
      leaseId: lease.leaseId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      runId: lease.runId,
      bindingId: lease.bindingId,
      action: 'browser-read',
    });
    await governor.authorizeFence(fence);
    const facts = {
      leaseId: lease.leaseId,
      fenceId: fence.fenceId,
      fenceEpoch: lease.fenceEpoch,
      leaseBindingDigest: lease.leaseBindingDigest,
      bindingId: lease.bindingId,
      bindingDigest: lease.bindingDigest,
      runId: lease.runId,
      runnerClaimDigest: lease.runnerClaimDigest,
      actionId: 'act_a4cli-1',
    };
    await governor.recordAction({ ...facts, outcome: 'prepared' });
    await governor.recordAction({ ...facts, outcome: 'dispatched' });
    await governor.recordAction({ ...facts, outcome: 'indeterminate' });
    const currentLease = governor.repository.read().leases[leaseId];
    await governor._establishRevocationBarrier(currentLease, { reasonCode: 'PROFILE_BINDING_STALE' });
  } finally {
    governor.close();
  }

  const detached = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const expectedDigest = computeRecoveryPlanDigest({
    leaseId,
    bindingDigest: DIGEST,
    fenceEpoch: 3,
    reasonCode: 'PROFILE_BINDING_STALE',
  });
  assert.equal(detached.resources[PHYSICAL_ID].recoveryPlanDigest, expectedDigest, 'precondition: digest must bind the raw barrier reason');
  detached.resources[PHYSICAL_ID].currentLeaseId = null;
  detached.resources[PHYSICAL_ID].state = 'ready';
  detached.leases[leaseId].state = 'cooldown';
  detached.leases[leaseId].releasedAt = new Date().toISOString();
  // Trim every quarantine proof receipt; the mapped quarantine event is retained.
  detached.receipts = detached.receipts.filter((r) => r.newState !== 'quarantined');
  assert.ok(
    detached.events.some((e) => e.leaseId === leaseId && e.state === 'quarantined' && e.fenceEpoch === 3 && e.stateReasonCode === 'PROFILE_LEASE_REVOKED'),
    'precondition: mapped quarantine event must be retained after trimming receipts',
  );
  fs.writeFileSync(statePath, `${JSON.stringify(detached, null, 2)}\n`);

  // Read-only paths succeed and leave the state file byte-identical.
  const beforeReads = sha256File(statePath);
  for (const args of [
    ['governor', 'status', '--json'],
    ['governor', 'inspect', ALIAS, '--approve', '--json'],
    ['governor', 'receipts', '--approve', '--json'],
    ['governor', 'events', '--approve', '--json'],
  ]) {
    const result = runCLI(args, statePath, configPath);
    redIfUnimplemented(result, `trimmed-history read-only ${args[1]}`);
    assert.equal(result.status, 0, `read path ${args[1]} must exit 0 on trimmed historical state (got ${result.status}; stderr=${result.stderr ?? ''})`);
    const parsed = assertExactJsonEnvelope(result, `trimmed-history read-only ${args[1]}`);
    assert.equal(parsed?.ok, true, `read path ${args[1]} must return {ok:true,...}`);
    assert.equal(sha256File(statePath), beforeReads, `read path ${args[1]} must not mutate the trimmed historical state file`);
  }

  // The writer must never authorize reclaim of the retired history: recover
  // fails closed with the typed unsafe code while the lease stays retired.
  const preRecover = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const preRecoverReceipts = (preRecover.receipts ?? []).length;
  const recover = runCLI(['governor', 'recover', ALIAS, '--approve', '--json'], statePath, configPath);
  redIfUnimplemented(recover, 'trimmed-history recover --approve');
  assertTypedFailure(recover, 'trimmed-history recover --approve', 'PROFILE_RECLAIM_UNSAFE');
  assertExactJsonEnvelope(recover, 'trimmed-history recover --approve');
  const post = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(post.resources?.[PHYSICAL_ID]?.currentLeaseId, null, 'failed recover must not reclaim a current lease');
  assert.equal(post.leases?.[leaseId]?.state, 'cooldown', 'failed recover must leave the retired lease in cooldown');
  assert.equal(post.leases?.[leaseId]?.fenceEpoch, 3, 'failed recover must not advance the retired fence epoch');
  assert.equal(Object.keys(post.leases ?? {}).length, 1, 'failed recover must mint no new lease');
  assert.equal((post.receipts ?? []).length, preRecoverReceipts, 'failed recover must mint no receipt');
});

// 37. ADDED (S16 finding 2): a FIFO state source fails quickly with the typed
// state error instead of blocking on open/read, without mutating anything —
// O_NONBLOCK keeps the fd-first open from hanging and the fstat
// private-regular-file guard rejects the non-regular descriptor fail-closed.
test('A4 CLI: ADDED FIFO state source fails fast with the typed state error without blocking', async (t) => {
  const { dir, statePath } = freshState(t, 'a4-cli-fifo-');
  const configPath = writeDispatcherConfig(dir);
  const fifoPath = path.join(dir, 'governor-fifo.json');
  if (typeof fs.mkfifoSync === 'function') {
    fs.mkfifoSync(fifoPath, 0o600);
  } else {
    const mk = spawnSync('mkfifo', ['-m', '0600', fifoPath], { timeout: 10000 });
    assert.equal(mk.status, 0, `mkfifo must succeed (status=${mk.status} stderr=${mk.stderr ?? ''})`);
  }
  try { fs.chmodSync(fifoPath, 0o600); } catch {}
  assert.ok(fs.statSync(fifoPath).isFIFO(), 'precondition: probe path must be a FIFO');

  const startedAt = Date.now();
  const result = runCLI(['governor', 'status', '--json'], fifoPath, configPath);
  const elapsedMs = Date.now() - startedAt;
  redIfUnimplemented(result, 'status on FIFO state');
  assert.equal(result.status, 2, `status on FIFO state must exit 2 (got ${result.status}; stdout=${result.stdout ?? ''} stderr=${result.stderr ?? ''})`);
  const parsed = assertExactJsonEnvelope(result, 'status on FIFO state');
  assert.equal(parsed?.ok, false, 'status on FIFO state must return {ok:false,...}');
  assert.equal(parsed?.error?.code, 'PROFILE_GOVERNOR_STATE_INVALID', 'status on FIFO state must fail with PROFILE_GOVERNOR_STATE_INVALID');
  assert.equal(typeof parsed?.error?.message, 'string', 'status on FIFO state must carry a message');
  assert.ok(elapsedMs < 15000, `FIFO read must fail fast without blocking (took ${elapsedMs}ms)`);
  assert.ok(fs.statSync(fifoPath).isFIFO(), 'FIFO probe path must persist unchanged (no mutation/replacement)');
  assert.ok(!fs.existsSync(statePath), 'FIFO rejection must not create the default state file as a side effect');
});
