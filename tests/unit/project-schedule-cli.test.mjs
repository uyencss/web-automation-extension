import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp-browser.mjs');
const WORKSPACE_ROOT = path.resolve(ROOT, '..');
const SCHEDULE_SOURCE = path.join(ROOT, 'lib', 'cli', 'commands', 'project', 'schedule.mjs');
const DEV_STORE_ROOT = path.join(WORKSPACE_ROOT, 'stores', 'webmcp-automation-store');
const HAS_DEV_STORE = existsSync(path.join(DEV_STORE_ROOT, 'lib', 'schedule', 'operations.mjs'));

function tempDirs() {
  const root = mkdtempSync(path.join(tmpdir(), 'webmcp-schedule-delegation-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(home, '.webmcp'), { recursive: true });
  writeFileSync(path.join(project, 'webmcp.project.json'), JSON.stringify({ id: 'project-alpha', name: 'Alpha' }));
  return { root, project, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Fake Runner: captures the exact argv vector, then replays a scripted
// stdout/stderr/exit so delegation is proven without any schedule logic.
function writeFakeRunner(dir, script = {}) {
  const bin = path.join(dir, 'fake-runner.mjs');
  writeFileSync(bin, [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "appendFileSync(process.env.WEBMCP_TEST_CAPTURE_FILE, `${JSON.stringify(args)}\\n`);",
    'const script = JSON.parse(process.env.WEBMCP_TEST_FAKE_SCRIPT || "{}");',
    'if (script.stderr) process.stderr.write(script.stderr);',
    'if (script.stdout) process.stdout.write(script.stdout);',
    'process.exit(script.exit ?? 0);',
    '',
  ].join('\n'));
  return bin;
}

function jsonEnvelope(command, data) {
  return JSON.stringify({
    ok: true,
    schema: 'webmcp-automation-runner/1',
    command,
    data,
    meta: { generatedAt: '2026-09-14T00:00:00.000Z' },
  });
}

function capturedArgv(home) {
  const file = path.join(home, 'runner-calls.jsonl');
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return lines.length ? lines : null;
}

function runBrowser(args, home, script) {
  const captureFile = path.join(home, 'runner-calls.jsonl');
  writeFileSync(captureFile, '');
  const fakeBin = writeFakeRunner(home, script);
  return {
    result: spawnSync(process.execPath, [BIN, ...args], {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        WEBMCP_HOME: path.join(home, '.webmcp-home'),
        WEBMCP_RUNNER_BIN: fakeBin,
        WEBMCP_TEST_CAPTURE_FILE: captureFile,
        WEBMCP_TEST_FAKE_SCRIPT: JSON.stringify(script),
      },
    }),
    calls: () => capturedArgv(home),
  };
}

const CONTROLLER_DATA = (project, extra = {}) => ({
  schema: 'webmcp.project-schedule-controller/1',
  projectId: 'project-alpha',
  workspaceRoot: project,
  ...extra,
});

test('schedule usage documents every lifecycle verb and the closed apply path', () => {
  const { root, cleanup } = (() => {
    const r = mkdtempSync(path.join(tmpdir(), 'webmcp-schedule-usage-'));
    return { root: r, cleanup: () => rmSync(r, { recursive: true, force: true }) };
  })();
  try {
    for (const args of [[], ['help']]) {
      const result = spawnSync(process.execPath, [BIN, 'project', 'schedule', ...args], {
        cwd: WORKSPACE_ROOT,
        encoding: 'utf8',
        env: { ...process.env, HOME: root, WEBMCP_RUNNER_BIN: './missing-runner.mjs' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /schedule list --workspace <path>/);
      assert.match(result.stderr, /schedule reconcile --workspace <path>/);
      assert.match(result.stderr, /schedule operation <operation-id> --workspace <path>/);
      assert.match(result.stderr, /schedule recover <operation-id> --workspace <path>/);
    }
  } finally {
    cleanup();
  }
});

test('schedule list delegates the exact argv vector and relays the exit code', () => {
  const env = tempDirs();
  try {
    const { result, calls } = runBrowser(
      ['project', 'schedule', 'list', '--workspace', env.project, '--json'],
      env.home,
      { stdout: jsonEnvelope('project-schedule.list', CONTROLLER_DATA(env.project, { schedules: [] })), exit: 0 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(), [['project-schedule', 'list', '--workspace', env.project, '--json']]);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, 'project-schedule.list');
  } finally {
    env.cleanup();
  }
});

test('schedule plan forwards id and --target/--as spellings exactly', () => {
  const env = tempDirs();
  try {
    for (const targetArgs of [['--target', 'gemini-sidecar'], ['--as', 'gemini-sidecar']]) {
      const { result, calls } = runBrowser(
        ['project', 'schedule', 'plan', 'morning-report', ...targetArgs, '--workspace', env.project, '--json'],
        env.home,
        { stdout: jsonEnvelope('project-schedule.plan', CONTROLLER_DATA(env.project, { action: 'none' })), exit: 0 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        calls(),
        [['project-schedule', 'plan', 'morning-report', ...targetArgs, '--workspace', env.project, '--json']],
      );
    }
  } finally {
    env.cleanup();
  }
});

test('schedule plan without --target fails usage before spawning a Runner', () => {
  const env = tempDirs();
  try {
    const { result, calls } = runBrowser(
      ['project', 'schedule', 'plan', 'morning-report', '--workspace', env.project],
      env.home,
      { stdout: '{}', exit: 0 },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--target/);
    assert.equal(calls(), null, 'Runner must not spawn on usage errors');
  } finally {
    env.cleanup();
  }
});

test('schedule status forwards id, --target and --json; human runs inherit output', () => {
  const env = tempDirs();
  try {
    const { result, calls } = runBrowser(
      ['project', 'schedule', 'status', 'morning-report', '--target', 'gemini-sidecar', '--workspace', env.project, '--json'],
      env.home,
      { stdout: jsonEnvelope('project-schedule.status', CONTROLLER_DATA(env.project, { status: 'in-sync' })), exit: 0 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(), [[
      'project-schedule', 'status', 'morning-report',
      '--target', 'gemini-sidecar', '--workspace', env.project, '--json',
    ]]);
    const human = runBrowser(
      ['project', 'schedule', 'status', '--workspace', env.project],
      env.home,
      { stdout: 'human status line\n', exit: 0 },
    );
    assert.equal(human.result.status, 0, human.result.stderr);
    assert.match(human.result.stdout, /human status line/);
    assert.deepEqual(human.calls(), [['project-schedule', 'status', '--workspace', env.project]]);
  } finally {
    env.cleanup();
  }
});

test('schedule reconcile/operation/recover delegate with exact argv vectors', () => {
  const env = tempDirs();
  try {
    const cases = [
      {
        args: ['project', 'schedule', 'reconcile', '--workspace', env.project, '--json'],
        argv: ['project-schedule', 'reconcile', '--workspace', env.project, '--json'],
        envelope: jsonEnvelope('project-schedule.reconcile', { schema: 'webmcp.schedule-reconcile/1' }),
      },
      {
        args: ['project', 'schedule', 'operation', 'operation-1', '--workspace', env.project, '--json'],
        argv: ['project-schedule', 'operation', 'operation-1', '--workspace', env.project, '--json'],
        envelope: jsonEnvelope('project-schedule.operation', CONTROLLER_DATA(env.project, {})),
      },
      {
        args: ['project', 'schedule', 'recover', '--id', 'operation-2', '--workspace', env.project],
        argv: ['project-schedule', 'recover', '--id', 'operation-2', '--workspace', env.project],
        envelope: jsonEnvelope('project-schedule.recover', CONTROLLER_DATA(env.project, {})),
      },
    ];
    for (const entry of cases) {
      const { result, calls } = runBrowser(entry.args, env.home, { stdout: `${entry.envelope}\n`, exit: 0 });
      assert.equal(result.status, 0, `${entry.args.join(' ')}: ${result.stderr}`);
      assert.deepEqual(calls(), [entry.argv]);
    }
  } finally {
    env.cleanup();
  }
});

test('schedule operation/recover without an id fail usage before spawning', () => {
  const env = tempDirs();
  try {
    for (const verb of ['operation', 'recover']) {
      const { result, calls } = runBrowser(
        ['project', 'schedule', verb, '--workspace', env.project],
        env.home,
        { stdout: '{}', exit: 0 },
      );
      assert.equal(result.status, 2, `${verb}: ${result.stderr}`);
      assert.match(result.stderr, /operation-id/);
      assert.equal(calls(), null, 'Runner must not spawn without an operation id');
    }
  } finally {
    env.cleanup();
  }
});

test('schedule requires an explicit --workspace for every verb and never a registry default', () => {
  const env = tempDirs();
  try {
    for (const args of [
      ['project', 'schedule', 'list', '--json'],
      ['project', 'schedule', 'plan', 'morning-report', '--target', 'gemini-sidecar'],
      ['project', 'schedule', 'status'],
      ['project', 'schedule', 'reconcile'],
      ['project', 'schedule', 'operation', 'operation-1'],
      ['project', 'schedule', 'recover', 'operation-1'],
    ]) {
      const { result, calls } = runBrowser(args, env.home, { stdout: '{}', exit: 0 });
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, /SCHEDULE_WORKSPACE_INVALID/);
      assert.match(result.stderr, /--workspace/);
      assert.equal(calls(), null, 'Runner must not spawn without an explicit workspace');
    }
  } finally {
    env.cleanup();
  }
});

test('schedule rejects unknown verbs and unknown flags with usage before spawning', () => {
  const env = tempDirs();
  try {
    for (const args of [
      ['project', 'schedule', 'mutate', '--workspace', env.project],
      ['project', 'schedule', 'list', '--workspace', env.project, '--bogus', 'x'],
    ]) {
      const { result, calls } = runBrowser(args, env.home, { stdout: '{}', exit: 0 });
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(calls(), null);
    }
  } finally {
    env.cleanup();
  }
});

test('schedule legacy apply fails closed naming the lifecycle path without spawning', () => {
  const env = tempDirs();
  try {
    const { result, calls } = runBrowser(
      ['project', 'schedule', 'apply', 'morning-report', '--target', 'gemini-sidecar', '--workspace', env.project],
      env.home,
      { stdout: '{}', exit: 0 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SCHEDULE_APPLY_CLOSED/);
    assert.match(result.stderr, /plan/);
    assert.match(result.stderr, /operation/);
    assert.match(result.stderr, /recover/);
    assert.equal(calls(), null, 'apply must never reach a Runner or provider');
  } finally {
    env.cleanup();
  }
});

test('schedule without a resolvable Runner fails typed without importing sources', () => {
  const env = tempDirs();
  try {
    const result = spawnSync(process.execPath, [
      BIN, 'project', 'schedule', 'list', '--workspace', env.project, '--json',
    ], {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: env.home,
        WEBMCP_HOME: path.join(env.home, '.webmcp-home'),
        WEBMCP_RUNNER_BIN: path.join(env.home, 'missing-runner.mjs'),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SCHEDULE_RUNTIME_UNAVAILABLE/);
  } finally {
    env.cleanup();
  }
});

test('schedule rejects an incompatible Runner envelope version as not installed', () => {
  const env = tempDirs();
  try {
    for (const stdout of [
      JSON.stringify({ ok: true, schema: 'webmcp-automation-runner/9', command: 'x', data: {} }),
      'not json at all',
      JSON.stringify({ ok: true, schema: 'webmcp-automation-runner/1', command: 'project-schedule.list', data: { schema: 'webmcp.unknown/9' } }),
      JSON.stringify({ ok: true, schema: 'webmcp-automation-runner/1', command: 'project-schedule.list', data: { projectId: 'project-alpha' } }),
      JSON.stringify({ ok: true, schema: 'webmcp-automation-runner/1', command: 'project-schedule.list' }),
    ]) {
      const { result, calls } = runBrowser(
        ['project', 'schedule', 'list', '--workspace', env.project, '--json'],
        env.home,
        { stdout, exit: 0 },
      );
      assert.notEqual(result.status, 0, `envelope must be rejected: ${stdout}`);
      assert.match(result.stderr, /CAPABILITY_NOT_INSTALLED/);
      assert.deepEqual(calls(), [['project-schedule', 'list', '--workspace', env.project, '--json']]);
    }
  } finally {
    env.cleanup();
  }
});

test('schedule per-verb arity and flag validation fails usage before spawn', () => {
  const env = tempDirs();
  try {
    const cases = [
      // Excess positionals are never silently truncated.
      ['project', 'schedule', 'operation', 'operation-1', 'extra', '--workspace', env.project],
      ['project', 'schedule', 'recover', 'operation-1', 'extra', '--workspace', env.project, '--json'],
      ['project', 'schedule', 'status', 'a', 'b', '--workspace', env.project],
      ['project', 'schedule', 'plan', 'a', 'b', '--target', 'gemini-sidecar', '--workspace', env.project],
      ['project', 'schedule', 'list', 'extra', '--workspace', env.project],
      ['project', 'schedule', 'reconcile', 'extra', '--workspace', env.project],
      // Verb-inapplicable flags are never forwarded.
      ['project', 'schedule', 'list', '--target', 'bogus', '--workspace', env.project],
      ['project', 'schedule', 'list', '--id', 'x', '--workspace', env.project],
      ['project', 'schedule', 'reconcile', '--target', 'bogus', '--workspace', env.project],
      ['project', 'schedule', 'reconcile', '--as', 'bogus', '--workspace', env.project],
      ['project', 'schedule', 'operation', 'operation-1', '--target', 'bogus', '--workspace', env.project],
      ['project', 'schedule', 'recover', 'operation-1', '--as', 'bogus', '--workspace', env.project],
      // plan without any id (positional or --id) cannot spawn.
      ['project', 'schedule', 'plan', '--target', 'gemini-sidecar', '--workspace', env.project],
      ['project', 'schedule', 'plan', '--target', 'gemini-sidecar', '--workspace', env.project, '--json'],
    ];
    for (const args of cases) {
      const { result, calls } = runBrowser(args, env.home, { stdout: '{}', exit: 0 });
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(calls(), null, `Runner must not spawn for: ${args.join(' ')}`);
    }
  } finally {
    env.cleanup();
  }
});

test('schedule minimal valid argv delegates exactly for every verb', () => {
  const env = tempDirs();
  try {
    const cases = [
      {
        args: ['project', 'schedule', 'list', '--workspace', env.project],
        argv: ['project-schedule', 'list', '--workspace', env.project],
      },
      {
        args: ['project', 'schedule', 'plan', 'morning-report', '--target', 'gemini-sidecar', '--workspace', env.project],
        argv: ['project-schedule', 'plan', 'morning-report', '--target', 'gemini-sidecar', '--workspace', env.project],
      },
      {
        args: ['project', 'schedule', 'status', '--workspace', env.project],
        argv: ['project-schedule', 'status', '--workspace', env.project],
      },
      {
        args: ['project', 'schedule', 'reconcile', '--workspace', env.project],
        argv: ['project-schedule', 'reconcile', '--workspace', env.project],
      },
      {
        args: ['project', 'schedule', 'operation', 'operation-1', '--workspace', env.project],
        argv: ['project-schedule', 'operation', 'operation-1', '--workspace', env.project],
      },
      {
        args: ['project', 'schedule', 'recover', 'operation-1', '--workspace', env.project],
        argv: ['project-schedule', 'recover', 'operation-1', '--workspace', env.project],
      },
    ];
    for (const entry of cases) {
      const { result, calls } = runBrowser(entry.args, env.home, { stdout: 'human ok\n', exit: 0 });
      assert.equal(result.status, 0, `${entry.args.join(' ')}: ${result.stderr}`);
      assert.deepEqual(calls(), [entry.argv]);
    }
  } finally {
    env.cleanup();
  }
});

test('schedule preserves the delegated child exit on malformed JSON', () => {
  const env = tempDirs();
  try {
    for (const [childExit, wantExit] of [[0, 1], [1, 1], [2, 2]]) {
      const { result, calls } = runBrowser(
        ['project', 'schedule', 'list', '--workspace', env.project, '--json'],
        env.home,
        { stdout: 'not json at all', exit: childExit },
      );
      assert.equal(result.status, wantExit, `child exit ${childExit}: ${result.stderr}`);
      assert.match(result.stderr, /CAPABILITY_NOT_INSTALLED/);
      assert.deepEqual(calls(), [['project-schedule', 'list', '--workspace', env.project, '--json']]);
    }
  } finally {
    env.cleanup();
  }
});

test('schedule preserves the delegated child exit on typed Runner failures', () => {
  const env = tempDirs();
  try {
    for (const childExit of [1, 2, 3, 4]) {
      const envelope = JSON.stringify({
        ok: false,
        schema: 'webmcp-automation-runner/1',
        error: { code: 'SCHEDULE_RECOVERY_REQUIRED', message: 'nope', retryable: false },
      });
      const { result } = runBrowser(
        ['project', 'schedule', 'operation', 'operation-1', '--workspace', env.project, '--json'],
        env.home,
        { stdout: envelope, exit: childExit },
      );
      assert.equal(result.status, childExit, `typed failure must relay exit ${childExit}`);
      assert.equal(JSON.parse(result.stdout).error.code, 'SCHEDULE_RECOVERY_REQUIRED');
    }
  } finally {
    env.cleanup();
  }
});

test('schedule sanitizes absolute paths out of error envelopes', () => {
  const env = tempDirs();
  try {
    const envelope = JSON.stringify({
      ok: false,
      schema: 'webmcp-automation-runner/1',
      error: { code: 'SCHEDULE_RECOVERY_REQUIRED', message: `recovery under ${env.project} needs inspection`, retryable: false },
    });
    const { result } = runBrowser(
      ['project', 'schedule', 'operation', 'operation-1', '--workspace', env.project, '--json'],
      env.home,
      { stdout: envelope, exit: 3 },
    );
    assert.equal(result.status, 3, result.stderr);
    assert.ok(!result.stdout.includes(env.project), 'workspace root must not leak from error envelopes');
    assert.match(result.stdout, /<workspace>/);
    assert.equal(JSON.parse(result.stdout).error.code, 'SCHEDULE_RECOVERY_REQUIRED');
  } finally {
    env.cleanup();
  }
});

test('runner source-checkout fallback is refused in production and honored with the dev signal', async () => {
  const { getRunnerBin } = await import('../../lib/cli/component-resolver.mjs');
  const prevRunner = process.env.WEBMCP_RUNNER_BIN;
  const prevDev = process.env.WEBMCP_DEV_SOURCE_FALLBACK;
  const prevNodeEnv = process.env.NODE_ENV;
  const restore = () => {
    if (prevRunner === undefined) delete process.env.WEBMCP_RUNNER_BIN;
    else process.env.WEBMCP_RUNNER_BIN = prevRunner;
    if (prevDev === undefined) delete process.env.WEBMCP_DEV_SOURCE_FALLBACK;
    else process.env.WEBMCP_DEV_SOURCE_FALLBACK = prevDev;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  };
  try {
    delete process.env.WEBMCP_RUNNER_BIN;
    // Production without the opt-in must never resolve a source checkout.
    delete process.env.WEBMCP_DEV_SOURCE_FALLBACK;
    process.env.NODE_ENV = 'production';
    assert.equal(getRunnerBin(), null, 'packaged resolution must never fall back to a source checkout');
    // Explicit dev opt-in is honored, including under production.
    process.env.WEBMCP_DEV_SOURCE_FALLBACK = '1';
    const bin = getRunnerBin();
    assert.ok(typeof bin === 'string' && bin.endsWith('bin/webmcp-automation-runner.mjs'), `dev fallback must resolve the sibling checkout, got ${bin}`);
    assert.ok(existsSync(bin));
    // Dev/test default keeps the sibling resolution.
    delete process.env.WEBMCP_DEV_SOURCE_FALLBACK;
    delete process.env.NODE_ENV;
    assert.ok(getRunnerBin()?.endsWith('bin/webmcp-automation-runner.mjs'));
  } finally {
    restore();
  }
});

test('schedule refuses the source-checkout fallback in production end to end', () => {
  const env = tempDirs();
  try {
    const captureFile = path.join(env.home, 'runner-calls.jsonl');
    writeFileSync(captureFile, '');
    const spawnEnv = {
      ...process.env,
      HOME: env.home,
      WEBMCP_HOME: path.join(env.home, '.webmcp-home'),
      NODE_ENV: 'production',
      WEBMCP_TEST_CAPTURE_FILE: captureFile,
      WEBMCP_TEST_FAKE_SCRIPT: '{}',
    };
    delete spawnEnv.WEBMCP_RUNNER_BIN;
    delete spawnEnv.WEBMCP_DEV_SOURCE_FALLBACK;
    const result = spawnSync(process.execPath, [
      BIN, 'project', 'schedule', 'list', '--workspace', env.project, '--json',
    ], { cwd: WORKSPACE_ROOT, encoding: 'utf8', env: spawnEnv });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /SCHEDULE_RUNTIME_UNAVAILABLE/);
  } finally {
    env.cleanup();
  }
});

test('schedule sanitizes absolute machine paths out of relayed JSON', () => {
  const env = tempDirs();
  try {
    const envelope = jsonEnvelope('project-schedule.list', CONTROLLER_DATA(env.project, {
      note: `stored under ${env.project}/schedules and home ${env.home}`,
    }));
    const { result } = runBrowser(
      ['project', 'schedule', 'list', '--workspace', env.project, '--json'],
      env.home,
      { stdout: envelope, exit: 0 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(env.project), 'workspace root must not leak into portable JSON');
    assert.ok(!result.stdout.includes(env.home), 'home root must not leak into portable JSON');
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, 'project-schedule.list');
    assert.equal(payload.data.workspaceRoot, '<workspace>');
  } finally {
    env.cleanup();
  }
});

test('schedule relays Runner typed failures with the child exit code unchanged', () => {
  const env = tempDirs();
  try {
    const envelope = JSON.stringify({
      ok: false,
      schema: 'webmcp-automation-runner/1',
      error: { code: 'SCHEDULE_APPROVAL_REQUIRED', message: 'An operator deployment grant is required', retryable: false },
    });
    const { result, calls } = runBrowser(
      ['project', 'schedule', 'plan', 'morning-report', '--target', 'gemini-sidecar', '--workspace', env.project, '--json'],
      env.home,
      { stdout: envelope, stderr: 'runner diagnostic\n', exit: 3 },
    );
    assert.equal(result.status, 3);
    assert.match(result.stderr, /runner diagnostic/);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'SCHEDULE_APPROVAL_REQUIRED');
    assert.deepEqual(calls(), [[
      'project-schedule', 'plan', 'morning-report',
      '--target', 'gemini-sidecar', '--workspace', env.project, '--json',
    ]]);
  } finally {
    env.cleanup();
  }
});

test('schedule contains zero schedule business logic or Store/Runner source imports', () => {
  const source = readFileSync(SCHEDULE_SOURCE, 'utf8');
  for (const token of [
    'lib/schedule.mjs',
    'store-resolver',
    'applySchedule',
    'planSchedule',
    'discoverProjectSchedules',
    'inspectSchedule',
    'scheduleSetAdmissible',
    'webmcp.project.json',
    'Runner/src',
    'runner/src',
  ]) {
    assert.ok(!source.includes(token), `schedule.mjs must not reference ${token}`);
  }
  assert.ok(!/await import\(/.test(source), 'schedule.mjs must not dynamically import schedule sources');
  assert.ok(!/from '\.\.\/\.\.\/.*\.mjs'/.test(source) || source.includes('component-resolver.mjs'), 'only resolver imports allowed');
  assert.match(source, /getRunnerBin/);
  assert.match(source, /shell:\s*false/);
  assert.match(source, /stdio:\s*'inherit'/);
});

test('schedule project help advertises the lifecycle verbs and the closed apply', () => {
  const result = spawnSync(process.execPath, [BIN, 'project', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp project schedule list --workspace <path> \[--json\]/);
  assert.match(result.stdout, /webmcp project schedule reconcile --workspace <path> \[--json\]/);
  assert.match(result.stdout, /webmcp project schedule operation <operation-id> --workspace <path> \[--json\]/);
  assert.match(result.stdout, /webmcp project schedule recover <operation-id> --workspace <path> \[--json\]/);
});

function writeScheduleProject(project) {
  mkdirSync(path.join(project, 'schedules'), { recursive: true });
  writeFileSync(path.join(project, 'schedules', 'morning-report.schedule.json'), JSON.stringify({
    schema: 'webmcp.schedule/v2',
    id: 'morning-report',
    description: 'smoke schedule',
    enabled: true,
    trigger: { type: 'daily', at: '08:00', timezone: 'UTC' },
    task: {
      type: 'runbook',
      domain: 'reports',
      automationId: 'daily-report',
      requestTemplate: {
        schema: 'webmcp-run-request/1', automation: { id: 'daily-report' }, inputs: {}, requestedActions: [],
      },
    },
    targets: ['gemini-sidecar'],
  }));
}

function writeSmokeBinding(home, project) {
  writeFileSync(path.join(home, '.webmcp', 'schedule-targets.json'), JSON.stringify({
    schema: 'webmcp.schedule-targets/2',
    projects: { 'project-alpha': { workspace: realpathSync(project), targets: { 'gemini-sidecar': { timezone: 'UTC' } } } },
  }));
}

function smokeEnv(env) {
  return {
    ...process.env,
    HOME: env.home,
    WEBMCP_HOME: env.home,
    WEBMCP_AUTOMATION_STORE_ROOT: DEV_STORE_ROOT,
    // The real-Runner smoke path resolves the sibling source checkout, which
    // is an explicit dev-only opt-in (see getRunnerBin).
    WEBMCP_DEV_SOURCE_FALLBACK: '1',
  };
}

test('schedule real-Runner smoke: list and status succeed against a temp workspace', { skip: !HAS_DEV_STORE }, () => {
  const env = tempDirs();
  try {
    writeScheduleProject(env.project);
    writeSmokeBinding(env.home, env.project);
    for (const args of [
      ['project', 'schedule', 'list', '--workspace', env.project, '--json'],
      ['project', 'schedule', 'status', '--workspace', env.project, '--json'],
    ]) {
      const result = spawnSync(process.execPath, [BIN, ...args], {
        cwd: WORKSPACE_ROOT,
        encoding: 'utf8',
        env: smokeEnv(env),
      });
      assert.equal(result.status, 0, `${args.join(' ')}: stdout=${result.stdout} stderr=${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.schema, 'webmcp-automation-runner/1');
      assert.ok(!result.stdout.includes(env.home), 'portable JSON must not leak the home root');
    }
  } finally {
    env.cleanup();
  }
});

test('schedule real-Runner smoke: plan reaches the approval gate typed without mutation', { skip: !HAS_DEV_STORE }, () => {
  const env = tempDirs();
  try {
    writeScheduleProject(env.project);
    writeSmokeBinding(env.home, env.project);
    const result = spawnSync(process.execPath, [
      BIN, 'project', 'schedule', 'plan', 'morning-report',
      '--target', 'gemini-sidecar', '--workspace', env.project, '--json',
    ], {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      env: smokeEnv(env),
    });
    assert.equal(result.status, 3, `stdout=${result.stdout} stderr=${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'SCHEDULE_APPROVAL_REQUIRED');
  } finally {
    env.cleanup();
  }
});
