import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../../context.mjs';
import { getAutomationBin, getRunnerBin } from '../../component-resolver.mjs';
import { projectOption, resolvedProjectRoot } from './registry.mjs';

const SCHEDULE_VALUE_FLAGS = new Set(['--workspace', '--target']);

function scheduleIdArgument(rest) {
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (SCHEDULE_VALUE_FLAGS.has(arg)) {
      index += 1; // consume the flag's value
      continue;
    }
    if (arg.startsWith('--')) continue; // `--flag=value` and boolean flags
    return arg;
  }
  return undefined;
}

export async function runProjectSchedule(args) {
  const [subcommand, ...rest] = args;
  const usage = [
    'Usage: webmcp project schedule list [--workspace <path>] [--json]',
    '       webmcp project schedule plan [<id>] --target <t> [--workspace <path>] [--json]',
    '       webmcp project schedule apply [<id>] --target <t> [--workspace <path>] [--json]',
    '       webmcp project schedule status [--all-targets] [--workspace <path>] [--json]',
  ].join('\n');

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    console.error(usage);
    return subcommand && subcommand !== 'help' ? 2 : 0;
  }

  const workspaceOpt = projectOption(rest, 'workspace');
  let workspaceRoot = workspaceOpt ? resolve(process.cwd(), workspaceOpt) : null;
  let workspaceFromRegistry = false;
  if (!workspaceRoot) {
    const entry = resolvedProjectRoot();
    if (entry?.root) {
      workspaceRoot = resolve(entry.root);
      workspaceFromRegistry = resolve(entry.root) !== resolve(process.cwd());
    } else {
      workspaceRoot = process.cwd();
    }
  }

  // `apply` writes provider state. Without --workspace the root comes from the
  // registry's default project, which is frequently NOT the directory the
  // operator is standing in — applying there would arm a schedule in the wrong
  // project. Read-only verbs may keep the registry default.
  if (subcommand === 'apply' && workspaceFromRegistry) {
    console.error(`Refusing to apply: --workspace was not given, so the project resolved from the registry to ${workspaceRoot}, which is not the current directory (${process.cwd()}).`);
    console.error(`Re-run with the project stated explicitly, e.g. webmcp project schedule apply <id> --workspace ${process.cwd()} --target <t>`);
    return 2;
  }

  const manifestPath = join(workspaceRoot, 'webmcp.project.json');
  if (!existsSync(manifestPath)) {
    console.error(`No project workspace found at ${workspaceRoot} (missing webmcp.project.json)`);
    return 1;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`Invalid project manifest at ${manifestPath}: ${err.message}`);
    return 1;
  }

  const automationBin = getAutomationBin();
  const automationStoreRoot = automationBin ? resolve(dirname(automationBin), '..') : resolve(ROOT, '..', '..', 'stores', 'webmcp-automation-store');
  const scheduleLibPath = join(automationStoreRoot, 'lib', 'schedule.mjs');
  if (!existsSync(scheduleLibPath)) {
    console.error(`schedule.mjs not found at ${scheduleLibPath}`);
    return 1;
  }

  const scheduleMod = await import(pathToFileURL(scheduleLibPath).href);
  const json = rest.includes('--json');
  const target = projectOption(rest, 'target');
  const allTargets = rest.includes('--all-targets');

  // Discover schedules in project
  const projectSchedules = scheduleMod.discoverProjectSchedules(workspaceRoot);

  // Two-tier resolution is the runner's contract, not something to reimplement:
  // `resolveAutomation` validates each candidate (a project pack that exists but
  // lacks an entrypoint raises PROJECT_ASSET_INVALID instead of silently
  // shadowing the community copy) and owns the domain/id parsing rules.
  const runnerBinForResolve = getRunnerBin();
  const runnerRoot = runnerBinForResolve ? resolve(dirname(runnerBinForResolve), '..') : null;
  if (!runnerRoot || !existsSync(join(runnerRoot, 'src', 'store-resolver.mjs'))) {
    console.error('webmcp-automation-runner not found; cannot resolve automations for project schedules.');
    return 1;
  }
  const resolverMod = await import(pathToFileURL(join(runnerRoot, 'src', 'store-resolver.mjs')).href);
  const projectContextMod = await import(pathToFileURL(join(runnerRoot, 'src', 'workspace', 'project-context.mjs')).href);
  const projectContext = projectContextMod.resolveProjectContext(workspaceRoot);

  function resolvePackContext(scheduleRecord) {
    const schedule = scheduleRecord.schedule;
    const automationId = schedule?.task?.automationId;
    const domain = schedule?.task?.domain;
    if (!domain || !automationId) {
      throw new Error(`Schedule ${schedule?.id || scheduleRecord.file} is missing task.domain or task.automationId`);
    }
    const resolved = resolverMod.resolveAutomation({ domain, id: automationId }, projectContext, automationStoreRoot);
    const automationRoot = resolved.source === 'project' ? workspaceRoot : automationStoreRoot;
    return {
      automationRoot,
      automationDir: resolve(automationRoot, resolved.sourceRelativePath),
      source: resolved.source,
      domain,
      automationId,
    };
  }

  if (subcommand === 'list') {
    if (json) {
      console.log(JSON.stringify({
        schema: 'webmcp.project-schedules/1',
        projectId: manifest.id,
        workspaceRoot,
        schedules: projectSchedules,
      }, null, 2));
      return 0;
    }
    if (projectSchedules.length === 0) {
      console.log(`No schedules found in ${join(workspaceRoot, 'schedules')}`);
      return 0;
    }
    console.log(`\nProject Schedules for ${manifest.name || manifest.id} (${workspaceRoot}):\n`);
    for (const item of projectSchedules) {
      const s = item.schedule;
      if (!item.ok) {
        console.log(`  ✗ ${item.relativeFile}: ${item.errors.join('; ')}`);
        continue;
      }
      const triggerStr = s.trigger.type === 'cron' ? `cron(${s.trigger.expression})` : `${s.trigger.type}(${s.trigger.at || s.trigger.fireAt || ''})`;
      const statusStr = s.enabled ? '\x1b[32menabled\x1b[0m' : '\x1b[33mdisabled\x1b[0m';
      console.log(`  • \x1b[1m${s.id}\x1b[0m [${statusStr}] — ${s.description}`);
      console.log(`    Task: ${s.task.domain}/${s.task.automationId} (${s.task.type})`);
      console.log(`    Trigger: ${triggerStr}`);
      console.log(`    Targets: ${s.targets.join(', ')}`);
      console.log(`    File: ${item.relativeFile}`);
      console.log();
    }
    return 0;
  }

  if (subcommand === 'plan') {
    if (!target) {
      console.error('Missing required option: --target <target>');
      console.error(usage);
      return 2;
    }
    const scheduleId = scheduleIdArgument(rest);
    const targets = scheduleId
      ? projectSchedules.filter((item) => item.id === scheduleId)
      : projectSchedules;

    if (targets.length === 0) {
      console.error(scheduleId ? `Schedule not found: ${scheduleId}` : 'No schedules found to plan.');
      return 1;
    }

    const plans = [];
    for (const item of targets) {
      if (!item.ok) {
        console.error(`Invalid schedule ${item.relativeFile}: ${item.errors.join('; ')}`);
        return 1;
      }
      try {
        const packCtx = resolvePackContext(item);
        const plan = scheduleMod.planSchedule(item.schedule, {
          ...packCtx,
          target,
          externalIdPrefix: manifest.id,
        });
        plans.push({ id: item.id, relativeFile: item.relativeFile, ...plan });
      } catch (err) {
        console.error(`Failed to plan ${item.id}: ${err.message}`);
        return 1;
      }
    }

    if (json) {
      console.log(JSON.stringify(scheduleId ? plans[0] : { projectId: manifest.id, target, plans }, null, 2));
      return 0;
    }

    for (const p of plans) {
      console.log(`\nPlan for \x1b[1m${p.id}\x1b[0m (target: ${target}, action: \x1b[36m${p.action}\x1b[0m):`);
      console.log(`  Reason: ${p.reason}`);
      console.log(`  Desired Hash: ${p.desiredHash}`);
      console.log(`  Observed Hash: ${p.observedHash || '(none)'}`);
      if (p.desired?.prompt) {
        console.log(`  Prompt preview: ${p.desired.prompt.split('\n')[0]}...`);
      }
    }
    return 0;
  }

  if (subcommand === 'apply') {
    if (!target) {
      console.error('Missing required option: --target <target>');
      console.error(usage);
      return 2;
    }
    const scheduleId = scheduleIdArgument(rest);
    if (!scheduleId) {
      console.error('Missing schedule <id> argument to apply.');
      console.error(usage);
      return 2;
    }
    const item = projectSchedules.find((s) => s.id === scheduleId);
    if (!item) {
      console.error(`Schedule not found: ${scheduleId}`);
      return 1;
    }
    if (!item.ok) {
      console.error(`Invalid schedule ${item.relativeFile}: ${item.errors.join('; ')}`);
      return 1;
    }
    try {
      const packCtx = resolvePackContext(item);
      const result = scheduleMod.applySchedule(item.schedule, {
        ...packCtx,
        target,
        externalIdPrefix: manifest.id,
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 1;
      }
      if (result.ok) {
        console.log(`\x1b[32m✓\x1b[0m Successfully applied schedule \x1b[1m${item.id}\x1b[0m to target ${target}`);
        if (result.file) console.log(`  Sidecar file: ${result.file}`);
        if (result.configFile) console.log(`  Config authorization: ${result.configFile}`);
        if (result.nextSteps) {
          console.log('\nNext steps:');
          for (const step of result.nextSteps) console.log(`  - ${step}`);
        }
        return 0;
      } else {
        console.error(`\x1b[31m✗\x1b[0m Failed to apply schedule: ${result.code} - ${result.message}`);
        return 1;
      }
    } catch (err) {
      console.error(`Apply error: ${err.message}`);
      return 1;
    }
  }

  if (subcommand === 'status') {
    const inspectTarget = target || 'gemini-sidecar';
    const targetsToInspect = allTargets ? ['gemini-sidecar', 'claude-local-routine', 'codex-scheduled'] : [inspectTarget];
    const report = [];
    for (const item of projectSchedules) {
      if (!item.ok) continue;
      for (const t of targetsToInspect) {
        try {
          const inspected = scheduleMod.inspectSchedule(item.schedule, {
            target: t,
            externalIdPrefix: manifest.id,
          });
          report.push({
            id: item.id,
            target: t,
            enabled: item.schedule.enabled,
            exists: inspected.exists,
            status: inspected.entry?.status || (inspected.exists ? 'present' : 'absent'),
            inspected,
          });
        } catch (err) {
          report.push({ id: item.id, target: t, error: err.message });
        }
      }
    }
    if (json) {
      console.log(JSON.stringify({ projectId: manifest.id, workspaceRoot, statuses: report }, null, 2));
      return 0;
    }
    console.log(`\nProject Schedules Status for ${manifest.id}:\n`);
    for (const r of report) {
      console.log(`  • \x1b[1m${r.id}\x1b[0m (${r.target}): status=${r.status || 'unknown'}, exists=${r.exists}`);
    }
    return 0;
  }

  console.error(`Unknown project schedule subcommand: ${subcommand}`);
  console.error(usage);
  return 2;
}
