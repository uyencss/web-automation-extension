import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, chmodSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp-browser.mjs');
const launcher = require(path.join(ROOT, 'chrome-launcher'));

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'webmcp-launcher-test-'));
}

function fakeExtensionDir(root) {
  const dir = path.join(root, 'extension');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('slugify creates stable profile slugs', () => {
  assert.equal(launcher.slugify('Scraping Bot! 2026'), 'scraping-bot-2026');
  assert.equal(launcher.slugify('***'), 'profile');
});

test('createManagedProfile writes metadata under the configured directory', () => {
  const root = tempRoot();
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const userDataDir = launcher.createManagedProfile('Agent Profile', { managedProfilesDir });

  assert.equal(path.basename(userDataDir), 'agent-profile');
  assert.equal(existsSync(path.join(userDataDir, '.webmcp-meta.json')), true);

  const meta = JSON.parse(readFileSync(path.join(userDataDir, '.webmcp-meta.json'), 'utf8'));
  assert.equal(meta.name, 'Agent Profile');
});

test('sessions round-trip and prune dead pids', () => {
  const root = tempRoot();
  const sessionsFile = path.join(root, 'sessions.json');
  const userDataDir = path.join(root, 'profile');

  launcher.saveSessions({
    version: 1,
    managedSessions: {
      [userDataDir]: { pid: -1, startedAt: '2026-07-02T00:00:00.000Z' },
    },
    gateway: { pid: -1, url: 'http://localhost:7865', startedAt: '2026-07-02T00:00:00.000Z' },
  }, sessionsFile);

  const pruned = launcher.pruneDeadSessions(sessionsFile);
  assert.deepEqual(pruned.managedSessions, {});
  assert.equal(pruned.gateway, null);

  launcher.rememberManagedSession(userDataDir, process.pid, sessionsFile);
  assert.equal(launcher.hasLiveManagedSession(userDataDir, sessionsFile), true);
});

test('launchChrome dry-run returns Chrome args without spawning', async () => {
  const root = tempRoot();
  const extensionPath = fakeExtensionDir(root);
  const managedProfilesDir = path.join(root, 'managed-profiles');

  const result = await launcher.launchChrome({
    mode: 'managed',
    newProfileName: 'Dry Run',
    chromePath: process.execPath,
    extensionPath,
    managedProfilesDir,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.pid, null);
  assert.equal(result.userDataDir, path.join(managedProfilesDir, 'dry-run'));
  assert.ok(result.args.includes(`--user-data-dir=${result.userDataDir}`));
  assert.ok(result.args.includes(`--load-extension=${extensionPath}`));
  assert.ok(
    result.args.some((a) => a.startsWith('--disable-blink-features=') && a.slice('--disable-blink-features='.length).split(',').includes('AutomationControlled')),
    'default Chrome launch args must include --disable-blink-features=AutomationControlled',
  );

  const dedupRes = await launcher.launchChrome({
    mode: 'managed',
    newProfileName: 'Dry Run Dedup',
    chromePath: process.execPath,
    extensionPath,
    managedProfilesDir,
    extraArgs: ['--disable-blink-features=AutomationControlled,CustomBlinkFeat'],
    dryRun: true,
  });
  const blinkArgs = dedupRes.args.filter((a) => a.startsWith('--disable-blink-features='));
  assert.equal(blinkArgs.length, 1);
  assert.deepEqual(blinkArgs[0].slice('--disable-blink-features='.length).split(','), ['AutomationControlled', 'CustomBlinkFeat']);
});

test('detectChromeChannel classifies builds from path and version string', () => {
  assert.equal(launcher.detectChromeChannel('/Applications/Google Chrome.app/MacOS/Google Chrome', 'Google Chrome 149.0.7827.201'), 'stable');
  assert.equal(launcher.detectChromeChannel('/x/Google Chrome for Testing', 'Google Chrome for Testing 131.0'), 'testing');
  assert.equal(launcher.detectChromeChannel('/x/Google Chrome Canary', 'Google Chrome Canary 152.0'), 'canary');
  assert.equal(launcher.detectChromeChannel('/usr/bin/chromium', 'Chromium 140.0'), 'chromium');
  assert.equal(launcher.detectChromeChannel('/usr/bin/some-node', ''), 'unknown');
});

test('loadExtensionSupported reflects the Chrome M137 drop of --load-extension', () => {
  assert.equal(launcher.loadExtensionSupported({ channel: 'stable', major: 137 }), false);
  assert.equal(launcher.loadExtensionSupported({ channel: 'stable', major: 149 }), false);
  assert.equal(launcher.loadExtensionSupported({ channel: 'beta', major: 140 }), false);
  assert.equal(launcher.loadExtensionSupported({ channel: 'stable', major: 136 }), true);
  assert.equal(launcher.loadExtensionSupported({ channel: 'testing', major: 149 }), true);
  assert.equal(launcher.loadExtensionSupported({ channel: 'chromium', major: 149 }), true);
  assert.equal(launcher.loadExtensionSupported({ channel: 'canary', major: 152 }), true);
  // Unknown builds and undetectable versions are not blocked.
  assert.equal(launcher.loadExtensionSupported({ channel: 'unknown', major: null }), true);
  assert.equal(launcher.loadExtensionSupported(null), true);
});

test('published extension metadata is exported for install guidance', () => {
  assert.equal(launcher.WEBMCP_EXTENSION_ID, 'lbodkmkjbcemodklopcfdmpjomdoapae');
  assert.equal(
    launcher.WEBMCP_EXTENSION_STORE_URL,
    'https://chromewebstore.google.com/detail/webmcp-tools-provider/lbodkmkjbcemodklopcfdmpjomdoapae',
  );
});

test('launchChrome annotates the result with Chrome build + extension loadability', async () => {
  const root = tempRoot();
  const extensionPath = fakeExtensionDir(root);
  const managedProfilesDir = path.join(root, 'managed-profiles');

  const result = await launcher.launchChrome({
    mode: 'managed',
    newProfileName: 'Annotated',
    chromePath: process.execPath,
    extensionPath,
    managedProfilesDir,
    dryRun: true,
  });

  assert.equal(result.extensionPath, extensionPath);
  assert.equal(result.extensionId, launcher.WEBMCP_EXTENSION_ID);
  assert.equal(result.extensionStoreUrl, launcher.WEBMCP_EXTENSION_STORE_URL);
  assert.equal(typeof result.chromeChannel, 'string');
  assert.equal(typeof result.extensionLoadable, 'boolean');
  // process.execPath is not stable Chrome >= 137, so nothing is blocked here.
  assert.equal(result.extensionLoadable, true);
  assert.equal(result.warning, undefined);
});

test('existing locked profile reports needsRelaunch unless relaunch is explicit', async () => {
  const root = tempRoot();
  const extensionPath = fakeExtensionDir(root);
  const userDataDir = path.join(root, 'real-profile');
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(path.join(userDataDir, 'SingletonLock'), '');

  const result = await launcher.launchChrome({
    mode: 'existing',
    profile: { kind: 'existing', userDataDir, profileDir: 'Default' },
    chromePath: process.execPath,
    extensionPath,
    sessionsFile: path.join(root, 'sessions.json'),
    dryRun: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.needsRelaunch, true);
});

test('webmcp launch --dry-run --json is machine-readable', () => {
  const root = tempRoot();
  const result = spawnSync(process.execPath, [
    BIN,
    'launch',
    '--name',
    'cli smoke',
    '--dry-run',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_CHROME_BINARY: process.execPath,
      WEBMCP_DATA_DIR: root,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.pid, null);
  assert.equal(payload.mode, 'managed');
});

test('webmcp profiles list --json includes managed profiles', () => {
  const root = tempRoot();
  const managedProfile = path.join(root, 'managed-profiles', 'unit-profile');
  mkdirSync(managedProfile, { recursive: true });
  writeFileSync(
    path.join(managedProfile, '.webmcp-meta.json'),
    JSON.stringify({ name: 'Unit Profile', createdAt: 1 }, null, 2),
  );

  const result = spawnSync(process.execPath, [BIN, 'profiles', 'list', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_DATA_DIR: root,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.managed.length, 1);
  assert.equal(payload.managed[0].id, 'managed:unit-profile');
  assert.equal(payload.managed[0].name, 'Unit Profile');
});

test('forkExistingProfile copies profile state, filters cache, and refuses locked profiles', () => {
  const root = tempRoot();
  const srcUserData = path.join(root, 'source-chrome');
  const profileDir = 'Profile 9';
  const srcProfilePath = path.join(srcUserData, profileDir);
  mkdirSync(srcProfilePath, { recursive: true });
  mkdirSync(path.join(srcProfilePath, 'Network'), { recursive: true });
  mkdirSync(path.join(srcProfilePath, 'Cache'), { recursive: true });
  mkdirSync(path.join(srcProfilePath, 'Code Cache', 'js'), { recursive: true });
  mkdirSync(path.join(srcProfilePath, 'GPUCache'), { recursive: true });
  mkdirSync(path.join(srcProfilePath, 'Local Extension Settings', launcher.WEBMCP_EXTENSION_ID), { recursive: true });
  mkdirSync(path.join(srcProfilePath, 'Sync Extension Settings', launcher.WEBMCP_EXTENSION_ID), { recursive: true });
  mkdirSync(path.join(srcProfilePath, 'Local Extension Settings', 'other-ext-id'), { recursive: true });

  writeFileSync(path.join(srcUserData, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }, null, 2));
  writeFileSync(path.join(srcProfilePath, 'Preferences'), JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false } }, null, 2));
  writeFileSync(path.join(srcProfilePath, 'Network', 'Cookies'), 'dummy-cookies-data');
  writeFileSync(path.join(srcProfilePath, 'Cache', 'data_0'), 'cache-data');
  writeFileSync(path.join(srcProfilePath, 'Code Cache', 'js', 'data_1'), 'code-cache-data');
  writeFileSync(path.join(srcProfilePath, 'GPUCache', 'data_2'), 'gpu-cache-data');
  writeFileSync(path.join(srcProfilePath, 'Local Extension Settings', launcher.WEBMCP_EXTENSION_ID, '000003.log'), 'storage-data');
  writeFileSync(path.join(srcProfilePath, 'Sync Extension Settings', launcher.WEBMCP_EXTENSION_ID, '000003.log'), 'sync-data');
  writeFileSync(path.join(srcProfilePath, 'Local Extension Settings', 'other-ext-id', 'settings.json'), '{"ok":true}');

  const managedProfilesDir = path.join(root, 'managed-profiles');
  const srcProfile = {
    id: 'Chrome:Profile 9',
    browser: 'Chrome',
    userDataDir: srcUserData,
    profileDir: 'Profile 9',
  };

  const res = launcher.forkExistingProfile(srcProfile, 'scum', { managedProfilesDir });
  assert.equal(res.ok, true);
  assert.equal(res.id, 'managed:scum');
  assert.equal(res.profileDir, 'Profile 9');
  assert.equal(res.forkedFrom, 'Chrome:Profile 9');

  // Verify Local State and Preferences mutations
  const dstLocalState = JSON.parse(readFileSync(path.join(res.userDataDir, 'Local State'), 'utf8'));
  assert.equal(dstLocalState.profile.last_used, 'Profile 9');

  const dstPrefs = JSON.parse(readFileSync(path.join(res.userDataDir, 'Profile 9', 'Preferences'), 'utf8'));
  assert.equal(dstPrefs.profile.exit_type, 'Normal');
  assert.equal(dstPrefs.profile.exited_cleanly, true);

  // Verify cookies copied
  assert.equal(readFileSync(path.join(res.userDataDir, 'Profile 9', 'Network', 'Cookies'), 'utf8'), 'dummy-cookies-data');

  // Verify caches filtered out
  assert.equal(existsSync(path.join(res.userDataDir, 'Profile 9', 'Cache')), false);
  assert.equal(existsSync(path.join(res.userDataDir, 'Profile 9', 'Code Cache')), false);
  assert.equal(existsSync(path.join(res.userDataDir, 'Profile 9', 'GPUCache')), false);

  // Verify WebMCP extension storage filtered out to prevent profileId UUID collisions
  assert.equal(existsSync(path.join(res.userDataDir, 'Profile 9', 'Local Extension Settings', launcher.WEBMCP_EXTENSION_ID)), false);
  assert.equal(existsSync(path.join(res.userDataDir, 'Profile 9', 'Sync Extension Settings', launcher.WEBMCP_EXTENSION_ID)), false);
  // Verify other extension settings are preserved
  assert.equal(existsSync(path.join(res.userDataDir, 'Profile 9', 'Local Extension Settings', 'other-ext-id', 'settings.json')), true);

  // Verify .webmcp-meta.json
  const meta = JSON.parse(readFileSync(path.join(res.userDataDir, '.webmcp-meta.json'), 'utf8'));
  assert.equal(meta.profileDir, 'Profile 9');
  assert.equal(meta.forkedFrom, 'Chrome:Profile 9');
  assert.equal(meta.fingerprintSeed, undefined);

  // Verify listAllProfiles honors meta.profileDir
  const listed = launcher.listAllProfiles({ managedProfilesDir });
  const scumProfile = listed.managed.find((p) => p.id === 'managed:scum');
  assert.ok(scumProfile);
  assert.equal(scumProfile.profileDir, 'Profile 9');

  // Verify locked source throws
  const lockTarget = `host-${process.pid}`;
  symlinkSync(lockTarget, path.join(srcUserData, 'SingletonLock'));
  assert.throws(
    () => launcher.forkExistingProfile(srcProfile, 'should-fail', { managedProfilesDir }),
    /Source Chrome userDataDir is currently running/
  );
});

test('createManagedProfile generates fingerprintSeed uint32 and launchChrome enforces channel isolation', async () => {
  const root = tempRoot();
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const extensionPath = fakeExtensionDir(root);

  // 1. Check fingerprintSeed generation
  const userDataDir = launcher.createManagedProfile('seeded-test', { managedProfilesDir });
  const meta = JSON.parse(readFileSync(path.join(userDataDir, '.webmcp-meta.json'), 'utf8'));
  assert.equal(typeof meta.fingerprintSeed, 'number');
  assert.ok(meta.fingerprintSeed >= 0 && meta.fingerprintSeed < 0x100000000);

  // 2. Create fake Chromium binary
  const fakeChromium = path.join(root, 'fake-chromium.sh');
  writeFileSync(fakeChromium, `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "Chromium 140.0.0.0"\n  exit 0\nfi\nexit 0\n`);
  chmodSync(fakeChromium, 0o755);

  const resChromium = await launcher.launchChrome({
    mode: 'managed',
    profile: { userDataDir },
    chromePath: fakeChromium,
    extensionPath,
    managedProfilesDir,
    dryRun: true,
  });

  assert.ok(resChromium.args.some((arg) => arg === `--fingerprint=${meta.fingerprintSeed}`));

  // 3. Block forked profile on custom Chromium binary
  meta.forkedFrom = 'Chrome:Profile 9';
  writeFileSync(path.join(userDataDir, '.webmcp-meta.json'), JSON.stringify(meta, null, 2));

  await assert.rejects(
    async () => {
      await launcher.launchChrome({
        mode: 'managed',
        profile: { userDataDir },
        chromePath: fakeChromium,
        extensionPath,
        managedProfilesDir,
        dryRun: true,
      });
    },
    /Refusing to launch a profile forked from native Chrome on a custom Chromium binary/
  );

  // 4. Allowed when allowCrossChannelFork: true
  const resAllowed = await launcher.launchChrome({
    mode: 'managed',
    profile: { userDataDir },
    chromePath: fakeChromium,
    extensionPath,
    managedProfilesDir,
    allowCrossChannelFork: true,
    dryRun: true,
  });
  assert.equal(resAllowed.ok, true);
});

test('closeChrome terminates managed session with SIGTERM and cleans lock files', async () => {
  const root = tempRoot();
  const sessionsFile = path.join(root, 'sessions.json');
  const userDataDir = path.join(root, 'managed-profiles', 'close-target');
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(path.join(userDataDir, '.webmcp-meta.json'), JSON.stringify({ name: 'close-target' }, null, 2));

  // Spawn long-running dummy child process
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  symlinkSync(`host-${child.pid}`, path.join(userDataDir, 'SingletonLock'));

  launcher.saveSessions({
    version: 1,
    managedSessions: {
      [userDataDir]: { pid: child.pid, startedAt: new Date().toISOString() },
    },
    gateway: null,
  }, sessionsFile);

  assert.ok(launcher.isPidAlive(child.pid));
  assert.equal(launcher.readLockPid(userDataDir), child.pid);

  const closeRes = await launcher.closeChrome({
    profileId: 'managed:close-target',
    sessionsFile,
    killTimeoutMs: 1000,
  });

  assert.equal(closeRes.ok, true);
  assert.equal(closeRes.closedCount, 1);

  // Give OS a moment to process termination
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(launcher.isPidAlive(child.pid), false);
  assert.equal(launcher.readLockPid(userDataDir), null);

  const updatedSessions = launcher.loadSessions(sessionsFile);
  assert.equal(updatedSessions.managedSessions[userDataDir], undefined);
});

test('webmcp profiles fork via CLI creates managed fork with metadata', () => {
  const root = tempRoot();
  const managedProfile = path.join(root, 'managed-profiles', 'source-for-cli');
  mkdirSync(path.join(managedProfile, 'Default'), { recursive: true });
  writeFileSync(
    path.join(managedProfile, '.webmcp-meta.json'),
    JSON.stringify({ name: 'Source CLI', createdAt: 1 }, null, 2),
  );
  writeFileSync(
    path.join(managedProfile, 'Default', 'Preferences'),
    JSON.stringify({ profile: { exit_type: 'Normal', exited_cleanly: true } }, null, 2),
  );

  const result = spawnSync(process.execPath, [
    BIN,
    'profiles',
    'fork',
    '--profile-id',
    'managed:source-for-cli',
    '--name',
    'cli-fork-target',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_DATA_DIR: root,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.id, 'managed:cli-fork-target');
  assert.equal(payload.forkedFrom, 'managed:source-for-cli');
  assert.equal(existsSync(path.join(payload.userDataDir, '.webmcp-meta.json')), true);
});

test('webmcp launch --name reuses existing managed profile by display name and blocks rogue profile creation in bound project', () => {
  const root = tempRoot();
  const scumDir = path.join(root, 'managed-profiles', 'scum');
  mkdirSync(path.join(scumDir, 'Profile 9'), { recursive: true });
  writeFileSync(
    path.join(scumDir, '.webmcp-meta.json'),
    JSON.stringify({ name: 'Lười Cày (Scum)', profileDir: 'Profile 9', createdAt: 1 }, null, 2),
  );

  // 1. Launching by Vietnamese display name must reuse existing 'scum' directory and 'Profile 9', NOT create 'l-i-c-y-scum'
  const resReuse = spawnSync(process.execPath, [
    BIN,
    'launch',
    '--name',
    'Lười Cày (Scum)',
    '--dry-run',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_CHROME_BINARY: process.execPath,
      WEBMCP_DATA_DIR: root,
    },
  });

  assert.equal(resReuse.status, 0, resReuse.stderr);
  const payloadReuse = JSON.parse(resReuse.stdout);
  assert.equal(payloadReuse.userDataDir, scumDir);
  assert.equal(payloadReuse.profileDir, 'Profile 9');
  assert.equal(existsSync(path.join(root, 'managed-profiles', 'l-i-c-y-scum')), false);

  // 2. Inside a project directory with config/fb_growth_config.json, launching a rogue unknown profile name without --create is blocked
  const projRoot = path.join(root, 'bound-project');
  mkdirSync(path.join(projRoot, 'config'), { recursive: true });
  writeFileSync(
    path.join(projRoot, 'config', 'fb_growth_config.json'),
    JSON.stringify({
      channel_id: 'scum-story-reup',
      managed_profile_id: 'managed:scum',
      chrome_profile: 'Profile 9',
      channel_display_name: 'Lười Cày (Scum)',
    }, null, 2),
  );

  const resBlocked = spawnSync(process.execPath, [
    BIN,
    'launch',
    '--name',
    'Rogue Blank Profile',
    '--dry-run',
    '--json',
  ], {
    cwd: projRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_CHROME_BINARY: process.execPath,
      WEBMCP_DATA_DIR: root,
    },
  });

  assert.equal(resBlocked.status, 1);
  assert.match(resBlocked.stderr, /\[GUARDRAIL BLOCKED\]/);
});

