// A4 service-recovery drill — operator CLI crash recovery (self-contained).
//
// Self-contained: tmp dirs only, loopback only, no browser. Flow: seed a
// lease in a holder child process (dispatched action, indeterminate outward
// effect -> durable quarantine + epoch bump + receipt) -> SIGKILL the holder
// -> spawn the CLI `governor recover <alias> --approve --json` on the same
// durable state -> assert the quarantine barrier (typed
// PROFILE_RECLAIM_UNSAFE: unsafe to reclaim), epoch advancement, receipt
// visibility via `receipts`, and that the pre-crash fence is stale
// (PROFILE_FENCE_STALE via module check) -> print DRILL_PASS.
//
// S3 CONTRACT-CORRECTED (L2 F4): the holder records the indeterminate outcome
// (which quarantines) BEFORE it is killed. The crash therefore proves
// persistence + dead-writer takeover of that recorded indeterminate barrier,
// not that the crash itself causes quarantine. Post-recover the resource is
// NOT left quarantined: CLI startup normalization makes it `unknown`
// (not ready); recovery is refused (PROFILE_RECLAIM_UNSAFE); receipts persist;
// old fence stays stale. The barrier intent (no reuse/retry) stays.
//
// Registry (L2 F1): the CLI resolves authority ONLY via a real v3 dispatcher
// fixture (explicit verbatim physicalResourceId + bindingDigest); the drill
// writes it to tmp and sets WEBMCP_DISPATCHER_CONFIG for CLI spawns.
//
// RED now: the `governor` command does not exist, so the drill fails with a
// clear missing-capability error (exit 2), never a crash.
//
// Run re-runnable from the package dir (or tests/integration/):
//   node drills/a4-service-recovery-drill.mjs
//   node ../../drills/a4-service-recovery-drill.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'webmcp-browser.mjs');
const REPOSITORY_URL = new URL('../profile-governor/repository.mjs', import.meta.url).href;
const LEASE_SERVICE_URL = new URL('../profile-governor/lease-service.mjs', import.meta.url).href;

