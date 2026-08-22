#!/usr/bin/env node

import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProfilePool } from './profile-pool.mjs';

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
const RUNNER_PACKAGES = [
  '@gyga-browser/webmcp-automation-runner',
];
const SAFE_BOOTSTRAP_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const BOOTSTRAP_BINDING_DECISIONS = new Set(['approved', 'pending', 'rejected']);
const BOOTSTRAP_REAUTH_POLICIES = new Set(['manual', 'disabled', 'bounded-one-attempt']);
const BOOTSTRAP_NODE_ROLES = new Set(['operator', 'runner-node', 'fleet-node']);

function printHelp() {
  console.log(`WebMCP Browser Automation

Usage:
  webmcp mcp
  webmcp mcp --help
  webmcp gateway start
  webmcp gateway health [--json]
  webmcp health [--json]
  webmcp doctor [--json]
  webmcp bootstrap plan|apply|canary|vault-key-plan|binding-plan|tailnet-plan|tailnet-apply|profile-candidates|enroll-role|service-plan|service-apply|service-install-plan|service-install|service-load-plan|service-load|enroll-alias|enroll-binding [--json]
  webmcp launch [--name <name> | --profile-id <id>] [--gateway] [--relaunch] [--dry-run] [--json]
  webmcp close [--profile-id <id>] [--all] [--json]
  webmcp quit [--json]
  webmcp profiles list [--json]
  webmcp profile-pool acquire|renew|release|list|status|reclaim|doctor [--json]
  webmcp call <method> [jsonParams]
  webmcp ai <command> [options]
  webmcp vault <command> [options]
  webmcp workflow <command> [options]
  webmcp site <command> [options]
  webmcp automation <command> [options]
  webmcp project <command> [options]
  webmcp mobile mcp
  webmcp adb mcp                         Alias for webmcp mobile mcp
  webmcp captcha <command> [options]     Solve/detect CAPTCHAs (python solver)
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
  WEBMCP_RUNNER_BIN               Override Automation Runner CLI path or package name
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

function printBootstrapHelp() {
  console.log(`webmcp bootstrap — local WebMCP machine bootstrap

Usage:
  webmcp bootstrap plan [--json]
  webmcp bootstrap apply [--json]
  webmcp bootstrap canary [--json]
  webmcp bootstrap vault-key-plan [--json]
  webmcp bootstrap binding-plan [--json]
  webmcp bootstrap tailnet-plan [--json]
  webmcp bootstrap tailnet-apply [--yes] [--json]
  webmcp bootstrap profile-candidates [--json]
  webmcp bootstrap enroll-role --role <operator|runner-node|fleet-node> [--yes] [--json]
  webmcp bootstrap service-plan [--json]
  webmcp bootstrap service-apply [--json]
  webmcp bootstrap service-install-plan [--json]
  webmcp bootstrap service-install [--yes] [--json]
  webmcp bootstrap service-load-plan [--json]
  webmcp bootstrap service-load [--yes] [--json]
  webmcp bootstrap enroll-alias --gateway <id> --alias <id> (--candidate-ordinal <n>|--profile-id <id>) [--yes] [--json]
  webmcp bootstrap enroll-binding --id <id> --gateway <id> --profile-alias <id> --decision <approved|pending|rejected> [--reauth-policy <policy>] [--credential-purpose-ref <ref>] [--site-account-ref <ref>] [--download-policy <policy>] [--yes] [--json]

Notes:
  plan/canary/binding-plan/vault-key-plan/profile-candidates are read-only.
  enroll-* and service apply/install/load write only with --yes and redact local profile,
  Vault, account, Tailnet, and service path details from command output.`);
}

function printProjectHelp() {
  console.log(`webmcp project — WebMCP project workspace management

Usage:
  webmcp project attach <dir> [--replace] [--as-copy <id>] [--repair-layout] [--default] [--dry-run] [--json]
  webmcp project attach --scan <root> [--replace] [--repair-layout] [--default] [--dry-run] [--json]
  webmcp project list [--json]
  webmcp project where [<id>] [--json]
  webmcp project doctor [<dir>] [--json]
  webmcp project new [--template <id>] [--at <dir>] [--id <id>] [--name <name>] [--default] [--dry-run] [--json]
  webmcp project init [--at <dir>] [--id <id>] [--name <name>] [--dir <storeDir>] [--force] [--dry-run] [--json]
  webmcp project init-store [--at <dir>] [--id <id>] [--name <name>] [--dir <storeDir>] [--force] [--dry-run] [--json]
  webmcp project build-index [--dir <projectStoreDir>] [--workspace <dir>] [--json]
  webmcp project export-pack --select <domain>/<id> --output <dir> [--alias <alias>] [--json]
  webmcp project charter adopt <relative-md> [--workspace <dir>] [--yes] [--json]
  webmcp project guide list [--json]
  webmcp project guide stage <collections/<id>/GUIDE.md> --as inputs/<path> --yes [--json]
  webmcp project schedule list [--workspace <path>] [--json]
  webmcp project schedule plan [<id>] --target <t> [--workspace <path>] [--json]
  webmcp project schedule apply [<id>] --target <t> [--workspace <path>] [--json]
  webmcp project schedule status [--all-targets] [--workspace <path>] [--json]

Notes:
  attach registers an existing project directory in the local workspace registry,
  or relocates its registered root after the folder was moved. Idempotent; without
  flags it never changes an existing registration.
  where prints the resolved project root; without an ID it resolves the registered
  default project.
  doctor runs the runner's workspace doctor, a registry audit of the project root,
  and an attach dry-run sanity check.
  new creates a project from a template in the Automation Store (template id =
  store automation id); without --template it bootstraps the store's default
  selection (all automations). Without --at the default parent is $WEBMCP_PROJECTS_ROOT
  or ~/WebMCP Projects.
  charter adopt is dry-run by default; pass --yes to write. It delegates the charter
  operation to the Automation Runner and never reads or modifies project files itself.
  guide list shows derived guides (collections/<id>/GUIDE.md). guide stage copies a
  reviewed guide below the intent/evidence boundary into inputs/; it requires the
  explicit --yes confirmation and never modifies or deletes the source.`);
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

function readJsonFile(file) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function profileIdFromDispatcherEntry(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (!entry || typeof entry !== 'object') return '';
  const raw = entry.profileId ?? entry.id;
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizedReviewDecision(entry) {
  if (!entry || typeof entry !== 'object') return 'unknown';
  const raw = entry.decision ?? entry.reviewDecision ?? entry.review?.decision ?? entry.status;
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim().toLowerCase();
  if (['approved', 'allow', 'allowed', 'reviewed', 'accepted'].includes(value)) return 'approved';
  if (['rejected', 'deny', 'denied', 'blocked'].includes(value)) return 'rejected';
  if (['pending', 'todo', 'unreviewed', 'needs-review'].includes(value)) return 'pending';
  return 'other';
}

function summarizeDispatcherProfiles(rawProfiles) {
  const profiles = rawProfiles && typeof rawProfiles === 'object' && !Array.isArray(rawProfiles)
    ? rawProfiles
    : {};
  const decisions = { approved: 0, rejected: 0, pending: 0, other: 0, unknown: 0 };
  const trustDomains = new Set();
  const physicalRefs = new Map();
  let stringEntries = 0;
  let objectEntries = 0;
  let invalidEntries = 0;
  let missingProfileId = 0;
  let missingTrustDomain = 0;

  for (const [alias, entry] of Object.entries(profiles)) {
    const profileId = profileIdFromDispatcherEntry(entry);
    if (typeof entry === 'string') {
      stringEntries += 1;
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      objectEntries += 1;
      decisions[normalizedReviewDecision(entry)] += 1;
      const trustDomain = typeof entry.trustDomain === 'string' ? entry.trustDomain.trim() : '';
      if (trustDomain) trustDomains.add(trustDomain);
      else missingTrustDomain += 1;
      const physicalRef = entry.physicalProfileHash ?? entry.profileHash ?? entry.physicalProfileIdHash;
      if (typeof physicalRef === 'string' && physicalRef.trim()) {
        const key = physicalRef.trim();
        physicalRefs.set(key, (physicalRefs.get(key) || 0) + 1);
      }
    } else {
      invalidEntries += 1;
    }
    if (!profileId) missingProfileId += 1;
    if (typeof alias !== 'string' || !alias.trim()) invalidEntries += 1;
  }

  const physicalGroupSizes = [...physicalRefs.values()];
  return {
    profileAliases: Object.keys(profiles).length,
    stringEntries,
    objectEntries,
    invalidEntries,
    missingProfileId,
    decisions,
    trustDomains: {
      count: trustDomains.size,
      missing: missingTrustDomain,
    },
    physicalProfiles: {
      hashedEntries: physicalGroupSizes.reduce((sum, size) => sum + size, 0),
      distinctGroups: physicalGroupSizes.length,
      sharedGroups: physicalGroupSizes.filter((size) => size > 1).length,
      largestGroupSize: physicalGroupSizes.length ? Math.max(...physicalGroupSizes) : 0,
    },
  };
}

function summarizeDispatcherGatewayProfiles(rawGateways) {
  const gateways = rawGateways && typeof rawGateways === 'object' && !Array.isArray(rawGateways)
    ? rawGateways
    : {};
  const aggregate = {
    profileAliases: 0,
    stringEntries: 0,
    objectEntries: 0,
    invalidEntries: 0,
    missingProfileId: 0,
    decisions: { approved: 0, rejected: 0, pending: 0, other: 0, unknown: 0 },
    trustDomains: { count: 0, missing: 0 },
    physicalProfiles: { hashedEntries: 0, distinctGroups: 0, sharedGroups: 0, largestGroupSize: 0 },
  };
  const trustDomains = new Set();
  const physicalRefs = new Map();

  for (const gateway of Object.values(gateways)) {
    const summary = summarizeDispatcherProfiles(gateway?.profiles);
    aggregate.profileAliases += summary.profileAliases;
    aggregate.stringEntries += summary.stringEntries;
    aggregate.objectEntries += summary.objectEntries;
    aggregate.invalidEntries += summary.invalidEntries;
    aggregate.missingProfileId += summary.missingProfileId;
    for (const [key, value] of Object.entries(summary.decisions)) aggregate.decisions[key] += value;
    aggregate.trustDomains.missing += summary.trustDomains.missing;
    aggregate.physicalProfiles.hashedEntries += summary.physicalProfiles.hashedEntries;
    aggregate.physicalProfiles.sharedGroups += summary.physicalProfiles.sharedGroups;
    aggregate.physicalProfiles.largestGroupSize = Math.max(
      aggregate.physicalProfiles.largestGroupSize,
      summary.physicalProfiles.largestGroupSize,
    );

    const profiles = gateway?.profiles && typeof gateway.profiles === 'object' && !Array.isArray(gateway.profiles)
      ? gateway.profiles
      : {};
    for (const entry of Object.values(profiles)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const trustDomain = typeof entry.trustDomain === 'string' ? entry.trustDomain.trim() : '';
      if (trustDomain) trustDomains.add(trustDomain);
      const physicalRef = entry.physicalProfileHash ?? entry.profileHash ?? entry.physicalProfileIdHash;
      if (typeof physicalRef === 'string' && physicalRef.trim()) {
        const key = physicalRef.trim();
        physicalRefs.set(key, (physicalRefs.get(key) || 0) + 1);
      }
    }
  }

  const physicalGroupSizes = [...physicalRefs.values()];
  aggregate.trustDomains.count = trustDomains.size;
  aggregate.physicalProfiles.distinctGroups = physicalGroupSizes.length;
  if (physicalGroupSizes.length) {
    aggregate.physicalProfiles.sharedGroups = physicalGroupSizes.filter((size) => size > 1).length;
    aggregate.physicalProfiles.largestGroupSize = Math.max(...physicalGroupSizes);
  }
  return aggregate;
}

function summarizeProfileBindings(rawBindings) {
  const bindings = rawBindings && typeof rawBindings === 'object' && !Array.isArray(rawBindings)
    ? rawBindings
    : {};
  const decisions = { approved: 0, rejected: 0, pending: 0, other: 0, unknown: 0 };
  let missingGateway = 0;
  let missingProfileAlias = 0;
  let withCredentialRefs = 0;
  let withSiteAccountRef = 0;
  let withProfileIdentityRef = 0;
  let runStagingDownloads = 0;
  let boundedReauth = 0;

  for (const binding of Object.values(bindings)) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      decisions.unknown += 1;
      missingGateway += 1;
      missingProfileAlias += 1;
      continue;
    }
    decisions[normalizedReviewDecision(binding)] += 1;
    if (typeof binding.gateway !== 'string' || !binding.gateway.trim()) missingGateway += 1;
    if (typeof binding.profileAlias !== 'string' || !binding.profileAlias.trim()) missingProfileAlias += 1;
    if (binding.credentialRefs && typeof binding.credentialRefs === 'object' && !Array.isArray(binding.credentialRefs)) {
      withCredentialRefs += 1;
    }
    if (typeof binding.siteAccountRef === 'string' && binding.siteAccountRef.trim()) withSiteAccountRef += 1;
    if (typeof binding.profileIdentityRef === 'string' && binding.profileIdentityRef.trim()) withProfileIdentityRef += 1;
    if (binding.downloadPolicy === 'run-staging') runStagingDownloads += 1;
    if (typeof binding.reauthPolicy === 'string' && binding.reauthPolicy !== 'manual' && binding.reauthPolicy !== 'disabled') {
      boundedReauth += 1;
    }
  }

  return {
    count: Object.keys(bindings).length,
    missingGateway,
    missingProfileAlias,
    decisions,
    withCredentialRefs,
    withSiteAccountRef,
    withProfileIdentityRef,
    runStagingDownloads,
    boundedReauth,
  };
}

function readDispatcherReadiness() {
  const file = resolve(getWebmcpHome(), 'dispatcher.config.json');
  if (!existsSync(file)) {
    return {
      schema: 'webmcp-dispatcher-readiness/1',
      configured: false,
      readable: false,
      path: file,
      warning: 'dispatcher.config.json not found',
    };
  }

  const parsed = readJsonFile(file);
  if (!parsed.ok) {
    return {
      schema: 'webmcp-dispatcher-readiness/1',
      configured: true,
      readable: false,
      path: file,
      error: parsed.error,
    };
  }

  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  const gateways = data.gateways && typeof data.gateways === 'object' && !Array.isArray(data.gateways)
    ? data.gateways
    : {};
  return {
    schema: 'webmcp-dispatcher-readiness/1',
    configured: true,
    readable: true,
    path: file,
    configSchema: typeof data.schema === 'string' ? data.schema : null,
    defaultGatewayConfigured: typeof data.defaultGateway === 'string' && Boolean(data.defaultGateway.trim()),
    gatewayCount: Object.keys(gateways).length,
    profiles: data.profiles
      ? summarizeDispatcherProfiles(data.profiles)
      : summarizeDispatcherGatewayProfiles(gateways),
    profileBindings: summarizeProfileBindings(data.profileBindings),
  };
}

function dispatcherConfigPath() {
  return resolve(getWebmcpHome(), 'dispatcher.config.json');
}

function readDispatcherConfigForWrite() {
  const file = dispatcherConfigPath();
  if (!existsSync(file)) {
    throw new Error('dispatcher.config.json not found');
  }
  const parsed = readJsonFile(file);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw new Error(`dispatcher.config.json is not a JSON object: ${parsed.error || 'invalid JSON'}`);
  }
  return { file, config: parsed.data };
}

function safeBootstrapId(value, name) {
  if (typeof value !== 'string' || !SAFE_BOOTSTRAP_ID.test(value)) {
    throw new Error(`${name} must be a safe id`);
  }
  return value;
}

function maybeSafeBootstrapId(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return safeBootstrapId(value, name);
}

function safeBootstrapProfileId(value, name) {
  if (typeof value !== 'string'
    || value.length < 2
    || value.length > 160
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.includes('..')
    || value.includes('//')
    || value.includes('\\\\')) {
    throw new Error(`${name} must be a safe profile id`);
  }
  return value;
}

function shippedDownloadPolicyReadiness() {
  const installationRoot = resolve(ROOT, '..', '..', 'installation');
  const checks = [
    {
      platform: 'macos',
      file: resolve(installationRoot, 'extension', 'macos', 'WebMCP-ForceInstall.mobileconfig'),
      validate: (text) => (
        text.includes('PromptForDownloadLocation')
        && text.includes('DownloadDirectory')
        && !/PromptForDownload(?!Location)/.test(text)
        && text.includes('/Users/Shared/WebMCP/Downloads')
      ),
    },
    {
      platform: 'linux',
      file: resolve(installationRoot, 'extension', 'ubuntu', 'install.sh'),
      validate: (text) => (
        text.includes('"PromptForDownloadLocation": false')
        && text.includes('"DownloadDirectory": "${DOWNLOAD_DIR}"')
        && text.includes('/var/lib/webmcp/downloads')
      ),
    },
    {
      platform: 'windows',
      file: resolve(installationRoot, 'extension', 'windows', 'install.ps1'),
      validate: (text) => (
        text.includes('PromptForDownloadLocation')
        && text.includes('DownloadDirectory')
        && text.includes('C:\\WebMCP\\Downloads')
      ),
    },
  ];
  const platforms = checks.map((check) => {
    if (!existsSync(check.file)) {
      return { platform: check.platform, ok: false, configured: false, error: 'installer artifact missing' };
    }
    const text = readFileSync(check.file, 'utf8');
    return { platform: check.platform, ok: check.validate(text), configured: true };
  });
  return {
    schema: 'webmcp-download-policy-artifacts-readiness/1',
    ok: platforms.every((entry) => entry.ok),
    policy: {
      promptForDownloadLocation: false,
      managedDownloadDirectory: true,
    },
    platforms,
  };
}

function platformDownloadPolicyExpectation() {
  const testDownloadDirectory = process.env.WEBMCP_TEST_DOWNLOAD_POLICY_DIRECTORY || null;
  if (process.platform === 'darwin') {
    return {
      platform: 'macos',
      directory: testDownloadDirectory || '/Users/Shared/WebMCP/Downloads',
      source: 'configuration-profile',
    };
  }
  if (process.platform === 'linux') {
    return {
      platform: 'linux',
      directory: testDownloadDirectory || '/var/lib/webmcp/downloads',
      source: 'managed-policy-file',
      files: [
        '/etc/opt/chrome/policies/managed/webmcp_forcelist.json',
        '/etc/chromium/policies/managed/webmcp_forcelist.json',
        '/etc/chromium-browser/policies/managed/webmcp_forcelist.json',
      ],
    };
  }
  if (process.platform === 'win32') {
    return {
      platform: 'windows',
      directory: testDownloadDirectory || 'C:\\WebMCP\\Downloads',
      source: 'registry-policy',
    };
  }
  return { platform: process.platform, directory: null, source: 'unsupported-platform' };
}

function textHasManagedDownloadPolicy(text, expectedDirectory) {
  return Boolean(text
    && text.includes('PromptForDownloadLocation')
    && text.includes('DownloadDirectory')
    && text.includes(expectedDirectory)
    && !/PromptForDownload(?!Location)/.test(text));
}

function readMacManagedPreferencesPolicy(expectedDirectory) {
  const root = process.env.WEBMCP_TEST_MANAGED_PREFS_ROOT || '/Library/Managed Preferences';
  const candidates = [
    resolve(root, 'com.google.Chrome.plist'),
    resolve(root, process.env.USER || '', 'com.google.Chrome.plist'),
  ];
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue;
    try {
      const text = readFileSync(file, 'utf8');
      if (textHasManagedDownloadPolicy(text, expectedDirectory)) {
        return { installed: true, managedDownloadDirectory: true, source: 'managed-preferences' };
      }
      if (text.includes('com.google.Chrome') || text.includes('ExtensionInstallForcelist')) {
        return { installed: true, managedDownloadDirectory: false, source: 'managed-preferences' };
      }
    } catch {
      // Keep looking; an unreadable managed-preferences file should not make
      // policy readiness pass.
    }
  }
  return { installed: false, managedDownloadDirectory: false, source: 'managed-preferences' };
}

function currentDownloadPolicyReadiness() {
  const expectation = platformDownloadPolicyExpectation();
  const base = {
    schema: 'webmcp-current-download-policy-readiness/1',
    platform: expectation.platform,
    ok: false,
    installed: false,
    promptForDownloadLocation: false,
    managedDownloadDirectory: false,
    downloadDirectoryReady: false,
    source: expectation.source,
  };

  if (process.env.WEBMCP_TEST_CHROME_POLICY_EFFECTIVE === '1') {
    return {
      ...base,
      ok: true,
      installed: true,
      promptForDownloadLocation: false,
      managedDownloadDirectory: true,
      downloadDirectoryReady: true,
      source: 'test-override',
    };
  }
  if (process.env.WEBMCP_TEST_CHROME_POLICY_EFFECTIVE === '0') {
    return { ...base, source: 'test-override' };
  }

  if (!expectation.directory) {
    return { ...base, error: 'current platform policy inspection is not implemented' };
  }

  if (process.platform === 'darwin') {
    const profileOutputPath = process.env.WEBMCP_TEST_PROFILES_SHOW_FILE || null;
    const result = profileOutputPath
      ? { status: 0, stdout: readFileSync(profileOutputPath, 'utf8'), stderr: '' }
      : spawnSync('profiles', ['show', '-type', 'configuration'], { encoding: 'utf8', timeout: 5000 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const installed = result.status === 0 && output.includes('com.google.Chrome');
    const managedDownloadDirectory = textHasManagedDownloadPolicy(output, expectation.directory);
    const managedPrefs = managedDownloadDirectory
      ? { installed: false, managedDownloadDirectory: false, source: null }
      : readMacManagedPreferencesPolicy(expectation.directory);
    const effectiveInstalled = installed || managedPrefs.installed;
    const effectiveManagedDirectory = managedDownloadDirectory || managedPrefs.managedDownloadDirectory;
    return {
      ...base,
      ok: effectiveInstalled && effectiveManagedDirectory && existsSync(expectation.directory),
      installed: effectiveInstalled,
      promptForDownloadLocation: effectiveManagedDirectory ? false : null,
      managedDownloadDirectory: effectiveManagedDirectory,
      downloadDirectoryReady: existsSync(expectation.directory),
      source: managedDownloadDirectory
        ? (profileOutputPath ? 'test-profile-snapshot' : expectation.source)
        : managedPrefs.source,
      error: result.status === 0 ? null : 'unable to inspect macOS configuration profiles',
    };
  }

  if (process.platform === 'linux') {
    const matchingFiles = expectation.files.filter((file) => existsSync(file));
    const managedDownloadDirectory = matchingFiles.some((file) => {
      try {
        return textHasManagedDownloadPolicy(readFileSync(file, 'utf8'), expectation.directory);
      } catch {
        return false;
      }
    });
    return {
      ...base,
      ok: managedDownloadDirectory && existsSync(expectation.directory),
      installed: matchingFiles.length > 0,
      promptForDownloadLocation: managedDownloadDirectory ? false : null,
      managedDownloadDirectory,
      downloadDirectoryReady: existsSync(expectation.directory),
      source: expectation.source,
    };
  }

  if (process.platform === 'win32') {
    const script = [
      '$p = "HKLM:\\SOFTWARE\\Policies\\Google\\Chrome";',
      'try { $v = Get-ItemProperty -Path $p; [Console]::Out.Write(($v.PromptForDownloadLocation -eq 0).ToString() + "," + ($v.DownloadDirectory -eq "C:\\WebMCP\\Downloads").ToString()) } catch { exit 1 }',
    ].join(' ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 5000 });
    const [promptOk, dirOk] = String(result.stdout || '').trim().split(',');
    const managedDownloadDirectory = dirOk === 'True';
    const promptForDownloadLocation = promptOk === 'True' ? false : null;
    return {
      ...base,
      ok: promptForDownloadLocation === false && managedDownloadDirectory,
      installed: result.status === 0,
      promptForDownloadLocation,
      managedDownloadDirectory,
      downloadDirectoryReady: managedDownloadDirectory,
      source: expectation.source,
      error: result.status === 0 ? null : 'unable to inspect Windows Chrome policy registry',
    };
  }

  return base;
}

function downloadPolicyReadiness() {
  const artifacts = shippedDownloadPolicyReadiness();
  const current = currentDownloadPolicyReadiness();
  return {
    schema: 'webmcp-download-policy-readiness/1',
    ok: artifacts.ok && current.ok,
    policy: {
      promptForDownloadLocation: false,
      managedDownloadDirectory: true,
    },
    artifacts,
    current,
    platforms: artifacts.platforms,
  };
}

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

function readMachineRoleReadiness() {
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

function machineRoleConfigPath() {
  return resolve(getWebmcpHome(), 'bootstrap', 'role.config.json');
}

function expectedServiceIdsForRole(role) {
  if (role === 'operator') return ['webmcp-gateway'];
  if (role === 'runner-node') return ['webmcp-gateway', 'webmcp-node-executor'];
  if (role === 'fleet-node') return ['webmcp-gateway', 'webmcp-node-executor', 'webmcp-fleet-hub'];
  return ['webmcp-gateway'];
}

function serviceFileName(id) {
  if (process.platform === 'darwin') return `io.${id}.plist`;
  if (process.platform === 'win32') return `${id}.xml`;
  return `${id}.service`;
}

function serviceLabel(id) {
  if (process.platform === 'darwin') return `io.${id}`;
  return id;
}

function serviceRegistryDir() {
  return typeof process.env.WEBMCP_BOOTSTRAP_SERVICE_DIR === 'string' && process.env.WEBMCP_BOOTSTRAP_SERVICE_DIR.trim()
    ? process.env.WEBMCP_BOOTSTRAP_SERVICE_DIR.trim()
    : resolve(getWebmcpHome(), 'bootstrap', 'services');
}

function osServiceInstallDir() {
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

function isServiceLoaded(id) {
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

function loadService(id, file) {
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

function collectServiceReadiness(roleReadiness) {
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

async function collectTailnetReadiness() {
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

async function collectDoctorReport() {
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
  const dispatcher = readDispatcherReadiness();
  const downloadPolicy = downloadPolicyReadiness();
  const skills = buildSkillsDoctorReport();
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

async function runDoctor(args) {
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

function bootstrapReceiptPath() {
  return resolve(getWebmcpHome(), 'bootstrap', 'install-receipt.json');
}

function bootstrapEnrollmentReceiptPath(kind, id) {
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

function writeBootstrapEnrollmentReceipt(kind, id, subject) {
  const receipt = safeBootstrapEnrollmentReceipt({ kind, subject });
  const receiptFile = bootstrapEnrollmentReceiptPath(kind, id);
  mkdirSync(dirname(receiptFile), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(receiptFile), 0o700); } catch { /* best effort */ }
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(receiptFile, 0o600); } catch { /* best effort */ }
  return receipt;
}

async function buildBootstrapPlan({ apply = false } = {}) {
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

function runJsonChild(command, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolveChild) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveChild(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, status: null, error: 'command timed out' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ ok: false, status: null, error: error.message }));
    child.on('exit', (status, signal) => {
      let payload = null;
      try { payload = stdout.trim() ? JSON.parse(stdout) : null; } catch { payload = null; }
      finish({
        ok: status === 0 && payload && typeof payload === 'object',
        status,
        signal,
        payload,
        error: payload ? null : (stderr || stdout || 'command returned no JSON').slice(0, 500),
      });
    });
  });
}

async function collectVaultDoctorReport() {
  const vaultBin = getVaultBin();
  if (!vaultBin || !existsSync(vaultBin)) {
    return {
      available: false,
      initialized: false,
      unlocked: false,
      error: 'vault CLI not found',
    };
  }
  const result = await runJsonChild(process.execPath, [vaultBin, 'doctor', '--json']);
  const payload = result.payload && typeof result.payload === 'object' ? result.payload : {};
  return {
    available: true,
    initialized: payload.initialized === true,
    unlocked: payload.unlocked === true,
    key: {
      available: payload.key?.available === true,
      source: typeof payload.key?.source === 'string' ? payload.key.source : 'unknown',
      conflict: payload.key?.conflict === true,
      lengthBucket: typeof payload.key?.lengthBucket === 'string' ? payload.key.lengthBucket : 'unknown',
      strengthBucket: typeof payload.key?.strengthBucket === 'string' ? payload.key.strengthBucket : 'unknown',
      keyFileConfigured: payload.key?.keyFile?.configured === true,
    },
    error: result.ok ? null : result.error || null,
  };
}

function declaredProfileAlias(config, alias) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const topProfiles = config.profiles && typeof config.profiles === 'object' && !Array.isArray(config.profiles)
    ? config.profiles
    : {};
  if (Object.hasOwn(topProfiles, alias)) return true;
  const gateways = config.gateways && typeof config.gateways === 'object' && !Array.isArray(config.gateways)
    ? config.gateways
    : {};
  return Object.values(gateways).some((gateway) => Object.hasOwn(
    gateway?.profiles && typeof gateway.profiles === 'object' && !Array.isArray(gateway.profiles)
      ? gateway.profiles
      : {},
    alias,
  ));
}

function readBinding(config, id) {
  const bindings = config?.profileBindings && typeof config.profileBindings === 'object' && !Array.isArray(config.profileBindings)
    ? config.profileBindings
    : {};
  const binding = bindings[id];
  return binding && typeof binding === 'object' && !Array.isArray(binding) ? binding : null;
}

function redactedBindingStatus(binding) {
  const decision = normalizedReviewDecision(binding);
  const reauthPolicy = typeof binding?.reauthPolicy === 'string' ? binding.reauthPolicy : null;
  const hasCredentialRef = Boolean(binding?.credentialRefs && typeof binding.credentialRefs === 'object' && !Array.isArray(binding.credentialRefs));
  const hasSiteAccountRef = typeof binding?.siteAccountRef === 'string' && Boolean(binding.siteAccountRef.trim());
  const hasProfileIdentityRef = typeof binding?.profileIdentityRef === 'string' && Boolean(binding.profileIdentityRef.trim());
  const downloadPolicy = typeof binding?.downloadPolicy === 'string' ? binding.downloadPolicy : null;
  return {
    declared: Boolean(binding),
    gateway: typeof binding?.gateway === 'string' && binding.gateway.trim() ? binding.gateway : null,
    profileAlias: typeof binding?.profileAlias === 'string' && binding.profileAlias.trim() ? binding.profileAlias : null,
    decision,
    reauthPolicy,
    reauthReady: reauthPolicy === 'bounded-one-attempt' && hasCredentialRef,
    hasCredentialRef,
    hasSiteAccountRef,
    hasProfileIdentityRef,
    downloadPolicy,
  };
}

function bindingPlanNextAction(action) {
  if (action.code === 'ENROLL_CANARY_PROFILE_ALIAS') {
    return { code: action.code, command: 'webmcp bootstrap profile-candidates --json && webmcp bootstrap enroll-alias --gateway local --alias local-auth-fixture --candidate-ordinal <n> --yes --json', note: 'Pick the operator-reviewed redacted candidate ordinal for the local auth fixture profile.' };
  }
  if (action.code === 'ENROLL_PROFILE_BINDING' || action.code === 'APPROVE_PROFILE_BINDING' || action.code === 'ENROLL_BOUNDED_REAUTH_BINDING') {
    return { code: action.code, command: 'webmcp bootstrap enroll-binding --id local-auth-fixture --gateway local --profile-alias local-auth-fixture --decision approved --reauth-policy bounded-one-attempt --credential-purpose-ref <purpose-ref> --site-account-ref <site-account-ref> --download-policy run-staging --yes --json', note: 'Write only reviewed opaque refs; command output and receipt remain redacted.' };
  }
  if (action.code === 'ADD_SITE_ACCOUNT_REF') {
    return { code: action.code, command: 'webmcp bootstrap enroll-binding --id local-auth-fixture --gateway local --profile-alias local-auth-fixture --decision approved --reauth-policy bounded-one-attempt --credential-purpose-ref <purpose-ref> --site-account-ref <site-account-ref> --yes --json', note: 'Add the reviewed site account opaque ref before live account verification.' };
  }
  return { code: action.code, command: 'webmcp bootstrap binding-plan --json', note: 'Review binding readiness.' };
}

function buildBindingPlan() {
  const { config } = readDispatcherConfigForWrite();
  const aliasId = 'local-auth-fixture';
  const bindingId = 'local-auth-fixture';
  const aliasDeclared = declaredProfileAlias(config, aliasId);
  const binding = readBinding(config, bindingId);
  const bindingStatus = redactedBindingStatus(binding);
  const actions = [];
  if (!aliasDeclared) actions.push({ code: 'ENROLL_CANARY_PROFILE_ALIAS', status: 'required' });
  if (!bindingStatus.declared) actions.push({ code: 'ENROLL_PROFILE_BINDING', status: 'required' });
  else {
    if (bindingStatus.decision !== 'approved') actions.push({ code: 'APPROVE_PROFILE_BINDING', status: 'required' });
    if (!bindingStatus.reauthReady) actions.push({ code: 'ENROLL_BOUNDED_REAUTH_BINDING', status: 'required' });
    if (!bindingStatus.hasSiteAccountRef) actions.push({ code: 'ADD_SITE_ACCOUNT_REF', status: 'required' });
  }
  return {
    schema: 'webmcp-bootstrap-binding-plan/1',
    version: 1,
    ok: actions.length === 0,
    redacted: true,
    alias: {
      id: aliasId,
      declared: aliasDeclared,
    },
    binding: {
      id: bindingId,
      ...bindingStatus,
    },
    actions,
    nextActions: actions.map(bindingPlanNextAction),
    next: actions.length
      ? 'Resolve binding actions, then re-run webmcp bootstrap binding-plan --json.'
      : 'Re-run webmcp bootstrap canary --json; canary alias and binding readiness are satisfied.',
  };
}

async function buildBootstrapCanaryReadiness() {
  const doctor = await collectDoctorReport();
  const vault = await collectVaultDoctorReport();
  const bindingSummary = doctor.dispatcher?.profileBindings ?? {};
  const { config: dispatcherConfig } = doctor.dispatcher?.readable ? readDispatcherConfigForWrite() : { config: null };
  const declaredCanaryProfileAlias = Boolean(dispatcherConfig && (
    Object.hasOwn(dispatcherConfig.profiles && typeof dispatcherConfig.profiles === 'object' && !Array.isArray(dispatcherConfig.profiles)
      ? dispatcherConfig.profiles
      : {}, 'local-auth-fixture')
    || Object.values(dispatcherConfig.gateways && typeof dispatcherConfig.gateways === 'object' && !Array.isArray(dispatcherConfig.gateways)
      ? dispatcherConfig.gateways
      : {}).some((gateway) => Object.hasOwn(gateway?.profiles && typeof gateway.profiles === 'object' && !Array.isArray(gateway.profiles)
        ? gateway.profiles
        : {}, 'local-auth-fixture'))
  ));
  const blockers = [];
  if (!doctor.bootstrap.mcpRegistered) blockers.push({ code: 'REGISTER_MCP', status: 'required' });
  if (!doctor.bootstrap.dispatcherConfigured) blockers.push({ code: 'WRITE_DISPATCHER_CONFIG', status: 'required' });
  if (!doctor.bootstrap.skillsReady || !doctor.skills.receiptPresent) blockers.push({ code: 'INSTALL_SKILLS', status: 'required' });
  if (!doctor.bootstrap.gatewayReady) blockers.push({ code: 'START_GATEWAY', status: 'required' });
  if (!doctor.bootstrap.downloadPolicyReady) blockers.push({ code: 'INSTALL_CHROME_POLICY', status: 'required' });
  if (!doctor.bootstrap.roleConfigured) blockers.push({ code: 'SET_NODE_ROLE', status: 'required' });
  if (!doctor.bootstrap.serviceReady) blockers.push({ code: 'INSTALL_ROLE_SERVICES', status: 'required' });
  if (!doctor.bootstrap.tailnetReady) blockers.push({ code: 'CONNECT_TAILNET', status: 'required' });
  if (!vault.available) blockers.push({ code: 'INSTALL_VAULT_CLI', status: 'required' });
  else if (!vault.initialized) blockers.push({ code: 'INITIALIZE_VAULT', status: 'required' });
  else if (!vault.unlocked) blockers.push({ code: 'UNLOCK_VAULT', status: 'required' });
  if (!declaredCanaryProfileAlias) blockers.push({ code: 'ENROLL_CANARY_PROFILE_ALIAS', status: 'required' });
  if ((bindingSummary.count ?? 0) < 1) blockers.push({ code: 'ENROLL_PROFILE_BINDING', status: 'required' });
  if ((bindingSummary.boundedReauth ?? 0) < 1) blockers.push({ code: 'ENROLL_BOUNDED_REAUTH_BINDING', status: 'required' });

  const ok = blockers.length === 0;
  const nextActions = blockers.map((blocker) => {
    if (blocker.code === 'REGISTER_MCP') {
      return { code: blocker.code, command: 'webmcp bootstrap apply --json', note: 'Apply local bootstrap state, then restart Codex so MCP registrations are loaded by the new task.' };
    }
    if (blocker.code === 'WRITE_DISPATCHER_CONFIG') {
      return { code: blocker.code, command: 'webmcp bootstrap apply --json', note: 'Create the local dispatcher/bootstrap roots before enrollment.' };
    }
    if (blocker.code === 'INSTALL_SKILLS') {
      return { code: blocker.code, command: 'webmcp skills adopt --all --yes && webmcp bootstrap apply --json', note: 'Adopt reviewed WebMCP skills, then refresh bootstrap receipt.' };
    }
    if (blocker.code === 'START_GATEWAY') {
      return { code: blocker.code, command: 'webmcp gateway start', note: 'Start the local Gateway before re-running canary readiness.' };
    }
    if (blocker.code === 'INSTALL_CHROME_POLICY') {
      return { code: blocker.code, command: 'webmcp bootstrap plan --json', note: 'Review the OS-specific installer action for managed downloads; policy install may require operator/admin action.' };
    }
    if (blocker.code === 'SET_NODE_ROLE') {
      return { code: blocker.code, command: 'webmcp bootstrap enroll-role --role <operator|runner-node|fleet-node> --yes --json', note: 'Select and persist a reviewed node role before role-specific service install.' };
    }
    if (blocker.code === 'INSTALL_ROLE_SERVICES') {
      return { code: blocker.code, command: 'webmcp bootstrap service-plan --json && webmcp bootstrap service-apply --json', note: 'Render reviewed local service templates before any OS-level service installation.' };
    }
    if (blocker.code === 'CONNECT_TAILNET') {
      return { code: blocker.code, command: 'tailscale status --json && webmcp doctor --json', note: 'Connect the node to the reviewed Tailnet; doctor output remains redacted.' };
    }
    if (blocker.code === 'INSTALL_VAULT_CLI') {
      return { code: blocker.code, command: 'webmcp vault doctor --json', note: 'Confirm Vault Kit availability before credential-bound canaries.' };
    }
    if (blocker.code === 'INITIALIZE_VAULT') {
      return { code: blocker.code, command: 'WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp vault init --json', note: 'Initialize the encrypted local Vault with an operator-private key file.' };
    }
    if (blocker.code === 'UNLOCK_VAULT') {
      return { code: blocker.code, command: 'WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp bootstrap canary --json', note: 'Re-run readiness with the key available; do not paste the key into shared logs.' };
    }
    if (blocker.code === 'ENROLL_CANARY_PROFILE_ALIAS') {
      return { code: blocker.code, command: 'webmcp bootstrap profile-candidates --json && webmcp bootstrap enroll-alias --gateway local --alias local-auth-fixture --candidate-ordinal <n> --yes --json', note: 'Pick the operator-reviewed redacted candidate ordinal for the local auth fixture profile.' };
    }
    if (blocker.code === 'ENROLL_PROFILE_BINDING' || blocker.code === 'ENROLL_BOUNDED_REAUTH_BINDING') {
      return { code: blocker.code, command: 'webmcp bootstrap enroll-binding --id local-auth-fixture --gateway local --profile-alias local-auth-fixture --decision approved --reauth-policy bounded-one-attempt --credential-purpose-ref <purpose-ref> --site-account-ref <site-account-ref> --download-policy run-staging --yes --json', note: 'Write only reviewed opaque refs; command output and receipt remain redacted.' };
    }
    return { code: blocker.code, command: 'webmcp bootstrap plan --json', note: 'Review this blocker before applying changes.' };
  });
  return {
    schema: 'webmcp-bootstrap-canary-readiness/1',
    version: 1,
    ok,
    redacted: true,
    canary: 'local-auth-fixture-reauth-canary',
    readiness: {
      mcpRegistered: doctor.bootstrap.mcpRegistered,
      dispatcherConfigured: doctor.bootstrap.dispatcherConfigured,
      downloadPolicyReady: doctor.bootstrap.downloadPolicyReady,
      skillsReady: doctor.bootstrap.skillsReady,
      gatewayReady: doctor.bootstrap.gatewayReady,
      roleConfigured: doctor.bootstrap.roleConfigured,
      serviceReady: doctor.bootstrap.serviceReady,
      tailnetReady: doctor.bootstrap.tailnetReady,
      vaultInitialized: vault.initialized,
      vaultUnlocked: vault.unlocked,
      canaryProfileAliasDeclared: declaredCanaryProfileAlias,
      profileBindings: bindingSummary.count ?? 0,
      boundedReauthBindings: bindingSummary.boundedReauth ?? 0,
    },
    vault: {
      available: vault.available,
      initialized: vault.initialized,
      unlocked: vault.unlocked,
      key: vault.key ?? null,
    },
    blockers,
    nextActions,
    next: ok
      ? 'Run the Store-owned canary through Fleet/Controller from a task with WebMCP MCP tools attached.'
      : 'Resolve blockers, then re-run webmcp bootstrap canary --json before a live browser canary.',
  };
}

async function buildVaultKeyPlan() {
  const vault = await collectVaultDoctorReport();
  const actions = [];
  if (!vault.available) actions.push({ code: 'INSTALL_VAULT_CLI', status: 'required' });
  else if (!vault.initialized) actions.push({ code: 'INITIALIZE_VAULT', status: 'required' });
  if (vault.available && !vault.key?.available) actions.push({ code: 'CONFIGURE_VAULT_KEY_FILE', status: 'required' });
  if (vault.available && vault.key?.available && !vault.unlocked) actions.push({ code: 'FIX_VAULT_KEY', status: 'required' });
  if (vault.key?.conflict) actions.push({ code: 'REMOVE_VAULT_KEY_CONFLICT', status: 'required' });
  const nextActions = actions.map((action) => {
    if (action.code === 'INSTALL_VAULT_CLI') {
      return { code: action.code, command: 'webmcp vault doctor --json', note: 'Install or expose the WebMCP Vault CLI before credential-bound canaries.' };
    }
    if (action.code === 'INITIALIZE_VAULT') {
      return { code: action.code, command: 'WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp vault init --json', note: 'Initialize the local encrypted Vault with an operator-private key file.' };
    }
    if (action.code === 'CONFIGURE_VAULT_KEY_FILE') {
      return { code: action.code, command: 'WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp bootstrap vault-key-plan --json', note: 'Use a private key file; do not paste the key into shared command logs.' };
    }
    if (action.code === 'FIX_VAULT_KEY') {
      return { code: action.code, command: 'WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp vault doctor --json', note: 'The configured key is present but did not unlock the initialized Vault.' };
    }
    if (action.code === 'REMOVE_VAULT_KEY_CONFLICT') {
      return { code: action.code, command: 'unset WEBMCP_VAULT_KEY; WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp bootstrap vault-key-plan --json', note: 'Use exactly one Vault key source for deterministic unattended runs.' };
    }
    return { code: action.code, command: 'webmcp bootstrap vault-key-plan --json', note: 'Review Vault key-provider readiness.' };
  });
  return {
    schema: 'webmcp-bootstrap-vault-key-plan/1',
    version: 1,
    ok: vault.available === true && vault.initialized === true && vault.unlocked === true && vault.key?.conflict !== true,
    redacted: true,
    vault: {
      available: vault.available,
      initialized: vault.initialized,
      unlocked: vault.unlocked,
      key: vault.key ?? null,
    },
    actions,
    nextActions,
    next: actions.length
      ? 'Resolve Vault key-provider actions, then re-run webmcp bootstrap vault-key-plan --json.'
      : 'Re-run webmcp bootstrap canary --json; Vault key-provider readiness is satisfied.',
  };
}

function buildBindingEnrollment(args) {
  const { flags } = parseFlags(args);
  const id = safeBootstrapId(flags.id, 'id');
  const gateway = safeBootstrapId(flags.gateway, 'gateway');
  const profileAlias = safeBootstrapId(flags['profile-alias'], 'profile-alias');
  const decision = flags.decision ?? 'pending';
  if (!BOOTSTRAP_BINDING_DECISIONS.has(decision)) {
    throw new Error('decision must be approved, pending, or rejected');
  }
  const reauthPolicy = flags['reauth-policy'] ?? 'manual';
  if (!BOOTSTRAP_REAUTH_POLICIES.has(reauthPolicy)) {
    throw new Error('reauth-policy must be manual, disabled, or bounded-one-attempt');
  }
  const credentialPurposeRef = maybeSafeBootstrapId(flags['credential-purpose-ref'], 'credential-purpose-ref');
  const siteAccountRef = maybeSafeBootstrapId(flags['site-account-ref'], 'site-account-ref');
  const profileIdentityRef = maybeSafeBootstrapId(flags['profile-identity-ref'], 'profile-identity-ref');
  const downloadPolicy = flags['download-policy'] ?? null;
  if (downloadPolicy !== null && !['manual', 'run-staging'].includes(downloadPolicy)) {
    throw new Error('download-policy must be manual or run-staging');
  }
  const apply = Boolean(flags.yes);
  const { file, config } = readDispatcherConfigForWrite();
  const gateways = config.gateways && typeof config.gateways === 'object' && !Array.isArray(config.gateways)
    ? config.gateways
    : {};
  if (!gateways[gateway]) throw new Error(`gateway ${gateway} is not declared`);
  const gatewayProfiles = gateways[gateway]?.profiles && typeof gateways[gateway].profiles === 'object' && !Array.isArray(gateways[gateway].profiles)
    ? gateways[gateway].profiles
    : {};
  const topProfiles = config.profiles && typeof config.profiles === 'object' && !Array.isArray(config.profiles)
    ? config.profiles
    : {};
  if (!Object.hasOwn(gatewayProfiles, profileAlias) && !Object.hasOwn(topProfiles, profileAlias)) {
    throw new Error(`profile alias ${profileAlias} is not declared`);
  }

  const binding = {
    gateway,
    profileAlias,
    decision,
    reauthPolicy,
  };
  if (downloadPolicy) binding.downloadPolicy = downloadPolicy;
  if (credentialPurposeRef) binding.credentialRefs = { login: credentialPurposeRef };
  if (siteAccountRef) binding.siteAccountRef = siteAccountRef;
  if (profileIdentityRef) binding.profileIdentityRef = profileIdentityRef;

  let receipt = null;
  if (apply) {
    const next = {
      ...config,
      profileBindings: {
        ...(config.profileBindings && typeof config.profileBindings === 'object' && !Array.isArray(config.profileBindings)
          ? config.profileBindings
          : {}),
        [id]: binding,
      },
    };
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    receipt = writeBootstrapEnrollmentReceipt('binding', id, {
      id,
      gateway,
      profileAlias,
      decision,
      reauthPolicy,
      reauthReady: reauthPolicy !== 'manual' && reauthPolicy !== 'disabled' && Boolean(credentialPurposeRef),
      hasCredentialRef: Boolean(credentialPurposeRef),
      hasSiteAccountRef: Boolean(siteAccountRef),
      hasProfileIdentityRef: Boolean(profileIdentityRef),
      downloadPolicy: downloadPolicy || null,
    });
  }

  return {
    schema: 'webmcp-bootstrap-binding-enrollment/1',
    version: 1,
    applied: apply,
    redacted: true,
    dispatcherConfigured: true,
    binding: {
      id,
      gateway,
      profileAlias,
      decision,
      reauthReady: reauthPolicy !== 'manual' && reauthPolicy !== 'disabled' && Boolean(credentialPurposeRef),
      hasCredentialRef: Boolean(credentialPurposeRef),
      hasSiteAccountRef: Boolean(siteAccountRef),
      hasProfileIdentityRef: Boolean(profileIdentityRef),
      downloadPolicy: downloadPolicy || null,
    },
    receipt,
    next: apply
      ? 'Re-run webmcp bootstrap canary --json to verify the binding blockers.'
      : 'Re-run with --yes to write the reviewed profile binding metadata.',
  };
}

function buildAliasEnrollment(args) {
  const { flags } = parseFlags(args);
  const gateway = safeBootstrapId(flags.gateway, 'gateway');
  const alias = safeBootstrapId(flags.alias, 'alias');
  const candidateOrdinal = flags['candidate-ordinal'] === undefined ? null : Number(flags['candidate-ordinal']);
  if (candidateOrdinal !== null && (!Number.isInteger(candidateOrdinal) || candidateOrdinal < 1 || candidateOrdinal > 999)) {
    throw new Error('candidate-ordinal must be a positive integer');
  }
  if (flags['profile-id'] && candidateOrdinal !== null) {
    throw new Error('use either profile-id or candidate-ordinal, not both');
  }
  let profileId = flags['profile-id'] ? safeBootstrapProfileId(flags['profile-id'], 'profile-id') : null;
  if (!profileId && candidateOrdinal !== null) {
    const { listAllProfiles } = getChromeLauncher();
    const profiles = listAllProfiles();
    const candidates = [...(profiles.managed || []), ...(profiles.existing || [])];
    const candidate = candidates[candidateOrdinal - 1];
    if (!candidate?.id) throw new Error(`candidate ordinal ${candidateOrdinal} is not available`);
    profileId = safeBootstrapProfileId(candidate.id, 'candidate profile id');
  }
  if (!profileId) throw new Error('profile-id or candidate-ordinal is required');
  const apply = Boolean(flags.yes);
  const { file, config } = readDispatcherConfigForWrite();
  const gateways = config.gateways && typeof config.gateways === 'object' && !Array.isArray(config.gateways)
    ? config.gateways
    : {};
  if (!gateways[gateway]) throw new Error(`gateway ${gateway} is not declared`);
  const gatewayConfig = gateways[gateway] && typeof gateways[gateway] === 'object' && !Array.isArray(gateways[gateway])
    ? gateways[gateway]
    : {};
  const profiles = gatewayConfig.profiles && typeof gatewayConfig.profiles === 'object' && !Array.isArray(gatewayConfig.profiles)
    ? gatewayConfig.profiles
    : {};

  let receipt = null;
  if (apply) {
    const next = {
      ...config,
      gateways: {
        ...gateways,
        [gateway]: {
          ...gatewayConfig,
          profiles: {
            ...profiles,
            [alias]: profileId,
          },
        },
      },
    };
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    receipt = writeBootstrapEnrollmentReceipt('alias', alias, {
      id: alias,
      gateway,
      candidateOrdinal,
      profileIdProvided: true,
      alreadyPresent: Object.hasOwn(profiles, alias),
    });
  }

  return {
    schema: 'webmcp-bootstrap-alias-enrollment/1',
    version: 1,
    applied: apply,
    redacted: true,
    alias: {
      id: alias,
      gateway,
      profileIdProvided: true,
      candidateOrdinal,
      alreadyPresent: Object.hasOwn(profiles, alias),
    },
    receipt,
    next: apply
      ? 'Re-run webmcp bootstrap canary --json, then enroll reviewed binding metadata if needed.'
      : 'Re-run with --yes to write the reviewed logical profile alias.',
  };
}

function buildProfileCandidates() {
  const { listAllProfiles } = getChromeLauncher();
  const profiles = listAllProfiles();
  const candidates = [];
  let ordinal = 1;
  for (const kind of ['managed', 'existing']) {
    const entries = Array.isArray(profiles[kind]) ? profiles[kind] : [];
    for (const profile of entries) {
      candidates.push({
        ordinal,
        kind,
        displayName: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : `${kind} profile ${ordinal}`,
        hasEmail: typeof profile.email === 'string' && Boolean(profile.email.trim()),
      });
      ordinal += 1;
    }
  }
  return {
    schema: 'webmcp-bootstrap-profile-candidates/1',
    version: 1,
    redacted: true,
    counts: {
      managed: Array.isArray(profiles.managed) ? profiles.managed.length : 0,
      existing: Array.isArray(profiles.existing) ? profiles.existing.length : 0,
      total: candidates.length,
    },
    candidates,
    next: 'Use bootstrap enroll-alias --candidate-ordinal <n> --yes for the reviewed candidate, or webmcp profiles list --json only in an operator-private terminal if an exact physical profile ID is required.',
  };
}

function buildRoleEnrollment(args) {
  const { flags } = parseFlags(args);
  const role = safeBootstrapId(flags.role, 'role');
  if (!BOOTSTRAP_NODE_ROLES.has(role)) {
    throw new Error('role must be operator, runner-node, or fleet-node');
  }
  const apply = Boolean(flags.yes);
  const serviceIds = expectedServiceIdsForRole(role);
  let receipt = null;
  if (apply) {
    const file = machineRoleConfigPath();
    const config = {
      schema: 'webmcp-machine-role-config/1',
      version: 1,
      role,
      serviceIds,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(file), 0o700); } catch { /* best effort */ }
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    receipt = writeBootstrapEnrollmentReceipt('role', role, {
      role,
      serviceCount: serviceIds.length,
    });
  }
  return {
    schema: 'webmcp-bootstrap-role-enrollment/1',
    version: 1,
    applied: apply,
    redacted: true,
    role: {
      role,
      serviceIds,
    },
    receipt,
    next: apply
      ? 'Re-run webmcp bootstrap plan --json to verify role readiness and review required services.'
      : 'Re-run with --yes to write the reviewed machine role config.',
  };
}

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

function buildServicePlan({ apply = false } = {}) {
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

function buildServiceInstallPlan({ apply = false } = {}) {
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

function buildServiceLoadPlan({ apply = false } = {}) {
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

async function buildTailnetPlan({ apply = false } = {}) {
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

async function runBootstrap(args) {
  const [subcommand = 'plan'] = args.filter((arg) => !arg.startsWith('--'));
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h') || subcommand === 'help') {
    printBootstrapHelp();
    return 0;
  }
  if (!['plan', 'apply', 'canary', 'vault-key-plan', 'binding-plan', 'tailnet-plan', 'tailnet-apply', 'profile-candidates', 'enroll-role', 'service-plan', 'service-apply', 'service-install-plan', 'service-install', 'service-load-plan', 'service-load', 'enroll-alias', 'enroll-binding'].includes(subcommand)) {
    console.error('Usage: webmcp bootstrap plan|apply|canary|vault-key-plan|binding-plan|tailnet-plan|tailnet-apply|profile-candidates|enroll-role|service-plan|service-apply|service-install-plan|service-install|service-load-plan|service-load|enroll-alias|enroll-binding [--json]');
    return 2;
  }
  if (subcommand === 'canary') {
    const readiness = await buildBootstrapCanaryReadiness();
    if (json) console.log(JSON.stringify(readiness, null, 2));
    else {
      console.log(`WebMCP bootstrap canary: ${readiness.ok ? 'ready' : 'blocked'}`);
      console.log(`  Readiness: gateway=${readiness.readiness.gatewayReady ? 'ready' : 'missing'}, vault=${readiness.readiness.vaultUnlocked ? 'unlocked' : 'locked'}`);
      if (readiness.blockers.length) {
        console.log(`  Blockers: ${readiness.blockers.map((item) => item.code).join(', ')}`);
      }
    }
    return readiness.ok ? 0 : 1;
  }
  if (subcommand === 'vault-key-plan') {
    const plan = await buildVaultKeyPlan();
    if (json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`WebMCP bootstrap vault-key-plan: ${plan.ok ? 'ready' : 'blocked'}`);
      if (plan.actions.length) console.log(`  Actions: ${plan.actions.map((item) => item.code).join(', ')}`);
      console.log(`  Next: ${plan.next}`);
    }
    return plan.ok ? 0 : 1;
  }
  if (subcommand === 'binding-plan') {
    try {
      const plan = buildBindingPlan();
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`WebMCP bootstrap binding-plan: ${plan.ok ? 'ready' : 'blocked'}`);
        if (plan.actions.length) console.log(`  Actions: ${plan.actions.map((item) => item.code).join(', ')}`);
        console.log(`  Next: ${plan.next}`);
      }
      return plan.ok ? 0 : 1;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-binding-plan/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'tailnet-plan' || subcommand === 'tailnet-apply') {
    try {
      const plan = await buildTailnetPlan({ apply: subcommand === 'tailnet-apply' && args.includes('--yes') });
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`WebMCP bootstrap ${subcommand}: ${plan.ok ? 'ready' : 'blocked'}`);
        if (plan.actions.length) console.log(`  Actions: ${plan.actions.map((item) => item.code).join(', ')}`);
        console.log(`  Next: ${plan.next}`);
      }
      return plan.ok ? 0 : 1;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-tailnet-plan/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'profile-candidates') {
    const candidates = buildProfileCandidates();
    if (json) console.log(JSON.stringify(candidates, null, 2));
    else {
      console.log(`WebMCP bootstrap profile candidates: ${candidates.counts.total}`);
      for (const candidate of candidates.candidates) {
        console.log(`  ${candidate.ordinal}. ${candidate.kind}: ${candidate.displayName}${candidate.hasEmail ? ' (email present)' : ''}`);
      }
    }
    return 0;
  }
  if (subcommand === 'enroll-role') {
    try {
      const enrollment = buildRoleEnrollment(args);
      if (json) console.log(JSON.stringify(enrollment, null, 2));
      else {
        console.log(`WebMCP bootstrap enroll-role: ${enrollment.applied ? 'applied' : 'dry-run'}`);
        console.log(`  Role: ${enrollment.role.role}`);
        console.log(`  Next: ${enrollment.next}`);
      }
      return 0;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-role-enrollment/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'service-plan' || subcommand === 'service-apply') {
    try {
      const plan = buildServicePlan({ apply: subcommand === 'service-apply' });
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`WebMCP bootstrap ${subcommand}: ${plan.applied ? 'rendered' : 'planned'} ${plan.services.length} service template(s)`);
        console.log(`  Role: ${plan.role}`);
        console.log(`  Next: ${plan.next}`);
      }
      return 0;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-service-plan/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'service-install-plan' || subcommand === 'service-install') {
    try {
      const plan = buildServiceInstallPlan({ apply: subcommand === 'service-install' && args.includes('--yes') });
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`WebMCP bootstrap ${subcommand}: ${plan.applied ? 'installed' : 'planned'} ${plan.services.length} user service file(s)`);
        console.log(`  Role: ${plan.role}`);
        console.log(`  Next: ${plan.next}`);
      }
      return 0;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-service-install-plan/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'service-load-plan' || subcommand === 'service-load') {
    try {
      const plan = buildServiceLoadPlan({ apply: subcommand === 'service-load' && args.includes('--yes') });
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`WebMCP bootstrap ${subcommand}: ${plan.applied ? 'loaded' : 'planned'} ${plan.services.length} user service(s)`);
        console.log(`  Role: ${plan.role}`);
        console.log(`  Next: ${plan.next}`);
      }
      return 0;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-service-load-plan/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'enroll-alias') {
    try {
      const enrollment = buildAliasEnrollment(args.slice(1));
      if (json) console.log(JSON.stringify(enrollment, null, 2));
      else {
        console.log(`WebMCP bootstrap enroll-alias: ${enrollment.applied ? 'applied' : 'dry-run'}`);
        console.log(`  Alias: ${enrollment.alias.id} on ${enrollment.alias.gateway}`);
      }
      return 0;
    } catch (error) {
      const message = error?.message || String(error);
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-alias-enrollment/1',
          version: 1,
          applied: false,
          redacted: true,
          ok: false,
          error: message,
        }, null, 2));
      } else {
        console.error(message);
      }
      return 1;
    }
  }
  if (subcommand === 'enroll-binding') {
    try {
      const enrollment = buildBindingEnrollment(args.slice(1));
      if (json) console.log(JSON.stringify(enrollment, null, 2));
      else {
        console.log(`WebMCP bootstrap enroll-binding: ${enrollment.applied ? 'applied' : 'dry-run'}`);
        console.log(`  Binding: ${enrollment.binding.id} -> ${enrollment.binding.gateway}/${enrollment.binding.profileAlias}`);
        console.log(`  Reauth: ${enrollment.binding.reauthReady ? 'bounded' : 'not ready'}`);
      }
      return 0;
    } catch (error) {
      const message = error?.message || String(error);
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-binding-enrollment/1',
          version: 1,
          applied: false,
          redacted: true,
          ok: false,
          error: message,
        }, null, 2));
      } else {
        console.error(message);
      }
      return 1;
    }
  }
  const plan = await buildBootstrapPlan({ apply: subcommand === 'apply' });
  if (json) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(`WebMCP bootstrap ${plan.mode}: ${plan.applied ? 'applied safe local state' : 'planned safe local state'}`);
    console.log(`  Readiness: ${plan.readiness.ok ? 'ready' : 'needs operator action'}`);
    console.log(`  Mutations: ${plan.mutations.map((item) => `${item.target}:${item.status}`).join(', ')}`);
    if (plan.operatorActions.length) {
      console.log(`  Operator actions: ${plan.operatorActions.map((item) => item.code).join(', ')}`);
    }
  }
  return 0;
}

function buildSkillsDoctorReport() {
  const inventory = readSkillInventory();
  if (!inventory) {
    return {
      schema: 'webmcp-skills-doctor/1',
      ok: false,
      inventory: null,
      total: 0,
      available: 0,
      missing: [],
      receipt: skillsReceiptPath(),
      receiptPresent: Boolean(readSkillsReceipt()),
      orphanCandidates: [],
      error: 'WebMCP skill inventory not found.',
    };
  }
  const receipt = readSkillsReceipt();
  const kitId = process.env.WEBMCP_KIT_ID || inventory.kitId || 'webmcp-automation-kit';
  const mode = resolveSkillsMode(receiptOwner(receipt, kitId));
  const expected = doctorSkillNames(inventory, receipt, mode);
  const skills = skillReport(inventory);
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
  return {
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

// The workspace/registry runtime lives in the independent
// @gyga-browser/webmcp-automation-runner package. The `webmcp project` umbrella
// command is a thin bridge onto its `workspace *` surface so users never need
// to call the runner binary directly for day-to-day project operations.
function getRunnerBin() {
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

function runRunnerBin() {
  const runnerBin = getRunnerBin();
  if (!runnerBin || !existsSync(runnerBin)) {
    console.error([
      'WebMCP Automation Runner CLI not found.',
      'Install @gyga-browser/webmcp-automation-runner, run from the webmcp-automation-kit checkout, or set WEBMCP_RUNNER_BIN.',
    ].join('\n'));
    return null;
  }
  return runnerBin;
}

async function runRunner(args) {
  const runnerBin = runRunnerBin();
  if (!runnerBin) return 1;

  const runnerArgs = args.length > 0 ? args : ['--help'];
  const child = spawn(process.execPath, [runnerBin, ...runnerArgs], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: 'inherit',
  });

  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start Automation Runner CLI: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`Automation Runner CLI exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}

function runRunnerSync(args) {
  const runnerBin = runRunnerBin();
  if (!runnerBin) return { status: 1, stdout: '', stderr: '' };
  return spawnSync(process.execPath, [runnerBin, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function projectOption(args, name) {
  const prefix = `--${name}`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === prefix) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) return null;
      return value;
    }
    if (arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1);
  }
  return null;
}

