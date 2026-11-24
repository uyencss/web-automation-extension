import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { handleImport } from '../../lib/cli/commands/cookies-import.mjs';
import { handleAquaBrokerRequest } from '../../server/gateway/aqua-broker.mjs';

const require = createRequire(import.meta.url);
const launcher = require('../../chrome-launcher/launcher.js');
const sessions = require('../../chrome-launcher/sessions.js');
const proxyGuard = require('../../chrome-launcher/proxy-guard.js');

function makeFixture(t, meta = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-require-proxy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const managedProfilesDir = path.join(root, 'managed-profiles');
  const userDataDir = path.join(managedProfilesDir, 'acc-1');
  const existingUserDataDir = path.join(root, 'existing-chrome');
  const extensionPath = path.join(root, 'ext');
  const sessionsFile = path.join(root, 'sessions.json');
  const fakeChromeBin = path.join(root, 'fake-chrome.sh');
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  fs.mkdirSync(path.join(existingUserDataDir, 'Default'), { recursive: true });
  fs.mkdirSync(extensionPath, { recursive: true });
  fs.writeFileSync(
    path.join(extensionPath, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'Test', version: '1.0' }),
  );
  fs.writeFileSync(path.join(userDataDir, '.webmcp-meta.json'), JSON.stringify(meta));
  fs.writeFileSync(fakeChromeBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeChromeBin, 0o755);
  return { managedProfilesDir, userDataDir, existingUserDataDir, extensionPath, sessionsFile, fakeChromeBin };
}

function spawnDummyAlivePid(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  t.after(() => {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  });
  return child;
}

test('launchChrome blocks unbound or direct-mode managed profiles with ERR_PROXY_UNBOUND_BLOCKED when requireProxy is set', async (t) => {
  const fNoProxy = makeFixture(t, { name: 'unbound-acc' });
  await assert.rejects(
    () => launcher.launchChrome({
      mode: 'managed',
      profile: { kind: 'managed', userDataDir: fNoProxy.userDataDir },
      chromePath: process.execPath,
      extensionPath: fNoProxy.extensionPath,
      managedProfilesDir: fNoProxy.managedProfilesDir,
      sessionsFile: fNoProxy.sessionsFile,
      requireProxy: true,
      dryRun: true,
    }),
    (err) => {
      assert.equal(err.code, 'ERR_PROXY_UNBOUND_BLOCKED');
      return true;
    },
  );

  const fDirect = makeFixture(t, { name: 'direct-acc', requireProxy: true, proxy: { mode: 'direct' } });
  await assert.rejects(
    () => launcher.launchChrome({
      mode: 'managed',
      profile: { kind: 'managed', userDataDir: fDirect.userDataDir },
      chromePath: process.execPath,
      extensionPath: fDirect.extensionPath,
      managedProfilesDir: fDirect.managedProfilesDir,
      sessionsFile: fDirect.sessionsFile,
      dryRun: true,
    }),
    (err) => {
      assert.equal(err.code, 'ERR_PROXY_UNBOUND_BLOCKED');
      return true;
    },
  );

  const fBound = makeFixture(t, { name: 'bound-acc', proxy: { url: 'socks5://10.0.0.2:1080' } });
  const okRes = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: fBound.userDataDir },
    chromePath: process.execPath,
    extensionPath: fBound.extensionPath,
    managedProfilesDir: fBound.managedProfilesDir,
    sessionsFile: fBound.sessionsFile,
    requireProxy: true,
    dryRun: true,
  });
  assert.equal(okRes.ok, true);
  assert.ok(okRes.args.includes('--proxy-server=socks5://10.0.0.2:1080'));
  assert.ok(okRes.args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
});

test('launchChrome existing mode enforces requireProxy before early return', async (t) => {
  const f = makeFixture(t);

  await assert.rejects(
    () => launcher.launchChrome({
      mode: 'existing',
      profile: { kind: 'existing', userDataDir: f.existingUserDataDir, profileDir: 'Default' },
      chromePath: f.fakeChromeBin,
      extensionPath: f.extensionPath,
      sessionsFile: f.sessionsFile,
      requireProxy: true,
      dryRun: true,
    }),
    (err) => err.code === 'ERR_PROXY_UNBOUND_BLOCKED',
  );

  await assert.rejects(
    () => launcher.launchChrome({
      mode: 'existing',
      profile: { kind: 'existing', userDataDir: f.existingUserDataDir, profileDir: 'Default' },
      chromePath: f.fakeChromeBin,
      extensionPath: f.extensionPath,
      sessionsFile: f.sessionsFile,
      extraArgs: ['--proxy-server=direct://'],
      requireProxy: true,
      dryRun: true,
    }),
    (err) => err.code === 'ERR_PROXY_UNBOUND_BLOCKED',
  );

  const okWithArg = await launcher.launchChrome({
    mode: 'existing',
    profile: { kind: 'existing', userDataDir: f.existingUserDataDir, profileDir: 'Default' },
    chromePath: f.fakeChromeBin,
    extensionPath: f.extensionPath,
    sessionsFile: f.sessionsFile,
    extraArgs: ['--proxy-server=socks5://10.0.0.2:1080'],
    requireProxy: true,
    dryRun: true,
  });
  assert.equal(okWithArg.ok, true);
  assert.ok(okWithArg.args.includes('--proxy-server=socks5://10.0.0.2:1080'));
});

