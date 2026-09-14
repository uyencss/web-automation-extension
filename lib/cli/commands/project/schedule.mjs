import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { getRunnerBin } from '../../component-resolver.mjs';
import { projectOption } from './registry.mjs';

const RUNNER_SCHEMA = 'webmcp-automation-runner/1';
const KNOWN_DATA_SCHEMAS = new Set([
  'webmcp.project-schedule-controller/1',
  'webmcp.schedule-reconcile/1',
]);
const VERBS = new Set(['list', 'plan', 'status', 'reconcile', 'operation', 'recover']);
const VALUE_FLAGS = new Set(['--workspace', '--target', '--as', '--id']);
const KNOWN_FLAGS = new Set(['--workspace', '--target', '--as', '--id', '--json']);

function usage() {
  return [
    'Usage: webmcp project schedule list --workspace <path> [--json]',
    '       webmcp project schedule plan [<id>] --target <t> --workspace <path> [--json]',
    '       webmcp project schedule status [<id>] [--target <t>] --workspace <path> [--json]',
    '       webmcp project schedule reconcile --workspace <path> [--json]',
    '       webmcp project schedule operation <operation-id> --workspace <path> [--json]',
    '       webmcp project schedule recover <operation-id> --workspace <path> [--json]',
    'Note: legacy `apply` never mutates providers; use plan <id> --target <t>, then operation <operation-id> / recover <operation-id>.',
  ].join('\n');
}

// First bare positional, skipping values carried by known `--flag value` pairs.
// `--flag=value` spellings never surface as bare tokens, so no handling needed.
function positionals(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    out.push(arg);
  }
  return out;
}

function forwardFlag(args, names) {
  for (const name of names) {
    const value = projectOption(args, name.slice(2));
    if (value !== null && value !== undefined) return [name, value];
  }
  return [];
}

function wantsJson(args) {
  return args.some((arg) => arg === '--json' || arg === '--json=true');
}

function sanitize(value, roots) {
  if (typeof value === 'string') {
    let out = value;
    for (const [root, token] of roots) {
      if (root && out.includes(root)) out = out.split(root).join(token);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, roots));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry, roots)]));
  }
  return value;
}

function sanitizeRoots(envelope) {
  const roots = [];
  const workspace = envelope?.data?.workspaceRoot;
  if (typeof workspace === 'string' && workspace && isAbsolute(workspace)) {
    roots.push([workspace, '<workspace>']);
  }
  for (const home of [process.env.WEBMCP_HOME, process.env.HOME]) {
    if (typeof home === 'string' && home && isAbsolute(home) && !roots.some(([root]) => root === home)) {
      roots.push([home, '<home>']);
    }
  }
  return roots;
}

function missingRunnerBin() {
  const runnerBin = getRunnerBin();
  if (!runnerBin || !existsSync(runnerBin)) return null;
  return runnerBin;
}

function runJson(runnerBin, runnerArgv) {
  const child = spawnSync(process.execPath, [runnerBin, ...runnerArgv], {
    encoding: 'utf8',
    shell: false,
  });
  if (child.error) {
    console.error(`SCHEDULE_RUNTIME_UNAVAILABLE: the Automation Runner CLI could not start: ${child.error.message}`);
    return 1;
  }
  if (child.stderr) process.stderr.write(child.stderr);
  let envelope = null;
  try {
    envelope = JSON.parse(child.stdout);
  } catch {
    envelope = null;
  }
  if (!envelope || typeof envelope !== 'object' || envelope.schema !== RUNNER_SCHEMA) {
    console.error(`CAPABILITY_NOT_INSTALLED: the Automation Runner reported an incompatible schedule envelope (want ${RUNNER_SCHEMA})`);
    return 1;
  }
  if (envelope.ok === true) {
    const dataSchema = envelope.data?.schema;
    if (typeof dataSchema === 'string' && !KNOWN_DATA_SCHEMAS.has(dataSchema)) {
      console.error(`CAPABILITY_NOT_INSTALLED: the Automation Runner reported an incompatible schedule payload (${dataSchema})`);
      return 1;
    }
  }
  process.stdout.write(`${JSON.stringify(sanitize(envelope, sanitizeRoots(envelope)), null, 2)}\n`);
  if (child.signal) {
    console.error(`Automation Runner CLI exited after signal ${child.signal}`);
    return 1;
  }
  return child.status ?? 1;
}

