import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('webmcp mcp --help exits without starting the stdio adapter', () => {
  const result = spawnSync(process.execPath, [BIN, 'mcp', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 3000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp mcp/);
  assert.match(result.stdout, /stdio MCP adapter/);
});

test('webmcp doctor reports MCP readiness, config state, and gateway health as JSON', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-doctor-'));
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  writeFileSync(path.join(home, '.codex', 'config.toml'), [
    '[mcp_servers.webmcp]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify([path.join(ROOT, 'server', 'mcp_server.mjs')])}`,
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      HOME: home,
      WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
      WEBMCP_NO_AUTOSTART: '1',
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'webmcp-doctor/1');
  assert.equal(report.mcp.ok, true, report.mcp.error);
  assert.ok(report.mcp.toolCount > 0);
  assert.equal(report.config.codex.registered, true);
  assert.equal(report.config.codex.healthy, true);
  assert.equal(report.gateway.ok, false);
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

test('webmcp site resolves the Site Store from a monorepo checkout', () => {
  const result = spawnSync(process.execPath, [BIN, 'site', 'list-capabilities', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.capabilities.length > 0);
  assert.match(payload.capabilities[0].id, /^[a-z0-9-]+\/[a-z0-9-]+$/);
});

test('webmcp store remains a deprecated compatibility route', () => {
  const result = spawnSync(process.execPath, [BIN, 'store', 'list'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Deprecation: 'webmcp store' is now 'webmcp site'/);
  assert.match(result.stdout, /Site Store Capabilities/);
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

test('webmcp automation delegates to the Automation Store CLI', () => {
  const result = spawnSync(process.execPath, [BIN, 'automation', 'list', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.automations.length > 0);
});

test('webmcp automation help uses the umbrella command name', () => {
  const result = spawnSync(process.execPath, [BIN, 'automation', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp automation run <id>/);
});

test('webmcp automation reports a clear install hint when unavailable', () => {
  const result = spawnSync(process.execPath, [BIN, 'automation', 'list'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_AUTOMATION_BIN: './missing-webmcp-automation.mjs',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /WebMCP Automation Store CLI not found/);
  assert.match(result.stderr, /WEBMCP_AUTOMATION_BIN/);
});

test('webmcp mobile exposes the ADB MCP entry point without starting it from help', () => {
  const result = spawnSync(process.execPath, [BIN, 'mobile', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp mobile mcp/);
  assert.match(result.stdout, /webmcp adb mcp/);
});

test('webmcp mobile reports a clear install hint when ADB Kit is unavailable', () => {
  const result = spawnSync(process.execPath, [BIN, 'mobile', 'mcp'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_ADB_MCP_BIN: './missing-webmcp-adb-server.mjs',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /WebMCP ADB MCP server not found/);
  assert.match(result.stderr, /WEBMCP_ADB_MCP_BIN/);
});

test('webmcp skills exposes the central 16-skill inventory', () => {
  const result = spawnSync(process.execPath, [BIN, 'skills', 'list', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema, 'webmcp-skills/1');
  assert.equal(payload.skills.length, 16);
  assert.ok(payload.skills.every((skill) => skill.available));
});

test('webmcp skills path and doctor resolve canonical local sources', () => {
  const skillPath = spawnSync(process.execPath, [BIN, 'skills', 'path', 'webmcp-workflow-cli'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });
  assert.equal(skillPath.status, 0, skillPath.stderr);
  assert.match(skillPath.stdout.trim(), /packages\/webmcp-workflow-cli\/skills\/webmcp-workflow-cli$/);

  const doctor = spawnSync(process.execPath, [BIN, 'skills', 'doctor', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.deepEqual(JSON.parse(doctor.stdout).missing, []);
});

test('webmcp skills adopt and prune remove an explicitly adopted legacy skill', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-cli-skills-'));
  const legacy = path.join(home, '.codex/skills/workflow-dispatcher-cli');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, 'SKILL.md'), '---\nname: workflow-dispatcher-cli\ndescription: legacy\n---\n');
  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_KIT_MANIFEST: path.resolve(ROOT, '..', '..', 'webmcp-kit.json'),
  };

  let result = spawnSync(process.execPath, [BIN, 'skills', 'adopt', '--provider', 'codex', '--yes'], {
    cwd: WORKSPACE_ROOT, encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(path.join(home, '.webmcp/skills/install-receipt.json'), 'utf8'));
  assert.ok(receipt.providers.codex.entries.includes('workflow-dispatcher-cli'));

  result = spawnSync(process.execPath, [BIN, 'skills', 'prune', '--yes'], {
    cwd: WORKSPACE_ROOT, encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(legacy));
});
