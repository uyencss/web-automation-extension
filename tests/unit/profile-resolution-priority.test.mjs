import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp-browser.mjs');
const launcher = require(path.join(ROOT, 'chrome-launcher'));
const DESKTOP_PROFILES_SERVICE_PATH = path.resolve(ROOT, '..', '..', 'apps', 'webmcp-desktop-app', 'src', 'main', 'services', 'profiles-service.js');

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'webmcp-profile-prio-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const managedProfilesDir = path.join(root, 'managed-profiles');
  const chromeUserDataDir = path.join(root, 'chrome-user-data');
  mkdirSync(managedProfilesDir, { recursive: true });
  mkdirSync(chromeUserDataDir, { recursive: true });

  return {
    root,
    managedProfilesDir,
    chromeUserDataDir,
    chromeUserDataDirs: [['Chrome', chromeUserDataDir]],
  };
}

function addManagedProfile(managedProfilesDir, slug, meta = {}, prefs = null) {
  const dir = path.join(managedProfilesDir, slug);
  const profileDir = meta.profileDir || 'Default';
  mkdirSync(path.join(dir, profileDir), { recursive: true });
  writeFileSync(
    path.join(dir, '.webmcp-meta.json'),
    JSON.stringify({ name: slug, profileDir, createdAt: Date.now(), ...meta }, null, 2),
  );
  if (prefs) {
    writeFileSync(path.join(dir, profileDir, 'Preferences'), JSON.stringify(prefs, null, 2));
  }
  return dir;
}

function writeChromeUserData(chromeUserDataDir, profiles) {
  const infoCache = {};
  for (const p of profiles) {
    const dir = p.profileDir;
    const subDir = path.join(chromeUserDataDir, dir);
    mkdirSync(subDir, { recursive: true });
    infoCache[dir] = {
      name: p.name || dir,
      ...(p.email ? { user_name: p.email } : {}),
      ...(p.gaiaName ? { gaia_name: p.gaiaName } : {}),
      ...(typeof p.lastUsed === 'number' ? { active_time: p.lastUsed } : {}),
    };
    if (p.email || p.gaiaName) {
      writeFileSync(
        path.join(subDir, 'Preferences'),
        JSON.stringify({
          account_info: [
            {
              ...(p.email ? { email: p.email } : {}),
              ...(p.gaiaName ? { full_name: p.gaiaName } : {}),
            },
          ],
        }, null, 2),
      );
    }
  }
  writeFileSync(
    path.join(chromeUserDataDir, 'Local State'),
    JSON.stringify({ profile: { info_cache: infoCache } }, null, 2),
  );
}

function runCliLaunch(args, { root, chromeUserDataDir, cwd = ROOT }) {
  return spawnSync(process.execPath, [BIN, 'launch', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_HOME: root,
      WEBMCP_DATA_DIR: root,
      WEBMCP_CHROME_USER_DATA_DIR: chromeUserDataDir,
      WEBMCP_CHROME_BINARY: process.execPath,
    },
  });
}

test('1. Tier-1 Managed wins over Chrome User Data on email, local-part, name, gaiaName, and profileDir', (t) => {
  const fx = createFixture(t);
  addManagedProfile(fx.managedProfilesDir, 'shared-managed', {
    name: 'Shared Creator',
    email: 'shared.user@gmail.com',
    gaiaName: 'Shared Gaia',
    profileDir: 'Profile 10',
  });
  writeChromeUserData(fx.chromeUserDataDir, [
    {
      profileDir: 'Profile 10',
      name: 'Shared Creator',
      email: 'shared.user@gmail.com',
      gaiaName: 'Shared Gaia',
    },
  ]);

  const opts = {
    managedProfilesDir: fx.managedProfilesDir,
    chromeUserDataDirs: fx.chromeUserDataDirs,
  };

  for (const query of ['shared.user@gmail.com', 'shared.user', 'Shared Creator', 'Shared Gaia', 'Profile 10']) {
    const resolved = launcher.findProfileById(query, opts);
    assert.ok(resolved, `expected match for "${query}"`);
    assert.equal(resolved.id, 'managed:shared-managed', `expected managed match for "${query}"`);
    assert.equal(resolved.kind, 'managed');

    const cliByFlag = runCliLaunch(['--profile-id', query, '--dry-run', '--json'], fx);
    assert.equal(cliByFlag.status, 0, cliByFlag.stderr);
    const payloadFlag = JSON.parse(cliByFlag.stdout);
    assert.equal(payloadFlag.mode, 'managed');
    assert.equal(payloadFlag.userDataDir, path.join(fx.managedProfilesDir, 'shared-managed'));

    const cliPositional = runCliLaunch([query, '--dry-run', '--json'], fx);
    assert.equal(cliPositional.status, 0, cliPositional.stderr);
    const payloadPos = JSON.parse(cliPositional.stdout);
    assert.equal(payloadPos.mode, 'managed');
    assert.equal(payloadPos.userDataDir, path.join(fx.managedProfilesDir, 'shared-managed'));
  }
});

