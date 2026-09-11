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
import { resolveCliBin } from '../component-resolver.mjs';
import { readDispatcherReadiness } from './bootstrap/config-readiness.mjs';
import { downloadPolicyReadiness } from './bootstrap/download-readiness.mjs';
import {
  collectServiceReadiness,
  collectTailnetReadiness,
  readMachineRoleReadiness,
} from './bootstrap/services.mjs';

function classifyRegistration(command, args, serverPath) {
  if (command === process.execPath && args.length === 1 && args[0] === serverPath) return 'durable';
  if (command === 'npx' && JSON.stringify(args) === JSON.stringify(['-y', PACKAGE_NAME, 'mcp'])) return 'published';
  if (
    typeof command === 'string'
    && /(^|\/)(webmcp|webmcp-cli)$/.test(command)
    && JSON.stringify(args) === JSON.stringify(['mcp'])
  ) return 'cli-wrapper';
  return 'unknown';
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
    result.mode = classifyRegistration(result.command, result.args, serverPath);
    result.healthy = result.mode !== 'unknown';
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
  result.mode = classifyRegistration(result.command, result.args, serverPath);
  result.healthy = result.mode !== 'unknown';
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

function missingCliSkillsState(error) {
  return {
    schema: 'webmcp-skills-doctor/1',
    ok: false,
    inventory: null,
    total: 0,
    available: 0,
    missing: [],
    receipt: null,
    receiptPresent: false,
    orphanCandidates: [],
    error,
  };
}

export async function probeCliSkills() {
  let cliBin = null;
  try {
    cliBin = resolveCliBin();
  } catch {
    cliBin = null;
  }
  if (!cliBin || !existsSync(cliBin)) {
    return { ...missingCliSkillsState('webmcp-cli not found'), status: null };
  }
  return new Promise((resolveProbe) => {
    const child = spawn(process.execPath, [cliBin, 'skills', 'doctor', '--json'], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
      resolveProbe(result);
    };
    timer = setTimeout(() => {
      finish({ ...missingCliSkillsState('webmcp-cli skills doctor timed out'), status: null });
    }, 15000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      finish({ ...missingCliSkillsState(error.message || 'failed to start webmcp-cli'), status: null });
    });
    child.on('exit', (status, signal) => {
      let payload = null;
      try {
        payload = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        payload = null;
      }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const verbatim = {
          ...payload,
          schema: typeof payload.schema === 'string' ? payload.schema : 'webmcp-skills-doctor/1',
          ok: payload.ok === true,
          inventory: payload.inventory ?? null,
          total: typeof payload.total === 'number' ? payload.total : 0,
          available: typeof payload.available === 'number' ? payload.available : 0,
          missing: Array.isArray(payload.missing) ? payload.missing : [],
          receipt: payload.receipt ?? null,
          receiptPresent: payload.receiptPresent === true,
        };
        finish(verbatim);
        return;
      }
      const detail = (stderr || stdout || '').trim().slice(0, 500);
      const suffix = detail ? `: ${detail}` : '';
      const label = signal
        ? `webmcp-cli skills doctor exited after signal ${signal}${suffix}`
        : `webmcp-cli skills doctor output was not JSON${suffix}`;
      finish({ ...missingCliSkillsState(label), status: status ?? null });
    });
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
  const skills = await probeCliSkills();
  const role = readMachineRoleReadiness();
  const services = collectServiceReadiness(role);
  const tailnet = await collectTailnetReadiness();
  const configHealthy = Object.values(config).some((entry) => entry.healthy);
  const bootstrap = {
    schema: 'webmcp-machine-bootstrap-readiness/1',
    ok: nodeOk && Boolean(sdkPath) && mcp.ok && configHealthy && dispatcher.readable && downloadPolicy.ok && skills.ok && skills.receiptPresent,
    mcpRegistered: configHealthy,
    dispatcherConfigured: dispatcher.readable === true,
    downloadPolicyReady: downloadPolicy.ok === true,
    skillsReady: skills.ok === true,
    gatewayReady: gateway.ok === true,
    receiptPresent: skills.receiptPresent === true,
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
    skills,
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
    console.log(`  Skills: ${report.skills.ok ? `${report.skills.available}/${report.skills.total} available` : `missing ${report.skills.missing.join(', ') || 'inventory'}`}`);
    console.log(`  Role: ${report.role.ok ? report.role.role : 'missing'}`);
    console.log(`  Services: ${report.services.ok ? 'ready' : 'missing service registration'}`);
    console.log(`  Tailnet: ${report.tailnet.ok ? 'online' : 'not ready'}`);
  }
  return report.ok ? 0 : 1;
}
