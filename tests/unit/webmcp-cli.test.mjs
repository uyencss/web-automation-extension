import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp.mjs');
const WORKSPACE_ROOT = path.resolve(ROOT, '..');

test('webmcp workflow delegates to the workflow dispatcher CLI', () => {
  const result = spawnSync(process.execPath, [
    BIN,
    'workflow',
    'dry-run',
    'webmcp-workflow-cli/tests/fixtures/minimal-workflow.json',
    '--json',
    '--no-history',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.workflow.id, 'minimal');
  assert.equal(payload.validation.valid, true);
});

test('webmcp mcp --help exits without starting the stdio adapter', () => {
  const result = spawnSync(process.execPath, [BIN, 'mcp', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 3000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp mcp/);
  assert.match(result.stdout, /stdio MCP adapter/);
});

test('webmcp doctor reports MCP readiness, config state, and gateway health as JSON', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-doctor-'));
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  mkdirSync(path.join(home, '.webmcp'), { recursive: true });
  const serviceDir = path.join(home, 'services');
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(path.join(serviceDir, 'webmcp-gateway.service'), 'redacted fixture service\n');
  writeFileSync(path.join(serviceDir, 'io.webmcp-gateway.plist'), 'redacted fixture service\n');
  writeFileSync(path.join(serviceDir, 'webmcp-gateway.xml'), 'redacted fixture service\n');
  const tailnetStatusPath = path.join(home, 'tailscale-status.json');
  writeFileSync(tailnetStatusPath, JSON.stringify({
    Self: {
      Online: true,
      HostName: 'secret-hostname',
      DNSName: 'secret.tailnet.ts.net.',
      TailscaleIPs: ['100.64.0.1'],
    },
  }, null, 2));
  writeFileSync(path.join(home, '.codex', 'config.toml'), [
    '[mcp_servers.webmcp]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify([path.join(ROOT, 'server', 'mcp_server.mjs')])}`,
    '',
  ].join('\n'));
  writeFileSync(path.join(home, '.webmcp', 'dispatcher.config.json'), JSON.stringify({
    schema: 'webmcp-dispatcher-config/2',
    defaultGateway: 'local',
    gateways: {
      local: {
        baseUrl: 'http://127.0.0.1:7865',
        profiles: {
          research: 'Chrome:Secret Research',
          affiliate: 'Chrome:Secret Affiliate',
          legacy: 'Chrome:Legacy Secret',
        },
      },
    },
    profileBindings: {
      research: {
        gateway: 'local',
        profileAlias: 'research',
        decision: 'approved',
        profileIdentityRef: 'local-identity-secret',
        siteAccountRef: 'vault-account-secret',
        credentialRefs: { login: 'vault-credential-secret' },
        downloadPolicy: 'run-staging',
        reauthPolicy: 'bounded-one-attempt',
      },
      affiliate: {
        gateway: 'local',
        profileAlias: 'affiliate',
        reviewDecision: 'pending',
        downloadPolicy: 'run-staging',
        reauthPolicy: 'manual',
      },
      broken: {
        decision: 'blocked',
      },
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      HOME: home,
      WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
      WEBMCP_NO_AUTOSTART: '1',
      WEBMCP_NODE_ROLE: 'runner-node',
      WEBMCP_BOOTSTRAP_SERVICE_DIR: serviceDir,
      WEBMCP_TAILSCALE_BIN: process.execPath,
      WEBMCP_TAILSCALE_STATUS_FILE: tailnetStatusPath,
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'webmcp-doctor/1');
  assert.equal(report.mcp.ok, true, report.mcp.error);
  assert.ok(report.mcp.toolCount > 0);
  assert.equal(report.config.codex.registered, true);
  assert.equal(report.config.codex.healthy, true);
  assert.equal(report.gateway.ok, false);
  assert.equal(report.dispatcher.schema, 'webmcp-dispatcher-readiness/1');
  assert.equal(report.dispatcher.configured, true);
  assert.equal(report.dispatcher.readable, true);
  assert.equal(report.dispatcher.configSchema, 'webmcp-dispatcher-config/2');
  assert.equal(report.dispatcher.defaultGatewayConfigured, true);
  assert.equal(report.dispatcher.gatewayCount, 1);
  assert.equal(report.dispatcher.profiles.profileAliases, 3);
  assert.equal(report.dispatcher.profiles.objectEntries, 0);
  assert.equal(report.dispatcher.profiles.stringEntries, 3);
  assert.equal(report.dispatcher.profiles.missingProfileId, 0);
  assert.equal(report.dispatcher.profileBindings.count, 3);
  assert.equal(report.dispatcher.profileBindings.decisions.approved, 1);
  assert.equal(report.dispatcher.profileBindings.decisions.pending, 1);
  assert.equal(report.dispatcher.profileBindings.decisions.rejected, 1);
  assert.equal(report.dispatcher.profileBindings.missingGateway, 1);
  assert.equal(report.dispatcher.profileBindings.missingProfileAlias, 1);
  assert.equal(report.dispatcher.profileBindings.withCredentialRefs, 1);
  assert.equal(report.dispatcher.profileBindings.withSiteAccountRef, 1);
  assert.equal(report.dispatcher.profileBindings.withProfileIdentityRef, 1);
  assert.equal(report.dispatcher.profileBindings.runStagingDownloads, 2);
  assert.equal(report.dispatcher.profileBindings.boundedReauth, 1);
  assert.equal(report.downloadPolicy.schema, 'webmcp-download-policy-readiness/1');
  assert.equal(report.downloadPolicy.ok, true);
  assert.equal(report.downloadPolicy.policy.promptForDownloadLocation, false);
  assert.equal(report.downloadPolicy.policy.managedDownloadDirectory, true);
  assert.deepEqual(report.downloadPolicy.platforms.map((entry) => entry.platform).sort(), ['linux', 'macos', 'windows']);
  assert.equal(report.skills.schema, 'webmcp-skills-doctor/1');
  assert.equal(report.skills.ok, true);
  assert.equal(report.skills.receiptPresent, false);
  assert.equal(report.bootstrap.schema, 'webmcp-machine-bootstrap-readiness/1');
  assert.equal(report.bootstrap.dispatcherConfigured, true);
  assert.equal(report.bootstrap.downloadPolicyReady, true);
  assert.equal(report.bootstrap.skillsReady, true);
  assert.equal(report.bootstrap.receiptPresent, false);
  assert.equal(report.role.schema, 'webmcp-machine-role-readiness/1');
  assert.equal(report.role.role, 'runner-node');
  assert.equal(report.role.ok, true);
  assert.equal(report.services.schema, 'webmcp-service-readiness/1');
  assert.equal(report.services.ok, false);
  assert.equal(report.services.services.some((entry) => entry.id === 'webmcp-gateway' && entry.installed), true);
  assert.equal(report.services.services.some((entry) => entry.id === 'webmcp-node-executor' && !entry.installed), true);
  assert.equal(report.tailnet.schema, 'webmcp-tailnet-readiness/1');
  assert.equal(report.tailnet.cliAvailable, true);
  assert.equal(report.tailnet.online, true);
  assert.equal(report.bootstrap.roleConfigured, true);
  assert.equal(report.bootstrap.serviceReady, false);
  assert.equal(report.bootstrap.tailnetReady, true);
  assert.equal(report.bootstrap.ok, false);
  assert.doesNotMatch(result.stdout, /Chrome:Secret/);
  assert.doesNotMatch(result.stdout, /vault-credential-secret/);
  assert.doesNotMatch(result.stdout, /vault-account-secret/);
  assert.doesNotMatch(result.stdout, /local-identity-secret/);
  assert.doesNotMatch(result.stdout, /secret-hostname|secret\\.tailnet|100\\.64\\.0\\.1/);
});

test('webmcp bootstrap plan and apply produce redacted idempotent receipts', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-'));
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  mkdirSync(path.join(home, '.webmcp'), { recursive: true });
  writeFileSync(path.join(home, '.codex', 'config.toml'), [
    '[mcp_servers.webmcp]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify([path.join(ROOT, 'server', 'mcp_server.mjs')])}`,
    '',
  ].join('\n'));
  writeFileSync(path.join(home, '.webmcp', 'dispatcher.config.json'), JSON.stringify({
    schema: 'webmcp-dispatcher-config/2',
    defaultGateway: 'local',
    gateways: {
      local: {
        baseUrl: 'http://127.0.0.1:7865',
        profiles: { suno: 'Chrome:Secret Profile' },
      },
    },
    profileBindings: {
      suno: {
        gateway: 'local',
        profileAlias: 'suno',
        decision: 'approved',
        credentialRefs: { login: 'vault-secret-ref' },
        downloadPolicy: 'run-staging',
        reauthPolicy: 'bounded-one-attempt',
      },
    },
  }, null, 2));

  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
    WEBMCP_NO_AUTOSTART: '1',
    WEBMCP_TAILSCALE_BIN: path.join(home, 'missing-tailscale'),
  };
  const plan = spawnSync(process.execPath, [BIN, 'bootstrap', 'plan', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const planPayload = JSON.parse(plan.stdout);
  assert.equal(planPayload.schema, 'webmcp-bootstrap-plan/1');
  assert.equal(planPayload.mode, 'plan');
  assert.equal(planPayload.mutations.length, 3);
  assert.equal(planPayload.operatorActions.some((item) => item.code === 'START_GATEWAY'), true);
  assert.equal(planPayload.operatorActions.some((item) => item.code === 'SET_NODE_ROLE'), true);
  assert.equal(planPayload.operatorActions.some((item) => item.code === 'INSTALL_ROLE_SERVICES'), true);
  assert.equal(planPayload.operatorActions.some((item) => item.code === 'CONNECT_TAILNET'), true);
  assert.equal(planPayload.readiness.roleConfigured, false);
  assert.equal(planPayload.readiness.serviceReady, false);
  assert.equal(planPayload.readiness.tailnetReady, false);
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'install-receipt.json')), false);
  assert.doesNotMatch(plan.stdout, /Secret Profile|vault-secret-ref/);

  const apply = spawnSync(process.execPath, [BIN, 'bootstrap', 'apply', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(apply.status, 0, apply.stderr);
  const applyPayload = JSON.parse(apply.stdout);
  assert.equal(applyPayload.schema, 'webmcp-bootstrap-plan/1');
  assert.equal(applyPayload.mode, 'apply');
  assert.equal(applyPayload.applied, true);
  assert.equal(applyPayload.receipt.schema, 'webmcp-bootstrap-receipt/1');
  assert.equal(applyPayload.receipt.redacted, true);
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'install-receipt.json')), true);
  assert.equal(existsSync(path.join(home, '.webmcp', 'runs')), true);
  assert.equal(existsSync(path.join(home, '.webmcp', 'downloads')), true);
  assert.equal(existsSync(path.join(home, '.webmcp', 'vault')), true);
  assert.doesNotMatch(apply.stdout, /Secret Profile|vault-secret-ref/);
});