test('2. Unprefixed query falls back to Chrome User Data by name, email, local-part, and profileDir', (t) => {
  const fx = createFixture(t);
  addManagedProfile(fx.managedProfilesDir, 'unrelated-bot', {
    name: 'Unrelated Bot',
    email: 'other@example.com',
    profileDir: 'Default',
  });
  writeChromeUserData(fx.chromeUserDataDir, [
    {
      profileDir: 'Profile 7',
      name: 'Channel Chrome Seven',
      email: 'alice.creator@gmail.com',
      gaiaName: 'Alice Creator',
    },
  ]);

  const opts = {
    managedProfilesDir: fx.managedProfilesDir,
    chromeUserDataDirs: fx.chromeUserDataDirs,
  };

  for (const query of ['Channel Chrome Seven', 'Alice Creator', 'alice.creator@gmail.com', 'alice.creator', 'Profile 7']) {
    const resolved = launcher.findProfileById(query, opts);
    assert.ok(resolved, `expected Chrome fallback for "${query}"`);
    assert.equal(resolved.id, 'Chrome:Profile 7');
    assert.equal(resolved.kind, 'existing');
    assert.equal(resolved.userDataDir, fx.chromeUserDataDir);
    assert.equal(resolved.profileDir, 'Profile 7');
  }

  // Prefer Chrome over Edge when both share the same profileDir; throw AMBIGUOUS_PROFILE when Chrome is absent
  const edgeUserDataDir = path.join(fx.root, 'edge-user-data');
  const chromiumUserDataDir = path.join(fx.root, 'chromium-user-data');
  writeChromeUserData(edgeUserDataDir, [{ profileDir: 'Profile 7', name: 'Edge Seven', email: 'edge@example.com' }]);
  writeChromeUserData(chromiumUserDataDir, [{ profileDir: 'Profile 8', name: 'Chromium Eight', email: 'cr@example.com' }]);
  writeChromeUserData(edgeUserDataDir, [
    { profileDir: 'Profile 7', name: 'Edge Seven', email: 'edge@example.com' },
    { profileDir: 'Profile 8', name: 'Edge Eight', email: 'edge8@example.com' },
  ]);

  const multiMatches = launcher.findExistingProfilesMatching('Profile 7', [
    ...launcher.readBrowserProfiles('Chrome', fx.chromeUserDataDir),
    ...launcher.readBrowserProfiles('Edge', edgeUserDataDir),
  ]);
  assert.equal(multiMatches.length, 1);
  assert.equal(multiMatches[0].id, 'Chrome:Profile 7');

  assert.throws(
    () => launcher.findProfileById('Profile 8', {
      managedProfilesDir: fx.managedProfilesDir,
      chromeUserDataDirs: [
        ['Chromium', chromiumUserDataDir],
        ['Edge', edgeUserDataDir],
      ],
    }),
    (err) => err.code === 'AMBIGUOUS_PROFILE' && /Chromium:Profile 8/.test(err.message) && /Edge:Profile 8/.test(err.message),
  );
});