function withoutProjectOptions(args, names) {
  const prefixes = names.map((name) => `--${name}`);
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const match = prefixes.find((prefix) => arg === prefix);
    if (match) {
      if (args[index + 1] !== undefined && !args[index + 1].startsWith('--')) index += 1;
      continue;
    }
    if (prefixes.some((prefix) => arg.startsWith(`${prefix}=`))) continue;
    rest.push(arg);
  }
  return rest;
}

function resolvedProjectRoot() {
  const listed = runRunnerSync(['workspace', 'list', '--json']);
  if (listed.status !== 0) {
    process.stdout.write(listed.stdout);
    process.stderr.write(listed.stderr);
    return null;
  }
  const registry = JSON.parse(listed.stdout).data;
  return registry.workspaces.find((item) => item.id === registry.defaultWorkspaceId) || null;
}

async function runProjectAttach(args) {
  const rest = [];
  let dir = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--scan') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        rest.push('--scan');
      } else {
        rest.push('--scan', value);
        index += 1;
      }
    } else if (!arg.startsWith('--')) {
      dir = arg;
    } else {
      rest.push(arg);
    }
  }
  if (!dir && !rest.includes('--scan')) {
    console.error('Usage: webmcp project attach <dir> [--replace] [--as-copy <id>] [--repair-layout] [--default] [--dry-run] [--json]');
    console.error('       webmcp project attach --scan <root> [--replace] [--repair-layout] [--default] [--dry-run] [--json]');
    return 2;
  }
  if (dir) return runRunner(['workspace', 'attach', '--workspace', dir, ...rest]);
  return runRunner(['workspace', 'attach', ...rest]);
}