test('webmcp bootstrap tailnet-plan and tailnet-apply verify online state before receipt', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-tailnet-'));
  const statusFile = path.join(home, 'tailscale-status.json');
  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
    WEBMCP_NO_AUTOSTART: '1',
    WEBMCP_TAILSCALE_BIN: process.execPath,
    WEBMCP_TAILSCALE_STATUS_FILE: statusFile,
  };

  const missing = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'tailnet-plan',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(missing.status, 1, missing.stderr);
  const missingPayload = JSON.parse(missing.stdout);
  assert.equal(missingPayload.schema, 'webmcp-bootstrap-tailnet-plan/1');
  assert.equal(missingPayload.ok, false);
  assert.equal(missingPayload.actions.some((item) => item.code === 'CONNECT_TAILNET'), true);
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'tailnet-current.json')), false);

  writeFileSync(statusFile, JSON.stringify({
    Self: {
      Online: true,
      HostName: 'secret-hostname',
      DNSName: 'secret.tailnet.ts.net.',
      TailscaleIPs: ['100.64.0.1'],
    },
  }, null, 2));

  const applied = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'tailnet-apply',
    '--yes',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(applied.status, 0, applied.stderr);
  const appliedPayload = JSON.parse(applied.stdout);
  assert.equal(appliedPayload.schema, 'webmcp-bootstrap-tailnet-plan/1');
  assert.equal(appliedPayload.ok, true);
  assert.equal(appliedPayload.applied, true);
  assert.equal(appliedPayload.tailnet.online, true);
  assert.equal(appliedPayload.receipt.kind, 'tailnet');
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'tailnet-current.json')), true);
  assert.doesNotMatch(applied.stdout, /secret-hostname|secret\\.tailnet|100\\.64\\.0\\.1/);
});

