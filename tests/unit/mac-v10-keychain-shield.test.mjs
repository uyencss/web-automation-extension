import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = require(path.join(ROOT, 'chrome-launcher'));
const guard = require(path.join(ROOT, 'chrome-launcher', 'mac-keychain-guard'));
import { directCdpExportCookies, handleExport } from '../../lib/cli/commands/cookies-export.mjs';
import { getMacKeychainPassword } from '../../lib/cookie-crypto.mjs';

function createCookiesDb(dbPath, prefixes = []) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB);');
    const stmt = db.prepare('INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)');
    prefixes.forEach((pfx, idx) => {
      const payload = Buffer.concat([Buffer.from(pfx, 'ascii'), Buffer.from(`payload-${idx}`)]);
      stmt.run('.facebook.com', `c_${idx}`, payload);
    });
  } finally {
    db.close();
  }
}

test('buildManagedShieldArgs includes macOS v10 UserDataDirProtection disable flags only when preserveMacV10Keychain is true', () => {
  const defaultDisable = launcher.buildManagedShieldArgs().find((a) => a.startsWith('--disable-features='));
  assert.ok(defaultDisable);
  assert.equal(defaultDisable.includes('KeychainKeyProviderUserDataDirProtection'), false);

  const v10Disable = launcher
    .buildManagedShieldArgs({ preserveMacV10Keychain: true })
    .find((a) => a.startsWith('--disable-features='));
  assert.ok(v10Disable);
  for (const feat of launcher.MAC_V10_KEYCHAIN_SHIELD_FEATURES) {
    assert.ok(v10Disable.includes(feat), `expected ${feat} in ${v10Disable}`);
  }
});

