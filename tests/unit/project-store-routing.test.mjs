import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp.mjs');
const WORKSPACE_ROOT = path.resolve(ROOT, '..');

function createCaptureRunner(home, { exitCode = 0 } = {}) {
  const runnerBin = path.join(home, 'capture-runner.mjs');
  writeFileSync(runnerBin, [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    'appendFileSync(process.env.WEBMCP_TEST_RUNNER_CAPTURE_FILE, `${JSON.stringify(args)}\\n`);',
    "process.stdout.write('RUNNER_STDOUT_MARKER\\n');",
    "process.stderr.write('RUNNER_STDERR_MARKER\\n');",
    `process.exit(${exitCode});`,
    '',
  ].join('\n'));
  return runnerBin;
}

function runUmbrella(t, args, { exitCode = 0 } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-project-routing-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.webmcp'), { recursive: true });
  const captureFile = path.join(home, 'runner-calls.jsonl');
  writeFileSync(captureFile, '');
  const runnerBin = createCaptureRunner(home, { exitCode });
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      WEBMCP_HOME: path.join(home, '.webmcp'),
      WEBMCP_RUNNER_BIN: runnerBin,
      WEBMCP_TEST_RUNNER_CAPTURE_FILE: captureFile,
    },
  });
  return {
    result,
    capturedCalls: readFileSync(captureFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line)),
  };
}