test('webmcp bootstrap enroll-role is dry-run by default and writes reviewed role only with --yes', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-role-'));
  mkdirSync(path.join(home, '.webmcp'), { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
    WEBMCP_NO_AUTOSTART: '1',
  };

  const dryRun = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'enroll-role',
    '--role', 'runner-node',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryPayload = JSON.parse(dryRun.stdout);
  assert.equal(dryPayload.schema, 'webmcp-bootstrap-role-enrollment/1');
  assert.equal(dryPayload.applied, false);
  assert.equal(dryPayload.role.role, 'runner-node');
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'role.config.json')), false);
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'role-runner-node.json')), false);

  const applied = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'enroll-role',
    '--role', 'runner-node',
    '--yes',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(applied.status, 0, applied.stderr);
  const appliedPayload = JSON.parse(applied.stdout);
  assert.equal(appliedPayload.applied, true);
  assert.equal(appliedPayload.receipt.schema, 'webmcp-bootstrap-enrollment-receipt/1');
  assert.equal(appliedPayload.receipt.kind, 'role');
  const config = JSON.parse(readFileSync(path.join(home, '.webmcp', 'bootstrap', 'role.config.json'), 'utf8'));
  assert.equal(config.schema, 'webmcp-machine-role-config/1');
  assert.equal(config.role, 'runner-node');
  const receipt = JSON.parse(readFileSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'role-runner-node.json'), 'utf8'));
  assert.equal(receipt.subject.role, 'runner-node');
});

test('webmcp bootstrap service-plan and service-apply render reviewed local service templates', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-services-'));
  mkdirSync(path.join(home, '.webmcp', 'bootstrap'), { recursive: true });
  writeFileSync(path.join(home, '.webmcp', 'bootstrap', 'role.config.json'), JSON.stringify({
    schema: 'webmcp-machine-role-config/1',
    version: 1,
    role: 'operator',
    serviceIds: ['webmcp-gateway'],
  }, null, 2));
  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
    WEBMCP_NO_AUTOSTART: '1',
    WEBMCP_BOOTSTRAP_OS_SERVICE_DIR: path.join(home, 'os-services'),
    WEBMCP_BOOTSTRAP_SERVICE_LOAD_STATE_FILE: path.join(home, 'service-load-state.json'),
  };

  const plan = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'service-plan',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const planPayload = JSON.parse(plan.stdout);
  assert.equal(planPayload.schema, 'webmcp-bootstrap-service-plan/1');
  assert.equal(planPayload.applied, false);
  assert.equal(planPayload.role, 'operator');
  assert.equal(planPayload.services.length, 1);
  assert.equal(planPayload.services[0].id, 'webmcp-gateway');
  assert.equal(planPayload.services[0].status, 'pending');
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'services', 'io.webmcp-gateway.plist')), false);
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'services-operator.json')), false);
  assert.doesNotMatch(plan.stdout, /webmcp-bootstrap-services-|ttcenter|Secret|TOKEN|KEY/);

  const applied = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'service-apply',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(applied.status, 0, applied.stderr);
  const appliedPayload = JSON.parse(applied.stdout);
  assert.equal(appliedPayload.applied, true);
  assert.equal(appliedPayload.receipt.schema, 'webmcp-bootstrap-enrollment-receipt/1');
  assert.equal(appliedPayload.receipt.kind, 'services');
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'services', 'io.webmcp-gateway.plist')), true);
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'services-operator.json')), true);
  assert.doesNotMatch(applied.stdout, /webmcp-bootstrap-services-|ttcenter|Secret|TOKEN|KEY/);

  const doctor = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(doctor.status, 1, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.services.ok, true);
  assert.equal(report.bootstrap.serviceReady, true);
  assert.equal(report.services.services[0].source, 'local-template');

  const installPlan = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'service-install-plan',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(installPlan.status, 0, installPlan.stderr);
  const installPlanPayload = JSON.parse(installPlan.stdout);
  assert.equal(installPlanPayload.schema, 'webmcp-bootstrap-service-install-plan/1');
  assert.equal(installPlanPayload.applied, false);
  assert.equal(installPlanPayload.services[0].status, 'pending');
  assert.equal(existsSync(path.join(home, 'os-services', 'io.webmcp-gateway.plist')), false);
  assert.doesNotMatch(installPlan.stdout, /webmcp-bootstrap-services-|ttcenter|Secret|TOKEN|KEY/);

  const installed = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'service-install',
    '--yes',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(installed.status, 0, installed.stderr);
  const installedPayload = JSON.parse(installed.stdout);
  assert.equal(installedPayload.applied, true);
  assert.equal(installedPayload.services[0].status, 'installed');
  assert.equal(installedPayload.receipt.kind, 'os-services');
  assert.equal(
    existsSync(path.join(home, 'os-services', installedPayload.services[0].target)),
    true,
    JSON.stringify({
      target: installedPayload.services[0].target,
      files: existsSync(path.join(home, 'os-services')) ? readdirSync(path.join(home, 'os-services')) : [],
    }),
  );
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'os-services-operator.json')), true);
  assert.doesNotMatch(installed.stdout, /webmcp-bootstrap-services-|ttcenter|Secret|TOKEN|KEY/);

  const installedDoctor = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(installedDoctor.status, 1, installedDoctor.stderr);
  const installedReport = JSON.parse(installedDoctor.stdout);
  assert.equal(installedReport.services.ok, true);
  assert.equal(installedReport.services.services[0].source, 'os-user-service');
  assert.equal(installedReport.services.services[0].loaded, false);

  const loadPlan = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'service-load-plan',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(loadPlan.status, 0, loadPlan.stderr);
  const loadPlanPayload = JSON.parse(loadPlan.stdout);
  assert.equal(loadPlanPayload.schema, 'webmcp-bootstrap-service-load-plan/1');
  assert.equal(loadPlanPayload.applied, false);
  assert.equal(loadPlanPayload.services[0].status, 'pending');
  assert.equal(loadPlanPayload.services[0].loaded, false);
  assert.equal(existsSync(path.join(home, 'service-load-state.json')), false);
  assert.doesNotMatch(loadPlan.stdout, /webmcp-bootstrap-services-|ttcenter|Secret|TOKEN|KEY/);

  const loaded = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'service-load',
    '--yes',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  const loadedPayload = JSON.parse(loaded.stdout);
  assert.equal(loadedPayload.applied, true);
  assert.equal(loadedPayload.services[0].status, 'loaded');
  assert.equal(loadedPayload.services[0].loaded, true);
  assert.equal(loadedPayload.receipt.kind, 'service-load');
  assert.equal(existsSync(path.join(home, 'service-load-state.json')), true);
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'service-load-operator.json')), true);
  assert.doesNotMatch(loaded.stdout, /webmcp-bootstrap-services-|ttcenter|Secret|TOKEN|KEY/);

  const loadedDoctor = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(loadedDoctor.status, 1, loadedDoctor.stderr);
  const loadedReport = JSON.parse(loadedDoctor.stdout);
  assert.equal(loadedReport.services.ok, true);
  assert.equal(loadedReport.services.services[0].source, 'os-user-service');
  assert.equal(loadedReport.services.services[0].loaded, true);
});