test('findManagedProfileByNameOrId throws AMBIGUOUS_PROFILE when 2 managed profiles share display name', () => {
  const root = tempRoot();
  const managedProfilesDir = path.join(root, 'managed-profiles');
  mkdirSync(path.join(managedProfilesDir, 'scum-a'), { recursive: true });
  mkdirSync(path.join(managedProfilesDir, 'scum-b'), { recursive: true });
  writeFileSync(
    path.join(managedProfilesDir, 'scum-a', '.webmcp-meta.json'),
    JSON.stringify({ name: 'Lười Cày (Scum)', profileDir: 'Default', createdAt: 1 }),
  );
  writeFileSync(
    path.join(managedProfilesDir, 'scum-b', '.webmcp-meta.json'),
    JSON.stringify({ name: 'Lười Cày (Scum)', profileDir: 'Default', createdAt: 2 }),
  );

  assert.throws(
    () => launcher.findManagedProfileByNameOrId('Lười Cày (Scum)', { managedProfilesDir }),
    (err) => {
      assert.equal(err.code, 'AMBIGUOUS_PROFILE');
      assert.match(err.message, /Ambiguous managed profile name/);
      assert.match(err.message, /managed:scum-a/);
      assert.match(err.message, /managed:scum-b/);
      return true;
    },
  );
});

