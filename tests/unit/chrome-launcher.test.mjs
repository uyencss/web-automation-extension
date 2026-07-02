import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp.mjs');
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
