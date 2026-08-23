import process from 'node:process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, getWebmcpHome } from '../../context.mjs';
import { getGatewayBaseUrl } from '../../gateway-client.mjs';
import { writeBootstrapEnrollmentReceipt } from './receipts.mjs';
import {
  collectTailnetReadiness,
  expectedServiceIdsForRole,
  isServiceLoaded,
  loadService,
  osServiceInstallDir,
  readMachineRoleReadiness,
  serviceFileName,
  serviceRegistryDir,
} from './services.mjs';

function renderServiceTemplate(id, role) {
  const env = {
    WEBMCP_HOME: getWebmcpHome(),
    WEBMCP_GATEWAY_URL: getGatewayBaseUrl(),
    WEBMCP_NODE_ROLE: role,
  };
  if (process.platform === 'darwin') {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>io.${id}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      `    <string>${process.execPath}</string>`,
      `    <string>${resolve(ROOT, 'bin', 'webmcp.mjs')}</string>`,
      '    <string>gateway</string>',
      '    <string>start</string>',
      '  </array>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      ...Object.entries(env).flatMap(([key, value]) => [`    <key>${key}</key>`, `    <string>${value}</string>`]),
      '  </dict>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>KeepAlive</key>',
      '  <true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }
  if (process.platform === 'win32') {
    return [
      '<service>',
      `  <id>${id}</id>`,
      `  <name>${id}</name>`,
      `  <executable>${process.execPath}</executable>`,
      `  <arguments>${resolve(ROOT, 'bin', 'webmcp.mjs')} gateway start</arguments>`,
      `  <env name="WEBMCP_HOME" value="${env.WEBMCP_HOME}" />`,
      `  <env name="WEBMCP_GATEWAY_URL" value="${env.WEBMCP_GATEWAY_URL}" />`,
      `  <env name="WEBMCP_NODE_ROLE" value="${env.WEBMCP_NODE_ROLE}" />`,
      '</service>',
      '',
    ].join('\n');
  }
  return [
    '[Unit]',
    `Description=${id}`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=WEBMCP_HOME=${env.WEBMCP_HOME}`,
    `Environment=WEBMCP_GATEWAY_URL=${env.WEBMCP_GATEWAY_URL}`,
    `Environment=WEBMCP_NODE_ROLE=${env.WEBMCP_NODE_ROLE}`,
    `ExecStart=${process.execPath} ${resolve(ROOT, 'bin', 'webmcp.mjs')} gateway start`,
    'Restart=on-failure',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export function buildServicePlan({ apply = false } = {}) {
  const roleReadiness = readMachineRoleReadiness();
  if (!roleReadiness.ok) {
    throw new Error('machine role is not enrolled; run bootstrap enroll-role first');
  }
  const role = roleReadiness.role;
  const serviceRoot = serviceRegistryDir();
  const serviceIds = expectedServiceIdsForRole(role);
  let receipt = null;
  const services = serviceIds.map((id) => {
    const fileName = serviceFileName(id);
    const target = resolve(serviceRoot, fileName);
    const present = existsSync(target);
    return {
      id,
      manager: process.platform === 'darwin' ? 'launchd' : process.platform === 'win32' ? 'windows-service' : 'systemd',
      target: fileName,
      status: present ? 'already-present' : (apply ? 'rendered' : 'pending'),
    };
  });

  if (apply) {
    mkdirSync(serviceRoot, { recursive: true, mode: 0o700 });
    try { chmodSync(serviceRoot, 0o700); } catch { /* best effort */ }
    for (const service of services) {
      const target = resolve(serviceRoot, service.target);
      writeFileSync(target, renderServiceTemplate(service.id, role), { mode: 0o600 });
      try { chmodSync(target, 0o600); } catch { /* best effort */ }
    }
    receipt = writeBootstrapEnrollmentReceipt('services', role, {
      role,
      serviceCount: services.length,
      manager: services[0]?.manager || null,
    });
  }

  return {
    schema: 'webmcp-bootstrap-service-plan/1',
    version: 1,
    applied: apply,
    redacted: true,
    role,
    services,
    receipt,
    next: apply
      ? 'Re-run webmcp doctor --json to verify local service template readiness before OS service installation.'
      : 'Re-run bootstrap service-apply --json to render local service templates.',
  };
}

export function buildServiceInstallPlan({ apply = false } = {}) {
  const roleReadiness = readMachineRoleReadiness();
  if (!roleReadiness.ok) {
    throw new Error('machine role is not enrolled; run bootstrap enroll-role first');
  }
  const role = roleReadiness.role;
  const sourceRoot = serviceRegistryDir();
  const targetRoot = osServiceInstallDir();
  const serviceIds = expectedServiceIdsForRole(role);
  let receipt = null;
  const services = serviceIds.map((id) => {
    const fileName = serviceFileName(id);
    const source = resolve(sourceRoot, fileName);
    const target = resolve(targetRoot, fileName);
    const sourcePresent = existsSync(source);
    const targetPresent = existsSync(target);
    return {
      id,
      manager: process.platform === 'darwin' ? 'launchd' : process.platform === 'win32' ? 'windows-service' : 'systemd',
      target: fileName,
      sourceReady: sourcePresent,
      status: targetPresent ? 'already-installed' : (apply ? 'installed' : 'pending'),
    };
  });
  if (services.some((service) => !service.sourceReady)) {
    throw new Error('service templates are not rendered; run bootstrap service-apply first');
  }

  if (apply) {
    mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    try { chmodSync(targetRoot, 0o700); } catch { /* best effort */ }
    for (const service of services) {
      const source = resolve(sourceRoot, service.target);
      const target = resolve(targetRoot, service.target);
      writeFileSync(target, readFileSync(source, 'utf8'), { mode: 0o600 });
      try { chmodSync(target, 0o600); } catch { /* best effort */ }
    }
    receipt = writeBootstrapEnrollmentReceipt('os-services', role, {
      role,
      serviceCount: services.length,
      manager: services[0]?.manager || null,
      loaded: false,
    });
  }

  return {
    schema: 'webmcp-bootstrap-service-install-plan/1',
    version: 1,
    applied: apply,
    redacted: true,
    role,
    services,
    receipt,
    next: apply
      ? 'Review and load the installed user service with the OS service manager, then re-run webmcp doctor --json.'
      : 'Re-run bootstrap service-install --yes --json to copy reviewed templates to the user service directory.',
  };
}

export function buildServiceLoadPlan({ apply = false } = {}) {
  const roleReadiness = readMachineRoleReadiness();
  if (!roleReadiness.ok) {
    throw new Error('machine role is not enrolled; run bootstrap enroll-role first');
  }
  const role = roleReadiness.role;
  const targetRoot = osServiceInstallDir();
  const serviceIds = expectedServiceIdsForRole(role);
  let receipt = null;
  const services = serviceIds.map((id) => {
    const fileName = serviceFileName(id);
    const target = resolve(targetRoot, fileName);
    const installed = existsSync(target);
    const loaded = installed ? isServiceLoaded(id) : false;
    return {
      id,
      manager: process.platform === 'darwin' ? 'launchd' : process.platform === 'win32' ? 'windows-service' : 'systemd',
      target: fileName,
      installed,
      loaded: apply && installed ? true : loaded,
      status: loaded ? 'already-loaded' : (apply ? 'loaded' : 'pending'),
    };
  });
  if (services.some((service) => !service.installed)) {
    throw new Error('OS user service files are not installed; run bootstrap service-install --yes first');
  }

  if (apply) {
    for (const service of services) {
      if (isServiceLoaded(service.id)) continue;
      loadService(service.id, resolve(targetRoot, service.target));
    }
    receipt = writeBootstrapEnrollmentReceipt('service-load', role, {
      role,
      serviceCount: services.length,
      manager: services[0]?.manager || null,
      loaded: true,
    });
  }

  return {
    schema: 'webmcp-bootstrap-service-load-plan/1',
    version: 1,
    applied: apply,
    redacted: true,
    role,
    services,
    receipt,
    next: apply
      ? 'Re-run webmcp doctor --json to verify user service load status.'
      : 'Re-run bootstrap service-load --yes --json to load reviewed user services.',
  };
}

export async function buildTailnetPlan({ apply = false } = {}) {
  const tailnet = await collectTailnetReadiness();
  const actions = [];
  if (!tailnet.cliAvailable) actions.push({ code: 'INSTALL_TAILSCALE', status: 'required' });
  if (!tailnet.online) actions.push({ code: 'CONNECT_TAILNET', status: 'required' });
  let receipt = null;
  if (apply) {
    if (!tailnet.ok) {
      throw new Error('Tailnet is not online; connect Tailscale first, then re-run tailnet-apply');
    }
    receipt = writeBootstrapEnrollmentReceipt('tailnet', 'current', {
      cliAvailable: tailnet.cliAvailable,
      statusAvailable: tailnet.statusAvailable,
      online: tailnet.online,
    });
  }
  return {
    schema: 'webmcp-bootstrap-tailnet-plan/1',
    version: 1,
    ok: tailnet.ok,
    applied: apply,
    redacted: true,
    tailnet,
    actions,
    nextActions: actions.map((action) => (action.code === 'INSTALL_TAILSCALE'
      ? { code: action.code, command: 'Install Tailscale for this OS, then re-run webmcp bootstrap tailnet-plan --json.', note: 'Do not store auth keys or Tailnet hostnames in receipts.' }
      : { code: action.code, command: 'tailscale up using the operator-approved account/device policy, then re-run webmcp bootstrap tailnet-apply --yes --json.', note: 'This bootstrap command verifies online state; it does not perform SSO or ACL changes.' })),
    receipt,
    next: tailnet.ok
      ? (apply ? 'Re-run webmcp doctor --json to verify Tailnet readiness.' : 'Re-run bootstrap tailnet-apply --yes --json to write the redacted Tailnet receipt.')
      : 'Resolve Tailnet actions, then re-run bootstrap tailnet-plan --json.',
  };
}
