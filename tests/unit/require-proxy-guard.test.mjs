import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
  return { root, managedProfilesDir, userDataDir, existingUserDataDir, extensionPath, sessionsFile, fakeChromeBin };
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
  assert.equal((await proxyGuard.inspectRunningChromeHasProxy(123, { inspectPidCmdlineFn: () => 'chrome --proxy-server socks5://10.0.0.2:1080' })).hasProxy, false);
  assert.equal((await proxyGuard.inspectRunningChromeHasProxy(123, { inspectPidCmdlineFn: () => 'chrome --proxy-server=socks5://10.0.0.2:1080' })).hasProxy, true);
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

test('tokenizeCmdline, hasProxyServerArg, and cmdlineHasProxyServer block Chromium proxy bypass flags and precedence overrides', () => {
  assert.deepEqual(
    proxyGuard.tokenizeCmdline('"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --proxy-server="socks5://10.0.0.2:1080" --proxy-bypass-list=\'127.0.0.1, *\''),
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--proxy-server=socks5://10.0.0.2:1080', '--proxy-bypass-list=127.0.0.1, *'],
  );
  assert.deepEqual(
    proxyGuard.tokenizeCmdline('chrome --proxy-server "" --proxy-server=""'),
    ['chrome', '--proxy-server', '', '--proxy-server='],
  );

  const bypassVectors = [
    ['--no-proxy-server', '--proxy-server=http://x:1'],
    ['--proxy-server=http://x:1', '--no-proxy-server'],
    ['--proxy-server=http://x:1', '--no-proxy-server=true'],
    ['--proxy-server=http://x:1', '--no-proxy-server=1'],
    ['--proxy-server=http://x:1', '--proxy-server=direct://'],
    ['--proxy-server=http://x:1', '--proxy-server', 'direct://'],
    ['--proxy-pac-url=https://evil.example/pac.js', '--proxy-server=http://x:1'],
    ['--proxy-pac-url', 'https://evil.example/pac.js', '--proxy-server=http://x:1'],
    ['--proxy-bypass-list=*', '--proxy-server=http://x:1'],
    ['--proxy-bypass-list=127.0.0.1, *', '--proxy-server=http://x:1'],
    ['--proxy-bypass-list', 'localhost; *', '--proxy-server=http://x:1'],
    ['--proxy-server=""'],
    ['--proxy-server', '""'],
    ['--proxy-server=http://x:1', '--proxy-server'],
    ['--', '--proxy-server=http://x:1'],
  ];

  for (const argv of bypassVectors) {
    assert.equal(proxyGuard.hasProxyServerArg(argv), false, `Expected hasProxyServerArg=false for ${JSON.stringify(argv)}`);
  }

  const cmdlineBypassVectors = [
    'chrome --no-proxy-server --proxy-server=http://x:1',
    'chrome --proxy-server=http://x:1 --no-proxy-server=1',
    'chrome --proxy-server=http://x:1 --user-data-dir=/tmp/p --proxy-server=direct://',
    'chrome --proxy-pac-url="https://evil.example/pac.js" --proxy-server=http://x:1',
    'chrome --proxy-pac-url https://evil.example/pac.js --proxy-server=http://x:1',
    'chrome --proxy-bypass-list="*" --proxy-server=http://x:1',
    'chrome --proxy-bypass-list "127.0.0.1, *" --proxy-server=http://x:1',
    'chrome --proxy-server=""',
    'chrome --proxy-server ""',
    'chrome -- --proxy-server=http://x:1',
  ];

  for (const cmdline of cmdlineBypassVectors) {
    assert.equal(proxyGuard.cmdlineHasProxyServer(cmdline), false, `Expected cmdlineHasProxyServer=false for ${cmdline}`);
  }

  // Chromium HasSwitch treats --no-proxy-server=false and --no-proxy-server=0 as active bypass switches
  assert.equal(proxyGuard.hasProxyServerArg(['--no-proxy-server=false', '--proxy-server=http://x:1']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--no-proxy-server=0', '--proxy-server=http://x:1']), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --no-proxy-server=false --proxy-bypass-list="127.0.0.1;localhost" --proxy-server="socks5://10.0.0.2:1080"'), false);

  // Allowed non-bypass cases
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-bypass-list=127.0.0.1;localhost', '--proxy-server=http://x:1']), true);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-server=direct://', '--proxy-server=http://x:1']), true);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-bypass-list="127.0.0.1;localhost" --proxy-server="socks5://10.0.0.2:1080"'), true);
});

test('prepareLaunchProxy fails closed with ERR_PROXY_UNBOUND_BLOCKED when caller injects bypass flags even on bound profiles', (t) => {
  const fBound = makeFixture(t, { name: 'bound-acc', requireProxy: true, proxy: { url: 'socks5://10.0.0.2:1080' } });
  const adversarialArgSets = [
    ['--no-proxy-server'],
    ['--proxy-pac-url=https://evil.example/pac.js'],
    ['--proxy-bypass-list=*'],
    ['--proxy-bypass-list', 'localhost, *'],
    ['--proxy-server=direct://'],
    ['--proxy-server=http://x:1', '--proxy-server=direct://'],
    ['--proxy-server=""'],
  ];

  for (const extraArgs of adversarialArgSets) {
    assert.throws(
      () => proxyGuard.prepareLaunchProxy({
        mode: 'managed',
        userDataDir: fBound.userDataDir,
        meta: { requireProxy: true, proxy: { url: 'socks5://10.0.0.2:1080' } },
        options: { requireProxy: true, extraArgs },
      }),
      (err) => err.code === 'ERR_PROXY_UNBOUND_BLOCKED',
      `Expected managed prepareLaunchProxy to reject ${JSON.stringify(extraArgs)}`,
    );

    assert.throws(
      () => proxyGuard.prepareLaunchProxy({
        mode: 'existing',
        userDataDir: fBound.existingUserDataDir,
        options: { requireProxy: true, proxy: { url: 'socks5://10.0.0.2:1080' }, extraArgs },
      }),
      (err) => err.code === 'ERR_PROXY_UNBOUND_BLOCKED',
      `Expected existing prepareLaunchProxy to reject ${JSON.stringify(extraArgs)}`,
    );
  }

  const cleanManaged = proxyGuard.prepareLaunchProxy({
    mode: 'managed',
    userDataDir: fBound.userDataDir,
    meta: { requireProxy: true, proxy: { url: 'socks5://10.0.0.2:1080' } },
    options: { requireProxy: true, extraArgs: ['--proxy-bypass-list=127.0.0.1;localhost'] },
  });
  assert.ok(cleanManaged.extraArgs.includes('--proxy-server=socks5://10.0.0.2:1080'));
});

test('CLI launch --require-proxy refuses unbound direct profiles and unproxied running sessions cleanly', (t) => {
  const fDirect = makeFixture(t, { name: 'cli-direct-acc', proxy: { mode: 'direct' } });
  fs.mkdirSync(path.join(fDirect.root, '.git'), { recursive: true });
  const binPath = path.resolve(import.meta.dirname, '../../bin/webmcp-browser.mjs');
  const env = {
    ...process.env,
    WEBMCP_HOME: fDirect.root,
    WEBMCP_DATA_DIR: fDirect.root,
    WEBMCP_CHROME_BINARY: process.execPath,
  };

  // 1. --profile-id ... --require-proxy --dry-run -> ERR_PROXY_UNBOUND_BLOCKED (exit 1, JSON + stderr)
  const resFlag = spawnSync(
    process.execPath,
    [binPath, 'launch', '--profile-id', 'managed:acc-1', '--require-proxy', '--dry-run'],
    { cwd: fDirect.root, env, encoding: 'utf8' },
  );
  assert.equal(resFlag.status, 1);
  const flagJson = JSON.parse(resFlag.stdout);
  assert.equal(flagJson.ok, false);
  assert.equal(flagJson.code, 'ERR_PROXY_UNBOUND_BLOCKED');
  assert.equal(flagJson.error, 'ERR_PROXY_UNBOUND_BLOCKED');
  assert.match(resFlag.stderr, /ERR_PROXY_UNBOUND_BLOCKED/);

  // 2. Boolean --require-proxy immediately before positional profile query does not swallow query
  const resPositional = spawnSync(
    process.execPath,
    [binPath, 'launch', '--require-proxy', 'managed:acc-1', '--dry-run'],
    { cwd: fDirect.root, env, encoding: 'utf8' },
  );
  assert.equal(resPositional.status, 1);
  const posJson = JSON.parse(resPositional.stdout);
  assert.equal(posJson.ok, false);
  assert.equal(posJson.code, 'ERR_PROXY_UNBOUND_BLOCKED');
  assert.match(resPositional.stderr, /ERR_PROXY_UNBOUND_BLOCKED/);

  // 3. Running managed session lacking --proxy-server= -> ERR_RUNNING_CHROME_MISSING_PROXY (exit 2, needsRelaunch: true)
  const fBound = makeFixture(t, { name: 'cli-bound-acc', proxy: { url: 'socks5://10.0.0.2:1080' } });
  fs.mkdirSync(path.join(fBound.root, '.git'), { recursive: true });
  const dummy = spawnDummyAlivePid(t);
  sessions.rememberManagedSession(fBound.userDataDir, dummy.pid, fBound.sessionsFile);
  const resAttach = spawnSync(
    process.execPath,
    [binPath, 'launch', '--profile-id', 'managed:acc-1', '--require-proxy', '--skip-proxy-gate', '--no-aqua-service', '--json'],
    {
      cwd: fBound.root,
      env: {
        ...process.env,
        WEBMCP_HOME: fBound.root,
        WEBMCP_DATA_DIR: fBound.root,
        WEBMCP_CHROME_BINARY: process.execPath,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(resAttach.status, 2);
  const attachJson = JSON.parse(resAttach.stdout);
  assert.equal(attachJson.ok, false);
  assert.equal(attachJson.code, 'ERR_RUNNING_CHROME_MISSING_PROXY');
  assert.equal(attachJson.needsRelaunch, true);
  assert.equal(attachJson.exitCode, 2);
  assert.match(resAttach.stderr, /ERR_RUNNING_CHROME_MISSING_PROXY/);
});

test('proxy-guard enforces Chromium CommandLine semantics, negative bypass switches, wildcard bypass variants, ps-split lists, and multi-entry direct://', () => {
  // 1. Strict exact lowercase --proxy-server= vs ignored uppercase/single-dash/space-separated variants,
  //    and fail-closed case-insensitive / single-dash negative bypass switches
  assert.equal(proxyGuard.hasProxyServerArg(['--PROXY-SERVER=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--Proxy-Server', 'socks5://10.0.0.2:1080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['-proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-server', 'socks5://10.0.0.2:1080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-server=http://127.0.0.1:8080', '--proxy-server', 'host:1']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-server', 'host:1', '--proxy-server=http://127.0.0.1:8080']), true);
  assert.equal(proxyGuard.hasProxyServerArg(['--NO-PROXY-SERVER', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['-no-proxy-server', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--No-Proxy-Server=false', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--no-proxy-server=0', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--PROXY-PAC-URL=https://evil.example/pac.js', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['-proxy-pac-url', 'https://evil.example/pac.js', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--Proxy-Bypass-List=*', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['-proxy-bypass-list=*', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasExplicitProxyServerFlag(['--proxy-server=http://127.0.0.1:8080']), true);
  assert.equal(proxyGuard.hasExplicitProxyServerFlag(['--PROXY-SERVER=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasExplicitProxyServerFlag(['-proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasExplicitProxyServerFlag(['--proxy-server']), false);
  assert.equal(proxyGuard.hasExplicitProxyServerFlag(['--Proxy-Server', 'http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasExplicitProxyServerFlag(['--', '--proxy-server=http://127.0.0.1:8080']), false);

  // 2. --proxy-auto-detect bypass flag (HasSwitch semantics: =false and =0 are still active!)
  for (const autoDetectArgs of [
    ['--proxy-auto-detect', '--proxy-server=http://127.0.0.1:8080'],
    ['--Proxy-Auto-Detect', '--proxy-server=http://127.0.0.1:8080'],
    ['--proxy-auto-detect=1', '--proxy-server=http://127.0.0.1:8080'],
    ['--PROXY-AUTO-DETECT=true', '--proxy-server=http://127.0.0.1:8080'],
    ['--proxy-auto-detect=false', '--proxy-server=http://127.0.0.1:8080'],
    ['--PROXY-AUTO-DETECT=0', '--proxy-server=http://127.0.0.1:8080'],
    ['-proxy-auto-detect=0', '--proxy-server=http://127.0.0.1:8080'],
  ]) {
    assert.equal(proxyGuard.hasProxyServerArg(autoDetectArgs), false, `Expected rejection for ${JSON.stringify(autoDetectArgs)}`);
  }

  // 3. Wildcard bypass variants vs legitimate domain suffixes
  for (const wildcard of ['*', '*.*', '*:*', '*://*', 'http://*', 'https://*', 'http://*/*', 'https://*/*', '*:80', '*:443', '*/', 'http://*/', 'http://*.*', '*.*/*', '0.0.0.0/0', '::/0']) {
    assert.equal(proxyGuard.isWildcardBypassEntry(wildcard), true, `Expected wildcard=true for ${wildcard}`);
    assert.equal(
      proxyGuard.hasProxyServerArg([`--proxy-bypass-list=localhost,${wildcard}`, '--proxy-server=http://127.0.0.1:8080']),
      false,
      `Expected bypass list rejection for ${wildcard}`,
    );
  }
  for (const allowedEntry of ['*.example.com', 'localhost', '127.0.0.1', '.local', '<local>']) {
    assert.equal(proxyGuard.isWildcardBypassEntry(allowedEntry), false, `Expected wildcard=false for ${allowedEntry}`);
  }
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-bypass-list=*.example.com,localhost,127.0.0.1,.local,<local>', '--proxy-server=http://127.0.0.1:8080']), true);

  // 4. ps/cmdline whitespace-split --proxy-bypass-list handling
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-bypass-list=localhost, * --proxy-server=http://127.0.0.1:8080'), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-bypass-list="localhost,', '*"', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-bypass-list=localhost', ',*', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-bypass-list', 'localhost,', '*', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-bypass-list="localhost,', '--no-proxy-server', '--proxy-server=http://127.0.0.1:8080']), false);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-bypass-list=localhost', 'https://example.com', '--proxy-server=http://127.0.0.1:8080']), true);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-bypass-list="localhost,"', 'https://example.com', '--proxy-server=http://127.0.0.1:8080']), true);

  // 5. Comma/semicolon/scheme-list direct://, empty hosts, empty-scheme entries, and malformed `=`
  for (const badProxy of [
    'http://127.0.0.1:8080,direct://',
    'http://127.0.0.1:8080; direct://',
    'http=127.0.0.1:8080;https=direct://',
    'http=127.0.0.1:8080;https=DIRECT:',
    'http=,https=127.0.0.1:8080',
    'http://',
    'socks5://',
    '=http://127.0.0.1:8080',
    'http=http://;https=http://127.0.0.1:8080',
    'http://h=1.2.3.4:8080',
    'h:1"',
    '"h:1',
  ]) {
    assert.equal(proxyGuard.isNonDirectProxyValue(badProxy), false, `Expected isNonDirectProxyValue=false for ${badProxy}`);
    assert.equal(proxyGuard.evaluateProxyArgs([`--proxy-server=${badProxy}`]), false, `Expected evaluateProxyArgs=false for ${badProxy}`);
    assert.equal(proxyGuard.hasProxyServerArg([`--proxy-server=${badProxy}`]), false, `Expected hasProxyServerArg=false for ${badProxy}`);
    assert.equal(proxyGuard.resolveManagedProxyConfig(badProxy).cleanUrl, null, `Expected resolveManagedProxyConfig cleanUrl=null for ${badProxy}`);
  }
  assert.equal(proxyGuard.resolveManagedProxyConfig('socks5:///path').cleanUrl, null);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-server=http=127.0.0.1:8080;https=127.0.0.1:8080']), true);
  assert.equal(proxyGuard.hasProxyServerArg(['--proxy-server=socks5://10.0.0.2:1080']), true);

  // 6. Multi-token --proxy-server continuation and `--` end-of-switches
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-server=http=127.0.0.1:8080 ;https=direct://'), false);
  assert.equal(proxyGuard.evaluateProxyArgs(['--proxy-server=http=127.0.0.1:8080', ';https=direct://']), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-server=http=127.0.0.1:8080; https=127.0.0.1:8080'), true);
  assert.equal(proxyGuard.evaluateProxyArgs(['--proxy-server=http=127.0.0.1:8080;', 'https=127.0.0.1:8080']), true);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-server=http://127.0.0.1:8080 https://example.com'), true);
  assert.equal(proxyGuard.evaluateProxyArgs(['--proxy-server=http://127.0.0.1:8080', 'https://example.com']), true);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome -- --proxy-server=http://127.0.0.1:8080'), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-server=http://127.0.0.1:8080 -- --no-proxy-server'), true);

  // 7. Quoting edge cases (Bob's apostrophe, unclosed/mid-token quotes) & CR/LF/NBSP delimiters
  assert.deepEqual(
    proxyGuard.tokenizeCmdline("chrome --profile-directory=Bob's --no-proxy-server --proxy-server=http://127.0.0.1:8080"),
    ['chrome', "--profile-directory=Bob's", '--no-proxy-server', '--proxy-server=http://127.0.0.1:8080'],
  );
  assert.equal(
    proxyGuard.cmdlineHasProxyServer("chrome --profile-directory=Bob's --no-proxy-server --proxy-server=http://127.0.0.1:8080"),
    false,
  );
  assert.equal(
    proxyGuard.cmdlineHasProxyServer('chrome --proxy-server="http://127.0.0.1:8080 --no-proxy-server'),
    false,
  );
  assert.equal(
    proxyGuard.cmdlineHasProxyServer('chrome --proxy-server=h:1" --no-proxy-server'),
    false,
  );
  assert.equal(
    proxyGuard.cmdlineHasProxyServer('chrome --proxy-server="http://127.0.0.1:8080" --proxy-bypass-list="localhost, *"'),
    false,
  );
  assert.equal(
    proxyGuard.cmdlineHasProxyServer('chrome\u00a0--proxy-server=http://127.0.0.1:8080\r\n--no-proxy-server'),
    false,
  );
  assert.equal(
    proxyGuard.cmdlineHasProxyServer('chrome\u00a0--proxy-server=http://127.0.0.1:8080\r\n--user-data-dir=/tmp/p'),
    true,
  );

  // 8. Non-canonical proxy-server switches (single-dash, mixed-case, Windows /switch), backslash-escaped quotes, mid-token quotes, unclosed continuation, and NBSP
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-server=http://127.0.0.1:8080 -proxy-server=direct://'), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-server=http://127.0.0.1:8080 -proxy-server'), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-server=http://127.0.0.1:8080 --Proxy-Server=direct://'), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-server=http://127.0.0.1:8080 /proxy-server=direct://'), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-server=http://127.0.0.1:8080 /no-proxy-server'), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --user-data-dir="a\\\\" --no-proxy-server --foo="b" --proxy-server=http://127.0.0.1:8080'), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --user-data-dir="a\\\\\\" --no-proxy-server" --proxy-server=http://127.0.0.1:8080'), true);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome https://example.com/?a="1 --no-proxy-server x" --proxy-server=http://127.0.0.1:8080'), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --foo=a="1 --no-proxy-server b" --proxy-server=http://127.0.0.1:8080'), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome --proxy-bypass-list=foo" --other * --proxy-server=http://127.0.0.1:8080'), true);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome\u00a0--no-proxy-server --proxy-server=http://127.0.0.1:8080'), false);
  assert.equal(proxyGuard.cmdlineHasProxyServer('chrome\u00a0--proxy-server=http://127.0.0.1:8080'), true);
});