function runHuman(runnerBin, runnerArgv) {
  const child = spawnSync(process.execPath, [runnerBin, ...runnerArgv], {
    stdio: 'inherit',
    shell: false,
  });
  if (child.error) {
    console.error(`SCHEDULE_RUNTIME_UNAVAILABLE: the Automation Runner CLI could not start: ${child.error.message}`);
    return 1;
  }
  if (child.signal) {
    console.error(`Automation Runner CLI exited after signal ${child.signal}`);
    return 1;
  }
  return child.status ?? 1;
}

export async function runProjectSchedule(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    console.error(usage());
    return subcommand && subcommand !== 'help' ? 2 : 0;
  }

  if (!VERBS.has(subcommand)) {
    if (subcommand === 'apply') {
      console.error('SCHEDULE_APPLY_CLOSED: direct provider apply is closed and never mutates providers.');
      console.error('Use the read-only lifecycle instead: webmcp project schedule plan <id> --target <t> --workspace <dir>, then operation <operation-id> / recover <operation-id>.');
      return 1;
    }
    console.error(`Unknown project schedule subcommand: ${subcommand}`);
    console.error(usage());
    return 2;
  }

  const unknown = rest.find((arg) => arg.startsWith('--') && ![...KNOWN_FLAGS].some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  if (unknown) {
    console.error(`Unknown project schedule option: ${unknown}`);
    console.error(usage());
    return 2;
  }

  // Every verb requires an explicit owning workspace: registry/cwd guesses
  // previously armed schedules in the wrong project.
  const workspace = projectOption(rest, 'workspace');
  if (!workspace || !workspace.trim()) {
    console.error('SCHEDULE_WORKSPACE_INVALID: project schedule requires an explicit --workspace <path>; refusing the registry/cwd default.');
    console.error(usage());
    return 2;
  }

  const json = wantsJson(rest);
  const positional = positionals(rest);
  const idFlag = forwardFlag(rest, ['--id']);
  let runnerArgv;
  if (subcommand === 'list' || subcommand === 'reconcile') {
    if (positional.length > 0) {
      console.error(`Unexpected argument to project schedule ${subcommand}: ${positional[0]}`);
      console.error(usage());
      return 2;
    }
    runnerArgv = ['project-schedule', subcommand, '--workspace', workspace, ...(json ? ['--json'] : [])];
  } else if (subcommand === 'plan') {
    const target = forwardFlag(rest, ['--target', '--as']);
    if (target.length === 0) {
      console.error('Missing required option: --target <target>');
      console.error(usage());
      return 2;
    }
    runnerArgv = ['project-schedule', 'plan', ...positional.slice(0, 1), ...idFlag, ...target, '--workspace', workspace, ...(json ? ['--json'] : [])];
  } else if (subcommand === 'status') {
    const target = forwardFlag(rest, ['--target', '--as']);
    runnerArgv = ['project-schedule', 'status', ...positional.slice(0, 1), ...idFlag, ...target, '--workspace', workspace, ...(json ? ['--json'] : [])];
  } else {
    const id = positional[0] ?? projectOption(rest, 'id');
    if (!id) {
      console.error(`Missing required <operation-id> for project schedule ${subcommand}.`);
      console.error(usage());
      return 2;
    }
    runnerArgv = ['project-schedule', subcommand, ...positional.slice(0, 1), ...idFlag, '--workspace', workspace, ...(json ? ['--json'] : [])];
  }

  const runnerBin = missingRunnerBin();
  if (!runnerBin) {
    console.error('SCHEDULE_RUNTIME_UNAVAILABLE: the Automation Runner CLI was not found; install it, run from the kit checkout, or set WEBMCP_RUNNER_BIN.');
    return 1;
  }
  return json ? runJson(runnerBin, runnerArgv) : runHuman(runnerBin, runnerArgv);
}
