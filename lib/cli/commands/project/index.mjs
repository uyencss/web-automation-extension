// Shim replacement for packages/webmcp-browser-kit/lib/cli/commands/project/index.mjs
// Plan: docs/initiatives/00-backlog/2026-09-project-commands-extraction/plan.md §5
// Deprecation entrypoint: warns stderr "deprecated: use webmcp project\n"
// Terminal help branch (mirror index.mjs:141-144 -> exit 0) and unknown branch (mirror index.mjs:159-161 -> exit 2)
// Retains real local code and bridges during 30-day soak window (mirroring index.mjs:145-158):
//   - Local real/bridge: attach, list, where, doctor (via ./registry.mjs)
//   - Local runner bridge: charter, guide (via ./charter-guide.mjs)
//   - Retained real code: schedule (via ./schedule.mjs, deferred per §1.2)
//   - Local runner bridge: content, policy (via local runner helpers)
//   - Project Store bridge: init, init-store, build-index, export-pack (via runRunner)
//   - Hybrid subcommand 'new' (via ./create.mjs):
//       * Delegates --archetype to WebMCP CLI / Project Kit (plan §5)
//       * Retains local Runner execution for --template and bootstrap --at
// Avoids delegation loops with webmcp-cli/lib/commands/project.mjs:320-321,362.

import process from 'node:process';
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

function runProjectPolicy(args) {
  const [action, ...policyArgs] = args;
  const usage = action === 'apply'
    ? 'Usage: webmcp project policy apply [--at <dir>] [--all] --yes --json'
    : 'Usage: webmcp project policy plan [--at <dir>] [--all] --json';
  if (!['plan', 'apply'].includes(action)) {
    console.error(`Unknown project policy command: ${action || ''}`.trim());
    console.error(usage);
    return Promise.resolve(2);
  }

  const allowedBoolean = new Set(['all', 'json', 'yes']);
  for (let index = 0; index < policyArgs.length; index += 1) {
    const arg = policyArgs[index];
    if (!arg.startsWith('--')) {
      console.error(usage);
      return Promise.resolve(2);
    }
    const name = arg.slice(2).split('=', 1)[0];
    if (name === 'at' || name === 'workspace') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : policyArgs[index + 1];
      if (!arg.includes('=')) {
        if (value === undefined || value.startsWith('--')) {
          console.error(usage);
          return Promise.resolve(2);
        }
        index += 1;
      }
      if (!value?.trim()) {
        console.error(usage);
        return Promise.resolve(2);
      }
      continue;
    }
    if (!allowedBoolean.has(name) || (arg.includes('=') && !['true', 'false'].includes(arg.slice(arg.indexOf('=') + 1)))) {
      console.error(usage);
      return Promise.resolve(2);
    }
  }

  const atOptions = projectLocationOptions(policyArgs, 'at');
  const workspaceOptions = projectLocationOptions(policyArgs, 'workspace');
  if (atOptions.length > 1 || workspaceOptions.length > 1
    || (atOptions.length > 0 && workspaceOptions.length > 0)) {
    console.error('USAGE_ERROR: project policy accepts exactly one project location');
    return Promise.resolve(2);
  }
  const atSpecified = policyArgs.some((arg) => arg === '--at' || arg.startsWith('--at='));
  const at = projectOption(policyArgs, 'at');
  const workspace = projectOption(policyArgs, 'workspace');
  if (atSpecified && !at?.trim()) {
    console.error(usage);
    return Promise.resolve(2);
  }
  if (policyArgs.some((arg) => arg === '--all' || arg.startsWith('--all=')) && (at || workspace)) {
    console.error('USAGE_ERROR: project policy cannot combine --all with a project location');
    return Promise.resolve(2);
  }
  if (!policyArgs.some((arg) => arg === '--json' || arg.startsWith('--json='))) {
    console.error(usage);
    return Promise.resolve(2);
  }
  if (action === 'apply' && !policyArgs.some((arg) => arg === '--yes' || arg === '--yes=true')) {
    console.error(usage);
    return Promise.resolve(2);
  }
  if (action === 'plan' && policyArgs.some((arg) => arg === '--yes' || arg === '--yes=true')) {
    console.error(usage);
    return Promise.resolve(2);
  }

  const forwarded = at
    ? ['--workspace', at, ...withoutProjectOptions(policyArgs, ['at'])]
    : policyArgs;
  return runRunner(['project', 'policy', action, ...forwarded]);
}

export async function runProject(args) {
  // Warn format per plan §5 contract: "deprecated: use X"
  process.stderr.write('deprecated: use webmcp project\n');
  const [subcommand, ...rest] = args;

  // Re-entry guard: breaks ping-pong loop if CLI ever bounces back via delegateBrowser (:362)
  if (process.env.WEBMCP_PROJECT_SHIM_ACTIVE) {
    console.error(`error: re-entry loop detected for project command: ${subcommand || ''}`.trim());
    return 2;
  }

  // Local terminal help branch: mirrors canonical index.mjs:141-144 (exit 0)
  // Resolves loop with webmcp-cli/lib/commands/project.mjs:320-321
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printProjectHelp();
    return 0;
  }

  // Real local implementations & bridges retained during 30-day soak window (mirroring index.mjs:145-158)
  if (subcommand === 'attach') return runProjectAttach(rest);
  if (subcommand === 'list') return runRunner(['workspace', 'list', ...rest]);
  if (subcommand === 'where') return runProjectWhere(rest);
  if (subcommand === 'doctor') return runProjectDoctor(rest);
  // 'new' delegates --archetype to WebMCP CLI / Project Kit; retains --template and bootstrap locally
  if (subcommand === 'new') return runProjectNew(rest);
  if (subcommand === 'charter') return runProjectCharter(rest);
  if (subcommand === 'guide') return runProjectGuide(rest);
  if (subcommand === 'schedule') return runProjectSchedule(rest);
  if (subcommand === 'content') return runProjectContent(rest);
  if (subcommand === 'policy') return runProjectPolicy(rest);
  // Project Store commands — thin bridge onto Runner's project.* surface (R6.1)
  if (subcommand === 'init' || subcommand === 'init-store') return runRunner(['project', 'init-store', ...rest]);
  if (subcommand === 'build-index') return runRunner(['project', 'build-index', ...rest]);
  if (subcommand === 'export-pack') return runRunner(['project', 'export-pack', ...rest]);

  // Local terminal unknown branch: mirrors canonical index.mjs:159-161
  // Preserves Prep-2 Quirk 3 (exit 2, stderr message + stdout help) without bouncing to CLI
  console.error(`Unknown project command: ${subcommand}`);
  printProjectHelp();
  return 2;
}
