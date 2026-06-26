#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { WorkflowRunner } = require('./workflow-runner');
const { normalizeWorkflow } = require('./workflow-normalizer');
const { validateWorkflow } = require('./workflow-validator');
const { getCommand, getCommandGroups, isUnsupportedCommand, getUnsupportedReason } = require('./command-catalog');
const { extractTemplatePaths } = require('./workflow-context');

function printUsage() {
  console.log(`
WebMCP JSON Workflow Runner

Usage:
  node runner/run.js <workflow.json> [options]

Options:
  --var KEY=VALUE              Override a workflow variable. Can be repeated.
  --dry-run                    Normalize and validate without executing commands.
  --timeout MS                 Override the workflow default command timeout.
  --gateway-url URL            WebMCP gateway endpoint. Default: http://localhost:7865/api
  --run-id ID                  Stable run id for events/log correlation.
  --json-events                Print machine-readable event envelopes.
  --strict                     Treat unknown template variables as validation errors.
  --allow-unknown-command      Allow passthrough commands not present in the catalog.
  --help                       Show this help message.

Examples:
  node runner/run.js workflows/gemini/chat.json --dry-run
  node runner/run.js workflows/gemini/chat.json --var PROMPT="Hello" --timeout 60000
  node runner/run.js workflows/facebook/post_text.json --gateway-url http://localhost:7865/api
`);
}

function readOptionValue(args, index, optionName) {
  if (index + 1 >= args.length) {
    throw new Error(`${optionName} requires a value`);
  }
  return args[index + 1];
}

function parsePositiveInteger(value, optionName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return number;
}

function parseArgs(args) {
  const result = {
    workflowPath: null,
    variables: {},
    dryRun: false,
    timeoutMs: undefined,
    gatewayUrl: undefined,
    runId: undefined,
    jsonEvents: false,
    strict: false,
    allowUnknownCommand: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }

    if (arg === '--json-events') {
      result.jsonEvents = true;
      continue;
    }

    if (arg === '--strict') {
      result.strict = true;
      continue;
    }

    if (arg === '--allow-unknown-command') {
      result.allowUnknownCommand = true;
      continue;
    }

    if (arg === '--var') {
      const pair = readOptionValue(args, i, '--var');
      i += 1;
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) {
        throw new Error(`--var must be KEY=VALUE, got "${pair}"`);
      }
      result.variables[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);
      continue;
    }

    if (arg === '--timeout') {
      result.timeoutMs = parsePositiveInteger(readOptionValue(args, i, '--timeout'), '--timeout');
      i += 1;
      continue;
    }

    if (arg === '--gateway-url') {
      result.gatewayUrl = readOptionValue(args, i, '--gateway-url');
      i += 1;
      continue;
    }

    if (arg === '--run-id') {
      result.runId = readOptionValue(args, i, '--run-id');
      i += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (result.workflowPath) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    result.workflowPath = arg;
  }

  return result;
}

function loadWorkflow(workflowPath) {
  let workflowFile = path.resolve(workflowPath);
  if (!fs.existsSync(workflowFile)) {
    // Fallback: if path starts with workflows/ or is relative to it, check inside .examples/
    const isWorkflowsPrefix = workflowPath.startsWith('workflows/') || workflowPath.startsWith('./workflows/');
    if (isWorkflowsPrefix) {
      const normalizedPath = workflowPath.startsWith('./') ? workflowPath.slice(2) : workflowPath;
      const fallbackPath = path.join(ROOT, '.examples', normalizedPath);
      if (fs.existsSync(fallbackPath)) {
        workflowFile = fallbackPath;
      }
    }
  }

  if (!fs.existsSync(workflowFile)) {
    throw new Error(`Workflow file not found: ${workflowFile}`);
  }

  try {
    return {
      workflowFile,
      workflow: JSON.parse(fs.readFileSync(workflowFile, 'utf8')),
    };
  } catch (error) {
    throw new Error(`Failed to parse workflow file: ${error.message}`);
  }
}