test('webmcp bootstrap vault-key-plan reports redacted key-provider readiness', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-vault-key-'));
  const keyFile = path.join(home, 'secret-vault-key.txt');
  writeFileSync(keyFile, 'test-bootstrap-vault-key-32-bytes-minimum');
  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
    WEBMCP_NO_AUTOSTART: '1',
    WEBMCP_VAULT_KEY_FILE: keyFile,
  };
  const initialized = spawnSync(process.execPath, [BIN, 'vault', 'init', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const ready = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'vault-key-plan',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(ready.status, 0, ready.stderr);
  const readyPayload = JSON.parse(ready.stdout);
  assert.equal(readyPayload.schema, 'webmcp-bootstrap-vault-key-plan/1');
  assert.equal(readyPayload.ok, true);
  assert.equal(readyPayload.vault.initialized, true);
  assert.equal(readyPayload.vault.unlocked, true);
  assert.equal(readyPayload.vault.key.keyFileConfigured, true);
  assert.deepEqual(readyPayload.actions, []);
  assert.doesNotMatch(ready.stdout, /secret-vault-key\.txt|test-bootstrap-vault-key-32-bytes-minimum|\/tmp\/webmcp-bootstrap-vault-key-/);

  const missing = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'vault-key-plan',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...env,
      WEBMCP_VAULT_KEY_FILE: '',
      WEBMCP_VAULT_KEY: '',
    },
  });
  assert.equal(missing.status, 1, missing.stderr);
  const missingPayload = JSON.parse(missing.stdout);
  assert.equal(missingPayload.ok, false);
  assert.equal(missingPayload.actions.some((item) => item.code === 'CONFIGURE_VAULT_KEY_FILE'), true);
  assert.ok(missingPayload.nextActions.some((item) => item.command.includes('WEBMCP_VAULT_KEY_FILE=<private-key-file>')));
  assert.doesNotMatch(missing.stdout, /secret-vault-key\.txt|test-bootstrap-vault-key-32-bytes-minimum|\/tmp\/webmcp-bootstrap-vault-key-/);
});

test('webmcp bootstrap binding-plan reports canary alias and binding readiness without leaking refs', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-binding-plan-'));
  mkdirSync(path.join(home, '.webmcp'), { recursive: true });
  const dispatcherPath = path.join(home, '.webmcp', 'dispatcher.config.json');
  writeFileSync(dispatcherPath, JSON.stringify({
    schema: 'webmcp-dispatcher-config/2',
    defaultGateway: 'local',
    gateways: {
      local: {
        baseUrl: 'http://127.0.0.1:7865',
        profiles: {},
      },
    },
  }, null, 2));
  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
    WEBMCP_NO_AUTOSTART: '1',
  };

  const missing = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'binding-plan',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(missing.status, 1, missing.stderr);
  const missingPayload = JSON.parse(missing.stdout);
  assert.equal(missingPayload.schema, 'webmcp-bootstrap-binding-plan/1');
  assert.equal(missingPayload.ok, false);
  assert.equal(missingPayload.alias.declared, false);
  assert.equal(missingPayload.binding.declared, false);
  assert.equal(missingPayload.actions.some((item) => item.code === 'ENROLL_CANARY_PROFILE_ALIAS'), true);
  assert.equal(missingPayload.actions.some((item) => item.code === 'ENROLL_PROFILE_BINDING'), true);
  assert.ok(missingPayload.nextActions.some((item) => item.command.includes('bootstrap enroll-alias')));
  assert.ok(missingPayload.nextActions.some((item) => item.command.includes('bootstrap enroll-binding')));

  writeFileSync(dispatcherPath, JSON.stringify({
    schema: 'webmcp-dispatcher-config/2',
    defaultGateway: 'local',
    gateways: {
      local: {
        baseUrl: 'http://127.0.0.1:7865',
        profiles: { 'local-auth-fixture': 'Chrome:Secret Fixture Profile' },
      },
    },
    profileBindings: {
      'local-auth-fixture': {
        gateway: 'local',
        profileAlias: 'local-auth-fixture',
        decision: 'approved',
        credentialRefs: { login: 'vault-secret-ref' },
        siteAccountRef: 'account-secret-ref',
        profileIdentityRef: 'profile-secret-ref',
        downloadPolicy: 'run-staging',
        reauthPolicy: 'bounded-one-attempt',
      },
    },
  }, null, 2));

  const ready = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'binding-plan',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(ready.status, 0, ready.stderr);
  const readyPayload = JSON.parse(ready.stdout);
  assert.equal(readyPayload.ok, true);
  assert.equal(readyPayload.alias.declared, true);
  assert.equal(readyPayload.binding.declared, true);
  assert.equal(readyPayload.binding.decision, 'approved');
  assert.equal(readyPayload.binding.reauthReady, true);
  assert.equal(readyPayload.binding.hasCredentialRef, true);
  assert.equal(readyPayload.binding.hasSiteAccountRef, true);
  assert.equal(readyPayload.binding.hasProfileIdentityRef, true);
  assert.deepEqual(readyPayload.actions, []);
  assert.doesNotMatch(ready.stdout, /Secret Fixture Profile|vault-secret-ref|account-secret-ref|profile-secret-ref|Chrome:/);
});