test('project init-store delegates the full argv vector to the Runner', (t) => {
  const { result, capturedCalls } = runUmbrella(t,
    ['project', 'init-store', '--at', '/tmp/demo-workspace', '--id', 'demo', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedCalls, [
    ['project', 'init-store', '--at', '/tmp/demo-workspace', '--id', 'demo', '--json'],
  ]);
});

test('argument values with spaces, Unicode and shell metacharacters are preserved verbatim and never executed', (t) => {
  // R6.1: the bridge must forward the raw argument array. This value contains
  // spaces, Vietnamese diacritics, quotes and shell-looking text that would
  // break or escalate under any string-concatenation/shell execution. The
  // shell-looking fragments are harmless sentinels only — this test must never
  // risk a destructive command even if the router regresses into shell mode.
  const hostileValue = '/tmp/demo workspace – dự án "$HOME" `printf %s sentinel` ; | & > $(printf %s sentinel) \'quoted\'';
  const { result, capturedCalls } = runUmbrella(t,
    ['project', 'init-store', '--at', hostileValue, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedCalls, [
    ['project', 'init-store', '--at', hostileValue, '--json'],
  ], 'R6.1/E: every argv element — including values with spaces, Unicode and shell '
    + 'metacharacters — must arrive at the Runner byte-identical and as separate array entries');
  assert.equal(result.stdout.includes('RUNNER_STDOUT_MARKER'), true,
    'the delegated run must still complete normally through the fake Runner');
});

test('project init is an alias that routes to Runner project init-store', (t) => {
  const { result, capturedCalls } = runUmbrella(t, ['project', 'init', '--dry-run', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedCalls, [['project', 'init-store', '--dry-run', '--json']]);
});

test('project build-index routes to the Runner and preserves its stdout and stderr', (t) => {
  const { result, capturedCalls } = runUmbrella(t,
    ['project', 'build-index', '--workspace', WORKSPACE_ROOT, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedCalls, [
    ['project', 'build-index', '--workspace', WORKSPACE_ROOT, '--json'],
  ]);
  assert.ok(result.stdout.includes('RUNNER_STDOUT_MARKER'),
    'R6.1: the umbrella bridge must preserve the child stdout stream');
  assert.ok(result.stderr.includes('RUNNER_STDERR_MARKER'),
    'R6.1: the umbrella bridge must preserve the child stderr stream');
});

test('project content plan maps public --at to Runner --workspace and preserves clean forwarding', (t) => {
  const workspace = '/tmp/content overlay workspace';
  const { result, capturedCalls } = runUmbrella(t,
    ['project', 'content', 'plan', '--at', workspace, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedCalls, [
    ['project', 'content', 'plan', '--workspace', workspace, '--json'],
  ]);
  assert.equal(result.stdout, 'RUNNER_STDOUT_MARKER\n');
  assert.equal(result.stderr, 'RUNNER_STDERR_MARKER\n');
});

test('project content apply forwards --yes and maps public --at without touching filesystem', (t) => {
  const workspace = '/tmp/content apply workspace';
  const { result, capturedCalls } = runUmbrella(t,
    ['project', 'content', 'apply', '--at', workspace, '--yes', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedCalls, [
    ['project', 'content', 'apply', '--workspace', workspace, '--yes', '--json'],
  ]);
  assert.equal(result.stdout, 'RUNNER_STDOUT_MARKER\n');
});

test('project content rejects duplicate or mixed project-location aliases before invoking Runner', (t) => {
  const ambiguousLocations = [
    ['--at', '/tmp/one', '--at', '/tmp/two'],
    ['--at=/tmp/one', '--at=/tmp/two'],
    ['--at', '/tmp/one', '--at=/tmp/two'],
    ['--at=/tmp/one', '--workspace', '/tmp/two'],
    ['--at', '/tmp/one', '--workspace=/tmp/two'],
    ['--workspace', '/tmp/one', '--workspace', '/tmp/two'],
    ['--workspace=/tmp/one', '--workspace=/tmp/two'],
  ];

  for (const action of ['plan', 'apply']) {
    for (const locationArgs of ambiguousLocations) {
      const { result, capturedCalls } = runUmbrella(t,
        ['project', 'content', action, ...locationArgs, ...(action === 'apply' ? ['--yes'] : []), '--json']);
      assert.equal(result.status, 2, `${action} ${locationArgs.join(' ')}`);
      assert.match(result.stderr, /^USAGE_ERROR: project content accepts exactly one project location\n?$/);
      assert.deepEqual(capturedCalls, [], `${action} ${locationArgs.join(' ')} invoked Runner`);
    }
  }
});

test('project policy plan maps public --at to Runner --workspace and keeps JSON forwarding clean', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-policy-plan-routing-'));
  const workspace = path.join(home, 'project workspace');
  const { result, capturedCalls } = runUmbrella(t,
    ['project', 'policy', 'plan', '--at', workspace, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedCalls, [[
    'project', 'policy', 'plan', '--workspace', workspace, '--json',
  ]]);
  assert.equal(result.stdout, 'RUNNER_STDOUT_MARKER\n');
  assert.equal(result.stderr, 'RUNNER_STDERR_MARKER\n');
});

test('project policy apply maps --at, preserves --yes, and --all routes without a filesystem write', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-policy-apply-routing-'));
  const workspace = path.join(home, 'project workspace');
  const routed = runUmbrella(t,
    ['project', 'policy', 'apply', '--at', workspace, '--yes', '--json']);
  assert.equal(routed.result.status, 0, routed.result.stderr);
  assert.deepEqual(routed.capturedCalls, [[
    'project', 'policy', 'apply', '--workspace', workspace, '--yes', '--json',
  ]]);

  const all = runUmbrella(t, ['project', 'policy', 'plan', '--all', '--json']);
  assert.equal(all.result.status, 0, all.result.stderr);
  assert.deepEqual(all.capturedCalls, [['project', 'policy', 'plan', '--all', '--json']]);
});

test('project policy rejects missing --yes and --force before invoking Runner', (t) => {
  for (const args of [
    ['project', 'policy', 'apply', '--at', '/portable/project', '--json'],
    ['project', 'policy', 'apply', '--at', '/portable/project', '--yes', '--force', '--json'],
  ]) {
    const { result, capturedCalls } = runUmbrella(t, args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(capturedCalls.length, 0, `${args.join(' ')} invoked Runner`);
    assert.match(result.stderr, /Usage: webmcp project policy apply/);
  }
});

test('project export-pack routes to the Runner with arguments intact', (t) => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'webmcp-export-pack-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const { result, capturedCalls } = runUmbrella(t,
    ['project', 'export-pack', '--select', 'affiliate/shopee/flash-sale',
      '--output', outDir, '--alias', 'operator-vn', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedCalls, [
    ['project', 'export-pack', '--select', 'affiliate/shopee/flash-sale',
      '--output', outDir, '--alias', 'operator-vn', '--json'],
  ]);
});

test('the umbrella propagates a nonzero Runner exit code unchanged', (t) => {
  const { result, capturedCalls } = runUmbrella(t,
    ['project', 'build-index', '--workspace', WORKSPACE_ROOT], { exitCode: 7 });
  assert.equal(result.status, 7,
    'R6.1: exit code of the delegated Runner command must be preserved verbatim');
  assert.equal(capturedCalls.length, 1,
    'the delegated command must still have reached the Runner exactly once');
});

test('an unknown project subcommand fails typed with exit code 2 without invoking the Runner', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-project-unknown-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.webmcp'), { recursive: true });
  const captureFile = path.join(home, 'runner-calls.jsonl');
  const runnerBin = createCaptureRunner(home);
  const result = spawnSync(process.execPath, [BIN, 'project', 'not-a-command'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      WEBMCP_HOME: path.join(home, '.webmcp'),
      WEBMCP_RUNNER_BIN: runnerBin,
      WEBMCP_TEST_RUNNER_CAPTURE_FILE: captureFile,
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown project command/);
  assert.equal(existsSync(captureFile) ? readFileSync(captureFile, 'utf8').trim() : '', '',
    'the unknown subcommand must not reach the Runner at all');
});

test('project help documents exactly the canonical store commands (help parity)', (t) => {
  const { result } = runUmbrella(t, ['project', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project init-store/);
  assert.match(result.stdout, /project build-index/);
  assert.match(result.stdout, /project export-pack/);
  assert.match(result.stdout, /project content plan --at <dir> --json/);
  assert.match(result.stdout, /project content apply --at <dir> --yes --json/);
});
