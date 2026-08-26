import { printProjectHelp } from '../../help.mjs';
import { runProjectCharter, runProjectGuide } from './charter-guide.mjs';
import { runProjectNew } from './create.mjs';
import {
  runProjectAttach,
  runProjectDoctor,
  runProjectWhere,
  runRunner,
  projectOption,
  withoutProjectOptions,
} from './registry.mjs';
import { runProjectSchedule } from './schedule.mjs';

function projectLocationOptions(args, name) {
  const prefix = `--${name}`;
  const matches = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === prefix) {
      const next = args[index + 1];
      matches.push(next === undefined || next.startsWith('--') ? null : next);
      if (next !== undefined && !next.startsWith('--')) index += 1;
      continue;
    }
    if (arg.startsWith(`${prefix}=`)) matches.push(arg.slice(prefix.length + 1));
  }
  return matches;
}

function runProjectContent(args) {
  const [action, ...contentArgs] = args;
  if (!['plan', 'apply'].includes(action)) {
    console.error(`Unknown project content command: ${action || ''}`.trim());
    printProjectHelp();
    return Promise.resolve(2);
  }

  const atOptions = projectLocationOptions(contentArgs, 'at');
  const workspaceOptions = projectLocationOptions(contentArgs, 'workspace');
  if (atOptions.length > 1 || workspaceOptions.length > 1
    || (atOptions.length > 0 && workspaceOptions.length > 0)) {
    console.error('USAGE_ERROR: project content accepts exactly one project location');
    return Promise.resolve(2);
  }

  const hasAt = contentArgs.some((arg) => arg === '--at' || arg.startsWith('--at='));
  const at = projectOption(contentArgs, 'at');
  if (hasAt && !at?.trim()) {
    console.error('project content requires a non-empty --at <dir> value');
    return Promise.resolve(2);
  }
  if (at && projectOption(contentArgs, 'workspace')) {
    console.error('project content cannot combine --at with --workspace');
    return Promise.resolve(2);
  }
  const forwarded = at
    ? ['--workspace', at, ...withoutProjectOptions(contentArgs, ['at'])]
    : contentArgs;
  return runRunner(['project', 'content', action, ...forwarded]);
}

export async function runProject(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printProjectHelp();
    return 0;
  }
  if (subcommand === 'attach') return runProjectAttach(rest);
  if (subcommand === 'list') return runRunner(['workspace', 'list', ...rest]);
  if (subcommand === 'where') return runProjectWhere(rest);
  if (subcommand === 'doctor') return runProjectDoctor(rest);
  if (subcommand === 'new') return runProjectNew(rest);
  if (subcommand === 'charter') return runProjectCharter(rest);
  if (subcommand === 'guide') return runProjectGuide(rest);
  if (subcommand === 'schedule') return runProjectSchedule(rest);
  if (subcommand === 'content') return runProjectContent(rest);
  // Project Store commands — thin bridge onto Runner's project.* surface (R6.1)
  if (subcommand === 'init' || subcommand === 'init-store') return runRunner(['project', 'init-store', ...rest]);
  if (subcommand === 'build-index') return runRunner(['project', 'build-index', ...rest]);
  if (subcommand === 'export-pack') return runRunner(['project', 'export-pack', ...rest]);
  console.error(`Unknown project command: ${subcommand}`);
  printProjectHelp();
  return 2;
}