function buildRouteSummary(steps) {
  const routes = [];
  for (const step of steps) {
    if (step.onSuccess) routes.push({ from: step.id, type: 'success', to: step.onSuccess });
    if (typeof step.onFailure === 'string') {
      routes.push({ from: step.id, type: 'failure', to: step.onFailure });
    } else if (step.onFailure && typeof step.onFailure === 'object') {
      for (const [code, target] of Object.entries(step.onFailure)) {
        routes.push({ from: step.id, type: `failure:${code}`, to: target });
      }
    }
  }
  return routes;
}

function buildUsedCommands(steps) {
  const commands = new Set();
  for (const step of steps) {
    if (step.command) commands.add(step.command);
    if (step.fallback?.command) commands.add(step.fallback.command);
    if (step.strategy === 'ai-vision') {
      commands.add('getInteractiveElements');
      commands.add('dispatchClick');
    }
  }

  return Array.from(commands).sort().map((name) => {
    const command = getCommand(name);
    return {
      name,
      known: Boolean(command),
      group: command?.group,
      unsupported: isUnsupportedCommand(name),
      reason: isUnsupportedCommand(name) ? getUnsupportedReason(name) : undefined,
    };
  });
}

function buildDryRunReport(normalized, validation) {
  return {
    workflow: {
      id: normalized.id,
      name: normalized.name,
      version: normalized.version || '1.0',
      description: normalized.description,
    },
    settings: normalized.settings,
    validation,
    templateRefs: Array.from(extractTemplatePaths(normalized.steps)).sort(),
    commands: buildUsedCommands(normalized.steps || []),
    routes: buildRouteSummary(normalized.steps || []),
    steps: (normalized.steps || []).map((step) => ({
      id: step.id,
      label: step.label,
      command: step.command,
      strategy: step.strategy,
      critical: step.critical,
      timeoutMs: step.timeoutMs,
      retryPolicy: step.retryPolicy,
      wait: step.wait,
      captureAs: step.captureAs,
      onSuccess: step.onSuccess,
      onFailure: step.onFailure,
    })),
  };
}

function printValidation(validation) {
  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    console.log('Validation: ok');
    return;
  }

  if (validation.errors.length > 0) {
    console.log(`Validation errors (${validation.errors.length}):`);
    for (const error of validation.errors) console.log(`  - ${error}`);
  }

  if (validation.warnings.length > 0) {
    console.log(`Validation warnings (${validation.warnings.length}):`);
    for (const warning of validation.warnings) console.log(`  - ${warning}`);
  }
}

function printDryRun(report) {
  console.log(`Workflow: ${report.workflow.name} (${report.workflow.id})`);
  console.log(`Version: ${report.workflow.version}`);
  console.log(`Steps: ${report.steps.length}`);
  console.log(`Default timeout: ${report.settings.defaultTimeout}ms`);
  console.log('');
  printValidation(report.validation);
  console.log('');

  console.log('Steps:');
  for (let i = 0; i < report.steps.length; i++) {
    const step = report.steps[i];
    const kind = step.strategy ? `strategy:${step.strategy}` : `command:${step.command}`;
    const retry = step.retryPolicy
      ? `retry=${step.retryPolicy.maxAttempts} backoff=${step.retryPolicy.backoffMs}ms`
      : 'retry=default';
    console.log(`  ${i + 1}. [${step.id}] ${kind} critical=${step.critical} timeout=${step.timeoutMs}ms ${retry}`);
    if (step.captureAs) console.log(`     captureAs=${step.captureAs}`);
    if (step.wait) console.log(`     wait=${step.wait.type}:${step.wait.ms}ms`);
    if (step.onSuccess) console.log(`     onSuccess -> ${step.onSuccess}`);
    if (step.onFailure) console.log(`     onFailure -> ${JSON.stringify(step.onFailure)}`);
  }

  console.log('');
  console.log('Commands:');
  for (const command of report.commands) {
    const status = command.unsupported ? 'unsupported' : (command.known ? command.group : 'unknown');
    console.log(`  - ${command.name}: ${status}`);
    if (command.reason) console.log(`    ${command.reason}`);
  }

  console.log('');
  console.log('Routes:');
  if (report.routes.length === 0) {
    console.log('  - sequential only');
  } else {
    for (const route of report.routes) {
      console.log(`  - ${route.from} --${route.type}--> ${route.to}`);
    }
  }

  console.log('');
  console.log('Template refs:');
  if (report.templateRefs.length === 0) {
    console.log('  - none');
  } else {
    for (const ref of report.templateRefs) console.log(`  - {{${ref}}}`);
  }

  console.log('');
  console.log('Command catalog:');
  for (const group of getCommandGroups()) {
    console.log(`  - ${group.label}: ${group.commands.map((command) => command.name).join(', ')}`);
  }
}