async function runProjectWhere(args) {
  const id = args.find((arg) => !arg.startsWith('--'));
  if (id) return runRunner(['workspace', 'describe', id, ...args]);
  const entry = resolvedProjectRoot();
  if (!entry) {
    console.error('No default project is registered. Register one with: webmcp project attach <dir> --default');
    return 1;
  }
  return runRunner(['workspace', 'describe', entry.id, ...args]);
}

async function runProjectDoctor(args) {
  let root = args.find((arg) => !arg.startsWith('--'));
  if (!root) {
    const entry = resolvedProjectRoot();
    if (!entry) {
      console.error('No default project is registered. Register one with: webmcp project attach <dir> --default');
      return 1;
    }
    root = entry.root;
  }
  const json = args.includes('--json');
  const chain = [
    ['workspace', 'doctor', '--workspace', root, ...(json ? ['--json'] : [])],
    ['workspace', 'registry', 'audit', '--workspace-root', root, ...(json ? ['--json'] : [])],
    ['workspace', 'attach', '--workspace', root, '--dry-run', ...(json ? ['--json'] : [])],
  ];
  for (const runnerArgs of chain) {
    const exitCode = await runRunner(runnerArgs);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

async function runProjectNew(args) {
  const at = projectOption(args, 'at');
  const template = projectOption(args, 'template');
  if (args.includes('--template') && !template) {
    console.error('--template requires a value');
    return 2;
  }
  const flags = [];
  for (const flag of ['--default', '--dry-run', '--json']) {
    if (args.includes(flag)) flags.push(flag);
  }
  const id = projectOption(args, 'id');
  const name = projectOption(args, 'name');
  if (template) {
    const argv = ['workspace', 'project-new', '--template', template];
    if (at) argv.push('--at', at);
    if (id) argv.push('--id', id);
    if (name) argv.push('--name', name);
    argv.push(...flags);
    for (const extra of withoutProjectOptions(args, ['at', 'template', 'id', 'name'])) {
      if (!extra.startsWith('--') || ['--default', '--dry-run', '--json'].includes(extra)) continue;
      console.error(`Unknown project new option: ${extra}`);
      return 2;
    }
    return runRunner(argv);
  }
  if (!at) {
    console.error('Usage: webmcp project new [--template <id>] [--at <dir>] [--id <id>] [--name <name>] [--default] [--dry-run] [--json]');
    return 2;
  }
  const argv = ['workspace', 'bootstrap', '--workspace-root', at];
  argv.push('--all');
  if (id) argv.push('--project-id', id);
  if (name) argv.push('--project-name', name);
  argv.push(...flags);
  for (const extra of withoutProjectOptions(args, ['at', 'template', 'id', 'name'])) {
    if (!extra.startsWith('--') || ['--default', '--dry-run', '--json'].includes(extra)) continue;
    console.error(`Unknown project new option: ${extra}`);
    return 2;
  }
  return runRunner(argv);
}

async function runProjectCharter(args) {
  const [subcommand, ...rest] = args;
  const usage = 'Usage: webmcp project charter adopt <relative-md> [--workspace <dir>] [--yes] [--json]';
  if (subcommand !== 'adopt') {
    console.error(usage);
    return 2;
  }
  let relativeFile = null;
  let workspace = null;
  let workspaceSpecified = false;
  let yes = false;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--workspace') {
      const value = rest[index + 1];
      if (workspaceSpecified || value === undefined || value.startsWith('--') || value.trim() === '') {
        console.error(usage);
        return 2;
      }
      workspace = value;
      workspaceSpecified = true;
      index += 1;
      continue;
    }
    if (arg === '--yes') {
      if (yes) {
        console.error(usage);
        return 2;
      }
      yes = true;
      continue;
    }
    if (arg === '--json') {
      if (json) {
        console.error(usage);
        return 2;
      }
      json = true;
      continue;
    }
    if (arg.startsWith('--') || relativeFile) {
      console.error(usage);
      return 2;
    }
    relativeFile = arg;
  }
  if (!relativeFile) {
    console.error(usage);
    return 2;
  }
  const root = workspaceSpecified ? workspace : resolvedProjectRoot()?.root;
  if (!root) {
    console.error('No default project is registered. Register one with: webmcp project attach <dir> --default');
    return 1;
  }
  return runRunner([
    'workspace', 'charter', 'adopt', relativeFile, '--workspace', root,
    ...(yes ? ['--yes'] : []),
    ...(json ? ['--json'] : []),
  ]);
}

