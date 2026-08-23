import process from 'node:process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  ADB_PACKAGES,
  AI_CLI_PACKAGES,
  AUTOMATION_PACKAGES,
  ROOT,
  RUNNER_PACKAGES,
  STORE_PACKAGES,
  VAULT_PACKAGES,
  WORKFLOW_DISPATCHER_PACKAGES,
  requireFromCli,
} from './context.mjs';

export function getChromeLauncher() {
  return requireFromCli(resolve(ROOT, 'chrome-launcher'));
}

// The vault CLI lives in the standalone @gyga-browser/webmcp-vault-kit package
// so other apps (desktop app, workflow CLI) can reuse it. `webmcp vault ...`
// forwards to that package's `webmcp-vault` bin, preferring a local sibling
// checkout and falling back to the installed package.
export function getVaultBin() {
  const override = process.env.WEBMCP_VAULT_BIN;
  if (override) {
    const overridePath = resolve(process.cwd(), override);
    if (existsSync(overridePath)) return overridePath;
    try {
      return requireFromCli.resolve(`${override}/bin/webmcp-vault.mjs`);
    } catch {
      return overridePath;
    }
  }

  const siblingBin = resolve(ROOT, '..', 'webmcp-vault-kit', 'bin', 'webmcp-vault.mjs');
  if (existsSync(siblingBin)) return siblingBin;

  for (const packageName of VAULT_PACKAGES) {
    try {
      return requireFromCli.resolve(`${packageName}/bin`);
    } catch {
      // Try the next known package name.
    }
  }

  return null;
}


export function getWorkflowDispatcherBin() {
  const override = process.env.WEBMCP_WORKFLOW_DISPATCHER_BIN || process.env.WORKFLOW_DISPATCHER_BIN;
  if (override) {
    const overridePath = resolve(process.cwd(), override);
    if (existsSync(overridePath)) return overridePath;

    try {
      return requireFromCli.resolve(`${override}/bin/webmcp-workflow-cli.js`);
    } catch {
      return overridePath;
    }
  }

  const siblingBin = resolve(ROOT, '..', 'webmcp-workflow-cli', 'bin', 'webmcp-workflow-cli.js');
  if (existsSync(siblingBin)) return siblingBin;

  for (const packageName of WORKFLOW_DISPATCHER_PACKAGES) {
    try {
      return requireFromCli.resolve(`${packageName}/bin/webmcp-workflow-cli.js`);
    } catch {
      // Try the next known package name.
    }
  }

  return null;
}


export function getAiBin() {
  const override = process.env.WEBMCP_AI_BIN;
  if (override) {
    const overridePath = resolve(process.cwd(), override);
    if (existsSync(overridePath)) return overridePath;
    try {
      return requireFromCli.resolve(`${override}/bin`);
    } catch {
      return overridePath;
    }
  }

  const siblingBin = resolve(ROOT, '..', 'webmcp-ai-cli', 'bin', 'webmcp-ai.mjs');
  if (existsSync(siblingBin)) return siblingBin;

  for (const packageName of AI_CLI_PACKAGES) {
    try {
      return requireFromCli.resolve(`${packageName}/bin`);
    } catch {
      // Try the next known package name.
    }
  }

  return null;
}


export function getStoreBin() {
  const override = process.env.WEBMCP_STORE_BIN;
  if (override) {
    const overridePath = resolve(process.cwd(), override);
    if (existsSync(overridePath)) return overridePath;
    try {
      return requireFromCli.resolve(`${override}/bin/webmcp-store.mjs`);
    } catch {
      return overridePath;
    }
  }

  // In the monorepo a package lives at packages/<name>, while the Site Store
  // lives at stores/webmcp-site-store. Keep this checkout fallback separate
  // from npm resolution so published installs do not rely on the monorepo.
  const siblingBin = resolve(ROOT, '..', '..', 'stores', 'webmcp-site-store', 'bin', 'webmcp-store.mjs');
  if (existsSync(siblingBin)) return siblingBin;

  for (const packageName of STORE_PACKAGES) {
    try {
      return requireFromCli.resolve(`${packageName}/bin/webmcp-store.mjs`);
    } catch {
      // Try the next known package name.
    }
  }

  return null;
}


export function getAutomationBin() {
  const override = process.env.WEBMCP_AUTOMATION_BIN;
  if (override) {
    const overridePath = resolve(process.cwd(), override);
    if (existsSync(overridePath)) return overridePath;
    try {
      return requireFromCli.resolve(`${override}/bin/webmcp-automation.mjs`);
    } catch {
      return overridePath;
    }
  }

  const siblingBin = resolve(ROOT, '..', '..', 'stores', 'webmcp-automation-store', 'bin', 'webmcp-automation.mjs');
  if (existsSync(siblingBin)) return siblingBin;

  for (const packageName of AUTOMATION_PACKAGES) {
    try {
      return requireFromCli.resolve(`${packageName}/bin/webmcp-automation.mjs`);
    } catch {
      // Try the next known package name.
    }
  }

  return null;
}


export function getRunnerBin() {
  const override = process.env.WEBMCP_RUNNER_BIN;
  if (override) {
    const overridePath = resolve(process.cwd(), override);
    if (existsSync(overridePath)) return overridePath;
    try {
      return requireFromCli.resolve(`${override}/bin/webmcp-automation-runner.mjs`);
    } catch {
      return overridePath;
    }
  }

  const siblingBin = resolve(ROOT, '..', 'webmcp-automation-runner', 'bin', 'webmcp-automation-runner.mjs');
  if (existsSync(siblingBin)) return siblingBin;

  for (const packageName of RUNNER_PACKAGES) {
    try {
      return requireFromCli.resolve(`${packageName}/bin/webmcp-automation-runner.mjs`);
    } catch {
      // Try the next known package name.
    }
  }

  return null;
}


export function getAdbMcpBin() {
  const override = process.env.WEBMCP_ADB_MCP_BIN;
  if (override) {
    const overridePath = resolve(process.cwd(), override);
    if (existsSync(overridePath)) return overridePath;
    try {
      return requireFromCli.resolve(`${override}/server/mcp_server.mjs`);
    } catch {
      return overridePath;
    }
  }

  const siblingBin = resolve(ROOT, '..', 'webmcp-adb-kit', 'server', 'mcp_server.mjs');
  if (existsSync(siblingBin)) return siblingBin;

  for (const packageName of ADB_PACKAGES) {
    try {
      return requireFromCli.resolve(`${packageName}/server/mcp_server.mjs`);
    } catch {
      // Try the next known package name.
    }
  }

  return null;
}

// The captcha solver is a Python package with its own venv, so this resolves an
// executable to spawn directly rather than a JS entry point to run under node.
export function getCaptchaSolveBin() {
  const override = process.env.WEBMCP_CAPTCHA_BIN;
  if (override) return resolve(process.cwd(), override);

  const candidates = [];
  if (process.env.WEBMCP_CAPTCHA_HOME) {
    candidates.push(resolve(process.env.WEBMCP_CAPTCHA_HOME, '.venv', 'bin', 'captcha-solve'));
  }
  // Release install (installation/lib/python-packages.sh), then kit checkout.
  candidates.push(resolve(homedir(), '.webmcp', 'captcha-solver', '.venv', 'bin', 'captcha-solve'));
  candidates.push(resolve(ROOT, '..', 'webmcp-captcha-solver', '.venv', 'bin', 'captcha-solve'));

  return candidates.find((candidate) => existsSync(candidate)) || null;
}
