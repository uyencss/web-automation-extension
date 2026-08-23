import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  SAFE_BOOTSTRAP_ID,
  getWebmcpHome,
  readJsonFile,
} from '../../context.mjs';
import { runJsonChild } from './process.mjs';

function findExecutable(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? name : null;
  const pathEntries = (process.env.PATH || '').split(':').filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = resolve(entry, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function readMachineRoleReadiness() {
  const roleFile = machineRoleConfigPath();
  let role = typeof process.env.WEBMCP_NODE_ROLE === 'string' && process.env.WEBMCP_NODE_ROLE.trim()
    ? process.env.WEBMCP_NODE_ROLE.trim()
    : null;
  let source = role ? 'env' : 'missing';
  if (!role && existsSync(roleFile)) {
    const parsed = readJsonFile(roleFile);
    if (parsed.ok && parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
      role = typeof parsed.data.role === 'string' && parsed.data.role.trim() ? parsed.data.role.trim() : null;
      source = role ? 'file' : 'invalid';
    } else {
      source = 'invalid';
    }
  }
  const safeRole = role && SAFE_BOOTSTRAP_ID.test(role) ? role : null;
  return {
    schema: 'webmcp-machine-role-readiness/1',
    ok: Boolean(safeRole),
    role: safeRole,
    source,
  };
}

export function machineRoleConfigPath() {
  return resolve(getWebmcpHome(), 'bootstrap', 'role.config.json');
}

export function expectedServiceIdsForRole(role) {
  if (role === 'operator') return ['webmcp-gateway'];
  if (role === 'runner-node') return ['webmcp-gateway', 'webmcp-node-executor'];
  if (role === 'fleet-node') return ['webmcp-gateway', 'webmcp-node-executor', 'webmcp-fleet-hub'];
  return ['webmcp-gateway'];
}

export function serviceFileName(id) {
  if (process.platform === 'darwin') return `io.${id}.plist`;
  if (process.platform === 'win32') return `${id}.xml`;
  return `${id}.service`;
}

function serviceLabel(id) {
  if (process.platform === 'darwin') return `io.${id}`;
  return id;
}

export function serviceRegistryDir() {
  return typeof process.env.WEBMCP_BOOTSTRAP_SERVICE_DIR === 'string' && process.env.WEBMCP_BOOTSTRAP_SERVICE_DIR.trim()
    ? process.env.WEBMCP_BOOTSTRAP_SERVICE_DIR.trim()
    : resolve(getWebmcpHome(), 'bootstrap', 'services');
}

export function osServiceInstallDir() {
  if (typeof process.env.WEBMCP_BOOTSTRAP_OS_SERVICE_DIR === 'string' && process.env.WEBMCP_BOOTSTRAP_OS_SERVICE_DIR.trim()) {
    return process.env.WEBMCP_BOOTSTRAP_OS_SERVICE_DIR.trim();
  }
  if (process.platform === 'darwin') return resolve(homedir(), 'Library', 'LaunchAgents');
  if (process.platform === 'win32') return resolve(getWebmcpHome(), 'bootstrap', 'os-services');
  return resolve(homedir(), '.config', 'systemd', 'user');
}

function serviceLoadStateFile() {
  return typeof process.env.WEBMCP_BOOTSTRAP_SERVICE_LOAD_STATE_FILE === 'string' && process.env.WEBMCP_BOOTSTRAP_SERVICE_LOAD_STATE_FILE.trim()
    ? process.env.WEBMCP_BOOTSTRAP_SERVICE_LOAD_STATE_FILE.trim()
    : null;
}

function readServiceLoadState() {
  const file = serviceLoadStateFile();
  if (!file || !existsSync(file)) return { loadedServices: [] };
  const parsed = readJsonFile(file);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    return { loadedServices: [] };
  }
  return {
    loadedServices: Array.isArray(parsed.data.loadedServices)
      ? parsed.data.loadedServices.filter((id) => typeof id === 'string')
      : [],
  };
}

function writeServiceLoadState(ids) {
  const file = serviceLoadStateFile();
  if (!file) return false;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(file), 0o700); } catch { /* best effort */ }
  writeFileSync(file, `${JSON.stringify({
    schema: 'webmcp-bootstrap-service-load-state/1',
    loadedServices: [...new Set(ids)].sort(),
  }, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return true;
}

export function isServiceLoaded(id) {
  const stateFile = serviceLoadStateFile();
  if (stateFile) return readServiceLoadState().loadedServices.includes(id);
  if (process.platform === 'darwin') {
    if (typeof process.getuid !== 'function') return false;
    const result = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${serviceLabel(id)}`], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return result.status === 0;
  }
  if (process.platform === 'win32') return false;
  const result = spawnSync('systemctl', ['--user', 'is-active', '--quiet', serviceFileName(id)], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return result.status === 0;
}