test('discoverProjectProfileHint finds config from deep subdirectories and blocks rogue launch unless bypassed', () => {
  const root = tempRoot();
  const projRoot = path.join(root, 'my-channel');
  const deepSub = path.join(projRoot, 'output', '2026-10-31', 'runs', 'ep_01');
  mkdirSync(deepSub, { recursive: true });
  mkdirSync(path.join(projRoot, 'config'), { recursive: true });
  mkdirSync(path.join(root, 'managed-profiles', 'scum', 'Profile 9'), { recursive: true });
  writeFileSync(
    path.join(root, 'managed-profiles', 'scum', '.webmcp-meta.json'),
    JSON.stringify({ name: 'Lười Cày (Scum)', profileDir: 'Profile 9', createdAt: 1 }),
  );
  writeFileSync(
    path.join(projRoot, 'config', 'fb_growth_config.json'),
    JSON.stringify({
      channel_id: 'scum-story-reup',
      managed_profile_id: 'managed:scum',
      chrome_profile: 'Profile 9',
    }),
  );

  // 1. Invoked from deep directory: blocked even with --create
  const resBlocked = spawnSync(process.execPath, [
    BIN,
    'launch',
    '--name',
    'Rogue Profile',
    '--create',
    '--dry-run',
  ], {
    cwd: deepSub,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_CHROME_BINARY: process.execPath,
      WEBMCP_DATA_DIR: root,
      WEBMCP_HOME: root,
    },
  });
  assert.equal(resBlocked.status, 1);
  assert.match(resBlocked.stderr, /\[GUARDRAIL BLOCKED\]/);

  // 2. Invoked with WEBMCP_ALLOW_PROFILE_CREATE=1: permitted
  const resPermitted = spawnSync(process.execPath, [
    BIN,
    'launch',
    '--name',
    'Rogue Profile',
    '--dry-run',
    '--json',
  ], {
    cwd: deepSub,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_CHROME_BINARY: process.execPath,
      WEBMCP_DATA_DIR: root,
      WEBMCP_HOME: root,
      WEBMCP_ALLOW_PROFILE_CREATE: '1',
    },
  });
  assert.equal(resPermitted.status, 0, resPermitted.stderr);
});

test('mismatched --profile-id is blocked inside bound project', () => {
  const root = tempRoot();
  const projRoot = path.join(root, 'bound-proj');
  mkdirSync(path.join(projRoot, 'config'), { recursive: true });
  mkdirSync(path.join(root, 'managed-profiles', 'scum', 'Profile 9'), { recursive: true });
  mkdirSync(path.join(root, 'managed-profiles', 'game-di', 'Profile 5'), { recursive: true });
  writeFileSync(
    path.join(root, 'managed-profiles', 'scum', '.webmcp-meta.json'),
    JSON.stringify({ name: 'Lười Cày', profileDir: 'Profile 9', createdAt: 1 }),
  );
  writeFileSync(
    path.join(root, 'managed-profiles', 'game-di', '.webmcp-meta.json'),
    JSON.stringify({ name: 'Game Dị', profileDir: 'Profile 5', createdAt: 2 }),
  );
  writeFileSync(
    path.join(projRoot, 'config', 'fb_growth_config.json'),
    JSON.stringify({
      channel_id: 'scum-story-reup',
      managed_profile_id: 'managed:scum',
      chrome_profile: 'Profile 9',
    }),
  );

  const resMismatched = spawnSync(process.execPath, [
    BIN,
    'launch',
    '--profile-id',
    'managed:game-di',
    '--dry-run',
  ], {
    cwd: projRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_CHROME_BINARY: process.execPath,
      WEBMCP_DATA_DIR: root,
      WEBMCP_HOME: root,
    },
  });
  assert.equal(resMismatched.status, 1);
  assert.match(resMismatched.stderr, /Refusing to launch mismatched --profile-id "managed:game-di"/);
});

test('naked launch fails closed if bound managed profile missing on disk', () => {
  const root = tempRoot();
  const projRoot = path.join(root, 'bound-proj');
  mkdirSync(path.join(projRoot, 'config'), { recursive: true });
  writeFileSync(
    path.join(projRoot, 'config', 'fb_growth_config.json'),
    JSON.stringify({
      channel_id: 'scum-story-reup',
      managed_profile_id: 'managed:scum',
      chrome_profile: 'Profile 9',
    }),
  );

  const resNaked = spawnSync(process.execPath, [
    BIN,
    'launch',
    '--dry-run',
  ], {
    cwd: projRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_CHROME_BINARY: process.execPath,
      WEBMCP_DATA_DIR: root,
      WEBMCP_HOME: root,
    },
  });
  assert.equal(resNaked.status, 1);
  assert.match(resNaked.stderr, /but this managed profile does not exist on disk/);
});

test('naked launch outside project twice reuses webmcp without creating webmcp-2', () => {
  const root = tempRoot();
  const managedProfilesDir = path.join(root, 'managed-profiles');
  mkdirSync(managedProfilesDir, { recursive: true });

  const dir1 = launcher.findExistingManagedProfileDir('webmcp', managedProfilesDir);
  assert.equal(dir1, null);

  const created1 = launcher.createManagedProfile('webmcp', { managedProfilesDir });
  assert.equal(path.basename(created1), 'webmcp');

  const dir2 = launcher.findExistingManagedProfileDir('webmcp', managedProfilesDir);
  assert.equal(dir2, created1);

  // Even if nextManagedProfileDir is queried, findExistingManagedProfileDir protects against webmcp-2
  assert.equal(existsSync(path.join(managedProfilesDir, 'webmcp-2')), false);
});

test('NFD normalization matches NFC name', () => {
  const root = tempRoot();
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const scumDir = path.join(managedProfilesDir, 'scum');
  mkdirSync(scumDir, { recursive: true });
  const nfcName = 'Lười Cày (Scum)'.normalize('NFC');
  writeFileSync(
    path.join(scumDir, '.webmcp-meta.json'),
    JSON.stringify({ name: nfcName, profileDir: 'Profile 9' }),
  );

  const nfdQuery = 'Lười Cày (Scum)'.normalize('NFD');
  const match = launcher.findManagedProfileByNameOrId(nfdQuery, { managedProfilesDir });
  assert.ok(match);
  assert.equal(match.id, 'managed:scum');
});

test('scripts/backup_managed_profiles.sh completes within 3.5s under exclusive SQLite lock (30s) and passes PRAGMA integrity_check', async () => {
  const root = tempRoot();
  const webmcpHome = path.join(root, '.webmcp');
  const scumDir = path.join(webmcpHome, 'managed-profiles', 'scum', 'Profile 9');
  mkdirSync(scumDir, { recursive: true });
  writeFileSync(path.join(webmcpHome, 'managed-profiles', 'scum', '.webmcp-meta.json'), JSON.stringify({ name: 'scum' }));
  writeFileSync(path.join(webmcpHome, 'managed-profiles', 'scum', 'Local State'), '{"test":1}');

  const cookiesDb = path.join(scumDir, 'Cookies');
  // Initialize sqlite db with cookies table
  spawnSync('python3', [
    '-c',
    `import sqlite3; c = sqlite3.connect("${cookiesDb}"); c.execute("CREATE TABLE cookies (name TEXT, value TEXT)"); c.execute("INSERT INTO cookies VALUES ('session', '123')"); c.commit(); c.close()`,
  ]);

  // Hold exclusive lock in background python process for 30s
  const lockProc = spawn('python3', [
    '-c',
    `import sqlite3, time; c = sqlite3.connect("${cookiesDb}"); c.execute("BEGIN EXCLUSIVE"); time.sleep(30)`,
  ]);

  // Give python 200ms to acquire lock
  await new Promise((r) => setTimeout(r, 200));

  const start = Date.now();
  const scriptPath = path.join(ROOT, 'scripts', 'backup_managed_profiles.sh');
  const res = spawnSync(scriptPath, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_HOME: webmcpHome,
    },
  });
  const elapsedMs = Date.now() - start;

  try { lockProc.kill(); } catch {}

  assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
  assert.ok(elapsedMs < 3500, `Backup took too long: ${elapsedMs}ms (expected < 3500ms even with 30s lock)`);

  const today = spawnSync('date', ['+%Y-%m-%d'], { encoding: 'utf8' }).stdout.trim();
  const todayDir = path.join(webmcpHome, 'backups', 'profiles', today);
  const backupCookies = path.join(todayDir, 'scum', 'Profile 9', 'Cookies');
  assert.ok(existsSync(backupCookies), 'Backup Cookies file exists');
  assert.ok(existsSync(path.join(todayDir, '.verified_ok')), '.verified_ok marker exists');

  // Verify file permissions (0600 file, 0700 dir)
  assert.equal(statSync(backupCookies).mode & 0o777, 0o600);
  assert.equal(statSync(todayDir).mode & 0o777, 0o700);

  // Verify PRAGMA integrity_check passes on backup
  const verifyRes = spawnSync('python3', [
    '-c',
    `import sqlite3, sys; c = sqlite3.connect("${backupCookies}"); cur = c.cursor(); cur.execute("PRAGMA integrity_check"); res = cur.fetchone()[0]; sys.exit(0 if res == "ok" else 1)`,
  ]);
  assert.equal(verifyRes.status, 0);
});

test('WEBMCP_ALLOW_PROFILE_CREATE=1 cannot bypass mismatched --profile-id inside bound project', () => {
  const root = tempRoot();
  const projRoot = path.join(root, 'bound-proj');
  mkdirSync(path.join(projRoot, 'config'), { recursive: true });
  mkdirSync(path.join(root, 'managed-profiles', 'scum', 'Profile 9'), { recursive: true });
  mkdirSync(path.join(root, 'managed-profiles', 'game-di', 'Profile 5'), { recursive: true });
  writeFileSync(
    path.join(root, 'managed-profiles', 'scum', '.webmcp-meta.json'),
    JSON.stringify({ name: 'Lười Cày', profileDir: 'Profile 9', createdAt: 1 }),
  );
  writeFileSync(
    path.join(root, 'managed-profiles', 'game-di', '.webmcp-meta.json'),
    JSON.stringify({ name: 'Game Dị', profileDir: 'Profile 5', createdAt: 2 }),
  );
  writeFileSync(
    path.join(projRoot, 'config', 'fb_growth_config.json'),
    JSON.stringify({
      channel_id: 'scum-story-reup',
      managed_profile_id: 'managed:scum',
      chrome_profile: 'Profile 9',
    }),
  );

  const res = spawnSync(process.execPath, [
    BIN,
    'launch',
    '--profile-id',
    'managed:game-di',
    '--dry-run',
  ], {
    cwd: projRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_CHROME_BINARY: process.execPath,
      WEBMCP_DATA_DIR: root,
      WEBMCP_HOME: root,
      WEBMCP_ALLOW_PROFILE_CREATE: '1',
    },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Refusing to launch mismatched --profile-id "managed:game-di"/);
});

test('WEBMCP_BOUND_PROFILE_CONFIG with non-existent file fails closed', () => {
  const root = tempRoot();
  const res = spawnSync(process.execPath, [
    BIN,
    'launch',
    '--dry-run',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_CHROME_BINARY: process.execPath,
      WEBMCP_DATA_DIR: root,
      WEBMCP_HOME: root,
      WEBMCP_BOUND_PROFILE_CONFIG: path.join(root, 'non-existent-cfg.json'),
    },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /WEBMCP_BOUND_PROFILE_CONFIG points to non-existent file/);
});

test('relaunch on managed profile with orphaned lock returns needsRelaunch without global quit', async () => {
  const root = tempRoot();
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const scumDir = path.join(managedProfilesDir, 'scum');
  mkdirSync(scumDir, { recursive: true });
  writeFileSync(
    path.join(scumDir, '.webmcp-meta.json'),
    JSON.stringify({ name: 'Scum', profileDir: 'Default' }),
  );
  // Create orphaned lock file (no PID attached)
  writeFileSync(path.join(scumDir, 'SingletonCookie'), 'cookie-lock');

  const res = await launcher.launchChrome({
    profile: {
      kind: 'managed',
      userDataDir: scumDir,
      profileDir: 'Default',
    },
    relaunch: true,
    chromePath: process.execPath,
    managedProfilesDir,
  });

  assert.equal(res.ok, false);
  assert.equal(res.needsRelaunch, true);
  assert.match(res.message, /refusing global quitChrome\(\)/);
});