test('detectMacCookieEncryptionMode supports 5-state fixtures, WAL-only v11, Network/Cookies precedence, and WEBMCP_COOKIE_MODE override', (t) => {
  if (process.platform !== 'darwin') {
    assert.equal(launcher.detectMacCookieEncryptionMode('/tmp/ignored', 'Default'), 'other');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-v10-detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const pV10 = path.join(root, 'fixture-profile-v10');
  createCookiesDb(path.join(pV10, 'Profile 43', 'Cookies'), ['v10', 'v10', 'v10']);
  assert.equal(launcher.detectMacCookieEncryptionMode(pV10, 'Profile 43'), 'v10');

  const pV11 = path.join(root, 'fixture-profile-v11');
  createCookiesDb(path.join(pV11, 'Default', 'Cookies'), ['v11', 'v11']);
  assert.equal(launcher.detectMacCookieEncryptionMode(pV11, 'Default'), 'v11');

  // Empty dir & empty table -> 'none'
  const pMissing = path.join(root, 'fresh-missing');
  fs.mkdirSync(path.join(pMissing, 'Default'), { recursive: true });
  assert.equal(launcher.detectMacCookieEncryptionMode(pMissing, 'Default'), 'none');

  const pEmptyTbl = path.join(root, 'fresh-empty-table');
  createCookiesDb(path.join(pEmptyTbl, 'Default', 'Network', 'Cookies'), []);
  assert.equal(launcher.detectMacCookieEncryptionMode(pEmptyTbl, 'Default'), 'none');

  // Mixed v10 + v11 -> 'mixed'
  const pMixed = path.join(root, 'mixed-cookies');
  createCookiesDb(path.join(pMixed, 'Default', 'Network', 'Cookies'), ['v10', 'v11']);
  assert.equal(launcher.detectMacCookieEncryptionMode(pMixed, 'Default'), 'mixed');

  // Corrupt DB -> 'unknown'
  const pCorrupt = path.join(root, 'corrupt-cookies');
  fs.mkdirSync(path.join(pCorrupt, 'Default', 'Network'), { recursive: true });
  fs.writeFileSync(path.join(pCorrupt, 'Default', 'Network', 'Cookies'), 'not-a-sqlite-db');
  assert.equal(launcher.detectMacCookieEncryptionMode(pCorrupt, 'Default'), 'unknown');

  // Network/Cookies takes precedence over stale root Cookies
  const pPrecedence = path.join(root, 'precedence');
  createCookiesDb(path.join(pPrecedence, 'Default', 'Cookies'), ['v10', 'v10']);
  createCookiesDb(path.join(pPrecedence, 'Default', 'Network', 'Cookies'), ['v11']);
  assert.equal(launcher.detectMacCookieEncryptionMode(pPrecedence, 'Default'), 'v11');

  // v11-only-in-WAL with open writer (wal_autocheckpoint=0): temp-copy WAL replay detects v11!
  const pWal = path.join(root, 'wal-live-v11');
  const walDbPath = path.join(pWal, 'Default', 'Network', 'Cookies');
  fs.mkdirSync(path.dirname(walDbPath), { recursive: true });
  const walInit = new DatabaseSync(walDbPath);
  walInit.exec('PRAGMA journal_mode=WAL; CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB);');
  walInit.close();

  const liveWriter = new DatabaseSync(walDbPath);
  t.after(() => { try { liveWriter.close(); } catch {} });
  liveWriter.exec('PRAGMA wal_autocheckpoint=0;');
  liveWriter.prepare('INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)').run(
    '.facebook.com',
    'c_wal',
    Buffer.concat([Buffer.from('v11', 'ascii'), Buffer.from('wal-secret')]),
  );
  assert.equal(launcher.detectMacCookieEncryptionMode(pWal, 'Default'), 'v11');
  liveWriter.close();

  // Explicit WEBMCP_COOKIE_MODE=v10|v11 override
  assert.equal(launcher.detectMacCookieEncryptionMode(pMixed, 'Default', { env: { WEBMCP_COOKIE_MODE: 'v10' } }), 'v10');
  assert.equal(launcher.detectMacCookieEncryptionMode(pCorrupt, 'Default', { env: { WEBMCP_COOKIE_MODE: 'v11' } }), 'v11');
});

test('resolveMacV10Shield fails closed on mixed/unknown for real Chrome unless overridden or dryRun', () => {
  const realChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const stubChrome = process.execPath;

  assert.deepEqual(
    guard.resolveMacV10Shield({
      userDataDir: '/tmp/p',
      chromePath: realChrome,
      platform: 'darwin',
      detectFn: () => 'v10',
    }),
    { preserveMacV10Keychain: true, mode: 'v10' },
  );
  assert.deepEqual(
    guard.resolveMacV10Shield({
      userDataDir: '/tmp/p',
      chromePath: realChrome,
      platform: 'darwin',
      detectFn: () => 'v11',
    }),
    { preserveMacV10Keychain: false, mode: 'v11' },
  );
  assert.deepEqual(
    guard.resolveMacV10Shield({
      userDataDir: '/tmp/p',
      chromePath: realChrome,
      platform: 'darwin',
      detectFn: () => 'none',
    }),
    { preserveMacV10Keychain: false, mode: 'none' },
  );

  assert.throws(
    () => guard.resolveMacV10Shield({
      userDataDir: '/tmp/mixed',
      chromePath: realChrome,
      platform: 'darwin',
      detectFn: () => 'mixed',
    }),
    (err) => err.code === 'ERR_MACOS_COOKIE_MODE_MIXED' && /WEBMCP_COOKIE_MODE=v10\|v11/.test(err.message),
  );
  assert.throws(
    () => guard.resolveMacV10Shield({
      userDataDir: '/tmp/unknown',
      chromePath: realChrome,
      platform: 'darwin',
      detectFn: () => 'unknown',
    }),
    (err) => err.code === 'ERR_MACOS_COOKIE_MODE_UNKNOWN' && /WEBMCP_COOKIE_MODE=v10\|v11/.test(err.message),
  );

  // dryRun and test stubs do not fail on mixed/unknown, and still preserve v10
  assert.deepEqual(
    guard.resolveMacV10Shield({
      userDataDir: '/tmp/mixed',
      chromePath: realChrome,
      dryRun: true,
      platform: 'darwin',
      detectFn: () => 'mixed',
    }),
    { preserveMacV10Keychain: false, mode: 'mixed' },
  );
  assert.deepEqual(
    guard.resolveMacV10Shield({
      userDataDir: '/tmp/v10',
      chromePath: stubChrome,
      dryRun: false,
      platform: 'darwin',
      detectFn: () => 'v10',
    }),
    { preserveMacV10Keychain: true, mode: 'v10' },
  );
});

test('launchChrome managed gates Chrome 158 UserDataDirProtection disable flags on v10 vs v11 Cookies DB', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-v10-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const managedDir = path.join(root, 'managed-profiles');
  const extensionPath = path.join(root, 'ext');
  fs.mkdirSync(extensionPath, { recursive: true });
  fs.writeFileSync(path.join(extensionPath, 'manifest.json'), '{"manifest_version":3,"name":"Test","version":"1.0"}');
  const fakeChrome = path.join(root, 'fake-chrome.sh');
  fs.writeFileSync(fakeChrome, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const sessionsFile = path.join(root, 'sessions.json');

  const pV10 = path.join(managedDir, 'legacy-v10');
  createCookiesDb(path.join(pV10, 'Profile 43', 'Cookies'), ['v10', 'v10']);
  fs.writeFileSync(path.join(pV10, '.webmcp-meta.json'), JSON.stringify({ name: 'legacy-v10', profileDir: 'Profile 43' }));

  const resV10 = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: pV10, profileDir: 'Profile 43' },
    managedProfilesDir: managedDir,
    chromePath: fakeChrome,
    extensionPath,
    sessionsFile,
    dryRun: true,
  });
  const disableV10 = resV10.args.find((a) => a.startsWith('--disable-features='));
  assert.ok(disableV10.includes('KeychainKeyProviderUserDataDirProtection'));

  const pV11 = path.join(managedDir, 'modern-v11');
  createCookiesDb(path.join(pV11, 'Default', 'Cookies'), ['v11', 'v11']);
  fs.writeFileSync(path.join(pV11, '.webmcp-meta.json'), JSON.stringify({ name: 'modern-v11', profileDir: 'Default' }));

  const resV11 = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: pV11, profileDir: 'Default' },
    managedProfilesDir: managedDir,
    chromePath: fakeChrome,
    extensionPath,
    sessionsFile,
    dryRun: true,
  });
  const disableV11 = resV11.args.find((a) => a.startsWith('--disable-features='));
  assert.equal(disableV11.includes('KeychainKeyProviderUserDataDirProtection'), false);
});