function projectGuideTarget(rest) {
  const explicit = projectOption(rest, 'workspace');
  if (explicit) {
    return { root: explicit, flags: rest.filter((arg) => arg.startsWith('--') && !arg.startsWith('--workspace')) };
  }
  const entry = resolvedProjectRoot();
  if (!entry) {
    return { error: 'No default project is registered. Register one with: webmcp project attach <dir> --default' };
  }
  return { root: entry.root, flags: rest.filter((arg) => arg.startsWith('--')) };
}

async function runProjectGuide(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    console.error('Usage: webmcp project guide list [--json]');
    console.error('       webmcp project guide stage <collections/<id>/GUIDE.md> --as inputs/<path> --yes [--json]');
    return subcommand && subcommand !== 'help' ? 2 : 0;
  }
  const target = projectGuideTarget(rest);
  if (target.error) {
    console.error(target.error);
    return 1;
  }
  if (subcommand === 'list') {
    return runRunner(['workspace', 'guide', 'list', '--workspace', target.root, ...target.flags]);
  }
  if (subcommand === 'stage') {
    const source = rest.find((arg) => !arg.startsWith('--'));
    const as = projectOption(rest, 'as');
    if (!source || !as) {
      console.error('Usage: webmcp project guide stage <collections/<id>/GUIDE.md> --as inputs/<path> --yes [--json]');
      return 2;
    }
    const flags = target.flags.filter((arg) => !arg.startsWith('--as'));
    return runRunner(['workspace', 'guide', 'stage', source, '--workspace', target.root, '--as', as, ...flags]);
  }
  console.error(`Unknown project guide command: ${subcommand}`);
  printProjectHelp();
  return 2;
}