const ALIAS = 'a4-cli-profile';
const PHYSICAL_ID = 'prsc_a4-cli-01';
const BINDING_ID = 'pb_a4-cli-01';
const BINDING_REVISION = 1;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const CLAIM = `sha256:${'b'.repeat(64)}`;
// Real v3 dispatcher fixture dimensions (must match the seeded facts verbatim).
const GATEWAY = 'local';
const RESOURCE_REF = 'prf_local_a4cli_01';
const PROFILE_ID = 'opaque-physical-a4-cli-01';
const REVIEW_DIGEST = `sha256:${'c'.repeat(64)}`;

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
const lease = await governor.acquire({ schema: 'webmcp-profile-lease-request/1', requestId: 'plr_a4drill-hold1', ownerType: 'automation', nodeId: 'node-a4drill-1', runId: 'run_a4drill-hold1', runnerClaimDigest: CLAIM, bindingId: 'pb_a4-cli-01', bindingRevision: 1, bindingDigest: DIGEST, profileAlias: 'a4-cli-profile', leaseMode: 'single-context', requestedActions: ['browser-read'], heartbeatIntervalMs: 1000, leaseTtlMs: 60000, idempotencyKey: 'a4drill-key-hold1' });
const fence = await governor.createFence({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, runId: lease.runId, bindingId: lease.bindingId, action: 'browser-read' });
await governor.authorizeFence(fence);
const facts = { leaseId: lease.leaseId, fenceId: fence.fenceId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest, bindingId: lease.bindingId, bindingDigest: lease.bindingDigest, runId: lease.runId, runnerClaimDigest: lease.runnerClaimDigest, actionId: 'act_a4drill-h1' };
await governor.recordAction({ ...facts, outcome: 'prepared' });
await governor.recordAction({ ...facts, outcome: 'dispatched' });
const receipt = await governor.recordAction({ ...facts, outcome: 'indeterminate' });
fs.writeFileSync(factsPath, JSON.stringify({ leaseId: lease.leaseId, oldEpoch: lease.fenceEpoch, quarantineEpoch: receipt.newFenceEpoch, fence }) + '\\n');
setInterval(() => {}, 1000); // hold the writer lock until SIGKILL (a bare never-promise trips unsettled-TLA exit)
`;

function writeDispatcherConfig(dir) {
  const config = {
    schema: 'webmcp-dispatcher-config/3',
    registryRevision: 1,
    defaultGateway: GATEWAY,
    gateways: { [GATEWAY]: { apiUrl: 'http://127.0.0.1:7865/api', profiles: { [ALIAS]: PROFILE_ID } } },
    profileResources: {
      [RESOURCE_REF]: {
        gateway: GATEWAY, profileId: PROFILE_ID, resourceRevision: 1, status: 'enabled', physicalResourceId: PHYSICAL_ID,
      },
    },
    profileBindings: {
      [ALIAS]: {
        schema: 'webmcp-profile-binding/3', bindingId: BINDING_ID, bindingRevision: BINDING_REVISION,
        profileAlias: ALIAS, profileResourceRef: RESOURCE_REF, status: 'enabled',
        review: { decision: 'approved', receiptDigest: REVIEW_DIGEST },
        bindingDigest: DIGEST, allowedActions: ['browser-read'],
      },
    },
  };
  const configPath = path.join(dir, 'dispatcher.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  return configPath;
}

function cli(args, statePath, configPath) {
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

function isUnimplemented(result) {
  return /Unknown command:\s*governor/.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

function parseJSON(result, label) {
  for (const raw of [result.stdout, result.stderr]) {
    if (typeof raw === 'string' && raw.trim().length > 0) {
      try {
        return JSON.parse(raw);
      } catch {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) {
          try {
            return JSON.parse(raw.slice(start, end + 1));
          } catch {}
        }
      }
    }
  }
  throw new Error(`drill failed: expected JSON output for ${label} (exit=${result.status})`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-service-recovery-'));
const statePath = path.join(dir, 'governor-state.json');
const holderPath = path.join(dir, 'a4-drill-holder.mjs');
const factsPath = path.join(dir, 'a4-drill-facts.json');
const configPath = writeDispatcherConfig(dir);
const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// 1. Seed in a holder child; wait for the durable quarantine receipt.
// The holder records prepared -> dispatched -> indeterminate BEFORE the crash;
// the indeterminate record is what quarantines (epoch bump + receipt). The
// later SIGKILL only proves the barrier survives a dead writer.
fs.writeFileSync(holderPath, HOLDER_SCRIPT, { mode: 0o600 });
const child = spawn(process.execPath, [holderPath, REPOSITORY_URL, LEASE_SERVICE_URL, statePath, factsPath], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childStderr = '';
child.stderr.on('data', (chunk) => { childStderr += chunk.toString(); });
const killChild = async () => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
};
process.on('exit', () => { try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch {} });

let facts = null;
{
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(`drill failed: holder exited before SIGKILL (code=${child.exitCode} signal=${child.signalCode} stderr=${childStderr.slice(0, 300)})`);
    }
    try {
      facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
      if (facts?.leaseId) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (!facts?.leaseId) fail('drill failed: holder did not quarantine the lease in time');

// 2. SIGKILL the holder (real process crash).
child.kill('SIGKILL');
const signal = await new Promise((resolve) => {
  if (child.signalCode !== null) return resolve(child.signalCode);
  const timer = setTimeout(() => resolve(child.signalCode), 5000);
  child.once('exit', (_code, sig) => { clearTimeout(timer); resolve(sig); });
});
if (signal !== 'SIGKILL') fail(`drill failed: holder did not die by SIGKILL (got ${signal})`);

// 3. RED gate: probe the operator CLI before asserting anything.
const probe = cli(['governor', 'status', '--json'], statePath, configPath);
if (isUnimplemented(probe)) {
  fail(
    `DRILL_BLOCKED a4-service-recovery: governor CLI command not implemented yet ` +
    `(bin/webmcp-browser.mjs has no 'governor' route; wire lane must add ` +
    `lib/cli/commands/governor.mjs + router wiring; probe exit=${probe.status})`,
  );
}

// 4. Durable quarantine barrier (repository read only: a ProfileGovernor
// construction would reset live state to unknown via markStartupUnknown).
// This proves the recorded indeterminate outcome persisted across the
// dead-writer takeover — not that the crash itself caused quarantine.
{
  const { GovernorRepository } = await import(REPOSITORY_URL);
  const repository = new GovernorRepository({ statePath });
  let durable;
  try {
    durable = repository.read();
  } finally {
    repository.close();
  }
  const resource = durable.resources[PHYSICAL_ID];
  assert.equal(resource?.state, 'quarantined', `drill failed: crash orphan must be quarantined (got ${resource?.state})`);
  assert.ok(resource.fenceEpoch > facts.oldEpoch, `drill failed: epoch must advance past pre-crash ${facts.oldEpoch}`);
  assert.ok(
    (durable.receipts ?? []).some((entry) => entry?.leaseId === facts.leaseId && entry?.newState === 'quarantined'),
    'drill failed: quarantine receipt missing from durable state',
  );
}

// 5. Operator recover keeps the typed unsafe path (indeterminate effect).
let preRecoverEpoch;
{
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  preRecoverEpoch = raw.resources?.[PHYSICAL_ID]?.fenceEpoch;
}
{
  const recover = cli(['governor', 'recover', ALIAS, '--approve', '--json'], statePath, configPath);
  if (isUnimplemented(recover)) {
    fail(`DRILL_BLOCKED a4-service-recovery: governor CLI command not implemented yet (recover probe exit=${recover.status})`);
  }
  assert.equal(recover.status, 2, `drill failed: crash recover must exit 2 (got ${recover.status})`);
  const parsed = parseJSON(recover, 'recover');
  assert.equal(parsed?.ok, false, 'drill failed: crash recover must print {ok:false,...}');
  assert.equal(parsed?.error?.code, 'PROFILE_RECLAIM_UNSAFE', `drill failed: crash recover must keep PROFILE_RECLAIM_UNSAFE (got ${parsed?.error?.code})`);
}

// 5b. STRENGTHENED (F4): post-recover raw durable state — NOT left
// quarantined and NOT ready (startup normalization makes it unknown),
// receipts persist, epoch unchanged-or-advanced, old fence stays stale.
{
  const postRaw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const postResource = postRaw.resources?.[PHYSICAL_ID];
  assert.notEqual(postResource?.state, 'ready', `drill failed: post-recover resource must not be ready (got ${postResource?.state})`);
  assert.equal(postResource?.state, 'unknown', `drill failed: post-recover resource must be unknown via startup normalization (got ${postResource?.state})`);
  assert.ok(
    (postRaw.receipts ?? []).some((entry) => entry?.leaseId === facts.leaseId),
    'drill failed: post-recover receipts must still include the crashed lease receipt',
  );
  assert.ok(
    typeof postResource?.fenceEpoch === 'number' && postResource.fenceEpoch >= preRecoverEpoch,
    `drill failed: post-recover epoch must be unchanged-or-advanced (was ${preRecoverEpoch}, got ${postResource?.fenceEpoch})`,
  );
}

// 6. Receipt visible via the CLI; epoch advanced via inspect.
{
  const receipts = cli(['governor', 'receipts', '--approve', '--json'], statePath, configPath);
  assert.equal(receipts.status, 0, `drill failed: receipts must exit 0 (got ${receipts.status})`);
  const parsed = parseJSON(receipts, 'receipts');
  const list = parsed?.data ?? parsed?.receipts ?? parsed;
  assert.ok(
    Array.isArray(list) && list.some((entry) => entry?.leaseId === facts.leaseId && entry?.newState === 'quarantined'),
    'drill failed: receipts must show the quarantine receipt for the crashed lease',
  );
  const inspect = cli(['governor', 'inspect', ALIAS, '--approve', '--json'], statePath, configPath);
  assert.equal(inspect.status, 0, `drill failed: inspect must exit 0 (got ${inspect.status})`);
  const viewed = parseJSON(inspect, 'inspect');
  const projection = viewed?.data ?? viewed?.projection ?? viewed;
  assert.ok(
    typeof projection?.fenceEpoch === 'number' && projection.fenceEpoch > facts.oldEpoch,
    `drill failed: inspect fenceEpoch must exceed pre-crash ${facts.oldEpoch} (got ${projection?.fenceEpoch})`,
  );
}

// 7. Old pre-crash fence is stale (module check).
{
  const { GovernorRepository } = await import(REPOSITORY_URL);
  const { ProfileGovernor } = await import(LEASE_SERVICE_URL);
  const repository = new GovernorRepository({ statePath });
  const governor = new ProfileGovernor({
    repository,
    registry: { resolve: async () => ({ physicalResourceId: PHYSICAL_ID, bindingId: 'pb_a4-cli-01', bindingRevision: 1, bindingDigest: DIGEST, allowedActions: ['browser-read'] }) },
    claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read'], ...req }) },
    liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }),
    revokeGrants: async () => true,
  });
  try {
    await governor.authorizeFence(facts.fence);
    fail('drill failed: pre-crash fence authorized after quarantine (expected PROFILE_FENCE_STALE)');
  } catch (error) {
    assert.equal(error?.code, 'PROFILE_FENCE_STALE', `drill failed: pre-crash fence must be PROFILE_FENCE_STALE (got ${error?.code})`);
  } finally {
    governor.close();
  }
}

process.stdout.write('DRILL_PASS a4-service-recovery\n');
