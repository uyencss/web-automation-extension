#!/usr/bin/env node

/**
 * WebMCP JSON Workflow Runner — CLI Entry Point
 * 
 * Usage:
 *   node run.js <workflow.json> [--var KEY=VALUE ...]
 * 
 * Examples:
 *   node run.js ../workflows/facebook/post_text.json
 *   node run.js ../workflows/facebook/post_text.json --var POST_TEXT="Hello World!"
 *   node run.js ../workflows/facebook/post_with_gradient.json --var POST_TEXT="Good morning!"
 */

const fs = require('fs');
const path = require('path');
const { runWorkflow } = require('./workflow-runner');

function printUsage() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  WebMCP JSON Workflow Runner                                ║
╚══════════════════════════════════════════════════════════════╝

Usage:
  node run.js <workflow.json> [options]

Options:
  --var KEY=VALUE    Override a workflow variable (can be used multiple times)
  --dry-run          Parse and validate without executing
  --help             Show this help message

Examples:
  node run.js ../workflows/facebook/post_text.json
  node run.js ../workflows/facebook/post_text.json --var POST_TEXT="Hello World!"
  node run.js ../workflows/facebook/post_with_gradient.json --var POST_TEXT="Good morning! ☀️"
`);
}

function parseArgs(args) {
  const result = {
    workflowPath: null,
    variables: {},
    dryRun: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--var' && i + 1 < args.length) {
      i++;
      const pair = args[i];
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) {
        console.error(`Error: --var argument must be in KEY=VALUE format, got: "${pair}"`);
        process.exit(1);
      }
      const key = pair.substring(0, eqIdx);
      const value = pair.substring(eqIdx + 1);
      result.variables[key] = value;
    } else if (!arg.startsWith('--')) {
      result.workflowPath = arg;
    } else {
      console.error(`Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }
    i++;
  }

  return result;
}

function validateWorkflow(workflow) {
  const errors = [];

  if (!workflow.id) errors.push('Missing "id" field');
  if (!workflow.name) errors.push('Missing "name" field');
  if (!Array.isArray(workflow.steps)) errors.push('"steps" must be an array');
  
  if (Array.isArray(workflow.steps)) {
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      if (!step.id) errors.push(`Step ${i}: missing "id"`);
      if (!step.command && !step.strategy) {
        errors.push(`Step ${i} ("${step.id || '?'}"): must have "command" or "strategy"`);
      }
    }
  }

  return errors;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const parsed = parseArgs(args);

  if (!parsed.workflowPath) {
    console.error('Error: No workflow file specified');
    printUsage();
    process.exit(1);
  }

  // Resolve workflow path
  const workflowFile = path.resolve(parsed.workflowPath);
  if (!fs.existsSync(workflowFile)) {
    console.error(`Error: Workflow file not found: ${workflowFile}`);
    process.exit(1);
  }

  // Load and parse workflow
  let workflow;
  try {
    const raw = fs.readFileSync(workflowFile, 'utf-8');
    workflow = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: Failed to parse workflow file: ${err.message}`);
    process.exit(1);
  }

  // Validate
  const errors = validateWorkflow(workflow);
  if (errors.length > 0) {
    console.error('Workflow validation errors:');
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  console.log(`✓ Loaded workflow: ${workflow.name} (${workflow.steps.length} steps)`);

  if (Object.keys(parsed.variables).length > 0) {
    console.log(`✓ Runtime variables: ${Object.keys(parsed.variables).join(', ')}`);
  }

  // Dry run mode
  if (parsed.dryRun) {
    console.log('\n[DRY RUN] Workflow is valid. Steps that would execute:');
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const type = step.strategy || step.command;
      const critical = step.critical !== false ? '🔴' : '🟡';
      console.log(`  ${critical} ${i + 1}. [${step.id}] ${type}`);
    }
    console.log('\n[DRY RUN] No commands were sent.');
    process.exit(0);
  }

  // Execute workflow
  try {
    const result = await runWorkflow(workflow, parsed.variables);

    if (result.status === 'completed') {
      process.exit(0);
    } else if (result.status === 'completed_with_errors') {
      process.exit(0); // Non-critical failures are acceptable
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error(`\nFatal error: ${err.message}`);
    process.exit(1);
  }
}

main();
