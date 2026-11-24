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
import { directCdpExportCookies } from '../../lib/cli/commands/cookies-export.mjs';

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
  assert.equal(defaultDisable.includes('kKeychainKeyProviderUserDataDirProtection'), false);
  assert.equal(defaultDisable.includes('KeychainKeyProviderUserDataDirProtection'), false);

  const v10Disable = launcher
    .buildManagedShieldArgs({ preserveMacV10Keychain: true })
    .find((a) => a.startsWith('--disable-features='));
  assert.ok(v10Disable);
  for (const feat of launcher.MAC_V10_KEYCHAIN_SHIELD_FEATURES) {
    assert.ok(v10Disable.includes(feat), `expected ${feat} in ${v10Disable}`);
  }
});

test('detectMacCookieEncryptionMode detects v10 (with spaces in path), v11, and empty DB on darwin', (t) => {
  if (process.platform !== 'darwin') {
    assert.equal(launcher.detectMacCookieEncryptionMode('/tmp/ignored', 'Default'), 'other');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-v10-detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const pV10 = path.join(root, 'thichminhthien0');
  createCookiesDb(path.join(pV10, 'Profile 43', 'Cookies'), ['v10', 'v10', 'v10']);
  assert.equal(launcher.detectMacCookieEncryptionMode(pV10, 'Profile 43'), 'v10');

  const pV11 = path.join(root, 'hieu2906090');
  createCookiesDb(path.join(pV11, 'Default', 'Cookies'), ['v11', 'v11']);
  assert.equal(launcher.detectMacCookieEncryptionMode(pV11, 'Default'), 'v11');

  const pEmpty = path.join(root, 'fresh-empty');
  fs.mkdirSync(path.join(pEmpty, 'Default'), { recursive: true });
  assert.equal(launcher.detectMacCookieEncryptionMode(pEmpty, 'Default'), 'empty');
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
  assert.ok(disableV10.includes('kKeychainKeyProviderUserDataDirProtection'));
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
  assert.equal(disableV11.includes('kKeychainKeyProviderUserDataDirProtection'), false);
  assert.equal(disableV11.includes('KeychainKeyProviderUserDataDirProtection'), false);
});

test('isRealChromeBinary & stripMacSshEnv classify binaries and strip SSH_* safely', () => {
  assert.equal(guard.isRealChromeBinary(''), false);
  assert.equal(guard.isRealChromeBinary(null), false);
  assert.equal(guard.isRealChromeBinary(process.execPath), false);
  assert.equal(guard.isRealChromeBinary('/tmp/fake-chrome.sh'), false);
  assert.equal(guard.isRealChromeBinary('/tmp/mock-chrome.js'), false);
  assert.equal(guard.isRealChromeBinary('/tmp/mock-chrome.mjs'), false);
  assert.equal(guard.isRealChromeBinary('/tmp/run.cmd'), false);
  assert.equal(guard.isRealChromeBinary('/tmp/run.bat'), false);
  assert.equal(guard.isRealChromeBinary('/usr/local/bin/node22'), false);
  assert.equal(guard.isRealChromeBinary('/tmp/fake-launcher'), false);

  assert.equal(guard.isRealChromeBinary('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), true);
  assert.equal(guard.isRealChromeBinary('/Applications/Google Chrome.app'), true);
  assert.equal(guard.isRealChromeBinary('/usr/bin/chromium'), true);
  assert.equal(guard.isRealChromeBinary('/usr/bin/google-chrome'), true);

  const srcEnv = { HOME: '/Users/test', SSH_CONNECTION: '1.2.3.4 1 2 22', SSH_CLIENT: '1.2.3.4 1 22', SSH_TTY: '/dev/ttys001' };
  const stripped = guard.stripMacSshEnv(srcEnv);
  assert.equal(stripped.HOME, '/Users/test');
  assert.equal(srcEnv.SSH_CONNECTION, '1.2.3.4 1 2 22');
  if (process.platform === 'darwin') {
    assert.equal('SSH_CONNECTION' in stripped, false);
    assert.equal('SSH_CLIENT' in stripped, false);
    assert.equal('SSH_TTY' in stripped, false);
  }
});

test('probeMacosAquaKeychainSession & assertMacosAquaKeychainSession enforce fail-closed Aqua + Keychain checks', () => {
  const nonDarwin = guard.probeMacosAquaKeychainSession({ platform: 'linux' });
  assert.deepEqual(nonDarwin, { ok: true, platform: 'linux', skipped: true });

  const makeExec = ({ managerName = 'Aqua', keychainOk = true } = {}) => (bin, args) => {
    if (bin === '/bin/launchctl' && args[0] === 'managername') return `${managerName}\n`;
    if (bin === '/usr/bin/security' && args[0] === 'show-keychain-info') {
      if (!keychainOk) throw new Error('User interaction is not allowed');
      return '';
    }
    throw new Error(`Unexpected command: ${bin}`);
  };

  // 1. Background launchd session blocked
  const bg = guard.probeMacosAquaKeychainSession({
    platform: 'darwin',
    env: {},
    homedir: '/Users/test',
    execFileSyncFn: makeExec({ managerName: 'Background', keychainOk: true }),
  });
  assert.equal(bg.ok, false);
  assert.equal(bg.managerName, 'Background');

  // 2. SSH_CONNECTION / SSH_CLIENT / SSH_TTY blocked
  for (const sshEnv of [{ SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }, { SSH_CLIENT: '10.0.0.1 1 22' }, { SSH_TTY: '/dev/ttys0' }]) {
    const sshRes = guard.probeMacosAquaKeychainSession({
      platform: 'darwin',
      env: sshEnv,
      homedir: '/Users/test',
      execFileSyncFn: makeExec({ managerName: 'Aqua', keychainOk: true }),
    });
    assert.equal(sshRes.ok, false);
    assert.equal(sshRes.hasSshEnv, true);
  }

  // 3. Keychain inaccessible (exit != 0) blocked
  const locked = guard.probeMacosAquaKeychainSession({
    platform: 'darwin',
    env: {},
    homedir: '/Users/test',
    execFileSyncFn: makeExec({ managerName: 'Aqua', keychainOk: false }),
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.keychainOk, false);

  // 4. Clean Aqua + no SSH + keychainOk allowed
  const okRes = guard.probeMacosAquaKeychainSession({
    platform: 'darwin',
    env: { HOME: '/Users/test' },
    homedir: '/Users/test',
    execFileSyncFn: makeExec({ managerName: 'Aqua', keychainOk: true }),
  });
  assert.deepEqual(okRes, { ok: true, platform: 'darwin', managerName: 'Aqua', hasSshEnv: false, keychainOk: true });

  // 5. assertMacosAquaKeychainSession bypasses dryRun & stubs unless forceCheck: true
  assert.equal(guard.assertMacosAquaKeychainSession({ dryRun: true, chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', probe: () => bg }).skipped, 'dryRun');
  assert.equal(guard.assertMacosAquaKeychainSession({ chromePath: process.execPath, probe: () => bg }).skipped, 'non-chrome-binary');
  assert.equal(guard.assertMacosAquaKeychainSession({ chromePath: '/tmp/fake-chrome.sh', probe: () => bg }).skipped, 'non-chrome-binary');

  for (const badProbe of [bg, locked, { ok: false, platform: 'darwin', managerName: 'Aqua', hasSshEnv: true, keychainOk: true }]) {
    assert.throws(
      () => guard.assertMacosAquaKeychainSession({ chromePath: process.execPath, forceCheck: true, probe: () => badProbe }),
      (err) => err.code === 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED' && err.details === badProbe && /gui\/\$uid/.test(err.message),
    );
  }
  assert.deepEqual(
    guard.assertMacosAquaKeychainSession({ chromePath: process.execPath, forceCheck: true, probe: () => okRes }),
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
  const disableArg = seenArgs.find((a) => a.startsWith('--disable-features='));
  assert.ok(disableArg, `expected --disable-features= in ${JSON.stringify(seenArgs)}`);
  for (const feat of launcher.MAC_V10_KEYCHAIN_SHIELD_FEATURES) {
    assert.ok(disableArg.includes(feat), `expected ${feat} in ${disableArg}`);
  }
});
