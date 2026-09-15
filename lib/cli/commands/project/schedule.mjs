import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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
// Per-verb flag contract: a known flag that does not apply to the verb is a
// usage error before any spawn, never silently forwarded or dropped.
const VERB_FLAGS = {
  list: new Set(['--workspace', '--json']),
  plan: new Set(['--workspace', '--target', '--as', '--id', '--json']),
  status: new Set(['--workspace', '--target', '--as', '--id', '--json']),
  reconcile: new Set(['--workspace', '--json']),
  operation: new Set(['--workspace', '--id', '--json']),
  recover: new Set(['--workspace', '--id', '--json']),
};

function flagName(arg) {
  if (typeof arg !== 'string' || !arg.startsWith('--')) return null;
  return arg.split('=')[0];
}

function usage() {
  return [
    'Usage: webmcp project schedule list --workspace <path> [--json]',
    '       webmcp project schedule plan <id> --target <t> --workspace <path> [--json]',
    '       webmcp project schedule status [<id>] [--target <t>] --workspace <path> [--json]',
    '       webmcp project schedule reconcile --workspace <path> [--json]',
    '       webmcp project schedule operation <operation-id> --workspace <path> [--json]',
    '       webmcp project schedule recover <operation-id> --workspace <path> [--json]',
    'Note: legacy `apply` never mutates providers; plan <id> --target <t> is read-only.',
    'Note: operation <operation-id> / recover <operation-id> resume only the in-process Runner store that issued the plan; every CLI invocation spawns a fresh Runner, so cross-process resume is refused with SCHEDULE_RECOVERY_REQUIRED (exit 3).',
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

// A present value flag without a usable value is a usage error before any
// spawn: the Runner must never observe a swallowed `--flag --other` pair, a
// dangling trailing `--flag`, or an empty `--flag=` spelling.
function missingValue(rest) {
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (typeof arg !== 'string') continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      if (VALUE_FLAGS.has(arg.slice(0, eq)) && arg.slice(eq + 1) === '') return arg.slice(0, eq);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = rest[index + 1];
      if (value === undefined || value === '' || (typeof value === 'string' && value.startsWith('--'))) return arg;
    }
  }
  return null;
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

function sanitizeRoots(envelope, workspace) {
  const roots = [];
  const push = (root, token) => {
    if (typeof root === 'string' && root && !roots.some(([seen]) => seen === root)) {
      roots.push([root, token]);
    }
  };
  // The explicit workspace is known from the CLI argv, so error envelopes or
  // payloads without data.workspaceRoot are sanitized exactly the same way.
  // The argv form may be relative or pass through a symlink while the child
  // reports its absolute canonical path, so mask the resolved and realpath
  // forms too (the raw form only when already absolute, so short relative
  // spellings never over-mask the envelope).
  if (typeof workspace === 'string' && workspace) {
    if (isAbsolute(workspace)) push(workspace, '<workspace>');
    try {
      const resolved = resolve(process.cwd(), workspace);
      push(resolved, '<workspace>');
      try {
        push(realpathSync(resolved), '<workspace>');
      } catch {
        // Unresolvable path: the resolved form already covers it.
      }
    } catch {
      // Unresolvable argv: fall back to the raw and envelope forms.
    }
  }
  push(envelope?.data?.workspaceRoot, '<workspace>');
  for (const home of [process.env.WEBMCP_HOME, process.env.HOME]) {
    push(home, '<home>');
  }
  return roots;
}

function missingRunnerBin() {
  const runnerBin = getRunnerBin();
  if (!runnerBin || !existsSync(runnerBin)) return null;
  return runnerBin;
}

function runJson(runnerBin, runnerArgv, workspace) {
  const child = spawnSync(process.execPath, [runnerBin, ...runnerArgv], {
    encoding: 'utf8',
    shell: false,
  });
  if (child.error) {
    console.error(`SCHEDULE_RUNTIME_UNAVAILABLE: the Automation Runner CLI could not start: ${child.error.message}`);
    return 1;
  }
  if (child.stderr) process.stderr.write(child.stderr);
  // A signal has no exit code to preserve; the capability path below relays
  // a nonzero delegated child exit, defaulting to 1.
  const capabilityExit = () => {
    if (child.signal) return 1;
    return child.status ? child.status : 1;
  };
  let envelope = null;
  try {
    envelope = JSON.parse(child.stdout);
  } catch {
    envelope = null;
  }
  if (!envelope || typeof envelope !== 'object' || envelope.schema !== RUNNER_SCHEMA) {
    console.error(`CAPABILITY_NOT_INSTALLED: the Automation Runner reported an incompatible schedule envelope (want ${RUNNER_SCHEMA})`);
    if (child.signal) console.error(`Automation Runner CLI exited after signal ${child.signal}`);
    return capabilityExit();
  }
  if (envelope.ok === true) {
    // Every accepted success payload must declare its envelope schema; a
    // missing or unknown data schema is a capability mismatch, never a relay.
    const dataSchema = envelope.data?.schema;
    if (typeof dataSchema !== 'string' || !KNOWN_DATA_SCHEMAS.has(dataSchema)) {
      console.error(`CAPABILITY_NOT_INSTALLED: the Automation Runner reported an incompatible schedule payload (${dataSchema})`);
      if (child.signal) console.error(`Automation Runner CLI exited after signal ${child.signal}`);
      return capabilityExit();
    }
  }
  process.stdout.write(`${JSON.stringify(sanitize(envelope, sanitizeRoots(envelope, workspace)), null, 2)}\n`);
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
      console.error('Honest resume path: plan <id> --target <t> --workspace <dir> is read-only, and operation <operation-id> / recover <operation-id> resume only the in-process controller store that issued the plan; a fresh CLI invocation starts with an empty store, so cross-process resume is refused with SCHEDULE_RECOVERY_REQUIRED (exit 3).');
      return 1;
    }
    console.error(`Unknown project schedule subcommand: ${subcommand}`);
    console.error(usage());
    return 2;
  }

  const unknown = rest.find((arg) => {
    const name = flagName(arg);
    return name && ![...KNOWN_FLAGS].some((flag) => name === flag);
  });
  if (unknown) {
    console.error(`Unknown project schedule option: ${unknown}`);
    console.error(usage());
    return 2;
  }

  // Per-verb contract: a known flag that does not apply to this verb, or a
  // wrong positional arity, is a usage error before any spawn.
  const allowedFlags = VERB_FLAGS[subcommand];
  const misapplied = rest.find((arg) => {
    const name = flagName(arg);
    return name && KNOWN_FLAGS.has(name) && !allowedFlags.has(name);
  });
  if (misapplied) {
    console.error(`Option ${flagName(misapplied)} does not apply to project schedule ${subcommand}.`);
    console.error(usage());
    return 2;
  }

  const missing = missingValue(rest);
  if (missing) {
    console.error(`Missing value for option ${missing}: expected ${missing} <value>.`);
    console.error(usage());
    return 2;
  }

  function rejectExtra(positional) {
    console.error(`Unexpected argument to project schedule ${subcommand}: ${positional[0]}`);
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
      return rejectExtra(positional);
    }
    runnerArgv = ['project-schedule', subcommand, '--workspace', workspace, ...(json ? ['--json'] : [])];
  } else if (subcommand === 'plan') {
    if (positional.length > 1) {
      return rejectExtra(positional.slice(1));
    }
    if (!positional[0] && !projectOption(rest, 'id')) {
      console.error(`Missing required <id> for project schedule ${subcommand}.`);
      console.error(usage());
      return 2;
    }
    const target = forwardFlag(rest, ['--target', '--as']);
    if (target.length === 0) {
      console.error('Missing required option: --target <target>');
      console.error(usage());
      return 2;
    }
    runnerArgv = ['project-schedule', 'plan', ...positional.slice(0, 1), ...idFlag, ...target, '--workspace', workspace, ...(json ? ['--json'] : [])];
  } else if (subcommand === 'status') {
    if (positional.length > 1) {
      return rejectExtra(positional.slice(1));
    }
    const target = forwardFlag(rest, ['--target', '--as']);
    runnerArgv = ['project-schedule', 'status', ...positional.slice(0, 1), ...idFlag, ...target, '--workspace', workspace, ...(json ? ['--json'] : [])];
  } else {
    if (positional.length > 1) {
      return rejectExtra(positional.slice(1));
    }
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
  return json ? runJson(runnerBin, runnerArgv, workspace) : runHuman(runnerBin, runnerArgv);
}