test('launchChrome refuses attaching to running Chrome lacking --proxy-server= and attaches cleanly when present', async (t) => {
  const f = makeFixture(t, { name: 'bound-acc', requireProxy: true, proxy: { url: 'socks5://10.0.0.2:1080' } });
  const child = spawnDummyAlivePid(t);

  // 1. Existing mode locked + focusIfRunning: running PID lacks --proxy-server= -> ERR_RUNNING_CHROME_MISSING_PROXY
  fs.symlinkSync(`${os.hostname()}-${child.pid}`, path.join(f.existingUserDataDir, 'SingletonLock'));
  await assert.rejects(
    () => launcher.launchChrome({
      mode: 'existing',
      profile: { kind: 'existing', userDataDir: f.existingUserDataDir, profileDir: 'Default' },
      chromePath: f.fakeChromeBin,
      extensionPath: f.extensionPath,
      sessionsFile: f.sessionsFile,
      extraArgs: ['--proxy-server=socks5://10.0.0.2:1080'],
      requireProxy: true,
      focusIfRunning: true,
      skipGuardForTest: true,
      dryRun: false,
      inspectPidCmdlineFn: () => '/usr/bin/google-chrome --user-data-dir=/tmp/x --no-first-run',
    }),
    (err) => err.code === 'ERR_RUNNING_CHROME_MISSING_PROXY' && err.needsRelaunch === true,
  );

  // 2. Existing mode locked + focusIfRunning: running PID has --proxy-server= -> attaches cleanly
  const okExistingAttach = await launcher.launchChrome({
    mode: 'existing',
    profile: { kind: 'existing', userDataDir: f.existingUserDataDir, profileDir: 'Default' },
    chromePath: f.fakeChromeBin,
    extensionPath: f.extensionPath,
    sessionsFile: f.sessionsFile,
    extraArgs: ['--proxy-server=socks5://10.0.0.2:1080'],
    requireProxy: true,
    focusIfRunning: true,
    skipGuardForTest: true,
    dryRun: false,
    inspectPidCmdlineFn: () => '/usr/bin/google-chrome --user-data-dir=/tmp/x --proxy-server=socks5://10.0.0.2:1080',
  });
  assert.equal(okExistingAttach.ok, true);
  assert.equal(okExistingAttach.attached, true);
  assert.equal(okExistingAttach.focused, true);

  // 3. Managed mode locked + focusIfRunning without sessions.json: missing --proxy-server= -> ERR_RUNNING_CHROME_MISSING_PROXY
  fs.symlinkSync(`${os.hostname()}-${child.pid}`, path.join(f.userDataDir, 'SingletonLock'));
  await assert.rejects(
    () => launcher.launchChrome({
      mode: 'managed',
      profile: { kind: 'managed', userDataDir: f.userDataDir },
      chromePath: f.fakeChromeBin,
      extensionPath: f.extensionPath,
      managedProfilesDir: f.managedProfilesDir,
      sessionsFile: f.sessionsFile,
      focusIfRunning: true,
      skipGuardForTest: true,
      dryRun: false,
      inspectPidCmdlineFn: () => '/usr/bin/google-chrome --user-data-dir=/tmp/m',
    }),
    (err) => err.code === 'ERR_RUNNING_CHROME_MISSING_PROXY' && err.needsRelaunch === true,
  );

  // 4. Managed mode hasLiveManagedSession (even without SingletonLock): unavailable cmdline fails closed (ERR_RUNNING_CHROME_MISSING_PROXY)
  try { fs.unlinkSync(path.join(f.userDataDir, 'SingletonLock')); } catch {}
  sessions.rememberManagedSession(f.userDataDir, child.pid, f.sessionsFile);
  await assert.rejects(
    () => launcher.launchChrome({
      mode: 'managed',
      profile: { kind: 'managed', userDataDir: f.userDataDir },
      chromePath: f.fakeChromeBin,
      extensionPath: f.extensionPath,
      managedProfilesDir: f.managedProfilesDir,
      sessionsFile: f.sessionsFile,
      skipGuardForTest: true,
      dryRun: false,
      inspectPidCmdlineFn: () => null,
    }),
    (err) => err.code === 'ERR_RUNNING_CHROME_MISSING_PROXY' && err.needsRelaunch === true,
  );

  // 5. Managed mode hasLiveManagedSession: cmdline with --proxy-server= attaches cleanly
  const okManagedAttach = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: f.userDataDir },
    chromePath: f.fakeChromeBin,
    extensionPath: f.extensionPath,
    managedProfilesDir: f.managedProfilesDir,
    sessionsFile: f.sessionsFile,
    focusIfRunning: true,
    skipGuardForTest: true,
    dryRun: false,
    inspectPidCmdlineFn: () => '/usr/bin/google-chrome --proxy-server="socks5://10.0.0.2:1080"',
  });
  assert.equal(okManagedAttach.ok, true);
  assert.equal(okManagedAttach.attached, true);
  assert.equal(okManagedAttach.focused, true);
});

