import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getRunnerBin } from '../../component-resolver.mjs';

export function runRunnerBin() {
  const runnerBin = getRunnerBin();
  if (!runnerBin || !existsSync(runnerBin)) {
    console.error([
      'WebMCP Automation Runner CLI not found.',
      'Install @gyga-browser/webmcp-automation-runner, run from the webmcp-automation-kit checkout, or set WEBMCP_RUNNER_BIN.',
    ].join('\n'));
    return null;
  }
  return runnerBin;
}

export async function runRunner(args) {
  const runnerBin = runRunnerBin();
  if (!runnerBin) return 1;

  const runnerArgs = args.length > 0 ? args : ['--help'];
  const child = spawn(process.execPath, [runnerBin, ...runnerArgs], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: 'inherit',
  });

  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start Automation Runner CLI: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`Automation Runner CLI exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}

export function runRunnerSync(args) {
  const runnerBin = runRunnerBin();
  if (!runnerBin) return { status: 1, stdout: '', stderr: '' };
  return spawnSync(process.execPath, [runnerBin, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env },
  });
}

export function projectOption(args, name) {
  const prefix = `--${name}`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === prefix) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) return null;
      return value;
    }
    if (arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1);
  }
  return null;
}

export function withoutProjectOptions(args, names) {
  const prefixes = names.map((name) => `--${name}`);
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const match = prefixes.find((prefix) => arg === prefix);
    if (match) {
      if (args[index + 1] !== undefined && !args[index + 1].startsWith('--')) index += 1;
      continue;
    }
    if (prefixes.some((prefix) => arg.startsWith(`${prefix}=`))) continue;
    rest.push(arg);
  }
  return rest;
}

export function resolvedProjectRoot() {
  const listed = runRunnerSync(['workspace', 'list', '--json']);
  if (listed.status !== 0) {
    process.stdout.write(listed.stdout);
    process.stderr.write(listed.stderr);
    return null;
  }
  const registry = JSON.parse(listed.stdout).data;
  return registry.workspaces.find((item) => item.id === registry.defaultWorkspaceId) || null;
}

export async function runProjectAttach(args) {
  const rest = [];
  let dir = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--scan') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        rest.push('--scan');
      } else {
        rest.push('--scan', value);
        index += 1;
      }
    } else if (!arg.startsWith('--')) {
      dir = arg;
    } else {
      rest.push(arg);
    }
  }
  if (!dir && !rest.includes('--scan')) {
    console.error('Usage: webmcp project attach <dir> [--replace] [--as-copy <id>] [--repair-layout] [--default] [--dry-run] [--json]');
    console.error('       webmcp project attach --scan <root> [--replace] [--repair-layout] [--default] [--dry-run] [--json]');
    return 2;
  }
  if (dir) return runRunner(['workspace', 'attach', '--workspace', dir, ...rest]);
  return runRunner(['workspace', 'attach', ...rest]);
}

export async function runProjectWhere(args) {
  const id = args.find((arg) => !arg.startsWith('--'));
  if (id) return runRunner(['workspace', 'describe', id, ...args]);
  const entry = resolvedProjectRoot();
  if (!entry) {
    console.error('No default project is registered. Register one with: webmcp project attach <dir> --default');
    return 1;
  }
  return runRunner(['workspace', 'describe', entry.id, ...args]);
}

export async function runProjectDoctor(args) {
  let root = args.find((arg) => !arg.startsWith('--'));
  if (!root) {
    const entry = resolvedProjectRoot();
    if (!entry) {
      console.error('No default project is registered. Register one with: webmcp project attach <dir> --default');
      return 1;
    }
    root = entry.root;
  }
  const json = args.includes('--json');
  const chain = [
    ['workspace', 'doctor', '--workspace', root, ...(json ? ['--json'] : [])],
    ['workspace', 'registry', 'audit', '--workspace-root', root, ...(json ? ['--json'] : [])],
    ['workspace', 'attach', '--workspace', root, '--dry-run', ...(json ? ['--json'] : [])],
  ];
  for (const runnerArgs of chain) {
    const exitCode = await runRunner(runnerArgs);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}