test('backup_managed_profiles.sh supports single quotes in profile paths and prunes unverified old date folders', () => {
  const root = tempRoot();
  const webmcpHome = path.join(root, '.webmcp');
  const backupRoot = path.join(webmcpHome, 'backups', 'profiles');
  mkdirSync(backupRoot, { recursive: true });

  // Pre-populate 8 older dummy date directories (some unverified without .verified_ok)
  for (let i = 1; i <= 8; i++) {
    const day = `2026-10-0${i}`;
    const dpath = path.join(backupRoot, day);
    mkdirSync(dpath, { recursive: true });
    if (i % 2 === 0) {
      writeFileSync(path.join(dpath, '.verified_ok'), '');
    }
  }

  // Profile path containing single quotes and spaces
  const quotedDir = path.join(webmcpHome, 'managed-profiles', "user's-scum-channel", 'Profile 9');
  mkdirSync(quotedDir, { recursive: true });
  writeFileSync(path.join(webmcpHome, 'managed-profiles', "user's-scum-channel", '.webmcp-meta.json'), JSON.stringify({ name: "user's-scum" }));
  writeFileSync(path.join(webmcpHome, 'managed-profiles', "user's-scum-channel", 'Local State'), '{}');
  const cookiesDb = path.join(quotedDir, 'Cookies');
  spawnSync('python3', [
    '-c',
    `import sqlite3; c = sqlite3.connect("${cookiesDb}"); c.execute("CREATE TABLE cookies (name TEXT, value TEXT)"); c.execute("INSERT INTO cookies VALUES ('sess', 'quoted')"); c.commit(); c.close()`,
  ]);

  const scriptPath = path.join(ROOT, 'scripts', 'backup_managed_profiles.sh');
  const res = spawnSync(scriptPath, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_HOME: webmcpHome,
    },
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
  assert.match(res.stdout, /mode=online/);

  // Verify that total date folders in backupRoot is pruned to <= 7
  const remainingFolders = readdirSync(backupRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.staging'));
  assert.ok(remainingFolders.length <= 7, `Expected <= 7 backup folders, got ${remainingFolders.length}`);
});

test('backup_managed_profiles.sh --restore guards against session replay attack and recovers on corruption/loss', () => {
  const root = tempRoot();
  const webmcpHome = path.join(root, '.webmcp');
  const profilesDir = path.join(webmcpHome, 'managed-profiles');
  const scumProfile = path.join(profilesDir, 'scum', 'Profile 9');
  mkdirSync(scumProfile, { recursive: true });

  const metaPath = path.join(profilesDir, 'scum', '.webmcp-meta.json');
  writeFileSync(metaPath, JSON.stringify({ name: 'scum', profileDir: 'Profile 9' }));
  const localStatePath = path.join(profilesDir, 'scum', 'Local State');
  writeFileSync(localStatePath, '{"os_crypt":{"encrypted_key":"test-key"}}');

  const liveCookies = path.join(scumProfile, 'Cookies');
  // Initialize with facebook session cookie at timestamp 100
  spawnSync('python3', [
    '-c',
    `import sqlite3
c = sqlite3.connect("${liveCookies}")
c.execute("CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT, last_access_utc INTEGER)")
c.execute("INSERT INTO cookies VALUES (100, '.facebook.com', 'c_user', '10001', 100)")
c.execute("INSERT INTO cookies VALUES (100, '.facebook.com', 'xs', 'token_xs', 100)")
c.commit()
c.close()`,
  ]);

  const scriptPath = path.join(ROOT, 'scripts', 'backup_managed_profiles.sh');

  // 1. Run backup to create a verified backup with timestamp 100
  const backupRes = spawnSync(scriptPath, [], {
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_HOME: webmcpHome },
  });
  assert.equal(backupRes.status, 0, `Initial backup failed: ${backupRes.stderr}`);

  // 2. Scenario 1: Live DB is healthy and updated with newer last_access_utc (200)
  spawnSync('python3', [
    '-c',
    `import sqlite3
c = sqlite3.connect("${liveCookies}")
c.execute("UPDATE cookies SET last_access_utc = 200 WHERE name in ('c_user', 'xs')")
c.commit()
c.close()`,
  ]);

  // Attempting restore must be BLOCKED by Anti-Replay-Attack guardrail
  const blockedRes = spawnSync(scriptPath, ['--restore', 'scum'], {
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_HOME: webmcpHome },
  });
  assert.equal(blockedRes.status, 1, 'Expected restore to fail closed on healthy newer session');
  assert.match(blockedRes.stderr, /\[GUARDRAIL BLOCKED\].*Session Replay Attack/);

  // 3. Scenario 2: Live Cookies file is corrupted with arbitrary bytes
  writeFileSync(liveCookies, 'corrupted database bytes header');
  const restoreCorruptedRes = spawnSync(scriptPath, ['--restore', 'scum'], {
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_HOME: webmcpHome },
  });
  assert.equal(restoreCorruptedRes.status, 0, `Expected restore to succeed on corrupt DB: ${restoreCorruptedRes.stderr}`);

  // Verify that Cookies file is restored and intact with original backup timestamp (100)
  const verifyRes = spawnSync('python3', [
    '-c',
    `import sqlite3, sys
c = sqlite3.connect("${liveCookies}")
cur = c.cursor()
cur.execute("PRAGMA integrity_check")
if cur.fetchone()[0] != 'ok':
    sys.exit(1)
cur.execute("SELECT last_access_utc FROM cookies WHERE name = 'c_user'")
row = cur.fetchone()
sys.exit(0 if row and row[0] == 100 else 2)`,
  ]);
  assert.equal(verifyRes.status, 0, 'Restored Cookies DB should be intact with backup timestamp 100');

  // 4. Scenario 3: Live Cookies file is deleted (disk loss)
  unlinkSync(liveCookies);
  const restoreDeletedRes = spawnSync(scriptPath, ['--restore', 'scum'], {
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_HOME: webmcpHome },
  });
  assert.equal(restoreDeletedRes.status, 0, `Expected restore to succeed on deleted DB: ${restoreDeletedRes.stderr}`);
  assert.ok(existsSync(liveCookies), 'Cookies file should exist after restore');

  // 5. Scenario 4: Live process lock check
  const lockSymlink = path.join(profilesDir, 'scum', 'SingletonLock');
  symlinkSync(`test-host-${process.pid}`, lockSymlink);
  const lockBlockedRes = spawnSync(scriptPath, ['--restore', 'scum', '--force-disaster-recovery'], {
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_HOME: webmcpHome },
  });
  assert.equal(lockBlockedRes.status, 1, 'Expected restore to block when Chrome process is alive');
  assert.match(lockBlockedRes.stderr, /\[GUARDRAIL BLOCKED\] Chrome is currently running for profile 'scum'/);
  unlinkSync(lockSymlink);

  // 6. Scenario 5: --force-disaster-recovery succeeds even when live DB has newer tokens
  spawnSync('python3', [
    '-c',
    `import sqlite3
c = sqlite3.connect("${liveCookies}")
c.execute("UPDATE cookies SET last_access_utc = 300 WHERE name in ('c_user', 'xs')")
c.commit()
c.close()`,
  ]);
  const forceRes = spawnSync(scriptPath, ['--restore', 'scum', '--force-disaster-recovery'], {
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_HOME: webmcpHome },
  });
  assert.equal(forceRes.status, 0, `--force-disaster-recovery should succeed: ${forceRes.stderr}`);
});

test('forkExistingProfile enforces host profile ceiling unless force is true', () => {
  const root = tempRoot();
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const srcDir = path.join(managedProfilesDir, 'p0');
  mkdirSync(path.join(srcDir, 'Default'), { recursive: true });
  writeFileSync(path.join(srcDir, 'Default', 'Preferences'), '{}');
  const srcProfile = { id: 'managed:p0', userDataDir: srcDir, profileDir: 'Default' };
  assert.throws(() => launcher.forkExistingProfile(srcProfile, 'p1', { managedProfilesDir, maxProfiles: 1 }), /PROFILE_CEILING_REACHED/);
  const ok = launcher.forkExistingProfile(srcProfile, 'p1', { managedProfilesDir, force: true });
  assert.equal(ok.totalManagedCount, 2);
});

test('detoxForkedManagedProfile safely guards, preserves meta, backs up cookies, unlinks Secure Preferences and cleans Preferences/Local State/Web Data', () => {
  const root = tempRoot();
  const userDataDir = path.join(root, 'managed-detox');
  const profileDir = 'Profile 1';
  const profilePath = path.join(userDataDir, profileDir);
  mkdirSync(profilePath, { recursive: true });

  // 1. Guard test
  assert.deepEqual(launcher.detoxForkedManagedProfile(null, 'Default'), { ok: false, skipped: true });
  assert.deepEqual(launcher.detoxForkedManagedProfile(userDataDir, 'NonExistent'), { ok: false, skipped: true });

  // 2. Set up initial files:
  writeFileSync(
    path.join(profilePath, 'Preferences'),
    JSON.stringify({
      account_info: [
        {
          email: 'detox.user@example.com',
          full_name: 'Detox User',
          picture_url: 'https://example.com/avatar.jpg',
        },
      ],
      google: { services: { sync: { enabled: true } } },
      protection: { macs: { google: 'some-hmac' } },
      prefs: {
        tracked_preferences_reset: 1,
        preference_reset_time: 123456,
      },
      profile: { exit_type: 'Crashed', exited_cleanly: false },
    })
  );

  writeFileSync(path.join(profilePath, 'Secure Preferences'), '{"protection":{"macs":{"google":"hmac"}}}');

  writeFileSync(
    path.join(userDataDir, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: {
          'Profile 1': {
            gaia_id: '123456789',
            user_name: 'detox.user@example.com',
            name: 'Display Name',
            is_consented_primary_account: true,
            is_ephemeral: true,
          },
        },
      },
    })
  );

  mkdirSync(path.join(profilePath, 'Network'), { recursive: true });
  const cookieDbPath = path.join(profilePath, 'Network', 'Cookies');
  const { DatabaseSync } = require('node:sqlite');
  const cDb = new DatabaseSync(cookieDbPath);
  cDb.exec(`
    CREATE TABLE cookies (name TEXT, value TEXT);
    INSERT INTO cookies VALUES ('session', 'secret123');
  `);
  cDb.close();

  const webDataPath = path.join(profilePath, 'Web Data');
  const wDb = new DatabaseSync(webDataPath);
  wDb.exec(`
    CREATE TABLE token_service (service TEXT, encrypted_token BLOB);
    INSERT INTO token_service VALUES ('gaia', X'0102');
  `);
  wDb.close();

  writeFileSync(
    path.join(userDataDir, '.webmcp-meta.json'),
    JSON.stringify({ profileDir: 'Profile 1' })
  );

  const detoxRes = launcher.detoxForkedManagedProfile(userDataDir, profileDir);
  assert.equal(detoxRes.ok, true);
  assert.equal(detoxRes.detoxed, true);

  const meta = JSON.parse(readFileSync(path.join(userDataDir, '.webmcp-meta.json'), 'utf8'));
  assert.equal(meta.email, 'detox.user@example.com');
  assert.equal(meta.gaiaName, 'Detox User');
  assert.equal(meta.avatarUrl, 'https://example.com/avatar.jpg');
  assert.equal(meta.detoxedForManaged, true);
  assert.ok(meta.detoxedAt);

  const prebootPath = path.join(userDataDir, '.cookies-preboot.sqlite');
  assert.ok(existsSync(prebootPath));
  const prebootDb = new DatabaseSync(prebootPath);
  const rows = prebootDb.prepare('SELECT name, value FROM cookies').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'session');
  prebootDb.close();

  assert.equal(existsSync(path.join(profilePath, 'Secure Preferences')), false);
  assert.equal(existsSync(path.join(profilePath, 'Secure Preferences.pre-detox')), true);

  const updatedPrefs = JSON.parse(readFileSync(path.join(profilePath, 'Preferences'), 'utf8'));
  assert.equal(updatedPrefs.account_info, undefined);
  assert.equal(updatedPrefs.google?.services, undefined);
  assert.equal(updatedPrefs.protection, undefined);
  assert.equal(updatedPrefs.prefs?.tracked_preferences_reset, undefined);
  assert.equal(updatedPrefs.prefs?.preference_reset_time, undefined);
  assert.deepEqual(updatedPrefs.signin, {
    allowed: false,
    allowed_on_next_startup: false,
    bound_session_credentials_enabled: false,
  });
  assert.equal(updatedPrefs.profile?.exit_type, 'Normal');
  assert.equal(updatedPrefs.profile?.exited_cleanly, true);

  const updatedLocalState = JSON.parse(readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
  const entry = updatedLocalState.profile.info_cache['Profile 1'];
  assert.equal(entry.gaia_id, undefined);
  assert.equal(entry.user_name, undefined);
  assert.equal(entry.is_consented_primary_account, false);
  assert.equal(entry.is_ephemeral, false);
  assert.equal(entry.name, 'Display Name');

  const checkWDb = new DatabaseSync(webDataPath);
  const tokenRows = checkWDb.prepare('SELECT count(*) as count FROM token_service').get();
  assert.equal(tokenRows.count, 0);
  checkWDb.close();
});

