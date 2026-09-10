import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBMCP_BIN = path.join(ROOT, 'bin', 'webmcp.mjs');
const WEBMCP_BROWSER_BIN = path.join(ROOT, 'bin', 'webmcp-browser.mjs');
const PROFILE_POOL_BIN = path.join(ROOT, 'bin', 'profile-pool.mjs');
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HELP_SHA256 = '9863be6c2ace4e2ccf4cd947744334bc786963da979fbcac664b005be17253bf';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const lineCount = (file) => readFileSync(file, 'utf8').trimEnd().split('\n').length;

function run(args) {
  return spawnSync(process.execPath, [WEBMCP_BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_NO_AUTOSTART: '1' },
    timeout: 5000,
  });
}

test('top-level help, version and unknown-command process contracts match the frozen HEAD', () => {
  const noArgs = run([]);
  assert.equal(noArgs.status, 1);
  assert.equal(sha256(noArgs.stdout), HELP_SHA256);
  assert.equal(sha256(noArgs.stderr), EMPTY_SHA256);

  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.equal(sha256(help.stdout), HELP_SHA256);
  assert.equal(sha256(help.stderr), EMPTY_SHA256);

  const version = run(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, '1.0.35\n');
  assert.equal(version.stderr, '');

  const unknown = run(['definitely-unknown']);
  assert.equal(unknown.status, 1);
  assert.equal(sha256(unknown.stdout), HELP_SHA256);
  assert.equal(unknown.stderr, 'Unknown command: definitely-unknown\n');
});

test('public Browser Kit entrypoints are compatibility shims no longer than 15 lines', () => {
  assert.ok(lineCount(WEBMCP_BIN) <= 15, `webmcp bin is ${lineCount(WEBMCP_BIN)} lines`);
  assert.ok(lineCount(WEBMCP_BROWSER_BIN) <= 15, `webmcp-browser bin is ${lineCount(WEBMCP_BROWSER_BIN)} lines`);
  assert.ok(lineCount(PROFILE_POOL_BIN) <= 15, `profile-pool bin is ${lineCount(PROFILE_POOL_BIN)} lines`);
});

test('webmcp compatibility shim delegates to the sibling webmcp-browser bridge', () => {
  assert.equal(existsSync(WEBMCP_BROWSER_BIN), true, 'canonical webmcp-browser bridge must exist');
  const shim = readFileSync(WEBMCP_BIN, 'utf8');
  assert.match(shim, /from\s+['"]\.\/webmcp-browser\.mjs['"]|import\s+['"]\.\/webmcp-browser\.mjs['"]/);
  assert.doesNotMatch(shim, /process\.env\.PATH/);
  assert.doesNotMatch(shim, /spawnSync\s*\(\s*['"]webmcp['"]/);
  assert.doesNotMatch(shim, /execFileSync\s*\(\s*['"]webmcp['"]/);
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.bin['webmcp'], 'bin/webmcp.mjs');
  assert.equal(manifest.bin['webmcp-browser'], 'bin/webmcp-browser.mjs');
});

test('package closure explicitly ships the modular CLI and legacy profile-pool implementation', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(manifest.files.includes('lib/'), 'package files allowlist must include lib/');
  assert.equal(existsSync(path.join(ROOT, 'lib', 'cli', 'main.mjs')), true);
  assert.equal(existsSync(path.join(ROOT, 'lib', 'cli', 'router.mjs')), true);
  assert.equal(existsSync(path.join(ROOT, 'lib', 'profile-pool', 'cli.mjs')), true);
});
