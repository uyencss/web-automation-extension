import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
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

  writeFileSync(path.join(srcUserData, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }, null, 2));
  writeFileSync(path.join(srcProfilePath, 'Preferences'), JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false } }, null, 2));
  writeFileSync(path.join(srcProfilePath, 'Network', 'Cookies'), 'dummy-cookies-data');
  writeFileSync(path.join(srcProfilePath, 'Cache', 'data_0'), 'cache-data');
  writeFileSync(path.join(srcProfilePath, 'Code Cache', 'js', 'data_1'), 'code-cache-data');
  writeFileSync(path.join(srcProfilePath, 'GPUCache', 'data_2'), 'gpu-cache-data');

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
