import { runRunner } from './registry.mjs';

const PROJECT_NEW_USAGE = 'Usage: webmcp project new [--template <id>] [--at <dir>] [--id <id>] [--name <name>] [--default] [--dry-run] [--json]';
const VALUE_OPTIONS = new Set(['template', 'at', 'id', 'name']);
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
  const { at, template, id, name } = values;
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