// The optional <id> of `project schedule plan|apply` is a bare positional, so it
// cannot be found with a plain "first token that is not a flag": the VALUE of
// `--workspace <path>` / `--target <t>` is bare too and would be picked instead
// (`plan --workspace . --target x` used to fail with "Schedule not found: .").
// Walk the argv and skip each value-taking flag together with its value.
const SCHEDULE_VALUE_FLAGS = new Set(['--workspace', '--target']);

function scheduleIdArgument(rest) {
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (SCHEDULE_VALUE_FLAGS.has(arg)) {
      index += 1; // consume the flag's value
      continue;
    }
    if (arg.startsWith('--')) continue; // `--flag=value` and boolean flags
    return arg;
  }
  return undefined;
}

async function runProjectSchedule(args) {
  const [subcommand, ...rest] = args;
  const usage = [
    'Usage: webmcp project schedule list [--workspace <path>] [--json]',
    '       webmcp project schedule plan [<id>] --target <t> [--workspace <path>] [--json]',
    '       webmcp project schedule apply [<id>] --target <t> [--workspace <path>] [--json]',
    '       webmcp project schedule status [--all-targets] [--workspace <path>] [--json]',
  ].join('\n');

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    console.error(usage);
    return subcommand && subcommand !== 'help' ? 2 : 0;
  }

  const workspaceOpt = projectOption(rest, 'workspace');
  let workspaceRoot = workspaceOpt ? resolve(process.cwd(), workspaceOpt) : null;
  let workspaceFromRegistry = false;
  if (!workspaceRoot) {
    const entry = resolvedProjectRoot();
    if (entry?.root) {
      workspaceRoot = resolve(entry.root);
      workspaceFromRegistry = resolve(entry.root) !== resolve(process.cwd());
    } else {
      workspaceRoot = process.cwd();
    }
  }

  // `apply` writes provider state. Without --workspace the root comes from the
  // registry's default project, which is frequently NOT the directory the
  // operator is standing in — applying there would arm a schedule in the wrong
  // project. Read-only verbs may keep the registry default.
  if (subcommand === 'apply' && workspaceFromRegistry) {
    console.error(`Refusing to apply: --workspace was not given, so the project resolved from the registry to ${workspaceRoot}, which is not the current directory (${process.cwd()}).`);
    console.error(`Re-run with the project stated explicitly, e.g. webmcp project schedule apply <id> --workspace ${process.cwd()} --target <t>`);
    return 2;
  }

  const manifestPath = join(workspaceRoot, 'webmcp.project.json');
  if (!existsSync(manifestPath)) {
    console.error(`No project workspace found at ${workspaceRoot} (missing webmcp.project.json)`);
    return 1;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`Invalid project manifest at ${manifestPath}: ${err.message}`);
    return 1;
  }

  const automationBin = getAutomationBin();
  const automationStoreRoot = automationBin ? resolve(dirname(automationBin), '..') : resolve(ROOT, '..', '..', 'stores', 'webmcp-automation-store');
  const scheduleLibPath = join(automationStoreRoot, 'lib', 'schedule.mjs');
  if (!existsSync(scheduleLibPath)) {
    console.error(`schedule.mjs not found at ${scheduleLibPath}`);
    return 1;
  }

  const scheduleMod = await import(pathToFileURL(scheduleLibPath).href);
  const json = rest.includes('--json');
  const target = projectOption(rest, 'target');
  const allTargets = rest.includes('--all-targets');

  // Discover schedules in project
  const projectSchedules = scheduleMod.discoverProjectSchedules(workspaceRoot);

  // Two-tier resolution is the runner's contract, not something to reimplement:
  // `resolveAutomation` validates each candidate (a project pack that exists but
  // lacks an entrypoint raises PROJECT_ASSET_INVALID instead of silently
  // shadowing the community copy) and owns the domain/id parsing rules.
  const runnerBinForResolve = getRunnerBin();
  const runnerRoot = runnerBinForResolve ? resolve(dirname(runnerBinForResolve), '..') : null;
  if (!runnerRoot || !existsSync(join(runnerRoot, 'src', 'store-resolver.mjs'))) {
    console.error('webmcp-automation-runner not found; cannot resolve automations for project schedules.');
    return 1;
  }
  const resolverMod = await import(pathToFileURL(join(runnerRoot, 'src', 'store-resolver.mjs')).href);
  const projectContextMod = await import(pathToFileURL(join(runnerRoot, 'src', 'workspace', 'project-context.mjs')).href);
  const projectContext = projectContextMod.resolveProjectContext(workspaceRoot);

  function resolvePackContext(scheduleRecord) {
    const schedule = scheduleRecord.schedule;
    const automationId = schedule?.task?.automationId;
    const domain = schedule?.task?.domain;
    if (!domain || !automationId) {
      throw new Error(`Schedule ${schedule?.id || scheduleRecord.file} is missing task.domain or task.automationId`);
    }
    const resolved = resolverMod.resolveAutomation({ domain, id: automationId }, projectContext, automationStoreRoot);
    const automationRoot = resolved.source === 'project' ? workspaceRoot : automationStoreRoot;
    return {
      automationRoot,
      automationDir: resolve(automationRoot, resolved.sourceRelativePath),
      source: resolved.source,
      domain,
      automationId,
    };
  }

  if (subcommand === 'list') {
    if (json) {
      console.log(JSON.stringify({
        schema: 'webmcp.project-schedules/1',
        projectId: manifest.id,
        workspaceRoot,
        schedules: projectSchedules,
      }, null, 2));
      return 0;
    }
    if (projectSchedules.length === 0) {
      console.log(`No schedules found in ${join(workspaceRoot, 'schedules')}`);
      return 0;
    }
    console.log(`\nProject Schedules for ${manifest.name || manifest.id} (${workspaceRoot}):\n`);
    for (const item of projectSchedules) {
      const s = item.schedule;
      if (!item.ok) {
        console.log(`  ✗ ${item.relativeFile}: ${item.errors.join('; ')}`);
        continue;
      }
      const triggerStr = s.trigger.type === 'cron' ? `cron(${s.trigger.expression})` : `${s.trigger.type}(${s.trigger.at || s.trigger.fireAt || ''})`;
      const statusStr = s.enabled ? '\x1b[32menabled\x1b[0m' : '\x1b[33mdisabled\x1b[0m';
      console.log(`  • \x1b[1m${s.id}\x1b[0m [${statusStr}] — ${s.description}`);
      console.log(`    Task: ${s.task.domain}/${s.task.automationId} (${s.task.type})`);
      console.log(`    Trigger: ${triggerStr}`);
      console.log(`    Targets: ${s.targets.join(', ')}`);
      console.log(`    File: ${item.relativeFile}`);
      console.log();
    }
    return 0;
  }

  if (subcommand === 'plan') {
    if (!target) {
      console.error('Missing required option: --target <target>');
      console.error(usage);
      return 2;
    }
    const scheduleId = scheduleIdArgument(rest);
    const targets = scheduleId
      ? projectSchedules.filter((item) => item.id === scheduleId)
      : projectSchedules;

    if (targets.length === 0) {
      console.error(scheduleId ? `Schedule not found: ${scheduleId}` : 'No schedules found to plan.');
      return 1;
    }

    const plans = [];
    for (const item of targets) {
      if (!item.ok) {
        console.error(`Invalid schedule ${item.relativeFile}: ${item.errors.join('; ')}`);
        return 1;
      }
      try {
        const packCtx = resolvePackContext(item);
        const plan = scheduleMod.planSchedule(item.schedule, {
          ...packCtx,
          target,
          externalIdPrefix: manifest.id,
        });
        plans.push({ id: item.id, relativeFile: item.relativeFile, ...plan });
      } catch (err) {
        console.error(`Failed to plan ${item.id}: ${err.message}`);
        return 1;
      }
    }

    if (json) {
      console.log(JSON.stringify(scheduleId ? plans[0] : { projectId: manifest.id, target, plans }, null, 2));
      return 0;
    }

    for (const p of plans) {
      console.log(`\nPlan for \x1b[1m${p.id}\x1b[0m (target: ${target}, action: \x1b[36m${p.action}\x1b[0m):`);
      console.log(`  Reason: ${p.reason}`);
      console.log(`  Desired Hash: ${p.desiredHash}`);
      console.log(`  Observed Hash: ${p.observedHash || '(none)'}`);
      if (p.desired?.prompt) {
        console.log(`  Prompt preview: ${p.desired.prompt.split('\n')[0]}...`);
      }
    }
    return 0;
  }

  if (subcommand === 'apply') {
    if (!target) {
      console.error('Missing required option: --target <target>');
      console.error(usage);
      return 2;
    }
    const scheduleId = scheduleIdArgument(rest);
    if (!scheduleId) {
      console.error('Missing schedule <id> argument to apply.');
      console.error(usage);
      return 2;
    }
    const item = projectSchedules.find((s) => s.id === scheduleId);
    if (!item) {
      console.error(`Schedule not found: ${scheduleId}`);
      return 1;
    }
    if (!item.ok) {
      console.error(`Invalid schedule ${item.relativeFile}: ${item.errors.join('; ')}`);
      return 1;
    }
    try {
      const packCtx = resolvePackContext(item);
      const result = scheduleMod.applySchedule(item.schedule, {
        ...packCtx,
        target,
        externalIdPrefix: manifest.id,
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 1;
      }
      if (result.ok) {
        console.log(`\x1b[32m✓\x1b[0m Successfully applied schedule \x1b[1m${item.id}\x1b[0m to target ${target}`);
        if (result.file) console.log(`  Sidecar file: ${result.file}`);
        if (result.configFile) console.log(`  Config authorization: ${result.configFile}`);
        if (result.nextSteps) {
          console.log('\nNext steps:');
          for (const step of result.nextSteps) console.log(`  - ${step}`);
        }
        return 0;
      } else {
        console.error(`\x1b[31m✗\x1b[0m Failed to apply schedule: ${result.code} - ${result.message}`);
        return 1;
      }
    } catch (err) {
      console.error(`Apply error: ${err.message}`);
      return 1;
    }
  }

  if (subcommand === 'status') {
    const inspectTarget = target || 'gemini-sidecar';
    const targetsToInspect = allTargets ? ['gemini-sidecar', 'claude-local-routine', 'codex-scheduled'] : [inspectTarget];
    const report = [];
    for (const item of projectSchedules) {
      if (!item.ok) continue;
      for (const t of targetsToInspect) {
        try {
          const inspected = scheduleMod.inspectSchedule(item.schedule, {
            target: t,
            externalIdPrefix: manifest.id,
          });
          report.push({
            id: item.id,
            target: t,
            enabled: item.schedule.enabled,
            exists: inspected.exists,
            status: inspected.entry?.status || (inspected.exists ? 'present' : 'absent'),
            inspected,
          });
        } catch (err) {
          report.push({ id: item.id, target: t, error: err.message });
        }
      }
    }
    if (json) {
      console.log(JSON.stringify({ projectId: manifest.id, workspaceRoot, statuses: report }, null, 2));
      return 0;
    }
    console.log(`\nProject Schedules Status for ${manifest.id}:\n`);
    for (const r of report) {
      console.log(`  • \x1b[1m${r.id}\x1b[0m (${r.target}): status=${r.status || 'unknown'}, exists=${r.exists}`);
    }
    return 0;
  }

  console.error(`Unknown project schedule subcommand: ${subcommand}`);
  console.error(usage);
  return 2;
}

