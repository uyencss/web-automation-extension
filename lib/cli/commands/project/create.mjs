// Draft replacement for packages/webmcp-browser-kit/lib/cli/commands/project/create.mjs
// Initiative: 2026-09-project-commands-extraction (Plan §5)
// Shows archetype delegation branch while keeping --template and bootstrap branches intact.
// Quirk preservation:
//   - 'project new --help' -> exit 2 (no --help handling, rejects as unknown option)
//   - 'project new --template bogus --json' -> exit 2 with JSON envelope on stdout from Runner

import process from 'node:process';
import { spawn } from 'node:child_process';
import { resolveCliBin } from '../../component-resolver.mjs';
import { runRunner } from './registry.mjs';

const PROJECT_NEW_USAGE = 'Usage: webmcp project new [--archetype <id>] [--template <id>] [--at <dir>] [--id <id>] [--name <name>] [--default] [--dry-run] [--json]';
const VALUE_OPTIONS = new Set(['archetype', 'template', 'at', 'id', 'name']);
const BOOLEAN_OPTIONS = new Set(['default', 'dry-run', 'json']);

function parseProjectNewArgs(args) {
  const values = {};
  const booleans = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      return { error: `Unknown project new argument: ${arg}` };
    }

    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    if (!VALUE_OPTIONS.has(name) && !BOOLEAN_OPTIONS.has(name)) {
      return { error: `Unknown project new option: ${arg}` };
    }
    if (equals !== -1 && BOOLEAN_OPTIONS.has(name)) {
      return { error: `Project new option --${name} does not take a value` };
    }
    if (values[name] !== undefined || booleans.has(name)) {
      return { error: `Duplicate project new option: --${name}` };
    }

    if (VALUE_OPTIONS.has(name)) {
      const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
      if (equals === -1 && (value === undefined || value.startsWith('--'))) {
        return { error: `Project new option --${name} requires a value` };
      }
      if (typeof value !== 'string' || value.trim().length === 0) {
        return { error: `Project new option --${name} requires a non-empty value` };
      }
      values[name] = value;
      if (equals === -1) index += 1;
      continue;
    }

    booleans.add(name);
  }

  return { values, booleans };
}

export async function runProjectNew(args) {
  const parsed = parseProjectNewArgs(args);
  if (parsed.error) {
    console.error(parsed.error);
    console.error(PROJECT_NEW_USAGE);
    return 2;
  }

  const { values, booleans } = parsed;
  const { archetype, template, at, id, name } = values;

  // Mutual exclusion: fail-closed if both specified (matches webmcp-cli/lib/commands/project.mjs:74-75)
  if (archetype && template) {
    console.error('error: --archetype and --template must not be combined');
    return 2;
  }

  // --- NEW DELEGATE BRANCH: archetype -> WebMCP CLI / Project Kit ---
  if (archetype) {
    process.stderr.write('deprecated: use webmcp project new --archetype\n');
    const cliBin = resolveCliBin();
    if (!cliBin) {
      console.error('WebMCP CLI not found. Install @gyga-browser/webmcp-cli or run via webmcp.');
      return 1;
    }
    const child = spawn(process.execPath, [cliBin, 'project', 'new', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    return new Promise((resolve) => {
      child.on('error', (err) => {
        console.error(`Failed to delegate project new: ${err.message}`);
        resolve(1);
      });
      child.on('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    });
  }

  // --- UNTOUCHED REAL CODE: --template and legacy bootstrap (Runner) ---
  const flags = [];
  for (const flag of ['default', 'dry-run', 'json']) {
    if (booleans.has(flag)) flags.push(`--${flag}`);
  }

  if (template) {
    const argv = ['workspace', 'project-new', '--template', template];
    if (at) argv.push('--at', at);
    if (id) argv.push('--id', id);
    if (name) argv.push('--name', name);
    argv.push(...flags);
    return runRunner(argv);
  }
  if (!at) {
    console.error(PROJECT_NEW_USAGE);
    return 2;
  }
  const argv = ['workspace', 'bootstrap', '--workspace-root', at];
  argv.push('--all');
  if (id) argv.push('--project-id', id);
  if (name) argv.push('--project-name', name);
  argv.push(...flags);
  return runRunner(argv);
}