test('fresh native managed profiles without provenance are NOT detoxed on launch even with google in Secure Preferences', async () => {
  assert.equal(launcher.hasGoogleSecurePrefs, undefined);
  const root = tempRoot();
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const extensionPath = fakeExtensionDir(root);
  const ud = launcher.createManagedProfile('fresh-native', { managedProfilesDir });
  const defDir = path.join(ud, 'Default');
  mkdirSync(defDir, { recursive: true });
  writeFileSync(path.join(defDir, 'Preferences'), JSON.stringify({ signin: { allowed: true } }));
  writeFileSync(path.join(defDir, 'Secure Preferences'), '{"protection":{"macs":{"google":"valid-hmac"}}}');

  const fakeBin = path.join(root, 'fake-chrome.sh');
  writeFileSync(fakeBin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 130.0.0.0"; exit 0; fi\nexit 0\n');
  chmodSync(fakeBin, 0o755);

  const res = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: ud, profileDir: 'Default' },
    chromePath: fakeBin,
    extensionPath,
    managedProfilesDir,
    sessionsFile: path.join(root, 'sessions.json'),
  });
  assert.equal(res.ok, true);
  assert.equal(existsSync(path.join(defDir, 'Secure Preferences')), true);
  assert.equal(existsSync(path.join(defDir, 'Secure Preferences.pre-detox')), false);
  const meta = JSON.parse(readFileSync(path.join(ud, '.webmcp-meta.json'), 'utf8'));
  assert.equal(meta.detoxedForManaged, undefined);
});

test('detoxForkedManagedProfile checkpoints Cookies-wal into Cookies and .cookies-preboot.sqlite', () => {
  const { DatabaseSync } = require('node:sqlite');
  const root = tempRoot();
  const ud = path.join(root, 'wal-prof');
  const pd = path.join(ud, 'Profile 31');
  mkdirSync(pd, { recursive: true });
  writeFileSync(path.join(pd, 'Preferences'), JSON.stringify({ signin: { signin_pending_start_time: '123' } }));
  writeFileSync(path.join(ud, '.webmcp-meta.json'), JSON.stringify({ profileDir: 'Profile 31' }));

  const ckPath = path.join(pd, 'Cookies');
  const dbInit = new DatabaseSync(ckPath);
  dbInit.exec('PRAGMA journal_mode=WAL; CREATE TABLE cookies (name TEXT, value TEXT);');
  dbInit.close();

  // Keep writer holding WAL uncommitted until close while disabling autocheckpoint so rows live in -wal
  const dbWal = new DatabaseSync(ckPath);
  dbWal.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO cookies VALUES ('wal_only', 'v1');");
  dbWal.close();
  // Verify -wal still has data or exists before detox; ensure preboot & main DB retain the row without -wal
  const res = launcher.detoxForkedManagedProfile(ud, 'Profile 31');
  assert.equal(res.ok, true);
  assert.equal(res.detoxed, true);

  for (const ext of ['-wal', '-shm']) {
    try { unlinkSync(ckPath + ext); } catch {}
    try { unlinkSync(path.join(ud, '.cookies-preboot.sqlite' + ext)); } catch {}
  }

  const checkMain = new DatabaseSync(ckPath, { readOnly: true });
  assert.equal(checkMain.prepare('SELECT count(*) as c FROM cookies').get().c, 1);
  checkMain.close();

  const checkPre = new DatabaseSync(path.join(ud, '.cookies-preboot.sqlite'), { readOnly: true });
  assert.equal(checkPre.prepare('SELECT count(*) as c FROM cookies').get().c, 1);
  checkPre.close();
});

test('detoxAllManagedProfiles detoxes unlocked profiles and skips locked ones', () => {
  const root = tempRoot();
  const managedDir = path.join(root, 'managed-profiles');
  const unlocked = path.join(managedDir, 'offline-prof');
  const locked = path.join(managedDir, 'running-prof');
  mkdirSync(path.join(unlocked, 'Profile 9'), { recursive: true });
  mkdirSync(path.join(locked, 'Default'), { recursive: true });

  writeFileSync(path.join(unlocked, 'Profile 9', 'Preferences'), JSON.stringify({ account_info: [{ email: 'u@example.com' }], signin: { allowed: true } }));
  writeFileSync(path.join(unlocked, 'Profile 9', 'Secure Preferences'), '{"protection":{"macs":{"google":"bad"}}}');
  writeFileSync(path.join(locked, 'Default', 'Preferences'), JSON.stringify({ account_info: [{ email: 'live@example.com' }] }));
  writeFileSync(path.join(locked, 'Default', 'Secure Preferences'), '{"protection":{"macs":{"google":"keep"}}}');
  symlinkSync(`test-host-${process.pid}`, path.join(locked, 'SingletonLock'));

  const res = launcher.detoxAllManagedProfiles(managedDir);
  assert.equal(res.ok, true);
  assert.equal(res.total, 2);
  assert.equal(res.detoxedCount, 1);
  assert.equal(res.skippedLockedCount, 1);

  assert.equal(existsSync(path.join(unlocked, 'Profile 9', 'Secure Preferences')), false);
  const unlockedMeta = JSON.parse(readFileSync(path.join(unlocked, '.webmcp-meta.json'), 'utf8'));
  assert.equal(unlockedMeta.detoxedForManaged, true);
  assert.equal(unlockedMeta.email, 'u@example.com');

  assert.equal(existsSync(path.join(locked, 'Default', 'Secure Preferences')), true);
});

test('detoxForkedManagedProfile respects custom options.metaDir for managed-to-chrome', () => {
  const root = tempRoot();
  const sysChrome = path.join(root, 'SystemChrome');
  const pdir = path.join(sysChrome, 'Profile 4');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(path.join(pdir, 'Preferences'), JSON.stringify({ account_info: [{ email: 'm2c@example.com' }], signin: { allowed: true } }));
  writeFileSync(path.join(pdir, 'Secure Preferences'), '{"protection":{"macs":{"google":"old"}}}');
  const { DatabaseSync } = require('node:sqlite');
  const cdb = new DatabaseSync(path.join(pdir, 'Cookies'));
  cdb.exec("CREATE TABLE cookies (name TEXT, value TEXT); INSERT INTO cookies VALUES ('SID', 'abc');");
  cdb.close();

  const res = launcher.detoxForkedManagedProfile(sysChrome, 'Profile 4', { metaDir: pdir });
  assert.equal(res.ok, true);
  assert.equal(existsSync(path.join(pdir, 'Secure Preferences')), false);
  assert.equal(existsSync(path.join(pdir, '.cookies-preboot.sqlite')), true);
  assert.equal(existsSync(path.join(sysChrome, '.cookies-preboot.sqlite')), false);
  const meta = JSON.parse(readFileSync(path.join(pdir, '.webmcp-meta.json'), 'utf8'));
  assert.equal(meta.email, 'm2c@example.com');
  assert.equal(meta.detoxedForManaged, true);
  assert.equal(existsSync(path.join(sysChrome, 'External Extensions')), false);
});

test('detoxForkedManagedProfile preserves .pre-detox without clobbering and generates External Extensions JSON for Web Store IDs', () => {
  const root = tempRoot();
  const ud = path.join(root, 'ext-rehydrate');
  const pdir = path.join(ud, 'Default');
  const extFromSp = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const extFromDir = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const extLocation10 = 'cccccccccccccccccccccccccccccccc';
  const builtinPayments = 'nmmhkkegccagdldgiimedpiccmgmieda';
  const builtinDocs = 'ghbmnnjooekpmoecnnnilnnbdlolhkhi';

  mkdirSync(path.join(pdir, 'Extensions', extFromDir, '1.0_0'), { recursive: true });
  mkdirSync(path.join(pdir, 'Extensions', builtinDocs, '1.0_0'), { recursive: true });
  writeFileSync(path.join(pdir, 'Preferences'), JSON.stringify({ signin: { allowed: true } }));
  writeFileSync(path.join(pdir, 'Secure Preferences'), JSON.stringify({
    extensions: {
      settings: {
        [extFromSp]: { from_webstore: true, location: 1 },
        [extLocation10]: { from_webstore: true, location: 10 },
        [builtinPayments]: { from_webstore: true, location: 1 },
      },
    },
  }));
  writeFileSync(
    path.join(pdir, 'Extensions', extFromDir, '1.0_0', 'manifest.json'),
    JSON.stringify({ name: 'FromDir', update_url: 'https://clients2.google.com/service/update2/crx' })
  );
  writeFileSync(
    path.join(pdir, 'Extensions', builtinDocs, '1.0_0', 'manifest.json'),
    JSON.stringify({ name: 'DocsOffline', update_url: 'https://clients2.google.com/service/update2/crx' })
  );
  writeFileSync(path.join(ud, '.webmcp-meta.json'), JSON.stringify({ profileDir: 'Default' }));

  const res1 = launcher.detoxForkedManagedProfile(ud, 'Default');
  assert.equal(res1.ok, true);
  assert.deepEqual(res1.discoveredExtensions, [extFromSp, extFromDir]);

  const preDetoxPath = path.join(pdir, 'Secure Preferences.pre-detox');
  assert.equal(existsSync(path.join(pdir, 'Secure Preferences')), false);
  assert.equal(existsSync(preDetoxPath), true);
  assert.equal(statSync(preDetoxPath).mode & 0o777, 0o600);
  const origPreDetox = readFileSync(preDetoxPath, 'utf8');

  for (const id of [extFromSp, extFromDir]) {
    const extJson = JSON.parse(readFileSync(path.join(ud, 'External Extensions', `${id}.json`), 'utf8'));
    assert.equal(extJson.external_update_url, 'https://clients2.google.com/service/update2/crx');
  }
  assert.equal(existsSync(path.join(ud, 'External Extensions', `${extLocation10}.json`)), false);
  assert.equal(existsSync(path.join(ud, 'External Extensions', `${builtinPayments}.json`)), false);
  assert.equal(existsSync(path.join(ud, 'External Extensions', `${builtinDocs}.json`)), false);

  // Repeat detox with a new Secure Preferences must NOT clobber original .pre-detox
  writeFileSync(path.join(pdir, 'Secure Preferences'), '{"newer":true}');
  const res2 = launcher.detoxForkedManagedProfile(ud, 'Default');
  assert.equal(res2.ok, true);
  assert.equal(existsSync(path.join(pdir, 'Secure Preferences')), false);
  assert.equal(readFileSync(preDetoxPath, 'utf8'), origPreDetox);
});

