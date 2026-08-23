import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  getWebmcpHome,
} from '../../context.mjs';
import { collectDoctorReport } from '../doctor.mjs';

export function bootstrapReceiptPath() {
  return resolve(getWebmcpHome(), 'bootstrap', 'install-receipt.json');
}

export function bootstrapEnrollmentReceiptPath(kind, id) {
  return resolve(getWebmcpHome(), 'bootstrap', 'enrollments', `${kind}-${id}.json`);
}

function plannedStateDirs() {
  return [
    { code: 'CREATE_RUNS_DIR', key: 'runs', path: resolve(getWebmcpHome(), 'runs') },
    { code: 'CREATE_DOWNLOADS_DIR', key: 'downloads', path: resolve(getWebmcpHome(), 'downloads') },
    { code: 'CREATE_VAULT_DIR', key: 'vault', path: resolve(getWebmcpHome(), 'vault') },
  ];
}

function safeBootstrapReceipt(doctor, { applied }) {
  return {
    schema: 'webmcp-bootstrap-receipt/1',
    version: 1,
    redacted: true,
    applied: Boolean(applied),
    createdAt: new Date().toISOString(),
    package: {
      name: doctor.package.name,
      version: doctor.package.version,
    },
    node: {
      ok: doctor.node.ok,
      version: doctor.node.version,
      required: doctor.node.required,
    },
    readiness: {
      mcpRegistered: doctor.bootstrap.mcpRegistered,
      dispatcherConfigured: doctor.bootstrap.dispatcherConfigured,
      downloadPolicyReady: doctor.bootstrap.downloadPolicyReady,
      skillsReady: doctor.bootstrap.skillsReady,
      gatewayReady: doctor.bootstrap.gatewayReady,
      receiptPresent: true,
      roleConfigured: doctor.bootstrap.roleConfigured,
      serviceReady: doctor.bootstrap.serviceReady,
      tailnetReady: doctor.bootstrap.tailnetReady,
    },
    counts: {
      dispatcherProfiles: doctor.dispatcher?.profiles?.profileAliases ?? 0,
      profileBindings: doctor.dispatcher?.profileBindings?.count ?? 0,
      skillsAvailable: doctor.skills?.available ?? 0,
      skillsTotal: doctor.skills?.total ?? 0,
      roleServices: Array.isArray(doctor.services?.services) ? doctor.services.services.length : 0,
      installedRoleServices: Array.isArray(doctor.services?.services)
        ? doctor.services.services.filter((entry) => entry.installed).length
        : 0,
    },
  };
}

function safeBootstrapEnrollmentReceipt({ kind, subject }) {
  return {
    schema: 'webmcp-bootstrap-enrollment-receipt/1',
    version: 1,
    redacted: true,
    kind,
    createdAt: new Date().toISOString(),
    package: {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
    subject,
  };
}

export function writeBootstrapEnrollmentReceipt(kind, id, subject) {
  const receipt = safeBootstrapEnrollmentReceipt({ kind, subject });
  const receiptFile = bootstrapEnrollmentReceiptPath(kind, id);
  mkdirSync(dirname(receiptFile), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(receiptFile), 0o700); } catch { /* best effort */ }
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(receiptFile, 0o600); } catch { /* best effort */ }
  return receipt;
}

export async function buildBootstrapPlan({ apply = false } = {}) {
  const doctor = await collectDoctorReport();
  const dirs = plannedStateDirs();
  const missingDirs = dirs.filter((entry) => !existsSync(entry.path));
  const mutations = dirs.map((entry) => ({
    code: entry.code,
    status: existsSync(entry.path) ? 'already-present' : (apply ? 'created' : 'pending'),
    target: entry.key,
  }));
  const operatorActions = [];
  if (!doctor.bootstrap.mcpRegistered) operatorActions.push({ code: 'REGISTER_MCP', status: 'required' });
  if (!doctor.bootstrap.dispatcherConfigured) operatorActions.push({ code: 'WRITE_DISPATCHER_CONFIG', status: 'required' });
  if (!doctor.bootstrap.skillsReady || !doctor.skills.receiptPresent) operatorActions.push({ code: 'INSTALL_SKILLS', status: 'required' });
  if (!doctor.bootstrap.gatewayReady) operatorActions.push({ code: 'START_GATEWAY', status: 'required' });
  if (!doctor.bootstrap.downloadPolicyReady) operatorActions.push({ code: 'INSTALL_CHROME_POLICY', status: 'required' });
  if (!doctor.bootstrap.roleConfigured) operatorActions.push({ code: 'SET_NODE_ROLE', status: 'required' });
  if (!doctor.bootstrap.serviceReady) operatorActions.push({ code: 'INSTALL_ROLE_SERVICES', status: 'required' });
  if (!doctor.bootstrap.tailnetReady) operatorActions.push({ code: 'CONNECT_TAILNET', status: 'required' });

  let receipt = null;
  if (apply) {
    for (const entry of missingDirs) {
      mkdirSync(entry.path, { recursive: true, mode: 0o700 });
      try { chmodSync(entry.path, 0o700); } catch { /* best effort */ }
    }
    const receiptFile = bootstrapReceiptPath();
    mkdirSync(dirname(receiptFile), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(receiptFile), 0o700); } catch { /* best effort */ }
    receipt = safeBootstrapReceipt(doctor, { applied: true });
    writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(receiptFile, 0o600); } catch { /* best effort */ }
  }

  return {
    schema: 'webmcp-bootstrap-plan/1',
    mode: apply ? 'apply' : 'plan',
    applied: Boolean(apply),
    ok: apply ? missingDirs.every((entry) => existsSync(entry.path)) : false,
    readiness: {
      schema: doctor.bootstrap.schema,
      ok: doctor.bootstrap.ok,
      mcpRegistered: doctor.bootstrap.mcpRegistered,
      dispatcherConfigured: doctor.bootstrap.dispatcherConfigured,
      downloadPolicyReady: doctor.bootstrap.downloadPolicyReady,
      skillsReady: doctor.bootstrap.skillsReady,
      gatewayReady: doctor.bootstrap.gatewayReady,
      receiptPresent: apply ? true : doctor.bootstrap.receiptPresent,
      roleConfigured: doctor.bootstrap.roleConfigured,
      serviceReady: doctor.bootstrap.serviceReady,
      tailnetReady: doctor.bootstrap.tailnetReady,
    },
    mutations,
    operatorActions,
    receipt,
  };
}
