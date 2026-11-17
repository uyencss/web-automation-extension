import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { exportLocalCookies } from '../../lib/local-cookie-reader.mjs';
import { handleExport } from '../../lib/cli/commands/cookies-export.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = require(path.join(ROOT, 'chrome-launcher'));

function tempRoot(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'webmcp-phase1-test-'));
  if (t) {
    t.after(() => {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    });
  }
  return dir;
}

function fakeExtensionDir(root) {
  const dir = path.join(root, 'extension');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('mergeChromeLaunchArgs and mergeChromiumFeatureFlags deduplicate features with enable-over-disable precedence', () => {
  assert.equal(typeof launcher.mergeChromiumFeatureFlags, 'function');

  const merged = launcher.mergeChromiumFeatureFlags([
    '--disable-field-trial-config',
    '--disable-field-trial-config',
    '--disable-features=DeviceBoundSessions,BoundSessionCredentialsKillSwitch,FlashDeprecationWarning',
    '--enable-features=BoundSessionCredentialsKillSwitch,CustomFlag:param/1',
    '--disable-features=CustomFlag,AnotherFeat',
    '--enable-blink-features=FeatA',
    '--disable-blink-features=FeatA,FeatB',
  ]);

  assert.equal(merged.filter((a) => a === '--disable-field-trial-config').length, 1);

  const enableArg = merged.find((a) => a.startsWith('--enable-features='));
  const disableArg = merged.find((a) => a.startsWith('--disable-features='));
  assert.ok(enableArg);
  assert.ok(disableArg);

  const enabled = enableArg.slice('--enable-features='.length).split(',');
  const disabled = disableArg.slice('--disable-features='.length).split(',');
  assert.ok(enabled.includes('BoundSessionCredentialsKillSwitch'));
  assert.ok(enabled.includes('CustomFlag:param/1'));
  assert.equal(disabled.includes('BoundSessionCredentialsKillSwitch'), false);
  assert.equal(disabled.includes('CustomFlag'), false);
  assert.ok(disabled.includes('DeviceBoundSessions'));
  assert.ok(disabled.includes('AnotherFeat'));

  const enableBlink = merged.find((a) => a.startsWith('--enable-blink-features='));
  const disableBlink = merged.find((a) => a.startsWith('--disable-blink-features='));
  assert.equal(enableBlink, '--enable-blink-features=FeatA');
  assert.equal(disableBlink, '--disable-blink-features=FeatB');
});

test('launchChrome injects DBSC KillSwitch + session-shield flags for managed profiles and skips them for existing profiles', async (t) => {
  const root = tempRoot(t);
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const extensionPath = fakeExtensionDir(root);
  const sessionsFile = path.join(root, 'sessions.json');

  const resManaged = await launcher.launchChrome({
    mode: 'managed',
    newProfileName: 'dbsc-shield',
    chromePath: process.execPath,
    extensionPath,
    managedProfilesDir,
    sessionsFile,
    extraArgs: ['--enable-features=UserFeature', '--disable-features=BoundSessionCredentialsKillSwitch,UserDisabled'],
    dryRun: true,
  });

  assert.equal(resManaged.ok, true);
  assert.ok(resManaged.args.includes('--disable-field-trial-config'));
  const enableArg = resManaged.args.find((a) => a.startsWith('--enable-features='));
  const disableArg = resManaged.args.find((a) => a.startsWith('--disable-features='));
  assert.ok(enableArg.includes('BoundSessionCredentialsKillSwitch'));
  assert.ok(enableArg.includes('UserFeature'));
  assert.ok(disableArg.includes('DeviceBoundSessions'));
  assert.ok(disableArg.includes('EnableBoundSessionCredentials'));
  assert.ok(disableArg.includes('UserDisabled'));
  assert.equal(disableArg.slice('--disable-features='.length).split(',').includes('BoundSessionCredentialsKillSwitch'), false);

  const existingDir = path.join(root, 'existing-chrome');
  mkdirSync(path.join(existingDir, 'Default'), { recursive: true });
  const resExisting = await launcher.launchChrome({
    mode: 'existing',
    profile: { kind: 'existing', userDataDir: existingDir, profileDir: 'Default' },
    chromePath: process.execPath,
    extensionPath,
    sessionsFile,
    dryRun: true,
  });
  assert.equal(resExisting.args.includes('--disable-field-trial-config'), false);
});

test('launchChrome throws ERR_FORBIDDEN_MOCK_KEYCHAIN for --use-mock-keychain and --password-store=basic on managed profiles', async (t) => {
  const root = tempRoot(t);
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const extensionPath = fakeExtensionDir(root);
  const sessionsFile = path.join(root, 'sessions.json');

  for (const badArgs of [
    ['--use-mock-keychain'],
    ['--password-store=basic'],
    ['--password-store', 'basic'],
  ]) {
    await assert.rejects(
      () => launcher.launchChrome({
        mode: 'managed',
        newProfileName: 'forbidden-test',
        chromePath: process.execPath,
        extensionPath,
        managedProfilesDir,
        sessionsFile,
        extraArgs: badArgs,
        dryRun: true,
      }),
      (err) => {
        assert.equal(err.code, 'ERR_FORBIDDEN_MOCK_KEYCHAIN');
        return true;
      }
    );
  }
});

test('LOCK_FILES includes lockfile and isProfileLocked detects lockfile while cleaning stale local locks', (t) => {
  const root = tempRoot(t);
  assert.ok(launcher.LOCK_FILES.includes('lockfile'));

  const udLockfile = path.join(root, 'prof-lockfile');
  mkdirSync(udLockfile, { recursive: true });
  writeFileSync(path.join(udLockfile, 'lockfile'), '');
  assert.equal(launcher.isProfileLocked(udLockfile), true);
  launcher.cleanStaleLocks(udLockfile);
  assert.equal(existsSync(path.join(udLockfile, 'lockfile')), false);
  assert.equal(launcher.isProfileLocked(udLockfile), false);

  const udStale = path.join(root, 'prof-stale');
  mkdirSync(udStale, { recursive: true });
  symlinkSync(`${hostname()}-99999999`, path.join(udStale, 'SingletonLock'));
  assert.equal(launcher.isProfileLocked(udStale), false);
  assert.equal(existsSync(path.join(udStale, 'SingletonLock')), false);
});

test('launchChrome + closeChrome manage sessionDirty, lastLaunchedAt, lastClosedAt, and sessionVersion', async (t) => {
  const root = tempRoot(t);
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const extensionPath = fakeExtensionDir(root);
  const sessionsFile = path.join(root, 'sessions.json');

  const sleeperBin = path.join(root, 'fake-chrome-sleeper.sh');
  writeFileSync(
    sleeperBin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 130.0.0.0"; exit 0; fi\nsleep 30 &\nwait\n`
  );
  chmodSync(sleeperBin, 0o755);

  const launchRes = await launcher.launchChrome({
    mode: 'managed',
    newProfileName: 'lifecycle-prof',
    chromePath: sleeperBin,
    extensionPath,
    managedProfilesDir,
    sessionsFile,
  });
  assert.equal(launchRes.ok, true);
  assert.ok(launchRes.pid > 0);

  const metaPath = path.join(launchRes.userDataDir, '.webmcp-meta.json');
  const metaLaunched = JSON.parse(readFileSync(metaPath, 'utf8'));
  assert.equal(metaLaunched.sessionDirty, true);
  assert.ok(typeof metaLaunched.lastLaunchedAt === 'string' && metaLaunched.lastLaunchedAt.length > 0);

  const closeRes = await launcher.closeChrome({
    profileId: 'managed:lifecycle-prof',
    sessionsFile,
    managedProfilesDir,
    killTimeoutMs: 1000,
  });
  assert.equal(closeRes.ok, true);
  assert.equal(closeRes.closedCount, 1);

  const metaClosed = JSON.parse(readFileSync(metaPath, 'utf8'));
  assert.equal(metaClosed.sessionDirty, false);
  assert.ok(typeof metaClosed.lastClosedAt === 'string' && metaClosed.lastClosedAt.length > 0);
  assert.equal(metaClosed.sessionVersion, 1);
});

test('forkExistingProfile blocks Brave, Edge, CocCoc, and Chromium unless allowCrossBrowserFork is true', (t) => {
  const root = tempRoot(t);
  const managedProfilesDir = path.join(root, 'managed-profiles');

  const cases = [
    { id: 'Brave:Default', browser: 'Brave', dirName: 'BraveSoftware/Brave-Browser' },
    { id: 'Edge:Default', browser: 'Edge', dirName: 'Microsoft Edge' },
    { id: 'CocCoc:Default', browser: 'CocCoc', dirName: 'CocCoc/Browser' },
    { id: 'Chromium:Default', browser: 'Chromium', dirName: 'Chromium' },
    { id: 'Custom:Default', browser: 'Chrome', dirName: 'BraveSoftware/Custom' },
  ];

  for (const c of cases) {
    const srcUdd = path.join(root, c.dirName);
    mkdirSync(path.join(srcUdd, 'Default'), { recursive: true });
    writeFileSync(path.join(srcUdd, 'Default', 'Preferences'), '{}');

    assert.throws(
      () => launcher.forkExistingProfile(
        { id: c.id, browser: c.browser, userDataDir: srcUdd, profileDir: 'Default' },
        `fork-${c.browser}`,
        { managedProfilesDir }
      ),
      (err) => {
        assert.equal(err.code, 'ERR_UNSUPPORTED_SOURCE_BROWSER_KEYCHAIN');
        return true;
      }
    );
  }

  // Explicit opt-in succeeds
  const edgeUdd = path.join(root, 'Microsoft Edge');
  const allowed = launcher.forkExistingProfile(
    { id: 'Edge:Default', browser: 'Edge', userDataDir: edgeUdd, profileDir: 'Default' },
    'edge-explicit',
    { managedProfilesDir, allowCrossBrowserFork: true }
  );
  assert.equal(allowed.ok, true);
});

test('detoxForkedManagedProfile cleans bucket-8 rows, scrubs gaia/DBSC prefs, writes External Extensions in metaDir mode, and fails closed on busy WAL', async (t) => {
  const root = tempRoot(t);
  const ud = path.join(root, 'detox-phase1');
  const pdir = path.join(ud, 'Profile 4');
  const extId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  mkdirSync(path.join(pdir, 'Network'), { recursive: true });

  writeFileSync(
    path.join(pdir, 'Preferences'),
    JSON.stringify({
      gaia_cookie: { changed_time: 123 },
      bound_session_credentials_bound_session_params: { session_id: 'abc' },
      signin: { allowed: true, bound_session_credentials_enabled: true },
    })
  );
  writeFileSync(
    path.join(pdir, 'Secure Preferences'),
    JSON.stringify({ extensions: { settings: { [extId]: { from_webstore: true, location: 1 } } } })
  );

  const cookiePath = path.join(pdir, 'Network', 'Cookies');
  const db = new DatabaseSync(cookiePath);
  db.exec(`
    CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB);
    INSERT INTO cookies VALUES ('valid_plain', 'abc', X'');
    INSERT INTO cookies VALUES ('valid_enc', '', X'763130');
    INSERT INTO cookies VALUES ('bucket8_corrupt', 'both_present', X'763130');
  `);
  db.close();

  const res = launcher.detoxForkedManagedProfile(ud, 'Profile 4', { metaDir: pdir });
  assert.equal(res.ok, true);
  assert.deepEqual(res.discoveredExtensions, [extId]);

  // External Extensions written even with options.metaDir set
  const extJsonPath = path.join(ud, 'External Extensions', `${extId}.json`);
  assert.equal(existsSync(extJsonPath), true);

  // Bucket-8 row deleted from both Cookies and .cookies-preboot.sqlite
  const dbAfter = new DatabaseSync(cookiePath, { readOnly: true });
  const namesAfter = dbAfter.prepare('SELECT name FROM cookies ORDER BY name').all().map((r) => r.name);
  dbAfter.close();
  assert.deepEqual(namesAfter, ['valid_enc', 'valid_plain']);

  const prebootDb = new DatabaseSync(path.join(pdir, '.cookies-preboot.sqlite'), { readOnly: true });
  const prebootNames = prebootDb.prepare('SELECT name FROM cookies ORDER BY name').all().map((r) => r.name);
  prebootDb.close();
  assert.deepEqual(prebootNames, ['valid_enc', 'valid_plain']);

  // Preferences scrubbed
  const prefs = JSON.parse(readFileSync(path.join(pdir, 'Preferences'), 'utf8'));
  assert.equal(prefs.gaia_cookie, undefined);
  assert.equal(prefs.bound_session_credentials_bound_session_params, undefined);
  assert.deepEqual(prefs.signin, {
    allowed: false,
    allowed_on_next_startup: false,
    bound_session_credentials_enabled: false,
  });

  // writeExternalExtensions: false suppresses External Extensions creation
  const udNoExt = path.join(root, 'detox-no-ext');
  const pNoExt = path.join(udNoExt, 'Default');
  mkdirSync(pNoExt, { recursive: true });
  writeFileSync(path.join(pNoExt, 'Preferences'), '{}');
  writeFileSync(
    path.join(pNoExt, 'Secure Preferences'),
    JSON.stringify({ extensions: { settings: { [extId]: { from_webstore: true, location: 1 } } } })
  );
  launcher.detoxForkedManagedProfile(udNoExt, 'Default', { metaDir: pNoExt, writeExternalExtensions: false });
  assert.equal(existsSync(path.join(udNoExt, 'External Extensions')), false);

  // Busy WAL checkpoint throws SQLITE_WAL_BUSY (active reader pins older WAL snapshot)
  const udBusy = path.join(root, 'detox-wal-busy');
  const pBusy = path.join(udBusy, 'Default');
  mkdirSync(pBusy, { recursive: true });
  writeFileSync(path.join(pBusy, 'Preferences'), '{}');
  const busyCookiePath = path.join(pBusy, 'Cookies');
  const busyInit = new DatabaseSync(busyCookiePath);
  busyInit.exec("PRAGMA journal_mode=WAL; CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB); INSERT INTO cookies VALUES ('a', '1', X'');");
  busyInit.close();

  const locker = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(${JSON.stringify(busyCookiePath)});
       db.exec('BEGIN; SELECT * FROM cookies;');
       process.stdout.write('READ_LOCKED\\n');
       setTimeout(() => process.exit(0), 10000);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  t.after(() => { try { locker.kill('SIGKILL'); } catch {} });

  await new Promise((resolve, reject) => {
    locker.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('READ_LOCKED')) resolve();
    });
    locker.on('error', reject);
  });

  // Write a newer WAL frame while reader pins the older snapshot
  const busyWriter = new DatabaseSync(busyCookiePath);
  busyWriter.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO cookies VALUES ('b', '2', X'');");
  busyWriter.close();

  assert.throws(
    () => launcher.detoxForkedManagedProfile(udBusy, 'Default'),
    /SQLITE_WAL_BUSY/
  );
  locker.kill('SIGKILL');
});