test('forkExistingProfile builds minimal Local State without sibling profile leakage', () => {
  const root = tempRoot();
  const srcUserData = path.join(root, 'source-chrome');
  mkdirSync(path.join(srcUserData, 'Profile 9'), { recursive: true });
  writeFileSync(
    path.join(srcUserData, 'Local State'),
    JSON.stringify({
      os_crypt: { encrypted_key: 'keep-me' },
      profile: {
        last_used: 'Default',
        info_cache: {
          Default: { name: 'Sibling Main', gaia_id: 'sibling-gaia', user_name: 'sibling@example.com' },
          'Profile 9': { name: 'Target P9', gaia_id: 'target-gaia', user_name: 'target@example.com' },
        },
      },
      unrelated_secret_tree: { should_not_copy: true },
    })
  );
  writeFileSync(path.join(srcUserData, 'Profile 9', 'Preferences'), JSON.stringify({ profile: {} }));

  const managedProfilesDir = path.join(root, 'managed-profiles');
  const res = launcher.forkExistingProfile(
    { id: 'Chrome:Profile 9', browser: 'Chrome', userDataDir: srcUserData, profileDir: 'Profile 9' },
    'isolated-p9',
    { managedProfilesDir }
  );
  assert.equal(res.ok, true);
  const dstLs = JSON.parse(readFileSync(path.join(res.userDataDir, 'Local State'), 'utf8'));
  assert.equal(dstLs.unrelated_secret_tree, undefined);
  assert.deepEqual(dstLs.os_crypt, { encrypted_key: 'keep-me' });
  assert.equal(dstLs.profile.last_used, 'Profile 9');
  assert.deepEqual(Object.keys(dstLs.profile.info_cache), ['Profile 9']);
  assert.equal(dstLs.profile.info_cache.Default, undefined);
  assert.equal(dstLs.profile.info_cache['Profile 9'].gaia_id, undefined);
  assert.equal(dstLs.profile.info_cache['Profile 9'].user_name, undefined);
});

test('detoxForkedManagedProfile fails closed on corrupt JSON without setting detoxedForManaged or overwriting file', () => {
  const root = tempRoot();
  const ud = path.join(root, 'corrupt-detox');
  const pdir = path.join(ud, 'Default');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(path.join(pdir, 'Preferences'), '{ broken json !!!');
  writeFileSync(path.join(ud, '.webmcp-meta.json'), JSON.stringify({ profileDir: 'Default' }));

  assert.throws(
    () => launcher.detoxForkedManagedProfile(ud, 'Default'),
    /corrupt JSON/i
  );
  assert.equal(readFileSync(path.join(pdir, 'Preferences'), 'utf8'), '{ broken json !!!');
  const meta = JSON.parse(readFileSync(path.join(ud, '.webmcp-meta.json'), 'utf8'));
  assert.equal(meta.detoxedForManaged, undefined);
});

test('launchChrome with --relaunch auto-detoxes provenance profile after unlock', async () => {
  const root = tempRoot();
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const extensionPath = fakeExtensionDir(root);
  const ud = path.join(managedProfilesDir, 'relaunch-detox');
  const pdir = path.join(ud, 'Default');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(path.join(ud, '.webmcp-meta.json'), JSON.stringify({ name: 'relaunch-detox', profileDir: 'Default', forkedFrom: 'Chrome:Default' }));
  writeFileSync(path.join(pdir, 'Preferences'), JSON.stringify({ account_info: [{ email: 'relaunch@example.com' }], signin: { allowed: true } }));
  writeFileSync(path.join(pdir, 'Secure Preferences'), '{"protection":{"macs":{"google":"hmac"}}}');

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const lockPath = path.join(ud, 'SingletonLock');
  symlinkSync(`host-${child.pid}`, lockPath);
  const origKill = process.kill;
  // Ensure test cleanup on child exit removes lock so waitForUnlock observes unlock
  child.on('exit', () => { try { unlinkSync(lockPath); } catch {} });

  const fakeBin = path.join(root, 'fake-chrome.sh');
  writeFileSync(fakeBin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 130.0.0.0"; exit 0; fi\nexit 0\n');
  chmodSync(fakeBin, 0o755);

  const res = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: ud, profileDir: 'Default' },
    relaunch: true,
    chromePath: fakeBin,
    extensionPath,
    managedProfilesDir,
    sessionsFile: path.join(root, 'sessions.json'),
  });
  assert.equal(typeof origKill, 'function');
  assert.equal(res.ok, true);
  assert.equal(existsSync(path.join(pdir, 'Secure Preferences')), false);
  assert.equal(existsSync(path.join(pdir, 'Secure Preferences.pre-detox')), true);
  const meta = JSON.parse(readFileSync(path.join(ud, '.webmcp-meta.json'), 'utf8'));
  assert.equal(meta.detoxedForManaged, true);
  assert.equal(meta.email, 'relaunch@example.com');
});

test('webmcp profiles detox CLI supports --profile-id, --udd, and fails non-zero when locked', () => {
  const root = tempRoot();
  const managedDir = path.join(root, 'managed-profiles');
  const ud = path.join(managedDir, 'cli-detox');
  const pdir = path.join(ud, 'Profile 2');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(path.join(ud, '.webmcp-meta.json'), JSON.stringify({ name: 'cli-detox', profileDir: 'Profile 2' }));
  writeFileSync(path.join(pdir, 'Preferences'), JSON.stringify({ account_info: [{ email: 'cli@example.com' }] }));
  writeFileSync(path.join(pdir, 'Secure Preferences'), '{"protection":{"macs":{"google":"x"}}}');

  const okRes = spawnSync(process.execPath, [BIN, 'profiles', 'detox', '--profile-id', 'managed:cli-detox', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_DATA_DIR: root },
  });
  assert.equal(okRes.status, 0, okRes.stderr);
  const okPayload = JSON.parse(okRes.stdout);
  assert.equal(okPayload.ok, true);
  assert.equal(okPayload.detoxed, true);
  assert.equal(existsSync(path.join(pdir, 'Secure Preferences.pre-detox')), true);

  // Locked target via --udd must exit non-zero
  symlinkSync(`host-${process.pid}`, path.join(ud, 'SingletonLock'));
  const lockedRes = spawnSync(process.execPath, [BIN, 'profiles', 'detox', '--udd', ud, '--profile-dir', 'Profile 2', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_DATA_DIR: root },
  });
  assert.equal(lockedRes.status, 1);
  const lockedPayload = JSON.parse(lockedRes.stdout);
  assert.equal(lockedPayload.ok, false);
  assert.equal(lockedPayload.error, 'PROFILE_IN_USE');
});

test('readBrowserProfiles skips missing profile directories and empty garbage stubs on non-Chrome browsers', () => {
  const root = tempRoot();
  const chromeUserData = path.join(root, 'chrome-user-data');
  const chromiumUserData = path.join(root, 'chromium-user-data');
  mkdirSync(chromeUserData, { recursive: true });
  mkdirSync(chromiumUserData, { recursive: true });

  // Chrome Local State has Profile 1 (exists on disk) and Profile 2 (missing on disk)
  mkdirSync(path.join(chromeUserData, 'Profile 1'), { recursive: true });
  writeFileSync(path.join(chromeUserData, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        'Profile 1': { name: 'Active User', gaia_email: 'user@gmail.com' },
        'Profile 2': { name: 'Ghost Profile', gaia_email: 'ghost@gmail.com' },
      },
    },
  }));

  const chromeProfiles = launcher.readBrowserProfiles('Chrome', chromeUserData);
  assert.equal(chromeProfiles.length, 1);
  assert.equal(chromeProfiles[0].profileDir, 'Profile 1');

  // Chromium Local State has Default (garbage name "Your Chromium", no email, no .webmcp-meta.json)
  // and Profile 1 (has email) and Profile 2 (garbage name but has .webmcp-meta.json)
  mkdirSync(path.join(chromiumUserData, 'Default'), { recursive: true });
  mkdirSync(path.join(chromiumUserData, 'Profile 1'), { recursive: true });
  mkdirSync(path.join(chromiumUserData, 'Profile 2'), { recursive: true });
  writeFileSync(path.join(chromiumUserData, 'Profile 2', '.webmcp-meta.json'), JSON.stringify({ name: 'Bound Profile' }));

  writeFileSync(path.join(chromiumUserData, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        'Default': { name: 'Your Chromium' },
        'Profile 1': { name: 'Chromium User', gaia_email: 'chrom@example.com' },
        'Profile 2': { name: 'Person 1' },
      },
    },
  }));

  const chromiumProfiles = launcher.readBrowserProfiles('Chromium', chromiumUserData);
  // Default is skipped because garbage name, no email, no .webmcp-meta.json
  // Profile 1 is kept because email exists
  // Profile 2 is kept because .webmcp-meta.json exists
  assert.equal(chromiumProfiles.length, 2);
  const dirs = chromiumProfiles.map((p) => p.profileDir).sort();
  assert.deepEqual(dirs, ['Profile 1', 'Profile 2']);
});

test('launchChrome throws MANAGED_DIR_OUT_OF_ROOT when managed profile userDataDir is outside managedProfilesDir', async () => {
  const root = tempRoot();
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const outsideDir = path.join(root, 'rogue-outside-profiles', 'rogue-user');
  mkdirSync(outsideDir, { recursive: true });
  const extensionPath = fakeExtensionDir(root);

  // 1. Outside root -> throws MANAGED_DIR_OUT_OF_ROOT
  await assert.rejects(
    async () => {
      await launcher.launchChrome({
        mode: 'managed',
        profile: { kind: 'managed', userDataDir: outsideDir },
        chromePath: process.execPath,
        extensionPath,
        managedProfilesDir,
        dryRun: true,
      });
    },
    (err) => {
      assert.equal(err.code, 'MANAGED_DIR_OUT_OF_ROOT');
      return true;
    }
  );

  // 2. Outside root but allowExternalManagedDir: true -> passes
  const allowedRes = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: outsideDir },
    chromePath: process.execPath,
    extensionPath,
    managedProfilesDir,
    allowExternalManagedDir: true,
    dryRun: true,
  });
  assert.equal(allowedRes.ok, true);
  assert.equal(allowedRes.userDataDir, outsideDir);
});