test('3. Explicit Chrome:Profile 10 resolves to existing Chrome even when Managed has profileDir Profile 10', (t) => {
  const fx = createFixture(t);
  addManagedProfile(fx.managedProfilesDir, 'scum-managed', {
    name: 'Scum Managed',
    profileDir: 'Profile 10',
  });
  writeChromeUserData(fx.chromeUserDataDir, [
    {
      profileDir: 'Profile 10',
      name: 'System Chrome Ten',
      email: 'sys10@gmail.com',
    },
  ]);

  const resolved = launcher.findProfileById('Chrome:Profile 10', {
    managedProfilesDir: fx.managedProfilesDir,
    chromeUserDataDirs: fx.chromeUserDataDirs,
  });
  assert.ok(resolved);
  assert.equal(resolved.id, 'Chrome:Profile 10');
  assert.equal(resolved.kind, 'existing');
  assert.equal(resolved.userDataDir, fx.chromeUserDataDir);

  const cliRes = runCliLaunch(['--profile-id', 'Chrome:Profile 10', '--dry-run', '--json'], fx);
  assert.equal(cliRes.status, 0, cliRes.stderr);
  const payload = JSON.parse(cliRes.stdout);
  assert.equal(payload.mode, 'existing');
  assert.equal(payload.userDataDir, fx.chromeUserDataDir);
  assert.equal(payload.profileDir, 'Profile 10');
});

test('4. Explicit managed:missing returns null / CLI exit 1 without falling back to Chrome or creating a directory', (t) => {
  const fx = createFixture(t);
  writeChromeUserData(fx.chromeUserDataDir, [
    {
      profileDir: 'missing',
      name: 'missing',
      email: 'missing@gmail.com',
    },
  ]);

  const resolved = launcher.findProfileById('managed:missing', {
    managedProfilesDir: fx.managedProfilesDir,
    chromeUserDataDirs: fx.chromeUserDataDirs,
  });
  assert.equal(resolved, null);

  for (const args of [
    ['--profile-id', 'managed:missing', '--dry-run', '--json'],
    ['managed:missing', '--dry-run', '--json'],
  ]) {
    const res = runCliLaunch(args, fx);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Profile not found: managed:missing/);
    assert.equal(existsSync(path.join(fx.managedProfilesDir, 'missing')), false);
  }
});

test('5. Ambiguous managed profiles sharing profileDir Default throw AMBIGUOUS_PROFILE instead of falling back to Chrome:Default', (t) => {
  const fx = createFixture(t);
  addManagedProfile(fx.managedProfilesDir, 'alpha-one', {
    name: 'Alpha One',
    profileDir: 'Default',
  });
  addManagedProfile(fx.managedProfilesDir, 'beta-two', {
    name: 'Beta Two',
    profileDir: 'Default',
  });
  writeChromeUserData(fx.chromeUserDataDir, [
    {
      profileDir: 'Default',
      name: 'Default Chrome',
      email: 'default@gmail.com',
    },
  ]);

  assert.throws(
    () => launcher.findProfileById('Default', {
      managedProfilesDir: fx.managedProfilesDir,
      chromeUserDataDirs: fx.chromeUserDataDirs,
    }),
    (err) => (
      err.code === 'AMBIGUOUS_PROFILE' &&
      /managed:alpha-one/.test(err.message) &&
      /managed:beta-two/.test(err.message) &&
      !/Chrome:Default/.test(err.message)
    ),
  );

  const cliRes = runCliLaunch(['Default', '--dry-run', '--json'], fx);
  assert.equal(cliRes.status, 1);
  assert.match(cliRes.stderr, /\[GUARDRAIL BLOCKED\].*Ambiguous managed profile name/);
});

