import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIDGE_BIN = path.join(ROOT, 'bin', 'webmcp-browser.mjs');
const SHIM_BIN = path.join(ROOT, 'bin', 'webmcp.mjs');

function run(bin, args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, WEBMCP_NO_AUTOSTART: '1', ...(options.env ?? {}) },
    timeout: options.timeout ?? 5000,
  });
}

test('browser bridge --version prints 1.0.35 with stdout purity', () => {
  const result = run(BRIDGE_BIN, ['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '1.0.35\n');
  assert.equal(result.stderr, '');
});

test('browser bridge --help is byte-identical to webmcp --help with stdout purity', () => {
  const bridge = run(BRIDGE_BIN, ['--help']);
  const shim = run(SHIM_BIN, ['--help']);
  assert.equal(bridge.status, 0, bridge.stderr);
  assert.equal(bridge.stderr, '');
  assert.equal(shim.status, 0, shim.stderr);
  assert.equal(bridge.stdout, shim.stdout);
});

test('browser bridge with no args prints help and exits 1 like the shim', () => {
  const bridge = run(BRIDGE_BIN, []);
  const shim = run(SHIM_BIN, []);
  assert.equal(bridge.status, 1);
  assert.equal(bridge.stdout, shim.stdout);
  assert.equal(bridge.stderr, '');
  assert.equal(shim.stderr, '');
});

test('browser bridge unknown command reports stderr diagnostic and exits 1', () => {
  const result = run(BRIDGE_BIN, ['definitely-unknown']);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Unknown command: definitely-unknown\n');
  const help = run(BRIDGE_BIN, ['--help']);
  assert.equal(result.stdout, help.stdout);
});

test('browser bridge mcp --help exits without starting the MCP adapter', () => {
  const result = run(BRIDGE_BIN, ['mcp', '--help'], { timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp mcp/);
  assert.match(result.stdout, /stdio MCP adapter/);
});

test('browser bridge resolves package-relative resources from an unrelated cwd', () => {
  const result = run(BRIDGE_BIN, ['--version'], { cwd: tmpdir() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '1.0.35\n');
  assert.equal(result.stderr, '');
  const help = run(BRIDGE_BIN, ['--help'], { cwd: '/tmp' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /webmcp mcp/);
});

test('shim parity: webmcp --version and --help are byte-identical to the bridge', () => {
  const bridgeVersion = run(BRIDGE_BIN, ['--version']);
  const shimVersion = run(SHIM_BIN, ['--version']);
  assert.equal(shimVersion.status, 0, shimVersion.stderr);
  assert.equal(shimVersion.stdout, bridgeVersion.stdout);
  assert.equal(shimVersion.stdout, '1.0.35\n');
  assert.equal(shimVersion.stderr, '');

  const bridgeHelp = run(BRIDGE_BIN, ['--help']);
  const shimHelp = run(SHIM_BIN, ['--help']);
  assert.equal(shimHelp.status, 0, shimHelp.stderr);
  assert.equal(shimHelp.stdout, bridgeHelp.stdout);
  assert.equal(shimHelp.stderr, '');
});

test('shim delegates through an explicit relative import to the sibling bridge', () => {
  const source = readFileSync(SHIM_BIN, 'utf8');
  assert.match(source, /from\s+['"]\.\/webmcp-browser\.mjs['"]|import\s+['"]\.\/webmcp-browser\.mjs['"]/);
});

test('shim contains no PATH-based webmcp invocation (static anti-recursion)', () => {
  const source = readFileSync(SHIM_BIN, 'utf8');
  assert.doesNotMatch(source, /process\.env\.PATH/);
  assert.doesNotMatch(source, /spawnSync\s*\(\s*['"]webmcp['"]/);
  assert.doesNotMatch(source, /execFileSync\s*\(\s*['"]webmcp['"]/);
  assert.doesNotMatch(source, /['"]webmcp['"]\s*\)/);
  assert.ok(!source.includes("'webmcp'") || source.includes('webmcp-browser'), 'shim must not reference bare webmcp command');
  assert.ok(!source.includes('"webmcp"'), 'shim must not reference bare webmcp command');
});

test('shim never resolves webmcp from PATH even when a hostile fake precedes it (behavioral anti-recursion)', (t) => {
  const poisonDir = mkdtempSync(path.join(tmpdir(), 'webmcp-path-poison-'));
  t.after(() => rmSync(poisonDir, { recursive: true, force: true }));
  const marker = path.join(poisonDir, 'invoked.marker');
  const fakeBin = path.join(poisonDir, 'webmcp');
  writeFileSync(fakeBin, `#!/bin/sh\necho RECURSION\ntouch ${JSON.stringify(marker)}\nexit 7\n`);
  chmodSync(fakeBin, 0o755);
  const result = spawnSync(process.execPath, [SHIM_BIN, '--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      WEBMCP_NO_AUTOSTART: '1',
      PATH: `${poisonDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr} stdout: ${result.stdout}`);
  assert.equal(result.stdout, '1.0.35\n');
  assert.equal(result.stderr, '');
  assert.equal(existsSync(marker), false, 'hostile PATH webmcp must never be invoked');
});