test('launchChrome throws EXISTING_PROFILE_DIR_NOT_FOUND when existing profileDir does not exist on disk', async () => {
  const root = tempRoot();
  const userDataDir = path.join(root, 'existing-chrome-root');
  mkdirSync(userDataDir, { recursive: true });
  const extensionPath = fakeExtensionDir(root);

  // 'Profile 99' does not exist in userDataDir
  await assert.rejects(
    async () => {
      await launcher.launchChrome({
        mode: 'existing',
        profile: { kind: 'existing', userDataDir, profileDir: 'Profile 99' },
        chromePath: process.execPath,
        extensionPath,
        dryRun: false,
      });
    },
    (err) => {
      assert.equal(err.code, 'EXISTING_PROFILE_DIR_NOT_FOUND');
      return true;
    }
  );

  // If the directory does exist on disk, it does not throw EXISTING_PROFILE_DIR_NOT_FOUND
  const realProfileDir = path.join(userDataDir, 'Profile 1');
  mkdirSync(realProfileDir, { recursive: true });
  const fakeBin = path.join(root, 'fake-chrome.sh');
  writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeBin, 0o755);

  const res = await launcher.launchChrome({
    mode: 'existing',
    profile: { kind: 'existing', userDataDir, profileDir: 'Profile 1' },
    chromePath: fakeBin,
    extensionPath,
    dryRun: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.profileDir, 'Profile 1');
});

test('resolveMacAppBundle resolves .app bundle on darwin and returns null for headless / non-bundle binaries', () => {
  const chromeAppPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const betaAppPath = '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta';

  if (process.platform === 'darwin') {
    assert.equal(launcher.resolveMacAppBundle(chromeAppPath), '/Applications/Google Chrome.app');
    assert.equal(launcher.resolveMacAppBundle(betaAppPath), '/Applications/Google Chrome Beta.app');
    assert.equal(launcher.resolveMacAppBundle(chromeAppPath, ['--headless']), null);
    assert.equal(launcher.resolveMacAppBundle(chromeAppPath, ['--headless=new']), null);
  }

  assert.equal(launcher.resolveMacAppBundle('/usr/bin/google-chrome'), null);
  assert.equal(launcher.resolveMacAppBundle('/tmp/fake-chrome.sh'), null);
  assert.equal(launcher.resolveMacAppBundle(null), null);
  assert.equal(launcher.resolveMacAppBundle(undefined), null);
  assert.equal(launcher.resolveMacAppBundle(123), null);
});

test('extractCliFlagValue and matchChromePidInPsOutput: exact flag parsing against synthetic ps output ([H1])', () => {
  assert.equal(launcher.extractCliFlagValue('chrome --user-data-dir="/tmp/chrome with spaces" --other', '--user-data-dir'), '/tmp/chrome with spaces');
  assert.equal(launcher.extractCliFlagValue("chrome --user-data-dir='/tmp/chrome with spaces' --other", '--user-data-dir'), '/tmp/chrome with spaces');
  assert.equal(launcher.extractCliFlagValue('chrome --user-data-dir=/tmp/smoke https://google.com', '--user-data-dir'), '/tmp/smoke');
  assert.equal(launcher.extractCliFlagValue('chrome --user-data-dir=/tmp/smoke about:blank', '--user-data-dir'), '/tmp/smoke');
  assert.equal(launcher.extractCliFlagValue('chrome --profile-directory="Profile 1" --user-data-dir=/tmp/smoke', '--profile-directory'), 'Profile 1');
  assert.equal(launcher.extractCliFlagValue('chrome --other-flag=123', '--user-data-dir'), null);

  const syntheticPs = [
    '    1 /sbin/launchd',
    '  101 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow',
    '  201 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '  301 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer --user-data-dir=/tmp/smoke',
    '  302 /usr/bin/open -na /Applications/Google Chrome.app --args --user-data-dir=/tmp/smoke',
    '  401 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/smoke-2 --profile-directory="Profile 1"',
    '  402 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/smoke --profile-directory="Profile 10"',
    '  403 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/smoke --profile-directory="Profile 1"',
    '  501 /Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta --user-data-dir="/tmp/path with spaces/udd" --profile-directory=Default',
  ].join('\n');

  assert.equal(launcher.matchChromePidInPsOutput(syntheticPs, { userDataDir: '/tmp/smoke-2', profileDir: 'Profile 1' }), 401);
  assert.equal(launcher.matchChromePidInPsOutput(syntheticPs, { userDataDir: '/tmp/smoke', profileDir: 'Profile 10' }), 402);
  assert.equal(launcher.matchChromePidInPsOutput(syntheticPs, { userDataDir: '/tmp/smoke', profileDir: 'Profile 1' }), 403);
  assert.equal(launcher.matchChromePidInPsOutput(syntheticPs, { userDataDir: '/tmp/path with spaces/udd', profileDir: 'Default' }), 501);
  assert.equal(launcher.matchChromePidInPsOutput(syntheticPs, { userDataDir: '/nonexistent' }), null);
});

test('resolveMacAppBundle follows symlink to .app bundle on darwin ([L6])', () => {
  const root = tempRoot();
  const fakeAppDir = path.join(root, 'Fake Chrome.app', 'Contents', 'MacOS');
  mkdirSync(fakeAppDir, { recursive: true });
  const realBin = path.join(fakeAppDir, 'Fake Chrome');
  writeFileSync(realBin, '#!/bin/sh\nexit 0\n');
  chmodSync(realBin, 0o755);

  const symlinkBin = path.join(root, 'chrome-symlink');
  symlinkSync(realBin, symlinkBin);

  if (process.platform === 'darwin') {
    const resolved = launcher.resolveMacAppBundle(symlinkBin);
    assert.ok(resolved);
    assert.equal(realpathSync(resolved), realpathSync(path.join(root, 'Fake Chrome.app')));
  } else {
    assert.equal(launcher.resolveMacAppBundle(symlinkBin), null);
  }
});

test('launchChrome blocks symlink escape pointing outside managedProfilesDir ([L8])', async () => {
  const root = tempRoot();
  const managedDir = path.join(root, 'managed-profiles');
  const outsideDir = path.join(root, 'outside-rogue-dir');
  mkdirSync(managedDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const evilSymlink = path.join(managedDir, 'evil-symlink');
  symlinkSync(outsideDir, evilSymlink);

  await assert.rejects(
    async () => {
      await launcher.launchChrome({
        mode: 'managed',
        profile: { kind: 'managed', userDataDir: evilSymlink },
        managedProfilesDir: managedDir,
        dryRun: true,
      });
    },
    (err) => {
      assert.equal(err.code, 'MANAGED_DIR_OUT_OF_ROOT');
      return true;
    }
  );
});

test('backup_managed_profiles.sh --restore blocks stale replay when live FB is newer ([H2]) and blocks corrupt backup ([M1])', () => {
  const root = tempRoot();
  const webmcpHome = path.join(root, '.webmcp');
  const profilesDir = path.join(webmcpHome, 'managed-profiles');
  const pDir = path.join(profilesDir, 'myprofile', 'Default');
  mkdirSync(pDir, { recursive: true });

  writeFileSync(path.join(profilesDir, 'myprofile', '.webmcp-meta.json'), JSON.stringify({ name: 'myprofile', profileDir: 'Default' }));
  writeFileSync(path.join(profilesDir, 'myprofile', 'Local State'), '{"os_crypt":{"encrypted_key":"test-key"}}');

  const liveCookies = path.join(pDir, 'Cookies');
  spawnSync('python3', [
    '-c',
    `import sqlite3
c = sqlite3.connect("${liveCookies}")
c.execute("CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT, last_access_utc INTEGER)")
c.execute("INSERT INTO cookies VALUES (100, '.google.com', 'SID', 'sess_sid', 100)")
c.execute("INSERT INTO cookies VALUES (100, '.google.com', '__Secure-1PSID', 'sess_psid', 100)")
c.execute("INSERT INTO cookies VALUES (100, 'accounts.google.com', 'LSID', 'sess_lsid', 100)")
c.commit()
c.close()`,
  ]);

  const scriptPath = path.join(ROOT, 'scripts', 'backup_managed_profiles.sh');

  // 1. Run backup to snapshot Google session at timestamp 100
  const backupRes = spawnSync(scriptPath, [], {
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_HOME: webmcpHome },
  });
  assert.equal(backupRes.status, 0, `Initial backup failed: ${backupRes.stderr}`);

  // 2. Scenario [H2]: Live target lost Google, but logged into Facebook with newer timestamp 500!
  spawnSync('python3', [
    '-c',
    `import sqlite3
c = sqlite3.connect("${liveCookies}")
c.execute("DELETE FROM cookies")
c.execute("INSERT INTO cookies VALUES (500, '.facebook.com', 'c_user', '10001', 500)")
c.execute("INSERT INTO cookies VALUES (500, '.facebook.com', 'xs', 'token_xs', 500)")
c.commit()
c.close()`,
  ]);

  // Attempting restore WITHOUT --force-disaster-recovery must be BLOCKED
  const blockedH2 = spawnSync(scriptPath, ['--restore', 'myprofile'], {
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_HOME: webmcpHome },
  });
  assert.equal(blockedH2.status, 1, 'Expected restore to be blocked when live FB session is newer than backup Google');
  assert.match(blockedH2.stderr, /\[GUARDRAIL BLOCKED\].*Session Replay Attack/);

  // 3. Scenario [M1]: Backup Cookies file becomes corrupt or unreadable
  const backupDate = new Date().toISOString().slice(0, 10);
  const backupCookies = path.join(webmcpHome, 'backups', 'profiles', backupDate, 'myprofile', 'Default', 'Cookies');
  if (existsSync(backupCookies)) {
    writeFileSync(backupCookies, 'corrupted backup file content');
    const blockedM1 = spawnSync(scriptPath, ['--restore', 'myprofile'], {
      encoding: 'utf8',
      env: { ...process.env, WEBMCP_HOME: webmcpHome },
    });
    assert.equal(blockedM1.status, 1, 'Expected restore to fail closed on corrupt backup cookie file ([M1])');
  }
});

