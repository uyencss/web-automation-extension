#!/usr/bin/env node

import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_GATEWAY_URL = 'http://localhost:7865';
const PACKAGE_NAME = '@gyga-browser/webmcp-browser-automation-kit';
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
const requireFromCli = createRequire(import.meta.url);
const WORKFLOW_DISPATCHER_PACKAGES = [
  '@gyga-browser/webmcp-workflow',
  'webmcp-workflow-cli',
];
const STORE_PACKAGES = [
  '@gyga-browser/webmcp-store',
  'webmcp-workflow-store',
];

function printHelp() {
  console.log(`WebMCP Browser Automation

Usage:
  webmcp mcp
  webmcp gateway start
  webmcp gateway health [--json]
  webmcp health [--json]
  webmcp launch [--name <name> | --profile-id <id>] [--gateway] [--relaunch] [--dry-run] [--json]
  webmcp profiles list [--json]
  webmcp call <method> [jsonParams]
  webmcp workflow <command> [options]
  webmcp store <command> [options]
  webmcp extension-info [--json]
  webmcp extension-path

MCP config example:
  {
    "mcpServers": {
      "webmcp": {
        "command": "npx",
        "args": ["-y", "${PACKAGE_NAME}", "mcp"]
      }
    }
  }

Environment:
  WEBMCP_GATEWAY_URL=${DEFAULT_GATEWAY_URL}
  WEBMCP_GATEWAY_HOST=127.0.0.1   Gateway bind host (set 0.0.0.0 to expose on LAN)
  WEBMCP_GATEWAY_TOKEN            Shared secret; required on POST /api when set
  WEBMCP_GATEWAY_AUTOSTART=1  Enable MCP dev-mode gateway autostart
  WEBMCP_PROFILE_ID           Route gateway calls to this connected Chrome profile
  WEBMCP_WORKFLOW_DISPATCHER_BIN  Override workflow dispatcher bin path or package name
  WEBMCP_HOME                     Shared kit data dir (default: ~/.webmcp)
  WEBMCP_DATA_DIR                 Alias of WEBMCP_HOME (back-compat)
  WEBMCP_CHROME_BINARY            Override Chrome/Chromium binary path
`);
}

function getGatewayBaseUrl() {
  const raw = process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
}

function getGatewayApiUrl() {
  return `${getGatewayBaseUrl()}/api`;
}

// Build request headers, attaching the gateway token when the environment
// provides one so calls succeed against a token-protected (app-managed) gateway.
function gatewayHeaders(extra = {}) {
  const headers = { ...extra };
  const token = process.env.WEBMCP_GATEWAY_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseJsonParams(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('params must be a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid JSON params: ${err.message}`);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `HTTP ${response.status}` };
  }

  return { response, payload };
}

async function fetchJsonOrNull(url, options = {}) {
  try {
    return await fetchJson(url, options);
  } catch {
    return null;
  }
}

async function printHealth({ json = false } = {}) {
  const { response, payload } = await fetchJson(`${getGatewayBaseUrl()}/health`);
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (response.ok) {
    const state = payload.extensionConnected ? 'extension connected' : 'extension not connected';
    console.log(`Gateway OK at ${payload.apiUrl || getGatewayApiUrl()} (${state})`);
  } else {
    console.error(`Gateway health failed: ${payload.error || response.status}`);
  }

  if (!response.ok || payload.error) process.exit(1);
}

async function callGateway(method, rawParams) {
  const parsedParams = parseJsonParams(rawParams);
  const { profileId: requestProfileId, ...params } = parsedParams;
  const targetProfileId = requestProfileId || process.env.WEBMCP_PROFILE_ID || undefined;
  const body = { method, params };
  if (targetProfileId) body.profileId = targetProfileId;
  const { response, payload } = await fetchJson(getGatewayApiUrl(), {
    method: 'POST',
    headers: gatewayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });

  console.log(JSON.stringify(payload, null, 2));
  if (!response.ok || payload.error) process.exit(1);
}

async function runGateway(args) {
  const [subcommand = 'start', maybeJson] = args;
  if (subcommand === 'start') {
    await import('../server/gateway_server.js');
    return;
  }

  if (subcommand === 'health') {
    await printHealth({ json: maybeJson === '--json' });
    return;
  }

  console.error(`Unknown gateway command: ${subcommand}`);
  process.exit(1);
}

function parseFlags(args) {
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

function getChromeLauncher() {
  return requireFromCli(resolve(ROOT, 'chrome-launcher'));
}

function profileIdsFromHealth(payload) {
  if (!payload || !Array.isArray(payload.profiles)) return [];
  return payload.profiles.filter((profileId) => typeof profileId === 'string');
}

async function getGatewayHealth() {
  const result = await fetchJsonOrNull(`${getGatewayBaseUrl()}/health`);
  if (!result?.response?.ok) return null;
  return result.payload;
}

async function ensureGatewayRunning() {
  const existing = await getGatewayHealth();
  if (existing?.ok) return { started: false, health: existing };

  const { rememberGatewaySession } = getChromeLauncher();
  const gatewayPath = resolve(ROOT, 'server', 'gateway_server.js');
  const child = spawn(process.execPath, [gatewayPath], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      WEBMCP_GATEWAY_PORT: process.env.WEBMCP_GATEWAY_PORT || '7865',
      WEBMCP_GATEWAY_HOST: process.env.WEBMCP_GATEWAY_HOST || '127.0.0.1',
    },
    stdio: 'ignore',
  });
  child.unref();
  rememberGatewaySession(child.pid, { url: getGatewayBaseUrl() });

  const start = Date.now();
  while (Date.now() - start < 8000) {
    const health = await getGatewayHealth();
    if (health?.ok) return { started: true, pid: child.pid, health };
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }

  throw new Error(`Gateway did not become healthy at ${getGatewayBaseUrl()}/health`);
}