async function runProject(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printProjectHelp();
    return 0;
  }
  if (subcommand === 'attach') return runProjectAttach(rest);
  if (subcommand === 'list') return runRunner(['workspace', 'list', ...rest]);
  if (subcommand === 'where') return runProjectWhere(rest);
  if (subcommand === 'doctor') return runProjectDoctor(rest);
  if (subcommand === 'new') return runProjectNew(rest);
  if (subcommand === 'charter') return runProjectCharter(rest);
  if (subcommand === 'guide') return runProjectGuide(rest);
  if (subcommand === 'schedule') return runProjectSchedule(rest);
  // Project Store commands — thin bridge onto Runner's project.* surface (R6.1)
  if (subcommand === 'init' || subcommand === 'init-store') return runRunner(['project', 'init-store', ...rest]);
  if (subcommand === 'build-index') return runRunner(['project', 'build-index', ...rest]);
  if (subcommand === 'export-pack') return runRunner(['project', 'export-pack', ...rest]);
  console.error(`Unknown project command: ${subcommand}`);
  printProjectHelp();
  return 2;
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

// The captcha solver is a Python package with its own venv, so this resolves an
// executable to spawn directly rather than a JS entry point to run under node.
function getCaptchaSolveBin() {
  const override = process.env.WEBMCP_CAPTCHA_BIN;
  if (override) return resolve(process.cwd(), override);

  const candidates = [];
  if (process.env.WEBMCP_CAPTCHA_HOME) {
    candidates.push(resolve(process.env.WEBMCP_CAPTCHA_HOME, '.venv', 'bin', 'captcha-solve'));
  }
  // Release install (installation/lib/python-packages.sh), then kit checkout.
  candidates.push(resolve(homedir(), '.webmcp', 'captcha-solver', '.venv', 'bin', 'captcha-solve'));
  candidates.push(resolve(ROOT, '..', 'webmcp-captcha-solver', '.venv', 'bin', 'captcha-solve'));

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

async function runCaptcha(args) {
  const captchaBin = getCaptchaSolveBin();
  if (!captchaBin) {
    console.error([
      'WebMCP captcha solver not found.',
      'Run install.sh step 4, or set WEBMCP_CAPTCHA_HOME to a checkout of',
      'packages/webmcp-captcha-solver that has a built .venv.',
    ].join('\n'));
    return 1;
  }

  const child = spawn(captchaBin, args.length > 0 ? args : ['--help'], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: 'inherit',
  });

  return new Promise((resolveExitCode) => {
    child.on('error', (err) => {
      console.error(`Failed to start captcha solver: ${err.message}`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`Captcha solver exited after signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 0);
    });
  });
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

  if (command === 'bootstrap') {
    process.exit(await runBootstrap(args));
  }

  if (command === 'gateway') {
    await runGateway(args);
    return;
  }

  if (command === 'profiles') {
    await runProfiles(args);
    return;
  }

  if (command === 'profile-pool') {
    process.exit(await runProfilePool(args));
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

  if (command === 'project') {
    process.exit(await runProject(args));
  }

  if (command === 'mobile' || command === 'adb') {
    process.exit(await runMobile(args));
  }

  if (command === 'captcha') {
    process.exit(await runCaptcha(args));
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
