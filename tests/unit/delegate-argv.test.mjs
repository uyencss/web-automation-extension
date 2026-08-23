import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp.mjs');
const HOSTILE = '/tmp/demo workspace – dự án "$HOME" `printf sentinel` ; | & > $(printf sentinel) \'quoted\'';

function captureProgram(t) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'webmcp-delegate-argv-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const file = path.join(fixtureRoot, 'capture.mjs');
  writeFileSync(file, [
    '#!/usr/bin/env node',
    "process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\\n`);",
    '',
  ].join('\n'));
  chmodSync(file, 0o755);
  return { file, fixtureRoot };
}

function invoke(command, args, env) {
  return spawnSync(process.execPath, [BIN, command, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 5000,
  });
}

test('optional CLI delegates preserve Unicode, spaces and shell metacharacters as exact argv elements', (t) => {
  const { file, fixtureRoot } = captureProgram(t);
  const args = ['probe', HOSTILE, '--literal', 'semi;pipe|amp&dollar$'];
  const cases = [
    ['workflow', 'WEBMCP_WORKFLOW_DISPATCHER_BIN'],
    ['ai', 'WEBMCP_AI_BIN'],
    ['vault', 'WEBMCP_VAULT_BIN'],
    ['site', 'WEBMCP_STORE_BIN'],
    ['automation', 'WEBMCP_AUTOMATION_BIN'],
    ['captcha', 'WEBMCP_CAPTCHA_BIN'],
  ];

  for (const [command, override] of cases) {
    const result = invoke(command, args, {
      WEBMCP_HOME: path.join(fixtureRoot, '.webmcp'),
      [override]: file,
    });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), args, `${command} changed argv boundaries`);
  }
});

test('mobile MCP delegation remains lazy and invokes the resolved server with an empty argv vector', (t) => {
  const { file, fixtureRoot } = captureProgram(t);
  const result = invoke('mobile', ['mcp'], {
    WEBMCP_HOME: path.join(fixtureRoot, '.webmcp'),
    WEBMCP_ADB_MCP_BIN: file,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});