test('webmcp bootstrap canary reports typed live blockers without writing receipt', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-canary-'));
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  mkdirSync(path.join(home, '.webmcp', 'vault'), { recursive: true });
  writeFileSync(path.join(home, '.codex', 'config.toml'), [
    '[mcp_servers.webmcp]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify([path.join(ROOT, 'server', 'mcp_server.mjs')])}`,
    '',
  ].join('\n'));
  writeFileSync(path.join(home, '.webmcp', 'dispatcher.config.json'), JSON.stringify({
    schema: 'webmcp-dispatcher-config/2',
    defaultGateway: 'local',
    gateways: {
      local: {
        baseUrl: 'http://127.0.0.1:7865',
        profiles: { 'local-auth-fixture': 'Chrome:Secret Fixture Profile' },
      },
    },
    profileBindings: {
      'local-auth-fixture': {
        gateway: 'local',
        profileAlias: 'local-auth-fixture',
        decision: 'approved',
        credentialRefs: { login: 'vault-secret-ref' },
        siteAccountRef: 'account-secret-ref',
        reauthPolicy: 'bounded-one-attempt',
      },
    },
  }, null, 2));

  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
    WEBMCP_NO_AUTOSTART: '1',
  };
  const initialized = spawnSync(process.execPath, [BIN, 'vault', 'init', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...env, WEBMCP_VAULT_KEY: 'test-bootstrap-canary-key-32-bytes-minimum' },
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const result = spawnSync(process.execPath, [BIN, 'bootstrap', 'canary', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });

  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema, 'webmcp-bootstrap-canary-readiness/1');
  assert.equal(payload.ok, false);
  assert.equal(payload.canary, 'local-auth-fixture-reauth-canary');
  assert.equal(payload.readiness.gatewayReady, false);
  assert.equal(payload.readiness.canaryProfileAliasDeclared, true);
  assert.equal(payload.readiness.vaultUnlocked, false);
  assert.equal(payload.blockers.some((item) => item.code === 'START_GATEWAY'), true);
  assert.equal(payload.blockers.some((item) => item.code === 'UNLOCK_VAULT'), true);
  assert.equal(payload.blockers.some((item) => item.code === 'SET_NODE_ROLE'), true);
  assert.equal(payload.blockers.some((item) => item.code === 'INSTALL_ROLE_SERVICES'), true);
  assert.ok(payload.nextActions.some((item) => item.code === 'UNLOCK_VAULT'));
  assert.ok(payload.nextActions.some((item) => item.command.includes('WEBMCP_VAULT_KEY_FILE=<private-key-file>')));
  assert.ok(payload.nextActions.some((item) => item.code === 'START_GATEWAY'));
  assert.ok(payload.nextActions.some((item) => item.code === 'SET_NODE_ROLE'));
  assert.ok(payload.nextActions.some((item) => item.code === 'INSTALL_ROLE_SERVICES'));
  assert.equal(payload.next.includes('webmcp bootstrap canary'), true);
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'install-receipt.json')), false);
  assert.doesNotMatch(result.stdout, /Secret Fixture Profile|vault-secret-ref|account-secret-ref/);
});