test('inspectRunningChromeHasProxy validates token boundaries and fails closed', async () => {
  assert.equal((await proxyGuard.inspectRunningChromeHasProxy(null)).hasProxy, false);
  assert.equal((await proxyGuard.inspectRunningChromeHasProxy(123, { inspectPidCmdlineFn: () => { throw new Error('boom'); } })).hasProxy, false);
  assert.equal((await proxyGuard.inspectRunningChromeHasProxy(123, { inspectPidCmdlineFn: () => 'chrome https://example.com/--proxy-server=1.2.3.4' })).hasProxy, false);
  assert.equal((await proxyGuard.inspectRunningChromeHasProxy(123, { inspectPidCmdlineFn: () => 'chrome --proxy-server=direct://' })).hasProxy, false);
  assert.equal((await proxyGuard.inspectRunningChromeHasProxy(123, { inspectPidCmdlineFn: () => 'chrome --proxy-server socks5://10.0.0.2:1080' })).hasProxy, true);
});

test('cookies-import --clear-first recognizes douyin.com as a known auth domain', async () => {
  let clearCalled = false;
  await assert.rejects(
    () => handleImport(
      { profileId: 'p1', input: 'douyin-anon.json', clearFirst: true, overwrite: true },
      {
        inputContent: JSON.stringify([
          { name: 'ttwid', value: 'anon_tracking_value', domain: '.douyin.com', path: '/' },
          { name: 'sessionid_ss', value: '0', domain: '.douyin.com', path: '/' },
        ]),
        gatewayCall: async (method) => {
          if (method === 'executeCDP') clearCalled = true;
          return { success: true };
        },
      },
    ),
    { code: 'ERR_COOKIES_IMPORT_EMPTY_OR_EXPIRED' },
  );
  assert.equal(clearCalled, false, 'Anonymous/empty douyin.com payload must not authorize --clear-first');

  const calls = [];
  const resValid = await handleImport(
    { profileId: 'p1', input: 'douyin-valid.json', clearFirst: true, overwrite: true },
    {
      inputContent: JSON.stringify([
        { name: 'sessionid_ss', value: 'valid_dy_sess', domain: '.douyin.com', path: '/', secure: true },
      ]),
      gatewayCall: async (method, params) => {
        calls.push({ method, params });
        return { success: true };
      },
    },
  );
  assert.equal(resValid.status, 'success');
  assert.equal(resValid.appliedCount, 1);
  assert.deepEqual(calls.map((c) => c.method), ['executeCDP', 'setCookie']);
});

test('aqua-broker forwards requireProxy and propagates ERR_PROXY_UNBOUND_BLOCKED with 409', async (t) => {
  const fNoProxy = makeFixture(t, { name: 'aqua-unbound' });
  const req = new PassThrough();
  req.method = 'POST';
  req.url = '/api/aqua/launch';
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  process.nextTick(() => req.end(JSON.stringify({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: fNoProxy.userDataDir },
    managedProfilesDir: fNoProxy.managedProfilesDir,
    requireProxy: true,
    dryRun: true,
  })));
  let statusCode = 0;
  let body = '';
  const res = {
    writeHead(code) { statusCode = code; },
    end(chunk = '') { body += chunk; },
  };
  await handleAquaBrokerRequest(req, res);
  if (statusCode !== 503) {
    assert.equal(statusCode, 409);
    const parsed = JSON.parse(body);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'ERR_PROXY_UNBOUND_BLOCKED');
  }
});

