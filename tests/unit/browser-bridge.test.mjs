import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIDGE_BIN = path.join(ROOT, 'bin', 'webmcp-browser.mjs');

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

test('browser bridge --help has stdout purity', () => {
  const bridge = run(BRIDGE_BIN, ['--help']);
  assert.equal(bridge.status, 0, bridge.stderr);
  assert.equal(bridge.stderr, '');
  assert.match(bridge.stdout, /webmcp-browser mcp/);
});

test('browser bridge with no args prints help and exits 1', () => {
  const bridge = run(BRIDGE_BIN, []);
  assert.equal(bridge.status, 1);
  const help = run(BRIDGE_BIN, ['--help']);
  assert.equal(bridge.stdout, help.stdout);
  assert.equal(bridge.stderr, '');
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
  assert.match(result.stdout, /webmcp-browser mcp/);
  assert.match(result.stdout, /stdio MCP adapter/);
});

test('browser bridge resolves package-relative resources from an unrelated cwd', () => {
  const result = run(BRIDGE_BIN, ['--version'], { cwd: tmpdir() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '1.0.35\n');
  assert.equal(result.stderr, '');
  const help = run(BRIDGE_BIN, ['--help'], { cwd: '/tmp' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /webmcp-browser mcp/);
});