test('webmcp bootstrap enroll-binding is dry-run by default and writes reviewed metadata only with --yes', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-enroll-'));
  mkdirSync(path.join(home, '.webmcp'), { recursive: true });
  const dispatcherPath = path.join(home, '.webmcp', 'dispatcher.config.json');
  writeFileSync(dispatcherPath, JSON.stringify({
    schema: 'webmcp-dispatcher-config/2',
    defaultGateway: 'local',
    gateways: {
      local: {
        baseUrl: 'http://127.0.0.1:7865',
        profiles: { 'local-auth-fixture': 'Chrome:Secret Fixture Profile' },
      },
    },
  }, null, 2));

  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
    WEBMCP_NO_AUTOSTART: '1',
  };

  const dryRun = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'enroll-binding',
    '--id', 'local-auth-fixture',
    '--gateway', 'local',
    '--profile-alias', 'local-auth-fixture',
    '--decision', 'approved',
    '--reauth-policy', 'bounded-one-attempt',
    '--credential-purpose-ref', 'vault-secret-ref',
    '--site-account-ref', 'account-secret-ref',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryPayload = JSON.parse(dryRun.stdout);
  assert.equal(dryPayload.schema, 'webmcp-bootstrap-binding-enrollment/1');
  assert.equal(dryPayload.applied, false);
  assert.equal(dryPayload.binding.id, 'local-auth-fixture');
  assert.equal(dryPayload.binding.reauthReady, true);
  assert.equal(JSON.parse(readFileSync(dispatcherPath, 'utf8')).profileBindings, undefined);
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'binding-local-auth-fixture.json')), false);
  assert.doesNotMatch(dryRun.stdout, /Secret Fixture Profile|vault-secret-ref|account-secret-ref/);

  const applied = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'enroll-binding',
    '--id', 'local-auth-fixture',
    '--gateway', 'local',
    '--profile-alias', 'local-auth-fixture',
    '--decision', 'approved',
    '--reauth-policy', 'bounded-one-attempt',
    '--credential-purpose-ref', 'vault-secret-ref',
    '--site-account-ref', 'account-secret-ref',
    '--yes',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(applied.status, 0, applied.stderr);
  const appliedPayload = JSON.parse(applied.stdout);
  assert.equal(appliedPayload.applied, true);
  assert.equal(appliedPayload.receipt.schema, 'webmcp-bootstrap-enrollment-receipt/1');
  assert.equal(appliedPayload.receipt.kind, 'binding');
  assert.equal(appliedPayload.receipt.redacted, true);
  assert.doesNotMatch(applied.stdout, /Secret Fixture Profile|vault-secret-ref|account-secret-ref/);
  const dispatcher = JSON.parse(readFileSync(dispatcherPath, 'utf8'));
  assert.equal(dispatcher.profileBindings['local-auth-fixture'].gateway, 'local');
  assert.equal(dispatcher.profileBindings['local-auth-fixture'].profileAlias, 'local-auth-fixture');
  assert.equal(dispatcher.profileBindings['local-auth-fixture'].decision, 'approved');
  assert.equal(dispatcher.profileBindings['local-auth-fixture'].credentialRefs.login, 'vault-secret-ref');
  assert.equal(dispatcher.profileBindings['local-auth-fixture'].siteAccountRef, 'account-secret-ref');
  assert.equal(dispatcher.profileBindings['local-auth-fixture'].reauthPolicy, 'bounded-one-attempt');
  const receipt = JSON.parse(readFileSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'binding-local-auth-fixture.json'), 'utf8'));
  assert.equal(receipt.kind, 'binding');
  assert.equal(receipt.subject.id, 'local-auth-fixture');
  assert.equal(receipt.subject.hasCredentialRef, true);
  assert.doesNotMatch(JSON.stringify(receipt), /vault-secret-ref|account-secret-ref|Secret Fixture Profile/);
});

test('webmcp bootstrap enroll-alias is dry-run by default and writes logical aliases only with --yes', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-alias-'));
  mkdirSync(path.join(home, '.webmcp'), { recursive: true });
  const dispatcherPath = path.join(home, '.webmcp', 'dispatcher.config.json');
  writeFileSync(dispatcherPath, JSON.stringify({
    schema: 'webmcp-dispatcher-config/2',
    defaultGateway: 'local',
    gateways: {
      local: {
        baseUrl: 'http://127.0.0.1:7865',
        profiles: { existing: 'Chrome:Existing Secret Profile' },
      },
    },
  }, null, 2));

  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
    WEBMCP_NO_AUTOSTART: '1',
  };

  const dryRun = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'enroll-alias',
    '--gateway', 'local',
    '--alias', 'local-auth-fixture',
    '--profile-id', 'Chrome:Secret Fixture Profile',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryPayload = JSON.parse(dryRun.stdout);
  assert.equal(dryPayload.schema, 'webmcp-bootstrap-alias-enrollment/1');
  assert.equal(dryPayload.applied, false);
  assert.equal(dryPayload.alias.id, 'local-auth-fixture');
  assert.equal(dryPayload.alias.gateway, 'local');
  assert.equal(dryPayload.alias.profileIdProvided, true);
  assert.equal(JSON.parse(readFileSync(dispatcherPath, 'utf8')).gateways.local.profiles['local-auth-fixture'], undefined);
  assert.equal(existsSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'alias-local-auth-fixture.json')), false);
  assert.doesNotMatch(dryRun.stdout, /Secret Fixture Profile|Existing Secret Profile|Chrome:/);

  const applied = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'enroll-alias',
    '--gateway', 'local',
    '--alias', 'local-auth-fixture',
    '--profile-id', 'Chrome:Secret Fixture Profile',
    '--yes',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(applied.status, 0, applied.stderr);
  const appliedPayload = JSON.parse(applied.stdout);
  assert.equal(appliedPayload.applied, true);
  assert.equal(appliedPayload.receipt.schema, 'webmcp-bootstrap-enrollment-receipt/1');
  assert.equal(appliedPayload.receipt.kind, 'alias');
  assert.equal(appliedPayload.receipt.subject.id, 'local-auth-fixture');
  assert.doesNotMatch(applied.stdout, /Secret Fixture Profile|Existing Secret Profile|Chrome:/);
  const dispatcher = JSON.parse(readFileSync(dispatcherPath, 'utf8'));
  assert.equal(dispatcher.gateways.local.profiles['local-auth-fixture'], 'Chrome:Secret Fixture Profile');
  const receipt = JSON.parse(readFileSync(path.join(home, '.webmcp', 'bootstrap', 'enrollments', 'alias-local-auth-fixture.json'), 'utf8'));
  assert.equal(receipt.kind, 'alias');
  assert.equal(receipt.subject.gateway, 'local');
  assert.doesNotMatch(JSON.stringify(receipt), /Secret Fixture Profile|Existing Secret Profile|Chrome:/);
});

