import process from 'node:process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUTOMATION_PACKAGES,
  ROOT,
  RUNNER_PACKAGES,
  VAULT_PACKAGES,
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


// The WebMCP CLI owns the canonical `skills` implementation and the aggregate
// `doctor` in the dual-path release. `webmcp skills ...` forwards to that
// package's `webmcp-cli` bin, preferring an explicit override, then a monorepo
// sibling checkout, then the installed package. It never resolves a bare
// `webmcp` command from PATH.
export function resolveCliBin() {
  const override = process.env.WEBMCP_CLI_BIN;
  if (override) {
    const overridePath = resolve(process.cwd(), override);
    if (existsSync(overridePath)) return overridePath;
    try {
      return requireFromCli.resolve(`${override}/bin/webmcp-cli.mjs`);
    } catch {
      return overridePath;
    }
  }

  const siblingBin = resolve(ROOT, '..', 'webmcp-cli', 'bin', 'webmcp-cli.mjs');
  if (existsSync(siblingBin)) return siblingBin;

  try {
    return requireFromCli.resolve('@gyga-browser/webmcp-cli/bin/webmcp-cli.mjs');
  } catch {
    return null;
  }
}

export function getCliBin() {
  return resolveCliBin();
}
