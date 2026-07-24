#!/usr/bin/env node

import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:7865';
const PACKAGE_NAME = '@gyga-browser/webmcp-browser-automation-kit';
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
const requireFromCli = createRequire(import.meta.url);
const WORKFLOW_DISPATCHER_PACKAGES = [
  '@gyga-browser/webmcp-workflow',
  'webmcp-workflow-cli',
];
const STORE_PACKAGES = [
  '@gyga-browser/webmcp-site-store',
  'webmcp-site-store',
];
const VAULT_PACKAGES = [
  '@gyga-browser/webmcp-vault-kit',
];
const AI_CLI_PACKAGES = [
  '@gyga-browser/webmcp-ai',
  'webmcp-ai-cli',
];
const AUTOMATION_PACKAGES = [
  '@gyga-browser/webmcp-automation-store',
];
const ADB_PACKAGES = [
  '@gyga-browser/webmcp-adb-kit',
];

function printHelp() {
  console.log(`WebMCP Browser Automation

Usage:
  webmcp mcp
  webmcp mcp --help
  webmcp gateway start
  webmcp gateway health [--json]
  webmcp health [--json]
  webmcp doctor [--json]
  webmcp launch [--name <name> | --profile-id <id>] [--gateway] [--relaunch] [--dry-run] [--json]
  webmcp close [--profile-id <id>] [--all] [--json]
  webmcp quit [--json]
  webmcp profiles list [--json]
  webmcp call <method> [jsonParams]
  webmcp ai <command> [options]
  webmcp vault <command> [options]
  webmcp workflow <command> [options]
  webmcp site <command> [options]
  webmcp automation <command> [options]
  webmcp mobile mcp
  webmcp adb mcp                         Alias for webmcp mobile mcp
  webmcp skills list [--json]
  webmcp skills path <name>
  webmcp skills doctor [--json]
  webmcp skills adopt [--provider <name> | --all] [--dry-run] [--yes]
  webmcp skills prune [--dry-run] [--yes]
  webmcp skills uninstall [--provider <name> | --all] [--dry-run] [--yes]
  webmcp store <command> [options]       Deprecated alias for webmcp site
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
  WEBMCP_VAULT_KEY            Unlock local encrypted WebMCP vault commands
  WEBMCP_VAULT_KEY_FILE       Read the local vault key from a file
  WEBMCP_AI_BIN               Override standalone WebMCP AI CLI path or package name
  WEBMCP_WORKFLOW_DISPATCHER_BIN  Override workflow dispatcher bin path or package name
  WEBMCP_AUTOMATION_BIN           Override Automation Store CLI path or package name
  WEBMCP_ADB_MCP_BIN              Override ADB MCP server path or package name
  WEBMCP_KIT_MANIFEST             Override webmcp-kit.json inventory path
  WEBMCP_HOME                     Shared kit data dir (default: ~/.webmcp)
  WEBMCP_DATA_DIR                 Alias of WEBMCP_HOME (back-compat)
  WEBMCP_CHROME_BINARY            Override Chrome/Chromium binary path
`);
}

