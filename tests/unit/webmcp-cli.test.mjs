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
    'workflow-dispatcher/tests/fixtures/minimal-workflow.json',
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
      WEBMCP_WORKFLOW_DISPATCHER_BIN: './missing-workflow-dispatcher.js',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workflow dispatcher CLI not found/);
  assert.match(result.stderr, /Install @gyga-browser\/webmcp-workflow/);
});
