import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp.mjs');
const WORKSPACE_ROOT = path.resolve(ROOT, '..');

test('webmcp workflow delegates to the workflow dispatcher CLI', () => {
  const result = spawnSync(process.execPath, [
    BIN,
    'workflow',
    'dry-run',
    'webmcp-workflow-cli/tests/fixtures/minimal-workflow.json',
    '--json',
    '--no-history',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.workflow.id, 'minimal');
  assert.equal(payload.validation.valid, true);
});

test('webmcp workflow help uses the webmcp workflow command name', () => {
  const result = spawnSync(process.execPath, [BIN, 'workflow', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp workflow <command> \[options\]/);
  assert.match(result.stdout, /webmcp workflow run example-title/);
});

test('webmcp workflow reports a clear install hint when dispatcher is unavailable', () => {
  const result = spawnSync(process.execPath, [BIN, 'workflow', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_WORKFLOW_DISPATCHER_BIN: './missing-webmcp-workflow-cli.js',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workflow dispatcher CLI not found/);
  assert.match(result.stderr, /Install @gyga-browser\/webmcp-workflow/);
});

test('webmcp ai delegates to the standalone AI CLI', () => {
  const result = spawnSync(process.execPath, [BIN, 'ai', 'providers', 'list', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.providers.map((provider) => provider.id), ['agy', 'claude', 'codex']);
});

test('webmcp ai help uses the umbrella command name', () => {
  const result = spawnSync(process.execPath, [BIN, 'ai', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp ai <command>/);
});

test('webmcp ai reports a clear install hint when the CLI is unavailable', () => {
  const result = spawnSync(process.execPath, [BIN, 'ai', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_AI_BIN: './missing-webmcp-ai.mjs',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /WebMCP AI CLI not found/);
  assert.match(result.stderr, /Install @gyga-browser\/webmcp-ai/);
});

test('webmcp extension-info prints published Chrome Web Store metadata', () => {
  const result = spawnSync(process.execPath, [BIN, 'extension-info', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.id, 'lbodkmkjbcemodklopcfdmpjomdoapae');
  assert.equal(
    payload.chromeWebStoreUrl,
    'https://chromewebstore.google.com/detail/webmcp-tools-provider/lbodkmkjbcemodklopcfdmpjomdoapae',
  );
  assert.match(payload.unpackedExtensionPath, /webmcp-extension\/dist$/);
});

test('webmcp vault delegates to the vault CLI', () => {
  const result = spawnSync(process.execPath, [BIN, 'vault', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp-vault — local encrypted credential vault/);
});

test('webmcp vault reports a clear install hint when vault is unavailable', () => {
  const result = spawnSync(process.execPath, [BIN, 'vault', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_VAULT_BIN: './missing-webmcp-vault.js',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /WebMCP vault CLI not found/);
  assert.match(result.stderr, /Install @gyga-browser\/webmcp-vault-kit/);
});
