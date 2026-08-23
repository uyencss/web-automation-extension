import process from 'node:process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:7865';
export const PACKAGE_NAME = '@gyga-browser/webmcp-browser-automation-kit';
export const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
export const requireFromCli = createRequire(resolve(ROOT, 'bin', 'webmcp.mjs'));
export const WORKFLOW_DISPATCHER_PACKAGES = ['@gyga-browser/webmcp-workflow', 'webmcp-workflow-cli'];
export const STORE_PACKAGES = ['@gyga-browser/webmcp-site-store', 'webmcp-site-store'];
export const VAULT_PACKAGES = ['@gyga-browser/webmcp-vault-kit'];
export const AI_CLI_PACKAGES = ['@gyga-browser/webmcp-ai', 'webmcp-ai-cli'];
export const AUTOMATION_PACKAGES = ['@gyga-browser/webmcp-automation-store'];
export const ADB_PACKAGES = ['@gyga-browser/webmcp-adb-kit'];
export const RUNNER_PACKAGES = ['@gyga-browser/webmcp-automation-runner'];
export const SAFE_BOOTSTRAP_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const BOOTSTRAP_BINDING_DECISIONS = new Set(['approved', 'pending', 'rejected']);
export const BOOTSTRAP_REAUTH_POLICIES = new Set(['manual', 'disabled', 'bounded-one-attempt']);
export const BOOTSTRAP_NODE_ROLES = new Set(['operator', 'runner-node', 'fleet-node']);

export function readJsonFile(file) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

export function getWebmcpHome() {
  return resolve(process.env.WEBMCP_HOME || process.env.WEBMCP_DATA_DIR || resolve(homedir(), '.webmcp'));
}