async function waitForLaunchedProfile(beforeIds, timeoutMs = 30000) {
  const before = new Set(beforeIds);
  const start = Date.now();
  let latest = null;

  while (Date.now() - start < timeoutMs) {
    const health = await getGatewayHealth();
    if (health?.ok) {
      latest = health;
      const ids = profileIdsFromHealth(health);
      const added = ids.find((profileId) => !before.has(profileId));
      if (added) return { profileId: added, health };
      if (ids.length === 1 && before.size === 0) return { profileId: ids[0], health };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }

  return { profileId: null, health: latest };
}

function printLaunchUsage() {
  console.log(`Usage:
  webmcp launch --name <managed-profile-name> [--gateway] [--dry-run] [--json]
  webmcp launch --profile-id <id> [--gateway] [--relaunch] [--dry-run] [--json]

Examples:
  webmcp launch --name scraping-bot --gateway --json
  webmcp profiles list --json
  webmcp launch --profile-id "Chrome:Default" --relaunch`);
}

function printProfiles(profiles, json) {
  if (json) {
    console.log(JSON.stringify(profiles, null, 2));
    return;
  }

  for (const group of ['managed', 'existing']) {
    console.log(`${group}:`);
    if (profiles[group].length === 0) {
      console.log('  (none)');
      continue;
    }
    for (const profile of profiles[group]) {
      const email = profile.email ? ` <${profile.email}>` : '';
      console.log(`  ${profile.id}  ${profile.name}${email}`);
    }
  }
}

async function runProfiles(args) {
  const [subcommand = 'list', ...rest] = args;
  if (subcommand !== 'list') {
    console.error(`Unknown profiles command: ${subcommand}`);
    process.exit(1);
  }

  const { flags } = parseFlags(rest);
  const { listAllProfiles } = getChromeLauncher();
  printProfiles(listAllProfiles(), Boolean(flags.json));
}

async function runLaunch(args) {
  const { flags } = parseFlags(args);
  if (flags.help || flags.h) {
    printLaunchUsage();
    return;
  }

  const json = Boolean(flags.json || flags.gateway || flags['dry-run']);
  const dryRun = Boolean(flags['dry-run']);
  const {
    defaultExtensionPath,
    findProfileById,
    launchChrome,
    listAllProfiles,
  } = getChromeLauncher();

  let profile = null;
  let mode = 'managed';
  if (flags['profile-id']) {
    profile = findProfileById(String(flags['profile-id']));
    if (!profile) {
      console.error(`Profile not found: ${flags['profile-id']}`);
      console.error('Run `webmcp profiles list --json` to see available ids.');
      process.exit(1);
    }
    mode = profile.kind === 'existing' ? 'existing' : 'managed';
  }

  const gateway = flags.gateway ? await ensureGatewayRunning() : null;
  const beforeIds = gateway?.health ? profileIdsFromHealth(gateway.health) : [];
  const launchResult = await launchChrome({
    mode,
    profile,
    newProfileName: flags.name || 'webmcp',
    relaunch: Boolean(flags.relaunch),
    dryRun,
    extensionPath: flags['extension-path'] || defaultExtensionPath(),
  });

  if (launchResult.needsRelaunch) {
    const payload = {
      ...launchResult,
      ok: false,
      exitCode: 2,
      hint: 'Ask the user before retrying with --relaunch because this may quit their running Chrome windows.',
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(2);
  }

  let connected = { profileId: null, health: null };
  if (flags.gateway && !dryRun) {
    connected = await waitForLaunchedProfile(beforeIds);
  }

  const payload = {
    ...launchResult,
    gatewayUrl: flags.gateway ? getGatewayBaseUrl() : null,
    gatewayStarted: gateway?.started || false,
    profileId: connected.profileId,
    profiles: flags['include-profiles'] ? listAllProfiles() : undefined,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    if (payload.warning) {
      console.error(`\n⚠️  ${payload.warning}`);
      if (payload.guidance) console.error(payload.guidance);
    }
    return;
  }

  console.log(`Chrome launched: ${payload.userDataDir}`);
  if (payload.profileId) console.log(`WebMCP profileId: ${payload.profileId}`);
  if (payload.warning) {
    console.error(`\n⚠️  ${payload.warning}`);
    if (payload.guidance) console.error(payload.guidance);
  }
}

function getWorkflowDispatcherBin() {
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

async function runWorkflow(args) {
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

function getStoreBin() {
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

  const siblingBin = resolve(ROOT, '..', 'webmcp-workflow-store', 'bin', 'webmcp-store.mjs');
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

async function runStore(args) {
  const storeBin = getStoreBin();
  if (!storeBin || !existsSync(storeBin)) {
    console.error([
      'WebMCP store CLI not found.',
      'Install @gyga-browser/webmcp-store, run from the webmcp-automation-kit checkout, or set WEBMCP_STORE_BIN.',
    ].join('\n'));
    return 1;
  }

  const storeArgs = args.length > 0 ? args : ['--help'];
  const child = spawn(process.execPath, [storeBin, ...storeArgs], {
    cwd: process.cwd(),
    env: { ...process.env, WEBMCP_STORE_COMMAND_NAME: 'webmcp store' },
    stdio: 'inherit',
  });

  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start store CLI: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`Store CLI exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  if (command === '--version' || command === '-v') {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (command === 'mcp') {
    await import('../server/mcp_server.mjs');
    return;
  }

  if (command === 'gateway') {
    await runGateway(args);
    return;
  }

  if (command === 'profiles') {
    await runProfiles(args);
    return;
  }

  if (command === 'launch') {
    await runLaunch(args);
    return;
  }

  if (command === 'workflow') {
    process.exit(await runWorkflow(args));
  }

  if (command === 'store') {
    process.exit(await runStore(args));
  }

  if (command === 'health') {
    await printHealth({ json: args.includes('--json') });
    return;
  }

  if (command === 'call') {
    const [method, rawParams] = args;
    if (!method) {
      console.error('Usage: webmcp call <method> [jsonParams]');
      process.exit(1);
    }
    await callGateway(method, rawParams);
    return;
  }

  if (command === 'extension-info') {
    const { defaultExtensionPath, WEBMCP_EXTENSION_ID, WEBMCP_EXTENSION_STORE_URL } = getChromeLauncher();
    const payload = {
      id: WEBMCP_EXTENSION_ID,
      name: 'WebMCP Tools Provider',
      chromeWebStoreUrl: WEBMCP_EXTENSION_STORE_URL,
      unpackedExtensionPath: defaultExtensionPath(),
    };
    if (args.includes('--json')) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`WebMCP Tools Provider (${payload.id})`);
      console.log(`Chrome Web Store: ${payload.chromeWebStoreUrl}`);
      console.log(`Unpacked extension path: ${payload.unpackedExtensionPath}`);
    }
    return;
  }

  if (command === 'extension-path') {
    console.log(resolve(ROOT, 'webmcp-extension', 'dist'));
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message || String(err) }, null, 2));
  process.exit(1);
});