test('exportLocalCookies and handleExport preserve sameSite=undefined for samesite=-1 in standard format while playwright defaults to Lax', async (t) => {
  const root = tempRoot(t);
  const dbPath = path.join(root, 'Default', 'Network', 'Cookies');
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('version', '24');
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL,
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL,
      has_expires INTEGER NOT NULL,
      is_persistent INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL,
      source_port INTEGER NOT NULL,
      last_update_utc INTEGER NOT NULL,
      source_type INTEGER NOT NULL,
      has_cross_site_ancestor INTEGER NOT NULL
    );
    INSERT INTO cookies VALUES (
      13300000000000000, '.example.com', '', 'unspec_cookie', 'val1', X'',
      '/', 0, 1, 1, 13300000000000000, 0, 1, 1, -1, 2, 443, 13300000000000000, 0, 0
    );
  `);
  db.close();

  const profile = { id: 'Chrome:Default', userDataDir: root, profileDir: 'Default' };

  const stdRes = exportLocalCookies(profile, {
    dbPathOverride: dbPath,
    format: 'standard',
    checkProcess: false,
  });
  assert.equal(stdRes.exportedCount, 1);
  assert.equal(stdRes.data[0].sameSite, undefined);

  const pwRes = exportLocalCookies(profile, {
    dbPathOverride: dbPath,
    format: 'playwright',
    checkProcess: false,
  });
  assert.equal(pwRes.exportedCount, 1);
  assert.equal(pwRes.data.cookies[0].sameSite, 'Lax');

  const throwKeychain = () => {
    const err = new Error('macOS keychain denied');
    err.code = 'KEYCHAIN_DENIED';
    throw err;
  };
  const directCdpExportFn = async () => [
    { name: 'c1', value: 'v1', domain: '.example.com', path: '/', sameSite: undefined },
  ];

  const cliStd = await handleExport(
    { profileId: 'Chrome:Default', allowOnline: true, format: 'standard' },
    {
      profileResolver: () => profile,
      cookieExporter: throwKeychain,
      gatewayHealthLookup: async () => ({ profileDetails: [] }),
      directCdpExportFn,
    }
  );
  assert.equal(cliStd.data[0].sameSite, undefined);

  const cliPw = await handleExport(
    { profileId: 'Chrome:Default', allowOnline: true, format: 'playwright' },
    {
      profileResolver: () => profile,
      cookieExporter: throwKeychain,
      gatewayHealthLookup: async () => ({ profileDetails: [] }),
      directCdpExportFn,
    }
  );
  assert.equal(cliPw.data.cookies[0].sameSite, 'Lax');
});
