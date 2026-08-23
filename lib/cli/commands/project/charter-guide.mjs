import { printProjectHelp } from '../../help.mjs';
import {
  projectOption,
  resolvedProjectRoot,
  runRunner,
} from './registry.mjs';

export async function runProjectCharter(args) {
  const [subcommand, ...rest] = args;
  const usage = 'Usage: webmcp project charter adopt <relative-md> [--workspace <dir>] [--yes] [--json]';
  if (subcommand !== 'adopt') {
    console.error(usage);
    return 2;
  }
  let relativeFile = null;
  let workspace = null;
  let workspaceSpecified = false;
  let yes = false;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--workspace') {
      const value = rest[index + 1];
      if (workspaceSpecified || value === undefined || value.startsWith('--') || value.trim() === '') {
        console.error(usage);
        return 2;
      }
      workspace = value;
      workspaceSpecified = true;
      index += 1;
      continue;
    }
    if (arg === '--yes') {
      if (yes) {
        console.error(usage);
        return 2;
      }
      yes = true;
      continue;
    }
    if (arg === '--json') {
      if (json) {
        console.error(usage);
        return 2;
      }
      json = true;
      continue;
    }
    if (arg.startsWith('--') || relativeFile) {
      console.error(usage);
      return 2;
    }
    relativeFile = arg;
  }
  if (!relativeFile) {
    console.error(usage);
    return 2;
  }
  const root = workspaceSpecified ? workspace : resolvedProjectRoot()?.root;
  if (!root) {
    console.error('No default project is registered. Register one with: webmcp project attach <dir> --default');
    return 1;
  }
  return runRunner([
    'workspace', 'charter', 'adopt', relativeFile, '--workspace', root,
    ...(yes ? ['--yes'] : []),
    ...(json ? ['--json'] : []),
  ]);
}

function projectGuideTarget(rest) {
  const explicit = projectOption(rest, 'workspace');
  if (explicit) {
    return { root: explicit, flags: rest.filter((arg) => arg.startsWith('--') && !arg.startsWith('--workspace')) };
  }
  const entry = resolvedProjectRoot();
  if (!entry) {
    return { error: 'No default project is registered. Register one with: webmcp project attach <dir> --default' };
  }
  return { root: entry.root, flags: rest.filter((arg) => arg.startsWith('--')) };
}

export async function runProjectGuide(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    console.error('Usage: webmcp project guide list [--json]');
    console.error('       webmcp project guide stage <collections/<id>/GUIDE.md> --as inputs/<path> --yes [--json]');
    return subcommand && subcommand !== 'help' ? 2 : 0;
  }
  const target = projectGuideTarget(rest);
  if (target.error) {
    console.error(target.error);
    return 1;
  }
  if (subcommand === 'list') {
    return runRunner(['workspace', 'guide', 'list', '--workspace', target.root, ...target.flags]);
  }
  if (subcommand === 'stage') {
    const source = rest.find((arg) => !arg.startsWith('--'));
    const as = projectOption(rest, 'as');
    if (!source || !as) {
      console.error('Usage: webmcp project guide stage <collections/<id>/GUIDE.md> --as inputs/<path> --yes [--json]');
      return 2;
    }
    const flags = target.flags.filter((arg) => !arg.startsWith('--as'));
    return runRunner(['workspace', 'guide', 'stage', source, '--workspace', target.root, '--as', as, ...flags]);
  }
  console.error(`Unknown project guide command: ${subcommand}`);
  printProjectHelp();
  return 2;
}

// The optional <id> of `project schedule plan|apply` is a bare positional, so it
// cannot be found with a plain "first token that is not a flag": the VALUE of
// `--workspace <path>` / `--target <t>` is bare too and would be picked instead
// (`plan --workspace . --target x` used to fail with "Schedule not found: .").
// Walk the argv and skip each value-taking flag together with its value.