test('6. CLI positional query and --name resolve Managed first then Chrome User Data without creating junk managed dirs', (t) => {
  const fx = createFixture(t);
  addManagedProfile(fx.managedProfilesDir, 'my-channel', {
    name: 'My Channel',
    email: 'channel@gmail.com',
    profileDir: 'Profile 3',
  });
  writeChromeUserData(fx.chromeUserDataDir, [
    {
      profileDir: 'Profile 3',
      name: 'System Channel',
      email: 'channel@gmail.com',
    },
    {
      profileDir: 'Profile 12',
      name: 'Only In Chrome',
      email: 'chrome.only@gmail.com',
    },
  ]);

  // Managed wins for overlapping query via positional and --name
  const resManagedPos = runCliLaunch(['My Channel', '--dry-run', '--json'], fx);
  assert.equal(resManagedPos.status, 0, resManagedPos.stderr);
  const payloadManagedPos = JSON.parse(resManagedPos.stdout);
  assert.equal(payloadManagedPos.mode, 'managed');
  assert.equal(payloadManagedPos.userDataDir, path.join(fx.managedProfilesDir, 'my-channel'));

  // Chrome User Data fallback via positional query and --name (no junk folder created in managed-profiles)
  const resChromePos = runCliLaunch(['chrome.only', '--dry-run', '--json'], fx);
  assert.equal(resChromePos.status, 0, resChromePos.stderr);
  const payloadChromePos = JSON.parse(resChromePos.stdout);
  assert.equal(payloadChromePos.mode, 'existing');
  assert.equal(payloadChromePos.userDataDir, fx.chromeUserDataDir);
  assert.equal(payloadChromePos.profileDir, 'Profile 12');

  const resChromeName = runCliLaunch(['--name', 'Only In Chrome', '--dry-run', '--json'], fx);
  assert.equal(resChromeName.status, 0, resChromeName.stderr);
  const payloadChromeName = JSON.parse(resChromeName.stdout);
  assert.equal(payloadChromeName.mode, 'existing');
  assert.equal(payloadChromeName.userDataDir, fx.chromeUserDataDir);
  assert.equal(payloadChromeName.profileDir, 'Profile 12');

  assert.deepEqual(readdirSync(fx.managedProfilesDir), ['my-channel']);
});

test('7. Desktop app resolveProfileForAction respects 2-tier priority, surfaces AMBIGUOUS_PROFILE, and blocks managed: fallback to systemChromeDir', { skip: !existsSync(DESKTOP_PROFILES_SERVICE_PATH) }, async (t) => {
  const profilesService = require(DESKTOP_PROFILES_SERVICE_PATH);
  const fx = createFixture(t);
  addManagedProfile(fx.managedProfilesDir, 'dup-a', { name: 'Dup Alpha', profileDir: 'Default' });
  addManagedProfile(fx.managedProfilesDir, 'dup-b', { name: 'Dup Beta', profileDir: 'Default' });
  addManagedProfile(fx.managedProfilesDir, 'only-managed', { name: 'Only Managed', email: 'm@example.com' });
  writeChromeUserData(fx.chromeUserDataDir, [
    { profileDir: 'Default', name: 'Sys Default', email: 'sys@example.com' },
    { profileDir: 'Profile 5', name: 'Sys Five', email: 'sys5@example.com' },
    { profileDir: 'only-managed', name: 'Sys Fake', email: 'fake@example.com' },
  ]);

  await assert.rejects(
    () => profilesService.launchProfile({
      id: 'Default',
      managedProfilesDir: fx.managedProfilesDir,
      systemChromeDir: fx.chromeUserDataDir,
      sessionsFile: path.join(fx.root, 'sessions.json'),
      dryRun: true,
    }),
    (err) => err.code === 'AMBIGUOUS_PROFILE',
  );

  // Explicit managed:missing must NOT fall back to systemChromeDir/missing
  mkdirSync(path.join(fx.chromeUserDataDir, 'missing'), { recursive: true });
  const missingManaged = await profilesService.launchProfile({
    id: 'managed:missing',
    managedProfilesDir: fx.managedProfilesDir,
    systemChromeDir: fx.chromeUserDataDir,
    sessionsFile: path.join(fx.root, 'sessions.json'),
    dryRun: true,
  });
  assert.equal(missingManaged.ok, false);
  assert.equal(missingManaged.code, 'PROFILE_NOT_FOUND');

  // Unprefixed Chrome query falls back to systemChromeDir
  const chromeFallback = await profilesService.launchProfile({
    id: 'sys5',
    managedProfilesDir: fx.managedProfilesDir,
    systemChromeDir: fx.chromeUserDataDir,
    sessionsFile: path.join(fx.root, 'sessions.json'),
    chromePath: process.execPath,
    dryRun: true,
  });
  assert.equal(chromeFallback.ok, true);
  assert.equal(chromeFallback.kind, 'chrome');
  assert.equal(chromeFallback.userDataDir, fx.chromeUserDataDir);
  assert.equal(chromeFallback.profileDir, 'Profile 5');
});