test('detoxForkedManagedProfile and launchChrome purge leaked sibling Local State info_cache and preserve metaDir siblings', async (t) => {
  const { detoxForkedManagedProfile, sanitizeManagedLocalState } = require(path.join(ROOT, 'chrome-launcher', 'profile-fork'));
  const root = tempRoot();
  t.after(() => {
    try { spawnSync('rm', ['-rf', root]); } catch {}
  });

  // 1. Isolated Managed Profile: sibling info_cache entries must be stripped & "Your Chrome" upgraded
  const managedDir = path.join(root, 'managed-profiles');
  const targetDir = path.join(managedDir, 'thichminhthien0');
  const p43Dir = path.join(targetDir, 'Profile 43');
  mkdirSync(p43Dir, { recursive: true });
  writeFileSync(path.join(targetDir, '.webmcp-meta.json'), JSON.stringify({
    name: 'thichminhthien0',
    profileDir: 'Profile 43',
  }));
  writeFileSync(path.join(p43Dir, 'Preferences'), JSON.stringify({
    account_info: [{ email: 'thichminhthien0@gmail.com' }],
    profile: { name: 'Your Chrome', using_default_name: true },
  }));
  writeFileSync(path.join(targetDir, 'Local State'), JSON.stringify({
    os_crypt: { encrypted_key: 'keep-me' },
    profile: {
      last_used: 'Profile 43',
      last_active_profiles: ['Profile 43', 'Profile 22'],
      profiles_order: ['Profile 43', 'Profile 22', 'Profile 45'],
      info_cache: {
        Default: { name: 'hieuhieu', user_name: 'hieu2906090@gmail.com' },
        'Profile 22': { name: 'codewithzerog' },
        'Profile 43': { name: 'Your Chrome', gaia_id: '123', user_name: 'thichminhthien0@gmail.com', is_consented_primary_account: true },
        'Profile 45': { name: 'chennie' },
      },
    },
  }));

  detoxForkedManagedProfile(targetDir, 'Profile 43');

  const lsAfter = JSON.parse(readFileSync(path.join(targetDir, 'Local State'), 'utf8'));
  assert.deepEqual(Object.keys(lsAfter.profile.info_cache), ['Profile 43'], 'Managed Local State must strip sibling Other Chrome Profiles');
  assert.equal(lsAfter.profile.info_cache['Profile 43'].name, 'thichminhthien0');
  assert.equal(lsAfter.profile.info_cache['Profile 43'].is_using_default_name, false);
  assert.equal(lsAfter.profile.info_cache['Profile 43'].gaia_id, undefined);
  assert.equal(lsAfter.profile.info_cache['Profile 43'].user_name, undefined);
  assert.equal(lsAfter.profile.info_cache['Profile 43'].is_consented_primary_account, false);
  assert.equal(lsAfter.profile.last_used, 'Profile 43');
  assert.deepEqual(lsAfter.profile.last_active_profiles, ['Profile 43']);
  assert.equal(lsAfter.profile.profiles_order, undefined);
  assert.equal(lsAfter.os_crypt.encrypted_key, 'keep-me');

  const prefsAfter = JSON.parse(readFileSync(path.join(p43Dir, 'Preferences'), 'utf8'));
  assert.equal(prefsAfter.profile.name, 'thichminhthien0');
  assert.equal(prefsAfter.profile.using_default_name, false);

  // 2. Shared System Chrome (metaDir option set = managed-to-chrome): sibling info_cache entries must stay intact!
  const sysDir = path.join(root, 'system-chrome');
  const sysP2 = path.join(sysDir, 'Profile 2');
  mkdirSync(sysP2, { recursive: true });
  writeFileSync(path.join(sysP2, 'Preferences'), JSON.stringify({ profile: { name: 'Migrated One' } }));
  writeFileSync(path.join(sysP2, '.webmcp-meta.json'), JSON.stringify({ name: 'Migrated One' }));
  writeFileSync(path.join(sysDir, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: { name: 'Main Personal' },
        'Profile 2': { name: 'Migrated One', gaia_id: '999', user_name: 'x@gmail.com', is_consented_primary_account: true },
      },
    },
  }));
  detoxForkedManagedProfile(sysDir, 'Profile 2', { metaDir: sysP2 });
  const sysLsAfter = JSON.parse(readFileSync(path.join(sysDir, 'Local State'), 'utf8'));
  assert.deepEqual(Object.keys(sysLsAfter.profile.info_cache).sort(), ['Default', 'Profile 2'], 'managed-to-chrome must preserve sibling System Chrome profiles');
  assert.equal(sysLsAfter.profile.info_cache['Profile 2'].user_name, undefined);

  // 3. launchChrome self-heals a already-detoxed Managed Profile whose Local State still has sibling leakage
  const alreadyDetoxed = path.join(managedDir, 'already-detoxed');
  mkdirSync(path.join(alreadyDetoxed, 'Default'), { recursive: true });
  writeFileSync(path.join(alreadyDetoxed, '.webmcp-meta.json'), JSON.stringify({
    name: 'Clean Name',
    profileDir: 'Default',
    detoxedForManaged: true,
  }));
  writeFileSync(path.join(alreadyDetoxed, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: { name: 'Your Chrome' },
        'Profile 99': { name: 'Ghost Sibling' },
      },
    },
  }));
  await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: alreadyDetoxed, profileDir: 'Default' },
    managedProfilesDir: managedDir,
    extensionPath: fakeExtensionDir(root),
    chromePath: process.execPath,
    sessionsFile: path.join(root, 'sessions.json'),
    extraArgs: ['-e', 'process.exit(0)'],
  });
  const healedLs = JSON.parse(readFileSync(path.join(alreadyDetoxed, 'Local State'), 'utf8'));
  assert.deepEqual(Object.keys(healedLs.profile.info_cache), ['Default']);
  assert.equal(healedLs.profile.info_cache.Default.name, 'Clean Name');
  assert.equal(typeof sanitizeManagedLocalState, 'function');
});

test('launcher: expandTilde works without ReferenceError, mode=existing never pollutes managedSessions, and locked existing --proxy-server returns hint', async (t) => {
  const { homedir } = require('os');
  const root = tempRoot();
  t.after(() => { try { spawnSync('rm', ['-rf', root]); } catch {} });

  // 1. expandTilde via matchChromePidInPsOutput
  assert.equal(
    launcher.matchChromePidInPsOutput('  777 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=~/my-prof --profile-directory=Default', {
      userDataDir: path.join(homedir(), 'my-prof'),
      profileDir: 'Default',
    }),
    777,
  );

  // 2. mode=existing never checks hasLiveManagedSession and never calls rememberManagedSession
  const existingUdd = path.join(root, 'sys-chrome');
  mkdirSync(path.join(existingUdd, 'Default'), { recursive: true });
  const sessionsFile = path.join(root, 'sessions.json');
  launcher.rememberManagedSession(existingUdd, process.pid, sessionsFile);
  const fakeBin = path.join(root, 'fake-chrome.sh');
  writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeBin, 0o755);

  const existingDry = await launcher.launchChrome({
    mode: 'existing',
    profile: { kind: 'existing', userDataDir: existingUdd, profileDir: 'Default' },
    chromePath: fakeBin,
    extensionPath: fakeExtensionDir(root),
    sessionsFile,
    dryRun: true,
  });
  assert.equal(existingDry.ok, true);
  assert.equal(existingDry.attached, false);

  // Reset sessionsFile and run non-dryRun existing launch -> managedSessions must stay empty
  launcher.saveSessions({ version: 1, managedSessions: {}, gateway: null }, sessionsFile);
  const existingRun = await launcher.launchChrome({
    mode: 'existing',
    profile: { kind: 'existing', userDataDir: existingUdd, profileDir: 'Default' },
    chromePath: process.execPath,
    extensionPath: fakeExtensionDir(root),
    sessionsFile,
    extraArgs: ['-e', 'process.exit(0)'],
  });
  assert.equal(existingRun.ok, true);
  assert.deepEqual(launcher.loadSessions(sessionsFile).managedSessions, {});

  // 3. Locked existing profile with --proxy-server= returns proxy hint in message
  writeFileSync(path.join(existingUdd, 'SingletonLock'), '');
  const lockedProxy = await launcher.launchChrome({
    mode: 'existing',
    profile: { kind: 'existing', userDataDir: existingUdd, profileDir: 'Default' },
    chromePath: fakeBin,
    extensionPath: fakeExtensionDir(root),
    sessionsFile,
    extraArgs: ['--proxy-server=http://127.0.0.1:8080'],
  });
  assert.equal(lockedProxy.ok, false);
  assert.equal(lockedProxy.needsRelaunch, true);
  assert.match(lockedProxy.message, /--proxy-server requires closing Chrome first or converting this profile to Managed/);
});

test('launchChrome managed applies meta.proxy (strips creds + sets proxyAuthWarning) and meta.fingerprint (TZ, --lang)', async (t) => {
  const root = tempRoot();
  t.after(() => { try { spawnSync('rm', ['-rf', root]); } catch {} });
  const managedDir = path.join(root, 'managed-profiles');
  const extensionPath = fakeExtensionDir(root);
  const sessionsFile = path.join(root, 'sessions.json');

  const pAuth = path.join(managedDir, 'auth-proxy');
  mkdirSync(path.join(pAuth, 'Default'), { recursive: true });
  writeFileSync(path.join(pAuth, '.webmcp-meta.json'), JSON.stringify({
    name: 'auth-proxy',
    proxy: { url: 'http://user:secret@10.0.0.5:8080', timezone: 'Asia/Ho_Chi_Minh' },
    fingerprint: { locale: 'vi-VN', timezone: 'America/New_York' },
  }));

  const resAuth = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: pAuth },
    chromePath: process.execPath,
    extensionPath,
    managedProfilesDir: managedDir,
    sessionsFile,
    dryRun: true,
  });
  assert.equal(resAuth.ok, true);
  assert.ok(resAuth.args.includes('--proxy-server=http://10.0.0.5:8080'));
  assert.ok(resAuth.args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(resAuth.args.includes('--lang=vi-VN'));
  assert.equal(resAuth.tz, 'Asia/Ho_Chi_Minh');
  assert.ok(typeof resAuth.proxyAuthWarning === 'string' && resAuth.proxyAuthWarning.length > 0);
  assert.equal(resAuth.args.some((a) => a.includes('user:secret')), false);

  // Attached branch receives effectiveEnv (TZ from fingerprint when proxy has no timezone)
  const pFp = path.join(managedDir, 'fp-only');
  mkdirSync(path.join(pFp, 'Default'), { recursive: true });
  writeFileSync(path.join(pFp, '.webmcp-meta.json'), JSON.stringify({
    name: 'fp-only',
    fingerprint: { locale: 'en-US', timezone: 'Europe/London' },
  }));
  launcher.rememberManagedSession(pFp, process.pid, sessionsFile);
  const resAttached = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: pFp },
    chromePath: process.execPath,
    extensionPath,
    managedProfilesDir: managedDir,
    sessionsFile,
    dryRun: true,
  });
  assert.equal(resAttached.attached, true);
  assert.equal(resAttached.tz, 'Europe/London');
  assert.ok(resAttached.args.includes('--lang=en-US'));
});

test('profile-fork ignores all 8 BUILTIN_EXTENSION_IDS and sanitizeManagedLocalState supports options.forceName', (t) => {
  const { detoxForkedManagedProfile, sanitizeManagedLocalState } = require(path.join(ROOT, 'chrome-launcher', 'profile-fork'));
  const root = tempRoot();
  t.after(() => { try { spawnSync('rm', ['-rf', root]); } catch {} });
  const ud = path.join(root, 'builtins-check');
  const pdir = path.join(ud, 'Default');
  const thirdParty = 'dddddddddddddddddddddddddddddddd';
  const extraBuiltins = [
    'pkedcjkdefgpdelpbcmbmeomcjbeemfm',
    'mhjfbmdgcfjbbpaeojofohoefgiehjai',
    'ahfgeienlihckogmohjhadlkjgocpleb',
    'nkeimhogjdpnpccoofpliimaahmaaome',
    'fignfifoniblkonapihmkfakmlgkbkcf',
    'admccjkmockfdflocgggjfgdacdodkdf',
  ];
  mkdirSync(pdir, { recursive: true });
  const settings = { [thirdParty]: { from_webstore: true, location: 1 } };
  for (const id of extraBuiltins) settings[id] = { from_webstore: true, location: 1 };
  writeFileSync(path.join(pdir, 'Preferences'), '{}');
  writeFileSync(path.join(pdir, 'Secure Preferences'), JSON.stringify({ extensions: { settings } }));
  writeFileSync(path.join(ud, '.webmcp-meta.json'), JSON.stringify({ name: 'CustomName', profileDir: 'Default' }));

  const detoxRes = detoxForkedManagedProfile(ud, 'Default');
  assert.deepEqual(detoxRes.discoveredExtensions, [thirdParty]);

  writeFileSync(path.join(ud, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Old Non-Generic Name' } } } }));
  sanitizeManagedLocalState(ud, 'Default', 'Forced Name', { forceName: true });
  const ls = JSON.parse(readFileSync(path.join(ud, 'Local State'), 'utf8'));
  assert.equal(ls.profile.info_cache.Default.name, 'Forced Name');
  assert.equal(ls.profile.info_cache.Default.is_using_default_name, false);
});