function attachReadableLogger(runner) {
  runner.on('start', (event) => {
    const workflow = event.payload.workflow;
    console.log(`Run: ${event.runId}`);
    console.log(`Workflow: ${workflow.name} (${workflow.id})`);
    console.log(`Steps: ${event.payload.totalSteps}`);
    if (event.payload.warnings.length > 0) {
      console.log(`Warnings: ${event.payload.warnings.length}`);
      for (const warning of event.payload.warnings) console.log(`  - ${warning}`);
    }
    console.log('');
  });

  runner.on('step', (event) => {
    const payload = event.payload;
    const prefix = `[${payload.stepIndex + 1}/${payload.totalSteps}] ${payload.stepId}`;

    if (payload.type === 'started') {
      const kind = payload.strategy ? `strategy:${payload.strategy}` : payload.command;
      console.log(`${prefix} started (${kind})`);
      return;
    }

    if (payload.type === 'retrying') {
      console.log(`${prefix} retrying attempt ${payload.nextAttempt} after ${payload.delayMs}ms: ${payload.error.code} ${payload.error.message}`);
      return;
    }

    if (payload.type === 'completed') {
      console.log(`${prefix} completed in ${payload.duration}ms`);
      return;
    }

    if (payload.type === 'skipped') {
      console.log(`${prefix} skipped in ${payload.duration}ms: ${payload.reason}`);
      return;
    }

    if (payload.type === 'failed') {
      console.log(`${prefix} failed in ${payload.duration}ms: ${payload.error.code} ${payload.error.message}`);
    }
  });

  runner.on('recovery', (event) => {
    console.log(`Recovery: ${event.payload.stepId} -> ${event.payload.nextStepId}`);
  });

  runner.on('end', (event) => {
    const summary = event.payload;
    console.log('');
    console.log(`Result: ${summary.status}`);
    console.log(`Duration: ${summary.duration}ms`);
    console.log(`Steps: ${summary.stepsCompleted} completed, ${summary.stepsFailed} failed, ${summary.stepsSkipped} skipped, ${summary.stepsTotal} total`);
    if (summary.error) {
      console.log(`Error: ${summary.error.code} ${summary.error.message}`);
    }
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    printUsage();
    process.exit(1);
  }

  if (!parsed.workflowPath) {
    console.error('Error: No workflow file specified');
    printUsage();
    process.exit(1);
  }

  let workflowFile;
  let workflow;
  try {
    ({ workflowFile, workflow } = loadWorkflow(parsed.workflowPath));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  const normalized = normalizeWorkflow(workflow, {
    defaultTimeout: parsed.timeoutMs,
  });
  const validation = validateWorkflow(normalized, {
    strict: parsed.strict,
    allowUnknownCommand: parsed.allowUnknownCommand,
    runtimeVariables: parsed.variables,
  });

  if (parsed.dryRun) {
    const report = buildDryRunReport(normalized, validation);
    if (parsed.jsonEvents) {
      console.log(JSON.stringify(report));
    } else {
      console.log(`Loaded: ${workflowFile}`);
      console.log('');
      printDryRun(report);
      console.log('');
      console.log('Dry run complete. No commands were sent.');
    }
    process.exit(validation.valid ? 0 : 1);
  }

  if (!validation.valid) {
    printValidation(validation);
    process.exit(1);
  }

  const runner = new WorkflowRunner(workflow, {
    variables: parsed.variables,
    gatewayUrl: parsed.gatewayUrl,
    runId: parsed.runId,
    timeoutMs: parsed.timeoutMs,
    strictValidation: parsed.strict,
    allowUnknownCommand: parsed.allowUnknownCommand,
  });

  if (parsed.jsonEvents) {
    runner.on('event', (event) => {
      console.log(JSON.stringify(event));
    });
  } else {
    attachReadableLogger(runner);
  }

  const result = await runner.run();
  if (result.status === 'completed' || result.status === 'completed_with_errors') {
    process.exit(0);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