test('no fake-binary exemptions or SSH env stripping exist in guard/launcher', () => {
  assert.equal(guard.isRealChromeBinary, undefined);
  assert.equal(guard.stripMacSshEnv, undefined);
  assert.equal(launcher.stripMacSshEnv, undefined);
});

test('probeMacosAquaKeychainSession & assertMacosAquaKeychainSession use JXA short-circuit and distinguish non-aqua vs keychain-locked', () => {
  const nonDarwin = guard.probeMacosAquaKeychainSession({ platform: 'linux' });
  assert.deepEqual(nonDarwin, { ok: true, platform: 'linux', skipped: true });

  let osascriptCalls = 0;
  let securityCalls = 0;
  const makeExec = ({ managerName = 'Aqua', keychainOk = true } = {}) => (bin, args) => {
    if (bin === '/bin/launchctl' && args[0] === 'managername') return `${managerName}\n`;
    if (bin === '/usr/bin/osascript' && args[0] === '-l' && args[1] === 'JavaScript' && args[2] === '-e') {
      osascriptCalls += 1;
      assert.match(args[3], /SecKeychainSetUserInteractionAllowed\(false\)/);
      assert.match(args[3], /SecKeychainGetStatus/);
      if (!keychainOk) throw new Error('locked');
      return '';
    }
    if (bin === '/usr/bin/security') {
      securityCalls += 1;
      throw new Error('security CLI must never be invoked by probe');
    }
    throw new Error(`Unexpected command: ${bin}`);
  };

  // 1. Background launchd session blocked WITHOUT calling osascript/Keychain
  osascriptCalls = 0;
  const bg = guard.probeMacosAquaKeychainSession({
    platform: 'darwin',
    env: {},
    homedir: '/Users/test',
    execFileSyncFn: makeExec({ managerName: 'Background', keychainOk: true }),
  });
  assert.equal(bg.ok, false);
  assert.equal(bg.reason, 'non-aqua');
  assert.equal(bg.code, 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED');
  assert.equal(bg.managerName, 'Background');
  assert.equal(osascriptCalls, 0);
  assert.equal(securityCalls, 0);

  // 2. SSH_CONNECTION / SSH_CLIENT / SSH_TTY blocked WITHOUT calling osascript/Keychain
  for (const sshEnv of [{ SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }, { SSH_CLIENT: '10.0.0.1 1 22' }, { SSH_TTY: '/dev/ttys0' }]) {
    osascriptCalls = 0;
    const sshRes = guard.probeMacosAquaKeychainSession({
      platform: 'darwin',
      env: sshEnv,
      homedir: '/Users/test',
      execFileSyncFn: makeExec({ managerName: 'Aqua', keychainOk: true }),
    });
    assert.equal(sshRes.ok, false);
    assert.equal(sshRes.reason, 'non-aqua');
    assert.equal(sshRes.code, 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED');
    assert.equal(sshRes.hasSshEnv, true);
    assert.equal(osascriptCalls, 0);
  }

  // 3. Keychain locked inside Aqua -> calls osascript JXA once and returns ERR_MACOS_KEYCHAIN_LOCKED
  osascriptCalls = 0;
  const locked = guard.probeMacosAquaKeychainSession({
    platform: 'darwin',
    env: {},
    homedir: '/Users/test',
    execFileSyncFn: makeExec({ managerName: 'Aqua', keychainOk: false }),
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'keychain-locked');
  assert.equal(locked.code, 'ERR_MACOS_KEYCHAIN_LOCKED');
  assert.equal(locked.keychainOk, false);
  assert.equal(osascriptCalls, 1);

  // 4. Clean Aqua + no SSH + unlocked Keychain allowed
  osascriptCalls = 0;
  const okRes = guard.probeMacosAquaKeychainSession({
    platform: 'darwin',
    env: { HOME: '/Users/test', SSH_CONNECTION: undefined },
    homedir: '/Users/test',
    execFileSyncFn: makeExec({ managerName: 'Aqua', keychainOk: true }),
  });
  assert.deepEqual(okRes, { ok: true, platform: 'darwin', managerName: 'Aqua', hasSshEnv: false, keychainOk: true });
  assert.equal(osascriptCalls, 1);
  assert.equal(securityCalls, 0);

  // 5. assertMacosAquaKeychainSession bypasses dryRun & skipGuardForTest only (never fake binary paths)
  assert.equal(guard.assertMacosAquaKeychainSession({ dryRun: true, probe: () => bg }).skipped, 'dryRun');
  assert.equal(guard.assertMacosAquaKeychainSession({ skipGuardForTest: true, probe: () => bg }).skipped, 'test-guard');

  for (const badProbe of [bg, { ok: false, platform: 'darwin', managerName: 'Aqua', hasSshEnv: true, keychainOk: true }]) {
    assert.throws(
      () => guard.assertMacosAquaKeychainSession({ forceCheck: true, probe: () => badProbe }),
      (err) => err.code === 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED' && err.details === badProbe && /Aqua Gateway/.test(err.message),
    );
  }
  assert.throws(
    () => guard.assertMacosAquaKeychainSession({ forceCheck: true, probe: () => locked }),
    (err) => err.code === 'ERR_MACOS_KEYCHAIN_LOCKED' && err.details === locked,
  );
  assert.deepEqual(
    guard.assertMacosAquaKeychainSession({ forceCheck: true, probe: () => okRes }),
    okRes,
  );
});

test('spawnChrome, focusOrOpenRunningChrome, and directCdpExportCookies fail closed with ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED when SSH_* is set on darwin', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-aqua-block-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extDir = path.join(root, 'ext');
  fs.mkdirSync(extDir, { recursive: true });
  const udd = path.join(root, 'prof');
  fs.mkdirSync(path.join(udd, 'Default'), { recursive: true });
  const realChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  const prevSsh = process.env.SSH_CONNECTION;
  process.env.SSH_CONNECTION = '100.64.0.1 12345 100.64.0.2 22';
  try {
    await assert.rejects(
      () => launcher.spawnChrome({
        chromePath: realChrome,
        extensionPath: extDir,
        userDataDir: udd,
        profileDir: 'Default',
        mode: 'managed',
        dryRun: false,
      }),
      (err) => err.code === 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED' && err.details?.hasSshEnv === true,
    );

    await assert.rejects(
      () => launcher.focusOrOpenRunningChrome({
        chromePath: realChrome,
        userDataDir: udd,
        profileDir: 'Default',
        mode: 'managed',
        dryRun: false,
      }),
      (err) => err.code === 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED' && err.details?.hasSshEnv === true,
    );

    await assert.rejects(
      () => directCdpExportCookies(
        { id: 'managed:prof', userDataDir: udd, profileDir: 'Default' },
        { chromePath: realChrome },
      ),
      (err) => err.code === 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED' && err.details?.hasSshEnv === true,
    );
  } finally {
    if (prevSsh === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = prevSsh;
  }
});

test('directCdpExportCookies injects macOS v10 UserDataDirProtection disable flags when Cookies DB is v10', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-cdp-v10-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const udd = path.join(root, 'v10-export');
  createCookiesDb(path.join(udd, 'Default', 'Cookies'), ['v10', 'v10']);

  const argsFile = path.join(root, 'seen-args.json');
  const portFile = path.join(udd, 'DevToolsActivePort');
  const mockBin = path.join(root, 'mock-chrome-args.js');
  fs.writeFileSync(
    mockBin,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nfs.writeFileSync(${JSON.stringify(portFile)}, '1\\n/devtools/browser/mock\\n');\nprocess.exit(0);\n`,
    { mode: 0o755 },
  );

  await assert.rejects(
    () => directCdpExportCookies(
      { id: 'managed:v10-export', userDataDir: udd, profileDir: 'Default' },
      { chromePath: mockBin, cdpTimeoutMs: 5000 },
    ),
  );
  const seenArgs = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  const disableArgs = seenArgs.filter((a) => a.startsWith('--disable-features='));
  assert.equal(disableArgs.length, 1, `expected single --disable-features= in ${JSON.stringify(seenArgs)}`);
  const disableArg = disableArgs[0];
  for (const feat of launcher.MAC_V10_KEYCHAIN_SHIELD_FEATURES) {
    assert.ok(disableArg.includes(feat), `expected ${feat} in ${disableArg}`);
  }
});

test('spawnChrome enforces Aqua guard, forbidden args, and single merged --disable-features across existing and managed modes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-spawn-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extDir = path.join(root, 'ext');
  fs.mkdirSync(extDir, { recursive: true });
  const udd = path.join(root, 'existing-v10');
  createCookiesDb(path.join(udd, 'Default', 'Network', 'Cookies'), ['v10', 'v10']);

  // Forbidden args blocked even in mode='existing'
  await assert.rejects(
    () => launcher.spawnChrome({
      chromePath: process.execPath,
      extensionPath: extDir,
      userDataDir: udd,
      profileDir: 'Default',
      mode: 'existing',
      extraArgs: ['--use-mock-keychain'],
      dryRun: true,
    }),
    (err) => err.code === 'ERR_FORBIDDEN_MOCK_KEYCHAIN',
  );

  // Single merged --disable-features= emitted when extraArgs also has --disable-features=
  const resExisting = await launcher.spawnChrome({
    chromePath: process.execPath,
    extensionPath: extDir,
    userDataDir: udd,
    profileDir: 'Default',
    mode: 'existing',
    extraArgs: ['--disable-features=CustomFeature'],
    dryRun: true,
  });
  const disableFlags = resExisting.args.filter((a) => a.startsWith('--disable-features='));
  assert.equal(disableFlags.length, 1);
  assert.ok(disableFlags[0].includes('CustomFeature'));
  if (process.platform === 'darwin') {
    for (const feat of launcher.MAC_V10_KEYCHAIN_SHIELD_FEATURES) {
      assert.ok(disableFlags[0].includes(feat));
    }
  }

  // mode='existing' with real Chrome binary blocks when SSH_* is active
  if (process.platform === 'darwin') {
    await assert.rejects(
      () => launcher.spawnChrome({
        chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        extensionPath: extDir,
        userDataDir: udd,
        profileDir: 'Default',
        mode: 'existing',
        dryRun: false,
        env: { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' },
      }),
      (err) => err.code === 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED',
    );
  }
});

test('cookies-export handleExport rethrows ERR_MACOS_* guard errors instead of swallowing them', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-export-rethrow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const udd = path.join(root, 'prof');
  fs.mkdirSync(path.join(udd, 'Default'), { recursive: true });
  const profile = { id: 'managed:prof', userDataDir: udd, profileDir: 'Default' };

  await assert.rejects(
    () => handleExport(
      { profileId: 'managed:prof', allowOnline: true },
      {
        profileResolver: () => profile,
        cookieExporter: () => {
          const err = new Error('macOS keychain denied');
          err.code = 'KEYCHAIN_DENIED';
          throw err;
        },
        gatewayHealthLookup: async () => ({ profileDetails: [] }),
        directCdpExportFn: async () => {
          const err = new Error('ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED: blocked');
          err.code = 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED';
          throw err;
        },
      },
    ),
    (err) => err.code === 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED',
  );
});

test('getMacKeychainPassword checks Aqua/Keychain guard BEFORE invoking security CLI on darwin', () => {
  let securityInvoked = false;
  const fakeExec = () => {
    securityInvoked = true;
    return 'secret\n';
  };

  assert.throws(
    () => getMacKeychainPassword({
      platform: 'darwin',
      exec: fakeExec,
      probe: () => ({
        ok: false,
        reason: 'non-aqua',
        code: 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED',
        managerName: 'Background',
        hasSshEnv: true,
        keychainOk: false,
      }),
    }),
    (err) => err.code === 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED',
  );
  assert.equal(securityInvoked, false, 'security find-generic-password must never run when Aqua guard fails');

  const pw = getMacKeychainPassword({
    platform: 'darwin',
    exec: fakeExec,
    probe: () => ({
      ok: true,
      platform: 'darwin',
      managerName: 'Aqua',
      hasSshEnv: false,
      keychainOk: true,
    }),
  });
  assert.equal(pw, 'secret');
  assert.equal(securityInvoked, true);
});

test('B2: copySqliteStable copies -wal/-journal before main DB, detects uncheckpointed WAL v10/v11 rows, and fails closed when unstable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-b2-wal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 1. copySqliteStable copies -wal BEFORE main Cookies DB, chmods 0o600, retries transient mutation, and fails after 3 unstable attempts
  const srcDir = path.join(root, 'copy-order');
  fs.mkdirSync(srcDir, { recursive: true });
  const srcDb = path.join(srcDir, 'Cookies');
  const srcWal = `${srcDb}-wal`;
  fs.writeFileSync(srcDb, 'main-db-bytes', { mode: 0o644 });
  fs.writeFileSync(srcWal, 'wal-bytes-v1', { mode: 0o644 });

  const dstDir = path.join(root, 'copy-dst');
  fs.mkdirSync(dstDir, { recursive: true });
  const dstDb = path.join(dstDir, 'Cookies');

  let walExistedBeforeMain = false;
  let mainMissingDuringHook = false;
  guard.copySqliteStable(srcDb, dstDb, 3, {
    afterSidecarHook: (attempt) => {
      if (attempt === 0) {
        walExistedBeforeMain = fs.existsSync(`${dstDb}-wal`);
        mainMissingDuringHook = !fs.existsSync(dstDb);
        // Mutate -wal on attempt 0 so copySqliteStable must retry on attempt 1
        fs.writeFileSync(srcWal, 'wal-bytes-v2-mutated');
      }
    },
  });
  assert.equal(walExistedBeforeMain, true, '-wal sidecar must be copied BEFORE main DB');
  assert.equal(mainMissingDuringHook, true, 'main DB must not be copied before sidecars');
  assert.equal(fs.readFileSync(`${dstDb}-wal`, 'utf8'), 'wal-bytes-v2-mutated');
  assert.equal(fs.statSync(dstDb).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${dstDb}-wal`).mode & 0o777, 0o600);

  // Unstable on every attempt -> throws SQLITE_SNAPSHOT_UNSTABLE
  let mutCounter = 0;
  assert.throws(
    () => guard.copySqliteStable(srcDb, dstDb, 3, {
      afterSidecarHook: () => {
        mutCounter += 1;
        fs.writeFileSync(srcWal, `wal-torn-${mutCounter}`);
      },
    }),
    (err) => err.message === 'SQLITE_SNAPSHOT_UNSTABLE',
  );
  assert.equal(mutCounter, 3);

  if (process.platform !== 'darwin') {
    return;
  }

  // 2. Uncheckpointed WAL-mode v10 and v11 rows still detected accurately, and unstable WAL fails closed as 'unknown'
  for (const mode of ['v10', 'v11']) {
    const pWal = path.join(root, `wal-${mode}`);
    const walDbPath = path.join(pWal, 'Default', 'Network', 'Cookies');
    fs.mkdirSync(path.dirname(walDbPath), { recursive: true });
    const walInit = new DatabaseSync(walDbPath);
    walInit.exec('PRAGMA journal_mode=WAL; CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB);');
    walInit.close();

    const writer = new DatabaseSync(walDbPath);
    t.after(() => { try { writer.close(); } catch {} });
    writer.exec('PRAGMA wal_autocheckpoint=0;');
    writer.prepare('INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)').run(
      '.google.com',
      'SID',
      Buffer.concat([Buffer.from(mode, 'ascii'), Buffer.from('uncheckpointed-wal')]),
    );
    assert.equal(fs.existsSync(`${walDbPath}-wal`), true, `${mode} WAL file should exist`);
    assert.equal(guard.detectMacCookieEncryptionMode(pWal, 'Default'), mode);

    let unstableTick = 0;
    const unstableMode = guard.detectMacCookieEncryptionMode(pWal, 'Default', {
      afterSidecarHook: () => {
        unstableTick += 1;
        fs.appendFileSync(`${walDbPath}-wal`, Buffer.from(`-${unstableTick}`));
      },
    });
    assert.equal(unstableMode, 'unknown', 'Unstable snapshot must fail closed to unknown');
    writer.close();
  }

  // 3. P1-4/P2-2: -shm mutation triggers retry & cleanup of tmp -shm, and retry pauses >=20ms unless retryDelayMs=0
  const shmSrc = path.join(srcDir, 'Cookies-shm-test');
  const shmDst = path.join(dstDir, 'Cookies-shm-dst');
  fs.writeFileSync(shmSrc, 'db-main');
  fs.writeFileSync(`${shmSrc}-shm`, 'shm-v1');
  fs.writeFileSync(`${shmDst}-shm`, 'stale-tmp-shm');
  let shmHookCalls = 0;
  const t0 = Date.now();
  guard.copySqliteStable(shmSrc, shmDst, 3, {
    afterSidecarHook: (attempt) => {
      shmHookCalls += 1;
      if (attempt === 0) fs.writeFileSync(`${shmSrc}-shm`, 'shm-v2');
    },
  });
  const elapsedMs = Date.now() - t0;
  assert.equal(shmHookCalls, 2);
  assert.equal(fs.existsSync(`${shmDst}-shm`), false, 'stale tmp -shm must be cleaned up');
  assert.ok(elapsedMs >= 15, `expected >=20ms retry backoff, got ${elapsedMs}ms`);

  let zeroDelayCalls = 0;
  const t1 = Date.now();
  guard.copySqliteStable(shmSrc, shmDst, 2, {
    retryDelayMs: 0,
    afterSidecarHook: (attempt) => {
      zeroDelayCalls += 1;
      if (attempt === 0) fs.writeFileSync(`${shmSrc}-shm`, 'shm-v3');
    },
  });
  assert.equal(zeroDelayCalls, 2);
  assert.ok(Date.now() - t1 < 50);
});