test('webmcp bootstrap profile-candidates lists selectable profiles without exposing ids', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-candidates-'));
  const managedRoot = path.join(home, '.webmcp', 'managed-profiles', 'secret-profile');
  mkdirSync(managedRoot, { recursive: true });
  writeFileSync(
    path.join(managedRoot, '.webmcp-meta.json'),
    JSON.stringify({ name: 'Secret Fixture Profile', createdAt: 1 }, null, 2),
  );

  const result = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'profile-candidates',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      HOME: home,
      WEBMCP_HOME: path.join(home, '.webmcp'),
      WEBMCP_DATA_DIR: path.join(home, '.webmcp'),
      WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
      WEBMCP_NO_AUTOSTART: '1',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema, 'webmcp-bootstrap-profile-candidates/1');
  assert.equal(payload.redacted, true);
  assert.equal(payload.counts.total, 1);
  assert.equal(payload.candidates.length, 1);
  assert.equal(payload.candidates[0].ordinal, 1);
  assert.equal(payload.candidates[0].kind, 'managed');
  assert.equal(payload.candidates[0].displayName, 'Secret Fixture Profile');
  assert.equal(Object.hasOwn(payload.candidates[0], 'id'), false);
  assert.equal(Object.hasOwn(payload.candidates[0], 'email'), false);
  assert.doesNotMatch(result.stdout, /managed:secret-profile|Chrome:|secret-profile/);
});

test('webmcp bootstrap enroll-alias can select a profile by redacted candidate ordinal', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-alias-ordinal-'));
  const managedRoot = path.join(home, '.webmcp', 'managed-profiles', 'secret-profile');
  mkdirSync(managedRoot, { recursive: true });
  writeFileSync(
    path.join(managedRoot, '.webmcp-meta.json'),
    JSON.stringify({ name: 'Secret Fixture Profile', createdAt: 1 }, null, 2),
  );
  const dispatcherPath = path.join(home, '.webmcp', 'dispatcher.config.json');
  writeFileSync(dispatcherPath, JSON.stringify({
    schema: 'webmcp-dispatcher-config/2',
    defaultGateway: 'local',
    gateways: {
      local: {
        baseUrl: 'http://127.0.0.1:7865',
        profiles: {},
      },
    },
  }, null, 2));

  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_DATA_DIR: path.join(home, '.webmcp'),
    WEBMCP_GATEWAY_URL: 'http://127.0.0.1:9',
    WEBMCP_NO_AUTOSTART: '1',
  };

  const dryRun = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'enroll-alias',
    '--gateway', 'local',
    '--alias', 'local-auth-fixture',
    '--candidate-ordinal', '1',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryPayload = JSON.parse(dryRun.stdout);
  assert.equal(dryPayload.schema, 'webmcp-bootstrap-alias-enrollment/1');
  assert.equal(dryPayload.applied, false);
  assert.equal(dryPayload.alias.profileIdProvided, true);
  assert.equal(dryPayload.alias.candidateOrdinal, 1);
  assert.equal(JSON.parse(readFileSync(dispatcherPath, 'utf8')).gateways.local.profiles['local-auth-fixture'], undefined);
  assert.doesNotMatch(dryRun.stdout, /managed:secret-profile|secret-profile|Chrome:/);

  const applied = spawnSync(process.execPath, [
    BIN,
    'bootstrap',
    'enroll-alias',
    '--gateway', 'local',
    '--alias', 'local-auth-fixture',
    '--candidate-ordinal', '1',
    '--yes',
    '--json',
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(applied.status, 0, applied.stderr);
  assert.doesNotMatch(applied.stdout, /managed:secret-profile|secret-profile|Chrome:/);
  const dispatcher = JSON.parse(readFileSync(dispatcherPath, 'utf8'));
  assert.equal(dispatcher.gateways.local.profiles['local-auth-fixture'], 'managed:secret-profile');
});

