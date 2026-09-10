import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  PACKAGE_NAME,
  ROOT,
  requireFromCli,
} from '../context.mjs';
import {
  fetchJsonOrNull,
  gatewayHeaders,
  getGatewayBaseUrl,
} from '../gateway-client.mjs';
import { readDispatcherReadiness } from './bootstrap/config-readiness.mjs';
import { downloadPolicyReadiness } from './bootstrap/download-readiness.mjs';
import {
  collectServiceReadiness,
  collectTailnetReadiness,
  readMachineRoleReadiness,
} from './bootstrap/services.mjs';

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

export async function collectDoctorReport() {
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

  const userConfigRoot = homedir();
  const config = {
    codex: readMcpTomlConfig(resolve(userConfigRoot, '.codex', 'config.toml'), serverPath),
    gemini: readMcpJsonConfig(resolve(userConfigRoot, '.gemini', 'config', 'mcp_config.json'), serverPath),
    antigravity: readMcpJsonConfig(resolve(userConfigRoot, '.gemini', 'antigravity-ide', 'mcp_config.json'), serverPath),
  };
  const dispatcher = readDispatcherReadiness();
  const downloadPolicy = downloadPolicyReadiness();
  const role = readMachineRoleReadiness();
  const services = collectServiceReadiness(role);
  const tailnet = await collectTailnetReadiness();
  const configHealthy = Object.values(config).some((entry) => entry.healthy);
  const bootstrap = {
    schema: 'webmcp-machine-bootstrap-readiness/1',
    ok: nodeOk && Boolean(sdkPath) && mcp.ok && configHealthy && dispatcher.readable && downloadPolicy.ok,
    mcpRegistered: configHealthy,
    dispatcherConfigured: dispatcher.readable === true,
    downloadPolicyReady: downloadPolicy.ok === true,
    gatewayReady: gateway.ok === true,
    roleConfigured: role.ok === true,
    serviceReady: services.ok === true,
    tailnetReady: tailnet.ok === true,
  };
  bootstrap.ok = bootstrap.ok && bootstrap.roleConfigured && bootstrap.serviceReady && bootstrap.tailnetReady;
  return {
    schema: 'webmcp-doctor/1',
    ok: bootstrap.ok && gateway.ok,
    node: { ok: nodeOk, version: nodeVersion, execPath: process.execPath, required: '>=18' },
    package: { ok: true, name: packageInfo.name, version: packageInfo.version, root: ROOT },
    mcp: { ...mcp, serverPath, sdk: { ok: Boolean(sdkPath), path: sdkPath, error: sdkError } },
    config,
    gateway,
    dispatcher,
    downloadPolicy,
    role,
    services,
    tailnet,
    bootstrap,
    next: 'If Codex tools are absent after registration, restart Codex and open a new task; MCP servers are not attached dynamically to an active task.',
  };
}

export async function runDoctor(args) {
  const json = args.includes('--json');
  const report = await collectDoctorReport();

  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`WebMCP doctor: ${report.ok ? 'OK' : 'NOT READY'}`);
    console.log(`  MCP adapter: ${report.mcp.ok ? `${report.mcp.toolCount} tools` : report.mcp.error}`);
    console.log(`  Gateway: ${report.gateway.ok ? 'reachable' : report.gateway.error}`);
    console.log(`  Codex config: ${report.config.codex.healthy ? 'registered' : 'missing or stale'}`);
    console.log(`  Dispatcher config: ${report.dispatcher.readable ? `${report.dispatcher.profiles.profileAliases} profile aliases` : report.dispatcher.warning || report.dispatcher.error}`);
    console.log(`  Download policy: ${report.downloadPolicy.ok ? 'managed downloads effective on this machine' : 'managed download policy needs install/reload'}`);
    console.log(`  Role: ${report.role.ok ? report.role.role : 'missing'}`);
    console.log(`  Services: ${report.services.ok ? 'ready' : 'missing service registration'}`);
    console.log(`  Tailnet: ${report.tailnet.ok ? 'online' : 'not ready'}`);
  }
  return report.ok ? 0 : 1;
}