function printMcpHelp() {
  console.log(`WebMCP stdio MCP adapter

Usage:
  webmcp mcp

The adapter is normally started by an MCP client from its registered config.
It exposes WebMCP gateway commands as mcp__webmcp__* tools and keeps browser
actions on the MCP transport. Start the gateway separately with:
  webmcp gateway start
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

function readMcpJsonConfig(file, serverPath) {
  const result = { file, registered: false, healthy: false };
  if (!existsSync(file)) return result;
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const entry = config?.mcpServers?.webmcp;
    if (!entry) return result;
    result.registered = true;
    result.command = entry.command;
    result.args = Array.isArray(entry.args) ? entry.args : [];
    result.mode = result.command === process.execPath ? 'durable' : result.command === 'npx' ? 'published' : 'unknown';
    result.healthy = (result.command === process.execPath && result.args.length === 1 && result.args[0] === serverPath)
      || (result.command === 'npx' && JSON.stringify(result.args) === JSON.stringify(['-y', PACKAGE_NAME, 'mcp']));
    if (!result.healthy) result.error = 'Registered MCP entry does not point to the WebMCP adapter';
  } catch (error) {
    result.error = `Invalid JSON: ${error.message}`;
  }
  return result;
}

function readMcpTomlConfig(file, serverPath) {
  const result = { file, registered: false, healthy: false };
  if (!existsSync(file)) return result;
  const text = readFileSync(file, 'utf8');
  const match = text.match(/(?:^|\n)\[mcp_servers\.webmcp\]\s*\n([\s\S]*?)(?=\n\s*\[[^\]]+\]|$)/);
  if (!match) return result;
  result.registered = true;
  const command = match[1].match(/^\s*command\s*=\s*"((?:\\.|[^"])*)"\s*$/m);
  const args = match[1].match(/^\s*args\s*=\s*(\[[^\n]*\])\s*$/m);
  try { result.command = command ? JSON.parse(`"${command[1]}"`) : undefined; } catch { result.command = undefined; }
  try { result.args = args ? JSON.parse(args[1]) : []; } catch { result.args = []; }
  result.mode = result.command === process.execPath ? 'durable' : result.command === 'npx' ? 'published' : 'unknown';
  result.healthy = (result.command === process.execPath && result.args.length === 1 && result.args[0] === serverPath)
    || (result.command === 'npx' && JSON.stringify(result.args) === JSON.stringify(['-y', PACKAGE_NAME, 'mcp']));
  if (!result.command || !args) result.error = 'MCP command or args is missing';
  else if (!result.healthy) result.error = 'Registered MCP entry does not point to the WebMCP adapter';
  return result;
}

async function probeMcpTools(serverPath) {
  return new Promise((resolveProbe) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: ROOT,
      env: { ...process.env, WEBMCP_NO_AUTOSTART: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolveProbe(result);
    };
    timer = setTimeout(() => finish({ ok: false, error: 'MCP adapter handshake timed out' }), 4000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 2) continue;
        if (message.error) finish({ ok: false, error: message.error.message || 'tools/list failed' });
        else finish({
          ok: true,
          toolCount: Array.isArray(message.result?.tools) ? message.result.tools.length : 0,
          toolNames: Array.isArray(message.result?.tools) ? message.result.tools.map((tool) => tool.name) : [],
        });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.on('exit', (code) => {
      if (!settled) finish({ ok: false, error: stderr.trim() || `MCP adapter exited with code ${code}` });
    });

    const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'webmcp-doctor', version: '1' },
      },
    });
    write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

async function runDoctor(args) {
  const json = args.includes('--json');
  const serverPath = resolve(ROOT, 'server', 'mcp_server.mjs');
  const packageInfo = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const nodeVersion = process.versions.node;
  const nodeOk = Number.parseInt(nodeVersion.split('.')[0], 10) >= 18;

  let sdkPath = null;
  let sdkError = null;
  try {
    sdkPath = requireFromCli.resolve('@modelcontextprotocol/sdk/server/index.js');
  } catch (error) {
    sdkError = error.message;
  }

  const mcp = existsSync(serverPath) && sdkPath
    ? await probeMcpTools(serverPath)
    : { ok: false, error: sdkError || `Adapter not found: ${serverPath}` };
  const gatewayResult = await fetchJsonOrNull(`${getGatewayBaseUrl()}/health`, {
    headers: gatewayHeaders(),
  });
  const gatewayPayload = gatewayResult?.payload || {};
  const gatewayReachable = Boolean(gatewayResult?.response?.ok && !gatewayPayload.error);
  const extensionConnected = Boolean(gatewayPayload.extensionConnected);
  const gateway = {
    url: getGatewayBaseUrl(),
    ok: gatewayReachable && extensionConnected,
    reachable: gatewayReachable,
    extensionConnected,
    profileCount: gatewayPayload.profileCount || 0,
    extensionVersion: gatewayPayload.profileDetails?.[0]?.extensionVersion || null,
    error: !gatewayReachable
      ? (gatewayResult ? gatewayPayload.error || 'Gateway health check failed' : 'Gateway is unreachable')
      : (extensionConnected ? undefined : 'Gateway is reachable but no WebMCP extension profile is connected'),
  };

  const home = homedir();
  const config = {
    codex: readMcpTomlConfig(resolve(home, '.codex', 'config.toml'), serverPath),
    gemini: readMcpJsonConfig(resolve(home, '.gemini', 'config', 'mcp_config.json'), serverPath),
    antigravity: readMcpJsonConfig(resolve(home, '.gemini', 'antigravity-ide', 'mcp_config.json'), serverPath),
  };
  const configHealthy = Object.values(config).some((entry) => entry.healthy);
  const report = {
    schema: 'webmcp-doctor/1',
    ok: nodeOk && Boolean(sdkPath) && mcp.ok && configHealthy && gateway.ok,
    node: { ok: nodeOk, version: nodeVersion, execPath: process.execPath, required: '>=18' },
    package: { ok: true, name: packageInfo.name, version: packageInfo.version, root: ROOT },
    mcp: { ...mcp, serverPath, sdk: { ok: Boolean(sdkPath), path: sdkPath, error: sdkError } },
    config,
    gateway,
    next: 'If Codex tools are absent after registration, restart Codex and open a new task; MCP servers are not attached dynamically to an active task.',
  };

  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`WebMCP doctor: ${report.ok ? 'OK' : 'NOT READY'}`);
    console.log(`  MCP adapter: ${mcp.ok ? `${mcp.toolCount} tools` : mcp.error}`);
    console.log(`  Gateway: ${gateway.ok ? 'reachable' : gateway.error}`);
    console.log(`  Codex config: ${config.codex.healthy ? 'registered' : 'missing or stale'}`);
  }
  return report.ok ? 0 : 1;
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

// The vault CLI lives in the standalone @gyga-browser/webmcp-vault-kit package
// so other apps (desktop app, workflow CLI) can reuse it. `webmcp vault ...`
// forwards to that package's `webmcp-vault` bin, preferring a local sibling
// checkout and falling back to the installed package.
function getVaultBin() {
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

async function runVault(args) {
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

// The AI provider implementation lives in the independent
// @gyga-browser/webmcp-ai package. This umbrella command is intentionally only
// a transparent bridge so workflows can depend on webmcp-ai directly without
// depending on the browser kit.
function getAiBin() {
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

async function runAi(args) {
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

async function runSite(args, { legacyAlias = false } = {}) {
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

function getAutomationBin() {
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

async function runAutomation(args) {
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

function getAdbMcpBin() {
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

function printMobileHelp() {
  console.log(`WebMCP Mobile Automation

Usage:
  webmcp mobile mcp
  webmcp adb mcp       Alias for webmcp mobile mcp
`);
}

async function runMobile(args) {
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

function getWebmcpHome() {
  return resolve(process.env.WEBMCP_HOME || process.env.WEBMCP_DATA_DIR || resolve(homedir(), '.webmcp'));
}

function readSkillInventory() {
  const explicit = process.env.WEBMCP_KIT_MANIFEST;
  const candidates = explicit
    ? [resolve(process.cwd(), explicit)]
    : [
        resolve(ROOT, '..', '..', 'webmcp-kit.json'),
        resolve(getWebmcpHome(), 'webmcp-kit.json'),
        resolve(getWebmcpHome(), 'skills', 'catalog.json'),
      ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const superseded = Array.isArray(data.supersededSkills) ? data.supersededSkills : [];
      if (data.schema === 'webmcp-kit/1' && Array.isArray(data.skills)) {
        return { file, root: dirname(file), kitId: data.kitId ?? 'webmcp-automation-kit', skills: data.skills, superseded };
      }
      if (data.schema === 'webmcp-skill-catalog/1' && Array.isArray(data.skills)) {
        return { file, root: resolve(dirname(file), '..'), skills: data.skills, superseded };
      }
    } catch {
      // Try the next inventory candidate.
    }
  }
  return null;
}

function installedSkillPaths(name) {
  return [
    resolve(homedir(), '.codex', 'skills', name),
    resolve(homedir(), '.claude', 'skills', name),
    resolve(homedir(), '.gemini', 'config', 'skills', name),
  ];
}

function skillPath(inventory, skill) {
  const canonical = resolve(inventory.root, skill.source);
  if (existsSync(canonical)) return canonical;
  return installedSkillPaths(skill.name).find((candidate) => existsSync(candidate)) || null;
}

function skillReport(inventory) {
  return [...inventory.skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => {
      const path = skillPath(inventory, skill);
      return { ...skill, path, available: Boolean(path) };
    });
}

function printSkillsHelp() {
  console.log(`WebMCP Skills

Usage:
  webmcp skills list [--json]
  webmcp skills path <name>
  webmcp skills doctor [--json]
  webmcp skills adopt [--provider <name> | --all] [--dry-run] [--yes]
  webmcp skills prune [--dry-run] [--yes]
  webmcp skills uninstall [--provider <name> | --all] [--dry-run] [--yes]
`);
}

function skillsReceiptPath() {
  return resolve(getWebmcpHome(), 'skills', 'install-receipt.json');
}

function readSkillsReceipt() {
  const file = skillsReceiptPath();
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function providerSkillRoots() {
  return {
    codex: resolve(homedir(), '.codex', 'skills'),
    claude: resolve(homedir(), '.claude', 'skills'),
    gemini: resolve(homedir(), '.gemini', 'config', 'skills'),
  };
}

function receiptTarget(root, name) {
  if (!root || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`Invalid skill receipt target: ${root}/${name}`);
  }
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || rel.includes('/') || rel.includes('\\')) {
    throw new Error(`Skill receipt target escapes provider root: ${target}`);
  }
  return target;
}

// Directories this kit could plausibly have installed: what the registry
// declares now, plus the names it used to declare before a rename. A
// `webmcp-*` prefix is not evidence of ownership — the user may have authored
// one — so it is never used to decide adoptability.
function adoptableNames(inventory) {
  return new Set([
    ...inventory.skills.map((skill) => skill.name),
    ...(inventory.superseded || []),
  ]);
}

// One default for every call site. `doctor` and `prune`/`uninstall` disagreeing
// here means the same receipt gets diagnosed under one mode and pruned under
// another.
function resolveSkillsMode(receipt) {
  return receipt?.skillsMode === 'separate' ? 'separate' : 'umbrella';
}

function receiptOwners(receipt) {
  if (!receipt) return {};
  if (receipt.schema === 'webmcp-install-receipt/2' && receipt.owners && typeof receipt.owners === 'object') {
    return receipt.owners;
  }
  if (receipt.schema === 'webmcp-install-receipt/1' || receipt.providers) {
    return {
      'webmcp-automation-kit': {
        installedAt: receipt.installedAt ?? null,
        skillsMode: receipt.skillsMode ?? 'umbrella',
        providers: receipt.providers ?? {},
      },
    };
  }
  return {};
}

function receiptOwner(receipt, kitId) {
  return receiptOwners(receipt)[kitId] ?? null;
}

function receiptInstalledEntries(receipt) {
  return Object.values(receiptOwners(receipt))
    .flatMap((owner) => Object.values(owner.providers || {}))
    .flatMap((provider) => provider.entries || []);
}

function publicSkillNames(inventory, mode) {
  return inventory.skills
    .filter((skill) => mode === 'separate'
      ? skill.name !== 'webmcp'
      : skill.exposure === 'public' || !skill.exposure)
    .filter((skill) => skill.defaultInstall !== false)
    .map((skill) => skill.name)
    .sort();
}

function doctorSkillNames(inventory, receipt, mode) {
  const expected = new Set(publicSkillNames(inventory, mode));
  const installed = new Set(receiptInstalledEntries(receipt));
  for (const skill of inventory.skills) {
    if (installed.has(skill.name)) expected.add(skill.name);
  }
  return expected;
}

function receiptRemovalPlan(receipt, ownerReceipt, kitId, inventory, providerFilter, mode) {
  const desired = new Set(publicSkillNames(inventory, mode));
  const removals = [];
  const otherOwners = Object.entries(receiptOwners(receipt)).filter(([ownerId]) => ownerId !== kitId);
  for (const [provider, value] of Object.entries(ownerReceipt?.providers || {})) {
    if (providerFilter && providerFilter !== '*' && provider !== providerFilter) continue;
    const keep = providerFilter ? new Set() : desired;
    for (const name of value.entries || []) {
      const shared = otherOwners.some(([, owner]) => {
        const other = owner.providers?.[provider];
        return other && resolve(other.root) === resolve(value.root) && (other.entries || []).includes(name);
      });
      if (!keep.has(name) && !shared) removals.push({ provider, name, path: receiptTarget(value.root, name) });
    }
  }
  return removals;
}

function applyReceiptRemovals(removals, dryRun) {
  for (const item of removals) {
    if (dryRun) console.log(`${item.provider}\t${item.path}`);
    else if (existsSync(item.path)) rmSync(item.path, { recursive: true, force: true });
  }
}

function writeSkillsReceipt(receipt, providers, mode, kitId) {
  const file = skillsReceiptPath();
  mkdirSync(dirname(file), { recursive: true });
  const updatedAt = new Date().toISOString();
  const owners = {
    ...receiptOwners(receipt),
    [kitId]: { installedAt: updatedAt, skillsMode: mode, providers },
  };
  writeFileSync(file, `${JSON.stringify({
    schema: 'webmcp-install-receipt/2', version: 2, updatedAt, owners,
  }, null, 2)}\n`);
}

function runSkills(args) {
  const first = args[0];
  if (first === '--help' || first === '-h' || first === 'help') {
    printSkillsHelp();
    return 0;
  }
  const subcommand = first && !first.startsWith('--') ? first : 'list';
  const options = subcommand === 'list' && first !== 'list' ? args : args.slice(1);

  const inventory = readSkillInventory();
  if (!inventory) {
    console.error([
      'WebMCP skill inventory not found.',
      'Run from the webmcp-automation-kit checkout, install the full kit, or set WEBMCP_KIT_MANIFEST.',
    ].join('\n'));
    return 1;
  }
  const skills = skillReport(inventory);
  const kitId = process.env.WEBMCP_KIT_ID || inventory.kitId || 'webmcp-automation-kit';

  if (subcommand === 'list') {
    if (options.includes('--json')) {
      console.log(JSON.stringify({
        schema: 'webmcp-skills/1',
        inventory: inventory.file,
        skills,
      }, null, 2));
    } else {
      console.log(`WebMCP Skills (${skills.length})`);
      for (const skill of skills) {
        const state = skill.available ? skill.path : 'not installed';
        console.log(`  ${skill.name.padEnd(28)} ${skill.owner.padEnd(18)} ${state}`);
      }
    }
    return 0;
  }

  if (subcommand === 'path') {
    const name = options[0];
    if (!name) {
      console.error('Usage: webmcp skills path <name>');
      return 1;
    }
    const skill = skills.find((entry) => entry.name === name);
    if (!skill) {
      console.error(`Unknown WebMCP skill: ${name}`);
      return 1;
    }
    if (!skill.path) {
      console.error(`WebMCP skill is registered but not available locally: ${name}`);
      return 1;
    }
    console.log(skill.path);
    return 0;
  }

  if (subcommand === 'doctor') {
    const receipt = readSkillsReceipt();
    const mode = resolveSkillsMode(receiptOwner(receipt, kitId));
    const expected = doctorSkillNames(inventory, receipt, mode);
    const relevantSkills = skills.filter((skill) => expected.has(skill.name));
    const missing = relevantSkills.filter((skill) => !skill.available).map((skill) => skill.name);
    const known = new Set(receiptInstalledEntries(receipt));
    const orphanCandidates = [];
    for (const [provider, root] of Object.entries(providerSkillRoots())) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        if (!known.has(name) && adoptableNames(inventory).has(name)) {
          orphanCandidates.push({ provider, name, path: resolve(root, name) });
        }
      }
    }
    const report = {
      schema: 'webmcp-skills-doctor/1',
      ok: missing.length === 0,
      inventory: inventory.file,
      total: relevantSkills.length,
      available: relevantSkills.length - missing.length,
      missing,
      receipt: skillsReceiptPath(),
      receiptPresent: Boolean(receipt),
      orphanCandidates,
    };
    if (options.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else if (report.ok) console.log(`Skills OK: ${report.available}/${report.total} available`);
    else console.error(`Skills incomplete: ${report.available}/${report.total} available; missing ${missing.join(', ')}`);
    return report.ok ? 0 : 1;
  }

  if (subcommand === 'adopt') {
    const { flags } = parseFlags(options);
    const roots = providerSkillRoots();
    const selected = flags.all ? Object.keys(roots) : [flags.provider].filter(Boolean);
    if (!selected.length || selected.some((provider) => !roots[provider])) {
      console.error('Usage: webmcp skills adopt --provider <codex|claude|gemini> | --all [--dry-run] [--yes]');
      return 1;
    }
    const knownNames = adoptableNames(inventory);
    const currentReceipt = readSkillsReceipt();
    const providers = { ...(receiptOwner(currentReceipt, kitId)?.providers || {}) };
    for (const provider of selected) {
      const root = roots[provider];
      const entries = existsSync(root)
        ? readdirSync(root).filter((name) => knownNames.has(name) && existsSync(receiptTarget(root, name))).sort()
        : [];
      providers[provider] = { root, entries };
      for (const name of entries) console.log(`${provider}\t${receiptTarget(root, name)}`);
    }
    if (!options.includes('--yes') || options.includes('--dry-run')) {
      console.log('Dry run only; pass --yes to adopt these directories into the WebMCP install receipt.');
      return 0;
    }
    const mode = Object.values(providers).some((value) => value.entries.includes('webmcp')) ? 'umbrella' : 'separate';
    writeSkillsReceipt(currentReceipt, providers, mode, kitId);
    console.log(`Adopted receipt entries for ${selected.join(', ')}.`);
    return 0;
  }

  if (subcommand === 'prune' || subcommand === 'uninstall') {
    const receipt = readSkillsReceipt();
    if (!receipt) {
      console.error('No WebMCP install receipt found; refusing to remove unowned skills.');
      return 1;
    }
    const { flags } = parseFlags(options);
    const provider = flags.provider;
    const all = Boolean(flags.all);
    if (subcommand === 'uninstall' && !provider && !all) {
      console.error('Usage: webmcp skills uninstall --provider <name> | --all [--dry-run] [--yes]');
      return 1;
    }
    const owner = receiptOwner(receipt, kitId);
    if (!owner) {
      console.error(`No install receipt ownership found for ${kitId}; refusing to remove skills.`);
      return 1;
    }
    const mode = resolveSkillsMode(owner);
    const removals = receiptRemovalPlan(
      receipt,
      owner,
      kitId,
      inventory,
      subcommand === 'uninstall' ? (all ? '*' : provider) : null,
      mode,
    );
    const dryRun = options.includes('--dry-run') || !options.includes('--yes');
    if (!removals.length) {
      console.log('No receipt-owned skill directories require removal.');
    } else if (dryRun) {
      console.log(`Planned removals (${removals.length}):`);
      applyReceiptRemovals(removals, true);
    } else {
      applyReceiptRemovals(removals, false);
      if (subcommand === 'uninstall' && all) {
        const owners = { ...receiptOwners(receipt) };
        delete owners[kitId];
        if (Object.keys(owners).length === 0) rmSync(skillsReceiptPath(), { force: true });
        else writeFileSync(skillsReceiptPath(), `${JSON.stringify({
          schema: 'webmcp-install-receipt/2',
          version: 2,
          updatedAt: new Date().toISOString(),
          owners,
        }, null, 2)}\n`);
      } else if (subcommand === 'uninstall' && provider) {
        const providers = { ...owner.providers };
        delete providers[provider];
        writeSkillsReceipt(receipt, providers, mode, kitId);
      } else {
        const desired = new Set(publicSkillNames(inventory, mode));
        const providers = {};
        for (const [name, value] of Object.entries(owner.providers || {})) {
          providers[name] = { root: value.root, entries: (value.entries || []).filter((entry) => desired.has(entry)) };
        }
        writeSkillsReceipt(receipt, providers, mode, kitId);
      }
      console.log(`Removed ${removals.length} receipt-owned skill director${removals.length === 1 ? 'y' : 'ies'}.`);
    }
    return 0;
  }

  console.error(`Unknown skills command: ${subcommand}`);
  printSkillsHelp();
  return 1;
}

async function runClose(args) {
  const { flags, positional } = parseFlags(args);
  const json = Boolean(flags.json);
  const all = Boolean(flags.all);
  const profileId = flags['profile-id'] || positional[0];
  
  if (!all && !profileId) {
    console.error('Usage:\n  webmcp close --profile-id <id> [--json]\n  webmcp close --all [--json]\n  webmcp close <profile-id-or-email-or-name>');
    process.exit(1);
  }
  
  const { closeChrome } = getChromeLauncher();
  const gatewayUrl = process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  
  try {
    const res = await closeChrome({
      profileId,
      all,
      gatewayUrl,
    });
    
    if (json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`Successfully closed ${res.closedCount} Chrome instance(s).`);
    }
  } catch (err) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    } else {
      console.error(`Error closing Chrome:`, err.message);
    }
    process.exit(1);
  }
}

async function runQuit(args) {
  const { flags } = parseFlags(args);
  const json = Boolean(flags.json);

  const { quitChrome, closeChrome } = getChromeLauncher();
  const gatewayUrl = process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  let closedViaGateway = 0;

  // 1. Try graceful close via gateway first (so extension sessions end cleanly)
  try {
    const res = await closeChrome({ all: true, gatewayUrl });
    closedViaGateway = res.closedCount || 0;
  } catch {
    // gateway not running — skip
  }

  // 2. Force-quit all remaining Chrome processes + clean stale lock files
  await quitChrome({ cleanLocks: true });

  const result = {
    ok: true,
    closedViaGateway,
    message: 'All Chrome processes have been terminated and stale locks cleaned.',
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (closedViaGateway > 0) {
      console.log(`Gracefully closed ${closedViaGateway} connected session(s) via gateway.`);
    }
    console.log('All Chrome processes have been terminated and stale locks cleaned.');
  }
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
    if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
      printMcpHelp();
      return;
    }
    await import('../server/mcp_server.mjs');
    return;
  }

  if (command === 'doctor') {
    process.exit(await runDoctor(args));
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

  if (command === 'close') {
    await runClose(args);
    return;
  }

  if (command === 'quit') {
    await runQuit(args);
    return;
  }

  if (command === 'workflow') {
    process.exit(await runWorkflow(args));
  }

  if (command === 'ai') {
    process.exit(await runAi(args));
  }

  if (command === 'site') {
    process.exit(await runSite(args));
  }

  if (command === 'automation') {
    process.exit(await runAutomation(args));
  }

  if (command === 'mobile' || command === 'adb') {
    process.exit(await runMobile(args));
  }

  if (command === 'skills') {
    process.exit(runSkills(args));
  }

  if (command === 'store') {
    process.exit(await runSite(args, { legacyAlias: true }));
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

  if (command === 'vault') {
    process.exit(await runVault(args));
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