test('webmcp bootstrap subcommand help exits before validating required flags', () => {
  const result = spawnSync(process.execPath, [BIN, 'bootstrap', 'enroll-alias', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp bootstrap/);
  assert.match(result.stdout, /enroll-alias/);
  assert.match(result.stdout, /vault-key-plan/);
  assert.doesNotMatch(result.stderr, /gateway must be a safe id|profile-id or candidate-ordinal/);
});

test('webmcp workflow help uses the webmcp workflow command name', () => {
  const result = spawnSync(process.execPath, [BIN, 'workflow', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp workflow <command> \[options\]/);
  assert.match(result.stdout, /webmcp workflow run example-title/);
});

test('webmcp workflow reports a clear install hint when dispatcher is unavailable', () => {
  const result = spawnSync(process.execPath, [BIN, 'workflow', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_WORKFLOW_DISPATCHER_BIN: './missing-webmcp-workflow-cli.js',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workflow dispatcher CLI not found/);
  assert.match(result.stderr, /Install @gyga-browser\/webmcp-workflow/);
});

test('webmcp site resolves the Site Store from a monorepo checkout', () => {
  const result = spawnSync(process.execPath, [BIN, 'site', 'list-capabilities', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.capabilities.length > 0);
  assert.match(payload.capabilities[0].id, /^[a-z0-9-]+\/[a-z0-9-]+$/);
});

test('webmcp store remains a deprecated compatibility route', () => {
  const result = spawnSync(process.execPath, [BIN, 'store', 'list'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Deprecation: 'webmcp store' is now 'webmcp site'/);
  assert.match(result.stdout, /Site Store Capabilities/);
});

test('webmcp ai delegates to the standalone AI CLI', () => {
  const result = spawnSync(process.execPath, [BIN, 'ai', 'providers', 'list', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.providers.map((provider) => provider.id), ['agy', 'claude', 'codex']);
});

test('webmcp ai help uses the umbrella command name', () => {
  const result = spawnSync(process.execPath, [BIN, 'ai', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp ai <command>/);
});

test('webmcp ai reports a clear install hint when the CLI is unavailable', () => {
  const result = spawnSync(process.execPath, [BIN, 'ai', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_AI_BIN: './missing-webmcp-ai.mjs',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /WebMCP AI CLI not found/);
  assert.match(result.stderr, /Install @gyga-browser\/webmcp-ai/);
});

test('webmcp extension-info prints published Chrome Web Store metadata', () => {
  const result = spawnSync(process.execPath, [BIN, 'extension-info', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.id, 'lbodkmkjbcemodklopcfdmpjomdoapae');
  assert.equal(
    payload.chromeWebStoreUrl,
    'https://chromewebstore.google.com/detail/webmcp-tools-provider/lbodkmkjbcemodklopcfdmpjomdoapae',
  );
  assert.match(payload.unpackedExtensionPath, /webmcp-extension\/dist$/);
});

test('webmcp vault delegates to the vault CLI', () => {
  const result = spawnSync(process.execPath, [BIN, 'vault', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp-vault — local encrypted credential vault/);
});

test('webmcp vault reports a clear install hint when vault is unavailable', () => {
  const result = spawnSync(process.execPath, [BIN, 'vault', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_VAULT_BIN: './missing-webmcp-vault.js',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /WebMCP vault CLI not found/);
  assert.match(result.stderr, /Install @gyga-browser\/webmcp-vault-kit/);
});

test('webmcp automation delegates to the Automation Store CLI', () => {
  const result = spawnSync(process.execPath, [BIN, 'automation', 'list', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.automations.length > 0);
});

test('webmcp automation help uses the umbrella command name', () => {
  const result = spawnSync(process.execPath, [BIN, 'automation', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp automation run <id>/);
});

test('webmcp automation reports a clear install hint when unavailable', () => {
  const result = spawnSync(process.execPath, [BIN, 'automation', 'list'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_AUTOMATION_BIN: './missing-webmcp-automation.mjs',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /WebMCP Automation Store CLI not found/);
  assert.match(result.stderr, /WEBMCP_AUTOMATION_BIN/);
});

test('webmcp mobile exposes the ADB MCP entry point without starting it from help', () => {
  const result = spawnSync(process.execPath, [BIN, 'mobile', '--help'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /webmcp mobile mcp/);
  assert.match(result.stdout, /webmcp adb mcp/);
});

test('webmcp mobile reports a clear install hint when ADB Kit is unavailable', () => {
  const result = spawnSync(process.execPath, [BIN, 'mobile', 'mcp'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_ADB_MCP_BIN: './missing-webmcp-adb-server.mjs',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /WebMCP ADB MCP server not found/);
  assert.match(result.stderr, /WEBMCP_ADB_MCP_BIN/);
});

test('webmcp skills exposes the Automation-owned 15-skill inventory', () => {
  const result = spawnSync(process.execPath, [BIN, 'skills', 'list', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema, 'webmcp-skills/1');
  assert.equal(payload.skills.length, 15);
  assert.ok(payload.skills.every((skill) => skill.available));
});

test('webmcp skills path and doctor resolve canonical local sources', () => {
  const skillPath = spawnSync(process.execPath, [BIN, 'skills', 'path', 'webmcp-workflow-cli'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });
  assert.equal(skillPath.status, 0, skillPath.stderr);
  assert.match(skillPath.stdout.trim(), /packages\/webmcp-workflow-cli\/skills\/webmcp-workflow-cli$/);

  const doctor = spawnSync(process.execPath, [BIN, 'skills', 'doctor', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.deepEqual(JSON.parse(doctor.stdout).missing, []);
});

test('webmcp skills adopt and prune remove an explicitly adopted legacy skill', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-cli-skills-'));
  const legacy = path.join(home, '.codex/skills/workflow-dispatcher-cli');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, 'SKILL.md'), '---\nname: workflow-dispatcher-cli\ndescription: legacy\n---\n');
  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_KIT_MANIFEST: path.resolve(ROOT, '..', '..', 'webmcp-kit.json'),
  };

  let result = spawnSync(process.execPath, [BIN, 'skills', 'adopt', '--provider', 'codex', '--yes'], {
    cwd: WORKSPACE_ROOT, encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(path.join(home, '.webmcp/skills/install-receipt.json'), 'utf8'));
  assert.ok(receipt.owners['webmcp-automation-kit'].providers.codex.entries.includes('workflow-dispatcher-cli'));

  result = spawnSync(process.execPath, [BIN, 'skills', 'prune', '--yes'], {
    cwd: WORKSPACE_ROOT, encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(legacy));
});

test('webmcp skills doctor unions owners and uninstall removes only the selected kit ownership', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'webmcp-cli-multi-owner-'));
  const codexRoot = path.join(home, '.codex/skills');
  const webmcp = path.join(codexRoot, 'webmcp');
  const zalo = path.join(codexRoot, 'zalo-bot-messaging');
  mkdirSync(webmcp, { recursive: true });
  mkdirSync(zalo, { recursive: true });
  writeFileSync(path.join(webmcp, 'SKILL.md'), 'automation owned');
  writeFileSync(path.join(zalo, 'SKILL.md'), 'ops owned');
  const receiptPath = path.join(home, '.webmcp/skills/install-receipt.json');
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify({
    schema: 'webmcp-install-receipt/2',
    version: 2,
    owners: {
      'webmcp-automation-kit': {
        skillsMode: 'umbrella',
        providers: { codex: { root: codexRoot, entries: ['webmcp'] } },
      },
      'webmcp-ops-kit': {
        skillsMode: 'separate',
        providers: { codex: { root: codexRoot, entries: ['zalo-bot-messaging'] } },
      },
    },
  }));
  const env = {
    ...process.env,
    HOME: home,
    WEBMCP_HOME: path.join(home, '.webmcp'),
    WEBMCP_KIT_MANIFEST: path.resolve(ROOT, '..', '..', 'webmcp-kit.json'),
  };

  let result = spawnSync(process.execPath, [BIN, 'skills', 'doctor', '--json'], {
    cwd: WORKSPACE_ROOT, encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).receiptPresent, true);

  result = spawnSync(process.execPath, [BIN, 'skills', 'uninstall', '--all', '--yes'], {
    cwd: WORKSPACE_ROOT, encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(webmcp));
  assert.ok(existsSync(zalo));
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.ok(!receipt.owners['webmcp-automation-kit']);
  assert.deepEqual(receipt.owners['webmcp-ops-kit'].providers.codex.entries, ['zalo-bot-messaging']);
});
