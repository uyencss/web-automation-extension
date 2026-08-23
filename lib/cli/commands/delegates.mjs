import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  getAdbMcpBin,
  getAiBin,
  getAutomationBin,
  getCaptchaSolveBin,
  getStoreBin,
  getVaultBin,
  getWorkflowDispatcherBin,
} from '../component-resolver.mjs';

export async function runVault(args) {
  const vaultBin = getVaultBin();
  if (!vaultBin || !existsSync(vaultBin)) {
    console.error([
      'WebMCP vault CLI not found.',
      'Install @gyga-browser/webmcp-vault-kit, run from the webmcp-automation-kit checkout, or set WEBMCP_VAULT_BIN.',
    ].join('\n'));
    return 1;
  }

  const vaultArgs = args.length > 0 ? args : ['--help'];
  const child = spawn(process.execPath, [vaultBin, ...vaultArgs], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: 'inherit',
  });

  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start vault CLI: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`Vault CLI exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}


export async function runWorkflow(args) {
  const dispatcherBin = getWorkflowDispatcherBin();
  if (!dispatcherBin || !existsSync(dispatcherBin)) {
    console.error([
      'Workflow dispatcher CLI not found.',
      'Install @gyga-browser/webmcp-workflow, run from the webmcp-automation-kit checkout, or set WEBMCP_WORKFLOW_DISPATCHER_BIN.',
    ].join('\n'));
    return 1;
  }

  const workflowArgs = args.length > 0 ? args : ['--help'];
  const child = spawn(process.execPath, [dispatcherBin, ...workflowArgs], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORKFLOW_DISPATCHER_COMMAND_NAME: 'webmcp workflow',
    },
    stdio: 'inherit',
  });

  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start workflow dispatcher: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`Workflow dispatcher exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}

// The AI provider implementation lives in the independent
// @gyga-browser/webmcp-ai package. This umbrella command is intentionally only
// a transparent bridge so workflows can depend on webmcp-ai directly without
// depending on the browser kit.

export async function runAi(args) {
  const aiBin = getAiBin();
  if (!aiBin || !existsSync(aiBin)) {
    console.error([
      'WebMCP AI CLI not found.',
      'Install @gyga-browser/webmcp-ai, run from the webmcp-automation-kit checkout, or set WEBMCP_AI_BIN.',
    ].join('\n'));
    return 1;
  }

  const aiArgs = args.length > 0 ? args : ['--help'];
  const child = spawn(process.execPath, [aiBin, ...aiArgs], {
    cwd: process.cwd(),
    env: { ...process.env, WEBMCP_AI_COMMAND_NAME: 'webmcp ai' },
    stdio: 'inherit',
  });

  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start WebMCP AI CLI: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`WebMCP AI CLI exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}


export async function runSite(args, { legacyAlias = false } = {}) {
  const storeBin = getStoreBin();
  if (!storeBin || !existsSync(storeBin)) {
    console.error([
      'WebMCP Site CLI not found.',
      'Install @gyga-browser/webmcp-site-store, run from the webmcp-automation-kit checkout, or set WEBMCP_STORE_BIN.',
    ].join('\n'));
    return 1;
  }

  const storeArgs = args.length > 0 ? args : ['--help'];
  const child = spawn(process.execPath, [storeBin, ...storeArgs], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WEBMCP_SITE_COMMAND_NAME: legacyAlias ? 'webmcp store' : 'webmcp site',
      ...(legacyAlias ? { WEBMCP_SITE_LEGACY_ALIAS: '1' } : {}),
    },
    stdio: 'inherit',
  });

  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start Site CLI: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`Site CLI exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}


export async function runAutomation(args) {
  const automationBin = getAutomationBin();
  if (!automationBin || !existsSync(automationBin)) {
    console.error([
      'WebMCP Automation Store CLI not found.',
      'Install the full WebMCP kit, run from the webmcp-automation-kit checkout, or set WEBMCP_AUTOMATION_BIN.',
    ].join('\n'));
    return 1;
  }

  const automationArgs = args.length > 0 ? args : ['--help'];
  const child = spawn(process.execPath, [automationBin, ...automationArgs], {
    cwd: process.cwd(),
    env: { ...process.env, WEBMCP_AUTOMATION_COMMAND_NAME: 'webmcp automation' },
    stdio: 'inherit',
  });

  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start Automation Store CLI: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`Automation Store CLI exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}

// The workspace/registry runtime lives in the independent
// @gyga-browser/webmcp-automation-runner package. The `webmcp project` umbrella
// command is a thin bridge onto its `workspace *` surface so users never need
// to call the runner binary directly for day-to-day project operations.

export async function runCaptcha(args) {
  const captchaBin = getCaptchaSolveBin();
  if (!captchaBin) {
    console.error([
      'WebMCP captcha solver not found.',
      'Run install.sh step 4, or set WEBMCP_CAPTCHA_HOME to a checkout of',
      'packages/webmcp-captcha-solver that has a built .venv.',
    ].join('\n'));
    return 1;
  }

  const child = spawn(captchaBin, args.length > 0 ? args : ['--help'], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: 'inherit',
  });

  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start captcha solver: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`Captcha solver exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 0);
    });
  });
}

function printMobileHelp() {
  console.log(`WebMCP Mobile Automation

Usage:
  webmcp mobile mcp
  webmcp adb mcp       Alias for webmcp mobile mcp
`);
}

export async function runMobile(args) {
  const [subcommand] = args;
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printMobileHelp();
    return 0;
  }
  if (subcommand !== 'mcp') {
    console.error(`Unknown mobile command: ${subcommand}`);
    printMobileHelp();
    return 1;
  }

  const adbMcpBin = getAdbMcpBin();
  if (!adbMcpBin || !existsSync(adbMcpBin)) {
    console.error([
      'WebMCP ADB MCP server not found.',
      'Install @gyga-browser/webmcp-adb-kit, run from the webmcp-automation-kit checkout, or set WEBMCP_ADB_MCP_BIN.',
    ].join('\n'));
    return 1;
  }

  const child = spawn(process.execPath, [adbMcpBin], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: 'inherit',
  });
  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start ADB MCP server: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`ADB MCP server exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}
