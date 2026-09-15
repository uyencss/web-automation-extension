import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FROZEN_VERBS = ['list', 'plan', 'status', 'reconcile', 'operation', 'recover'];

test('npm packed inventory contains every relative module imported by shipped Browser CLI files', (t) => {
  const packRoot = mkdtempSync(path.join(tmpdir(), 'webmcp-browser-pack-'));
  t.after(() => rmSync(packRoot, { recursive: true, force: true }));
  const globalConfig = path.join(packRoot, 'empty-global.npmrc');
  writeFileSync(globalConfig, '');
  const packed = spawnSync('npm', [
    `--userconfig=/dev/null`,
    `--globalconfig=${globalConfig}`,
    `--cache=${path.join(packRoot, 'cache')}`,
    'pack', '--dry-run', '--ignore-scripts', '--json',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.equal(packed.status, 0, packed.stderr);
  const inventory = JSON.parse(packed.stdout)[0].files;
  const files = new Set(inventory.map((entry) => entry.path));
  assert.equal(inventory.find((entry) => entry.path === 'bin/webmcp-browser.mjs')?.mode, 0o755);
  assert.equal(inventory.find((entry) => entry.path === 'bin/profile-pool.mjs')?.mode, 0o644);
  assert.ok([...files].some((file) => file.startsWith('lib/cli/')));
  assert.ok([...files].some((file) => file.startsWith('lib/profile-pool/')));

  const moduleFiles = [...files].filter((file) => /\.(?:mjs|js)$/.test(file));
  for (const file of moduleFiles) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    const specs = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]).filter((spec) => spec.startsWith('.'));
    for (const spec of specs) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      assert.ok(files.has(resolved), `${file} imports ${spec}, but ${resolved} is absent from the tarball`);
    }
  }
});

test('packed Browser Kit delegates project schedule by subprocess only', (t) => {
  const work = mkdtempSync(path.join(tmpdir(), 'webmcp-browser-packed-delegation-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const pack = spawnSync('npm', [
    `--cache=${path.join(work, 'cache')}`,
    'pack', '--ignore-scripts', '--pack-destination', work,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.equal(pack.status, 0, pack.stderr);
  const tarball = path.join(work, pack.stdout.trim().split('\n').pop());
  const unpack = spawnSync('tar', ['-xzf', tarball, '-C', work], { encoding: 'utf8', timeout: 60000 });
  assert.equal(unpack.status, 0, unpack.stderr);
  const packed = path.join(work, 'package');

  // The packed artifact ships the delegation shim and never Store/Runner internals.
  for (const file of [
    'bin/webmcp-browser.mjs',
    'lib/cli/commands/project/schedule.mjs',
    'lib/cli/component-resolver.mjs',
  ]) {
    assert.ok(existsSync(path.join(packed, file)), `packed tarball must contain ${file}`);
  }
  const names = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).stdout.split('\n');
  for (const token of ['runner/src', 'Runner/src', '/stores/', 'lib/schedule', 'store-resolver']) {
    assert.ok(!names.some((name) => name.includes(token)), `packed tarball must not contain ${token}`);
  }
  const packedSchedule = readFileSync(path.join(packed, 'lib/cli/commands/project/schedule.mjs'), 'utf8');
  for (const token of ['lib/schedule.mjs', 'store-resolver', 'planSchedule', 'Runner/src', 'runner/src']) {
    assert.ok(!packedSchedule.includes(token), `packed schedule.mjs must not reference ${token}`);
  }
  assert.match(packedSchedule, /getRunnerBin/);

  const home = path.join(work, 'home');
  const workspace = path.join(work, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const captureFile = path.join(work, 'runner-calls.jsonl');
  const fakeRunner = path.join(work, 'fake-installed-runner.mjs');
  writeFileSync(fakeRunner, [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(captureFile)}, \`\${JSON.stringify(args)}\\n\`);`,
    'const script = JSON.parse(process.env.WEBMCP_TEST_FAKE_SCRIPT || "{}");',
    'if (script.stderr) process.stderr.write(script.stderr);',
    'if (script.stdout) process.stdout.write(script.stdout);',
    'process.exit(script.exit ?? 0);',
    '',
  ].join('\n'));
  const calls = () => readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const baseEnv = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    NODE_ENV: 'production',
  };
  const runPacked = (args, script) => {
    writeFileSync(captureFile, '');
    return spawnSync(process.execPath, [path.join(packed, 'bin/webmcp-browser.mjs'), ...args], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        WEBMCP_RUNNER_BIN: fakeRunner,
        WEBMCP_TEST_FAKE_SCRIPT: JSON.stringify(script),
      },
    });
  };
  const verbArgs = {
    list: ['project', 'schedule', 'list', '--workspace', workspace],
    plan: ['project', 'schedule', 'plan', 'morning-report', '--target', 'gemini-sidecar', '--workspace', workspace],
    status: ['project', 'schedule', 'status', '--workspace', workspace],
    reconcile: ['project', 'schedule', 'reconcile', '--workspace', workspace],
    operation: ['project', 'schedule', 'operation', 'operation-1', '--workspace', workspace],
    recover: ['project', 'schedule', 'recover', 'operation-1', '--workspace', workspace],
  };

  // Every frozen verb resolves the installed Runner and forwards exactly.
  for (const verb of FROZEN_VERBS) {
    const result = runPacked(verbArgs[verb], { stdout: 'human ok\n', exit: 0 });
    assert.equal(result.status, 0, `${verb}: ${result.stderr}`);
    assert.deepEqual(calls(), [['project-schedule', ...verbArgs[verb].slice(2)]]);
  }

  // The packed artifact preserves the child's exit code on typed failures.
  const envelope = JSON.stringify({
    ok: false,
    schema: 'webmcp-automation-runner/1',
    error: { code: 'SCHEDULE_RECOVERY_REQUIRED', message: 'nope', retryable: false },
  });
  const typed = runPacked(
    ['project', 'schedule', 'operation', 'operation-1', '--workspace', workspace, '--json'],
    { stdout: envelope, exit: 3 },
  );
  assert.equal(typed.status, 3, typed.stderr);
  assert.equal(JSON.parse(typed.stdout).error.code, 'SCHEDULE_RECOVERY_REQUIRED');

  // Without a runtime the packed artifact fails typed, never importing sources.
  writeFileSync(captureFile, '');
  const missing = spawnSync(process.execPath, [
    path.join(packed, 'bin/webmcp-browser.mjs'),
    'project', 'schedule', 'list', '--workspace', workspace, '--json',
  ], {
    encoding: 'utf8',
    env: { ...baseEnv, WEBMCP_RUNNER_BIN: path.join(work, 'missing-runner.mjs') },
  });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /SCHEDULE_RUNTIME_UNAVAILABLE/);

  // Unknown verbs never reach the Runner, even from the packed artifact.
  const unknown = runPacked(['project', 'schedule', 'mutate', '--workspace', workspace], { stdout: '{}', exit: 0 });
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.deepEqual(calls(), [], 'Runner must not spawn for unknown verbs');
});