export function loadService(id, file) {
  const stateFile = serviceLoadStateFile();
  if (stateFile) {
    const state = readServiceLoadState();
    writeServiceLoadState([...state.loadedServices, id]);
    return { ok: true, mode: 'state-file' };
  }
  if (process.platform === 'darwin') {
    if (typeof process.getuid !== 'function') throw new Error('launchd user domain is unavailable');
    if (isServiceLoaded(id)) return { ok: true, mode: 'already-loaded' };
    const result = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, file], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      throw new Error(`launchd bootstrap failed: ${(result.stderr || result.stdout || 'unknown').trim().slice(0, 200)}`);
    }
    return { ok: true, mode: 'launchd' };
  }
  if (process.platform === 'win32') {
    throw new Error('Windows service loading is not automated by this user-scope bootstrap command');
  }
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (reload.status !== 0) {
    throw new Error(`systemd daemon-reload failed: ${(reload.stderr || reload.stdout || 'unknown').trim().slice(0, 200)}`);
  }
  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', serviceFileName(id)], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (enable.status !== 0) {
    throw new Error(`systemd enable --now failed: ${(enable.stderr || enable.stdout || 'unknown').trim().slice(0, 200)}`);
  }
  return { ok: true, mode: 'systemd' };
}

export function collectServiceReadiness(roleReadiness) {
  const role = roleReadiness.role || 'operator';
  const serviceRoot = serviceRegistryDir();
  const osRoot = osServiceInstallDir();
  const serviceIds = expectedServiceIdsForRole(role);
  const services = serviceIds.map((id) => {
    const fileName = serviceFileName(id);
    const localTemplate = existsSync(resolve(serviceRoot, fileName));
    const osService = existsSync(resolve(osRoot, fileName));
    const installed = localTemplate || osService;
    const loaded = osService ? isServiceLoaded(id) : false;
    return {
      id,
      required: true,
      installed,
      loaded,
      manager: process.platform === 'darwin' ? 'launchd' : process.platform === 'win32' ? 'windows-service' : 'systemd',
      source: osService ? 'os-user-service' : (localTemplate ? 'local-template' : 'missing'),
    };
  });
  return {
    schema: 'webmcp-service-readiness/1',
    ok: services.every((entry) => entry.installed),
    role,
    services,
  };
}

export async function collectTailnetReadiness() {
  const configuredBin = typeof process.env.WEBMCP_TAILSCALE_BIN === 'string' && process.env.WEBMCP_TAILSCALE_BIN.trim()
    ? process.env.WEBMCP_TAILSCALE_BIN.trim()
    : 'tailscale';
  const bin = findExecutable(configuredBin);
  let statusPayload = null;
  let statusAvailable = false;
  const statusFile = typeof process.env.WEBMCP_TAILSCALE_STATUS_FILE === 'string' && process.env.WEBMCP_TAILSCALE_STATUS_FILE.trim()
    ? process.env.WEBMCP_TAILSCALE_STATUS_FILE.trim()
    : null;
  if (statusFile && existsSync(statusFile)) {
    const parsed = readJsonFile(statusFile);
    if (parsed.ok) {
      statusPayload = parsed.data;
      statusAvailable = true;
    }
  } else if (bin) {
    const status = await runJsonChild(bin, ['status', '--json'], { timeoutMs: 2500 });
    if (status.payload) {
      statusPayload = status.payload;
      statusAvailable = status.ok;
    }
  }
  const self = statusPayload && typeof statusPayload === 'object' && !Array.isArray(statusPayload)
    ? statusPayload.Self
    : null;
  return {
    schema: 'webmcp-tailnet-readiness/1',
    ok: Boolean(bin && self?.Online === true),
    cliAvailable: Boolean(bin),
    statusAvailable,
    online: self?.Online === true,
    redacted: true,
  };
}
