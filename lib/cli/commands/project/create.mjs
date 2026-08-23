import {
  projectOption,
  runRunner,
  withoutProjectOptions,
} from './registry.mjs';

export async function runProjectNew(args) {
  const at = projectOption(args, 'at');
  const template = projectOption(args, 'template');
  if (args.includes('--template') && !template) {
    console.error('--template requires a value');
    return 2;
  }
  const flags = [];
  for (const flag of ['--default', '--dry-run', '--json']) {
    if (args.includes(flag)) flags.push(flag);
  }
  const id = projectOption(args, 'id');
  const name = projectOption(args, 'name');
  if (template) {
    const argv = ['workspace', 'project-new', '--template', template];
    if (at) argv.push('--at', at);
    if (id) argv.push('--id', id);
    if (name) argv.push('--name', name);
    argv.push(...flags);
    for (const extra of withoutProjectOptions(args, ['at', 'template', 'id', 'name'])) {
      if (!extra.startsWith('--') || ['--default', '--dry-run', '--json'].includes(extra)) continue;
      console.error(`Unknown project new option: ${extra}`);
      return 2;
    }
    return runRunner(argv);
  }
  if (!at) {
    console.error('Usage: webmcp project new [--template <id>] [--at <dir>] [--id <id>] [--name <name>] [--default] [--dry-run] [--json]');
    return 2;
  }
  const argv = ['workspace', 'bootstrap', '--workspace-root', at];
  argv.push('--all');
  if (id) argv.push('--project-id', id);
  if (name) argv.push('--project-name', name);
  argv.push(...flags);
  for (const extra of withoutProjectOptions(args, ['at', 'template', 'id', 'name'])) {
    if (!extra.startsWith('--') || ['--default', '--dry-run', '--json'].includes(extra)) continue;
    console.error(`Unknown project new option: ${extra}`);
    return 2;
  }
  return runRunner(argv);
}
