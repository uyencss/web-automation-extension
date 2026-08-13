import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp.mjs');

const PHYSICAL = 'Chrome:Secret Suno Account';
const PHYSICAL_FLOW = 'Chrome:Secret Flow Account';
const PHYSICAL_ZALO = 'Chrome:Secret Zalo Account';

function makeHome({ aliases = { suno: PHYSICAL, flow: PHYSICAL_FLOW, zalo: PHYSICAL_ZALO } } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-profile-pool-'));
  writeFileSync(path.join(home, 'profilePool.json'), JSON.stringify({
    schema: 'webmcp-profile-pool-config/1',
    aliases,
  }, null, 2), { mode: 0o600 });
  return {
    home,
    config: path.join(home, 'profilePool.json'),
    state: path.join(home, 'profile-pool-state.json'),
    env: { WEBMCP_HOME: home },
  };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [BIN, 'profile-pool', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runJson(args, env = {}) {
  const result = run(args, env);
  const stdout = result.stdout.trim();
  return { result, payload: stdout ? JSON.parse(stdout) : null };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Spawns a detached helper that busy-waits then releases the lease, so a
// long-held lease can be freed while another acquire is polling for it.
function delayedRelease(bin, leaseId, env, delayMs) {
  const script = `
    const { spawnSync } = require('node:child_process');
    const start = Date.now();
    while (Date.now() - start < ${delayMs}) {}
    const r = spawnSync(process.execPath, [${JSON.stringify(bin)}, 'profile-pool', 'release', ${JSON.stringify(leaseId)}, '--json'], { env: ${JSON.stringify(env)}, encoding: 'utf8' });
    process.exit(r.status ?? 1);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', detached: true });
  child.unref();
  return child;
}

test('acquire/release cycle', () => {
  const { env } = makeHome();
  const acquired = runJson(['acquire', 'suno', '--json'], env);
  assert.equal(acquired.result.status, 0, acquired.result.stderr);
  assert.equal(acquired.payload.ok, true);
  assert.equal(acquired.payload.command, 'profile-pool.acquire');
  assert.match(acquired.payload.data.leaseId, /^lease_[0-9a-f]{16}$/);
  assert.equal(acquired.payload.data.alias, 'suno');
  assert.equal(acquired.payload.data.tab, 'own');
  assert.equal(acquired.payload.data.reused, false);
  assert.ok(acquired.payload.data.waitedMs < 100, `expected a fresh acquire not to wait, got ${acquired.payload.data.waitedMs}`);

  const listed = runJson(['list', '--json'], env);
  assert.equal(listed.result.status, 0);
  assert.equal(listed.payload.data.leases.length, 1);
  assert.equal(listed.payload.data.leases[0].leaseId, acquired.payload.data.leaseId);

  const released = runJson(['release', acquired.payload.data.leaseId, '--json'], env);
  assert.equal(released.result.status, 0);
  assert.equal(released.payload.data.released, true);

  const after = runJson(['list', '--json'], env);
  assert.equal(after.payload.data.leases.length, 0);
});

test('double acquire with tab own conflicts (fail-closed)', () => {
  const { env } = makeHome();
  runJson(['acquire', 'suno', '--json'], env);
  const second = runJson(['acquire', 'suno', '--json'], env);
  assert.equal(second.result.status, 1);
  assert.equal(second.payload.ok, false);
  assert.equal(second.payload.error.code, 'CONFLICT');
  assert.match(second.payload.error.message, /already leased/);
});

test('shared leases are co-usable; own cannot join shared and vice versa', () => {
  const { env } = makeHome();
  const first = runJson(['acquire', 'suno', '--tab', 'shared', '--json'], env);
  assert.equal(first.result.status, 0, first.result.stderr);
  const second = runJson(['acquire', 'suno', '--tab', 'shared', '--json'], env);
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.notEqual(second.payload.data.leaseId, first.payload.data.leaseId);

  const ownAfterShared = runJson(['acquire', 'suno', '--tab', 'own', '--json'], env);
  assert.equal(ownAfterShared.result.status, 1);
  assert.equal(ownAfterShared.payload.error.code, 'CONFLICT');

  const sharedAfterOwn = runJson(['acquire', 'flow', '--json'], env);
  assert.equal(sharedAfterOwn.result.status, 0, sharedAfterOwn.result.stderr);
  const sharedJoin = runJson(['acquire', 'flow', '--tab', 'shared', '--json'], env);
  assert.equal(sharedJoin.result.status, 1);
  assert.equal(sharedJoin.payload.error.code, 'CONFLICT');
});

test('expiry via ttl reclaims the lease for a new holder', () => {
  const { env } = makeHome();
  const acquired = runJson(['acquire', 'suno', '--ttl-ms', '150', '--json'], env);
  assert.equal(acquired.result.status, 0, acquired.result.stderr);
  sleepSync(400);
  const renew = runJson(['renew', acquired.payload.data.leaseId, '--json'], env);
  assert.equal(renew.result.status, 1);
  assert.equal(renew.payload.error.code, 'LEASE_NOT_FOUND');
  const reacquire = runJson(['acquire', 'suno', '--json'], env);
  assert.equal(reacquire.result.status, 0, reacquire.result.stderr);
  assert.notEqual(reacquire.payload.data.leaseId, acquired.payload.data.leaseId);
});

test('reclaim requires confirmation and force-drops leases with a warning', () => {
  const { env } = makeHome();
  runJson(['acquire', 'suno', '--json'], env);
  const unconfirmed = runJson(['reclaim', 'suno', '--json'], env);
  assert.equal(unconfirmed.result.status, 2);
  assert.equal(unconfirmed.payload.error.code, 'RECLAIM_CONFIRMATION_REQUIRED');

  const confirmed = runJson(['reclaim', 'suno', '--yes', '--json'], env);
  assert.equal(confirmed.result.status, 0, confirmed.result.stderr);
  assert.equal(confirmed.payload.data.released, 1);
  assert.match(confirmed.payload.data.warning, /forced reclaim/);

  const after = runJson(['list', '--json'], env);
  assert.equal(after.payload.data.leases.length, 0);
});

test('release of an unknown or expired lease is an idempotent no-op success', () => {
  const { env } = makeHome();
  const first = runJson(['release', 'lease_deadbeefdeadbeef', '--json'], env);
  assert.equal(first.result.status, 0);
  assert.equal(first.payload.ok, true);
  assert.equal(first.payload.data.released, false);

  const acquired = runJson(['acquire', 'suno', '--ttl-ms', '150', '--json'], env);
  assert.equal(acquired.result.status, 0, acquired.result.stderr);
  sleepSync(300);
  const afterExpiry = runJson(['release', acquired.payload.data.leaseId, '--json'], env);
  assert.equal(afterExpiry.result.status, 0);
  assert.equal(afterExpiry.payload.data.released, false);
});

test('acquire waits when the alias is leased and succeeds once it frees', () => {
  const { env } = makeHome();
  const holder = runJson(['acquire', 'suno', '--json'], env);
  assert.equal(holder.result.status, 0, holder.result.stderr);
  const childEnv = { ...process.env, ...env };
  delayedRelease(BIN, holder.payload.data.leaseId, childEnv, 500);
  const waited = runJson(['acquire', 'suno', '--timeout-ms', '8000', '--json'], env);
  assert.equal(waited.result.status, 0, waited.result.stderr);
  assert.equal(waited.payload.ok, true);
  assert.ok(waited.payload.data.waitedMs >= 300, `expected waitedMs >= 300, got ${waited.payload.data.waitedMs}`);
});

test('acquire with a timeout that expires reports pool exhausted, not a crash', () => {
  const { env } = makeHome();
  runJson(['acquire', 'suno', '--json'], env);
  const exhausted = runJson(['acquire', 'suno', '--timeout-ms', '200', '--json'], env);
  assert.equal(exhausted.result.status, 1);
  assert.equal(exhausted.payload.ok, false);
  assert.equal(exhausted.payload.error.code, 'EXHAUSTED');
  assert.equal(exhausted.payload.error.details.alias, 'suno');
});

test('idempotency key makes re-acquire return the same lease', () => {
  const { env } = makeHome();
  const first = runJson(['acquire', 'suno', '--idempotency-key', 'audio-branch', '--json'], env);
  assert.equal(first.result.status, 0, first.result.stderr);
  const retry = runJson(['acquire', 'suno', '--idempotency-key', 'audio-branch', '--json'], env);
  assert.equal(retry.result.status, 0, retry.result.stderr);
  assert.equal(retry.payload.data.leaseId, first.payload.data.leaseId);
  assert.equal(retry.payload.data.reused, true);

  const differentKey = runJson(['acquire', 'suno', '--idempotency-key', 'visual-branch', '--json'], env);
  assert.equal(differentKey.result.status, 1);
  assert.equal(differentKey.payload.error.code, 'CONFLICT');
});

test('leases persist across processes and expire after restart', () => {
  const { env } = makeHome();
  const acquired = runJson(['acquire', 'suno', '--json'], env);
  assert.equal(acquired.result.status, 0, acquired.result.stderr);

  const listed = runJson(['list', '--json'], env);
  assert.equal(listed.payload.data.leases.length, 1, 'lease survives broker restarts while within ttl');

  runJson(['acquire', 'flow', '--ttl-ms', '120', '--json'], env);
  sleepSync(300);
  const after = runJson(['status', '--json'], env);
  const suno = after.payload.data.aliases.find((entry) => entry.alias === 'suno');
  const flow = after.payload.data.aliases.find((entry) => entry.alias === 'flow');
  assert.equal(suno.state, 'leased');
  assert.equal(flow.state, 'free', 'expired leases are swept on the next broker call');
});

test('physical profile ids never appear in command output', () => {
  const { home, env } = makeHome({
    aliases: { suno: PHYSICAL, suno2: PHYSICAL, flow: PHYSICAL_FLOW },
  });
  const commands = [
    ['acquire', 'suno', '--json'],
    ['list', '--json'],
    ['status', '--json'],
    ['doctor', '--json'],
    ['renew', 'x', '--json'],
    ['release', 'lease_deadbeefdeadbeef', '--json'],
  ];
  for (const args of commands) {
    const result = run(args, env);
    assert.ok(!result.stdout.includes(PHYSICAL), `${args.join(' ')} leaked the physical profile id`);
    assert.ok(!result.stderr.includes(PHYSICAL), `${args.join(' ')} leaked the physical profile id to stderr`);
    assert.ok(!result.stdout.includes(home), `${args.join(' ')} leaked the machine-local home path`);
    assert.ok(!result.stderr.includes(home), `${args.join(' ')} leaked the machine-local home path to stderr`);
  }
});

test('duplicate physical mappings block acquisition and doctor readiness', () => {
  const { env } = makeHome({
    aliases: { suno: PHYSICAL, suno2: PHYSICAL, flow: PHYSICAL_FLOW },
  });

  const first = runJson(['acquire', 'suno', '--json'], env);
  assert.equal(first.result.status, 1);
  assert.equal(first.payload.error.code, 'CONFIG_INVALID');
  assert.match(first.payload.error.message, /duplicate physical mapping/i);
  assert.ok(!first.result.stdout.includes(PHYSICAL));
  assert.ok(!first.result.stderr.includes(PHYSICAL));

  const second = runJson(['acquire', 'suno2', '--json'], env);
  assert.equal(second.result.status, 1);
  assert.equal(second.payload.error.code, 'CONFIG_INVALID');
  assert.ok(!second.result.stdout.includes(PHYSICAL));
  assert.ok(!second.result.stderr.includes(PHYSICAL));

  const doctor = runJson(['doctor', '--json'], env);
  assert.equal(doctor.result.status, 1, doctor.result.stderr);
  assert.equal(doctor.payload.ok, true);
  assert.equal(doctor.payload.data.ok, false);
  assert.equal(doctor.payload.data.config.ok, false);
  assert.match(doctor.payload.data.config.error, /duplicate physical mapping/i);
  assert.ok(!doctor.result.stdout.includes(PHYSICAL));
  assert.ok(!doctor.result.stderr.includes(PHYSICAL));

  const forSeam = runJson(['doctor', '--for', 'profile-pool', '--json'], env);
  assert.equal(forSeam.result.status, 1, forSeam.result.stderr);
  assert.equal(forSeam.payload.data.ok, false);

  const otherSeam = runJson(['doctor', '--for', 'runner', '--json'], env);
  assert.equal(otherSeam.result.status, 2);
  assert.equal(otherSeam.payload.error.code, 'USAGE_ERROR');
});

test('aliases mapped to one physical profile cannot hold conflicting exclusive leases', () => {
  const { env } = makeHome({ aliases: { suno: PHYSICAL, suno2: PHYSICAL } });
  const aliases = ['suno', 'suno2'].map((alias) => runJson(['acquire', alias, '--json'], env));
  assert.deepEqual(aliases.map(({ result }) => result.status), [1, 1]);
  assert.deepEqual(aliases.map(({ payload }) => payload.error.code), ['CONFIG_INVALID', 'CONFIG_INVALID']);
  assert.equal(aliases.some(({ payload }) => JSON.stringify(payload).includes(PHYSICAL)), false);
});

test('provider-free agent lifecycle acquires, waits, renews, and releases without private identity', () => {
  const { env } = makeHome({ aliases: { suno: PHYSICAL } });
  const acquired = runJson(['acquire', 'suno', '--ttl-ms', '1000', '--json'], env);
  assert.equal(acquired.result.status, 0, acquired.result.stderr);
  assert.equal(acquired.payload.data.alias, 'suno');

  const exhausted = runJson(['acquire', 'suno', '--timeout-ms', '120', '--json'], env);
  assert.equal(exhausted.result.status, 1);
  assert.equal(exhausted.payload.error.code, 'EXHAUSTED');

  const renewed = runJson(['renew', acquired.payload.data.leaseId, '--ttl-ms', '1200', '--json'], env);
  assert.equal(renewed.result.status, 0, renewed.result.stderr);
  assert.equal(renewed.payload.data.leaseId, acquired.payload.data.leaseId);

  const released = runJson(['release', acquired.payload.data.leaseId, '--json'], env);
  assert.equal(released.result.status, 0, released.result.stderr);
  assert.equal(released.payload.data.released, true);

  for (const result of [acquired, exhausted, renewed, released]) {
    assert.equal(JSON.stringify(result.payload).includes(PHYSICAL), false);
    assert.equal(result.result.stderr.includes(PHYSICAL), false);
  }
});

test('config is loaded from WEBMCP_PROFILE_POOL_CONFIG and failures are fail-closed', () => {
  const { home, env } = makeHome();
  const other = mkdtempSync(path.join(tmpdir(), 'webmcp-profile-pool-alt-'));
  const otherConfig = path.join(other, 'custom-pool.json');
  writeFileSync(otherConfig, JSON.stringify({
    schema: 'webmcp-profile-pool-config/1',
    aliases: { zalo: PHYSICAL_ZALO },
  }, null, 2), { mode: 0o600 });
  const overrideEnv = { ...env, WEBMCP_PROFILE_POOL_CONFIG: otherConfig };

  const unknown = runJson(['acquire', 'suno', '--json'], overrideEnv);
  assert.equal(unknown.result.status, 1);
  assert.equal(unknown.payload.error.code, 'UNKNOWN_ALIAS');

  const known = runJson(['acquire', 'zalo', '--json'], overrideEnv);
  assert.equal(known.result.status, 0, known.result.stderr);
  assert.equal(known.payload.data.alias, 'zalo');

  rmSync(other, { recursive: true, force: true });

  const missing = mkdtempSync(path.join(tmpdir(), 'webmcp-profile-pool-none-'));
  const missingRun = runJson(['acquire', 'suno', '--json'], { WEBMCP_HOME: missing, WEBMCP_PROFILE_POOL_CONFIG: path.join(missing, 'nope.json') });
  assert.equal(missingRun.result.status, 1);
  assert.equal(missingRun.payload.error.code, 'CONFIG_NOT_FOUND');
  assert.equal(missingRun.result.stdout.includes(missing), false);
  assert.equal(missingRun.result.stderr.includes(missing), false);

  const doctorMissing = runJson(['doctor', '--json'], { WEBMCP_HOME: missing });
  assert.equal(doctorMissing.result.status, 1);
  assert.equal(doctorMissing.payload.data.ok, false);
  assert.equal(doctorMissing.payload.data.config.present, false);
  assert.equal(doctorMissing.result.stdout.includes(missing), false);
  assert.equal(doctorMissing.result.stderr.includes(missing), false);

  rmSync(missing, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('config and state read/parse failures use stable path-free diagnostics', () => {
  const { home, env } = makeHome();
  const unreadableConfig = path.join(home, 'config-read-failure');
  mkdirSync(unreadableConfig);
  const configReadFailure = runJson(['acquire', 'suno', '--json'], {
    ...env,
    WEBMCP_PROFILE_POOL_CONFIG: unreadableConfig,
  });
  assert.equal(configReadFailure.result.status, 1);
  assert.equal(configReadFailure.payload.error.code, 'CONFIG_INVALID');
  assert.equal(configReadFailure.payload.error.message, 'profile pool config could not be read');
  assert.equal(JSON.stringify(configReadFailure.payload).includes(home), false);

  const invalidConfig = path.join(home, 'config-parse-failure.json');
  writeFileSync(invalidConfig, '{');
  const configParseFailure = runJson(['acquire', 'suno', '--json'], {
    ...env,
    WEBMCP_PROFILE_POOL_CONFIG: invalidConfig,
  });
  assert.equal(configParseFailure.result.status, 1);
  assert.equal(configParseFailure.payload.error.code, 'CONFIG_INVALID');
  assert.equal(configParseFailure.payload.error.message, 'profile pool config is not valid JSON');
  assert.equal(JSON.stringify(configParseFailure.payload).includes(home), false);

  const unreadableState = path.join(home, 'state-read-failure');
  mkdirSync(unreadableState);
  const stateReadFailure = runJson(['acquire', 'suno', '--json'], {
    ...env,
    WEBMCP_PROFILE_POOL_STATE: unreadableState,
  });
  assert.equal(stateReadFailure.result.status, 1);
  assert.equal(stateReadFailure.payload.error.code, 'STATE_INVALID');
  assert.equal(stateReadFailure.payload.error.message, 'profile pool state could not be read');
  assert.equal(JSON.stringify(stateReadFailure.payload).includes(home), false);

  const invalidState = path.join(home, 'state-parse-failure.json');
  writeFileSync(invalidState, '{');
  const stateParseFailure = runJson(['acquire', 'suno', '--json'], {
    ...env,
    WEBMCP_PROFILE_POOL_STATE: invalidState,
  });
  assert.equal(stateParseFailure.result.status, 1);
  assert.equal(stateParseFailure.payload.error.code, 'STATE_INVALID');
  assert.equal(stateParseFailure.payload.error.message, 'profile pool state is not valid JSON');
  assert.equal(JSON.stringify(stateParseFailure.payload).includes(home), false);

  rmSync(home, { recursive: true, force: true });
});

test('missing or wrong config schema fails before lease state mutation', () => {
  for (const schema of [undefined, 'webmcp-profile-pool-config/0']) {
    const fixture = makeHome();
    writeFileSync(fixture.config, JSON.stringify({
      ...(schema === undefined ? {} : { schema }),
      aliases: { suno: PHYSICAL },
    }, null, 2));

    const acquired = runJson(['acquire', 'suno', '--json'], fixture.env);
    assert.equal(acquired.result.status, 1);
    assert.equal(acquired.payload.error.code, 'CONFIG_INVALID');
    assert.equal(
      acquired.payload.error.message,
      'profile pool config schema must be webmcp-profile-pool-config/1',
    );
    assert.equal(existsSync(fixture.state), false);
    assert.equal(JSON.stringify(acquired.payload).includes(fixture.home), false);
    assert.equal(JSON.stringify(acquired.payload).includes(PHYSICAL), false);
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('missing or wrong state schema fails before state mutation', () => {
  for (const schema of [undefined, 'webmcp-profile-pool-state/0']) {
    const fixture = makeHome();
    const original = `${JSON.stringify({
      ...(schema === undefined ? {} : { schema }),
      leases: {},
    }, null, 2)}\n`;
    writeFileSync(fixture.state, original);

    const acquired = runJson(['acquire', 'suno', '--json'], fixture.env);
    assert.equal(acquired.result.status, 1);
    assert.equal(acquired.payload.error.code, 'STATE_INVALID');
    assert.equal(
      acquired.payload.error.message,
      'profile pool state schema must be webmcp-profile-pool-state/1',
    );
    assert.equal(readFileSync(fixture.state, 'utf8'), original);
    assert.equal(JSON.stringify(acquired.payload).includes(fixture.home), false);
    assert.equal(JSON.stringify(acquired.payload).includes(PHYSICAL), false);
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('state busy and lock creation failures use stable path-free diagnostics', () => {
  const busy = makeHome();
  mkdirSync(`${busy.state}.lock`);
  const busyResult = runJson(['list', '--json'], busy.env);
  assert.equal(busyResult.result.status, 1);
  assert.equal(busyResult.payload.error.code, 'STATE_BUSY');
  assert.equal(
    busyResult.payload.error.message,
    'Profile pool state is locked by another broker call; retry after the current broker operation completes',
  );
  assert.equal(JSON.stringify(busyResult.payload).includes(busy.home), false);
  assert.equal(busyResult.result.stderr.includes(busy.home), false);
  rmSync(busy.home, { recursive: true, force: true });

  const unwritable = makeHome();
  const parentFile = path.join(unwritable.home, 'not-a-directory');
  writeFileSync(parentFile, 'blocked\n');
  const state = path.join(parentFile, 'state.json');
  const lockFailure = runJson(['list', '--json'], {
    ...unwritable.env,
    WEBMCP_PROFILE_POOL_STATE: state,
  });
  assert.equal(lockFailure.result.status, 1);
  assert.equal(lockFailure.payload.error.code, 'STATE_UNWRITABLE');
  assert.equal(lockFailure.payload.error.message, 'Cannot create profile pool state lock');
  assert.equal(JSON.stringify(lockFailure.payload).includes(unwritable.home), false);
  assert.equal(lockFailure.result.stderr.includes(unwritable.home), false);
  rmSync(unwritable.home, { recursive: true, force: true });
});

test('usage errors exit 2 with USAGE_ERROR code', () => {
  const { env } = makeHome();
  for (const args of [['acquire'], ['renew'], ['release'], ['reclaim'], ['bogus']]) {
    const result = runJson([...args, '--json'], env);
    assert.equal(result.result.status, 2, `${args.join(' ')} should be a usage error`);
    assert.equal(result.payload.error.code, 'USAGE_ERROR');
  }
  const badTab = runJson(['acquire', 'suno', '--tab', 'exclusive', '--json'], env);
  assert.equal(badTab.result.status, 2);
  assert.match(badTab.payload.error.message, /own|shared/);
});
