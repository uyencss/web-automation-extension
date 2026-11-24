import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DEFAULT_GATEWAY_URL, ROOT, parseFlags, getWebmcpHome } from '../context.mjs';
import { getChromeLauncher, getFleetProxyGovernor } from '../component-resolver.mjs';
import { getGatewayBaseUrl, getGatewayHealth } from '../gateway-client.mjs';
import { isMacSshOrNonAqua, callAquaBroker } from '../aqua-broker-client.mjs';

function profileIdsFromHealth(payload) {
  if (!payload || !Array.isArray(payload.profiles)) return [];
  return payload.profiles.filter((profileId) => typeof profileId === 'string');
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
  webmcp launch <profile-query> [--gateway] [--relaunch] [--require-proxy] [--dry-run] [--json]
  webmcp launch --profile-id <id-or-query> [--gateway] [--relaunch] [--require-proxy] [--dry-run] [--json]
  webmcp launch --name <managed-profile-name> [--create] [--gateway] [--require-proxy] [--dry-run] [--json]

Resolution order (for unprefixed queries):
  1. Managed profiles (~/.webmcp/managed-profiles)
  2. Chrome User Data directory (existing browser profiles)

Examples:
  webmcp launch scraping-bot --gateway --json
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

export async function runProfiles(args) {
  const [subcommand = 'list', ...rest] = args;
  const { flags } = parseFlags(rest);

  if (subcommand === 'list') {
    const { listAllProfiles } = getChromeLauncher();
    printProfiles(listAllProfiles(), Boolean(flags.json));
    return;
  }

  if (subcommand === 'fork') {
    const { findProfileById, forkExistingProfile } = getChromeLauncher();
    const profileId = flags['profile-id'] ? String(flags['profile-id']) : rest[0];
    if (!profileId) {
      console.error('Usage: webmcp profiles fork --profile-id <id> [--name <new-name>] [--force] [--max-profiles <n>] [--json]');
      process.exit(1);
    }
    const srcProfile = findProfileById(profileId);
    if (!srcProfile) {
      console.error(`Profile not found: ${profileId}`);
      process.exit(1);
    }
    const res = forkExistingProfile(srcProfile, flags.name ? String(flags.name) : undefined, {
      force: Boolean(flags.force),
      maxProfiles: flags['max-profiles'] ? Number(flags['max-profiles']) : undefined,
    });
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`✅ Forked ${res.forkedFrom} -> ${res.id} (${res.userDataDir}) [managed profiles: ${res.totalManagedCount}]`);
    }
    return;
  }

  if (subcommand === 'harmonize') {
    const { listAllProfiles, findProfileById, harmonizeProfile } = getChromeLauncher();
    const dryRun = Boolean(flags['dry-run']);
    const isAll = Boolean(flags.all);
    const profileId = flags['profile-id'] ? String(flags['profile-id']) : null;
    const json = Boolean(flags.json);

    let targets = [];
    if (profileId) {
      const p = findProfileById(profileId);
      if (!p) {
        console.error(`Profile not found: ${profileId}`);
        process.exit(1);
      }
      targets = [p];
    } else if (isAll) {
      const all = listAllProfiles();
      targets = [...all.managed, ...all.existing];
    } else {
      console.error('Specify --profile-id <id> or --all to harmonize profiles.');
      process.exit(1);
    }

    const results = [];
    for (const target of targets) {
      const res = await harmonizeProfile(target, { dryRun });
      results.push(res);
    }

    if (json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const res of results) {
        if (!res.ok) {
          console.error(`❌ [${res.profileId || 'unknown'}] Harmonize failed: ${res.message || res.error}`);
        } else if (res.dryRun) {
          console.log(`🔍 [DRY-RUN] [${res.profileId}] ${res.currentName} -> ${res.targetName} (${res.email || 'no email'})`);
        } else {
          console.log(`✅ [${res.profileId}] Harmonized: ${res.oldName} -> ${res.newName} (Avatar synced: ${res.avatarSynced})`);
        }
      }
    }
    return;
  }

  if (subcommand === 'warmth') {
    const { findProfileById } = getChromeLauncher();
    const { positional } = parseFlags(rest);
    const profileId = flags['profile-id'] ? String(flags['profile-id']) : (positional[0] || rest[0]);
    if (!profileId) {
      console.error('Usage: webmcp profiles warmth <profile-id> [--json]');
      process.exit(1);
    }

    let profile = findProfileById(profileId);
    if (!profile) {
      const cleanId = String(profileId).replace(/^managed:/, '');
      const candidateDir = resolve(getWebmcpHome(), 'managed-profiles', cleanId);
      if (existsSync(candidateDir)) {
        profile = {
          id: `managed:${cleanId}`,
          userDataDir: candidateDir,
          profileDir: 'Default',
        };
      } else if (existsSync(resolve(profileId))) {
        profile = {
          id: profileId,
          userDataDir: resolve(profileId),
          profileDir: 'Default',
        };
      }
    }

    if (!profile) {
      console.error(`Profile not found: ${profileId}`);
      process.exit(1);
    }

    const { evaluateProfileWarmth } = await import('../../profile/profile-warmth.mjs');
    const report = evaluateProfileWarmth(profile.userDataDir, {
      id: profile.id,
      profileDir: profile.profileDir,
    });

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const badgeMap = {
      MATURE: '🏆 [MATURE]',
      SOAKED: '♨️  [SOAKED]',
      SEEDED: '🌱 [SEEDED]',
      COLD: '❄️  [COLD]',
    };
    const badge = badgeMap[report.verdict] || report.verdict;
    const mb = (report.cacheSizeBytes / (1024 * 1024)).toFixed(2);
    const storageDesc = report.breakdown.footprint.hasStorage ? 'LocalStorage active' : 'no LocalStorage';

    console.log(`\n${badge} Profile Warmth: ${report.profileId}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Score:          ${report.score}/100 (${report.verdict})`);
    console.log(`Soak Age:       ${report.soakAgeHours}h (${report.breakdown.soakAge.score}/30 pts)`);
    console.log(`3P Entropy:     ${report.thirdPartyDomains.length} domains, ${report.thirdPartyCookiesCount} cookies (${report.breakdown.entropy.score}/25 pts)`);
    console.log(`Core Telemetry: ${report.googleTokens.length} tokens [${report.googleTokens.join(', ') || 'none'}] (${report.breakdown.telemetry.score}/30 pts)`);
    console.log(`Cache/Storage:  ${mb} MB cache, ${storageDesc} (${report.breakdown.footprint.score}/15 pts)`);
    console.log('\nActions Permitted:');
    if (report.actionsPermitted.length === 0) {
      console.log('  (none - profile needs soaking/warming)');
    } else {
      for (const act of report.actionsPermitted) {
        console.log(`  ✅ ${act}`);
      }
    }
    console.log('');
    return;
  }

  if (subcommand === 'detox') {
    const { findProfileById, detoxForkedManagedProfile } = getChromeLauncher();
    const { positional } = parseFlags(rest);
    const json = Boolean(flags.json);
    const profileId = flags['profile-id'] ? String(flags['profile-id']) : (positional[0] || null);
    const uddFlag = flags.udd ? resolve(String(flags.udd)) : null;

    if (!profileId && !uddFlag) {
      const msg = 'Usage: webmcp profiles detox (--profile-id <id> | --udd <dir>) [--profile-dir <dir>] [--meta-dir <dir>] [--json]';
      if (json) console.log(JSON.stringify({ ok: false, error: 'MISSING_TARGET', message: msg }, null, 2));
      else console.error(msg);
      process.exit(1);
    }

    let userDataDir = uddFlag;
    let profileDir = flags['profile-dir'] ? String(flags['profile-dir']) : null;
    let metaDir = flags['meta-dir'] ? resolve(String(flags['meta-dir'])) : undefined;

    if (!userDataDir && profileId) {
      const target = findProfileById(profileId);
      if (!target) {
        const msg = `Profile not found: ${profileId}`;
        if (json) console.log(JSON.stringify({ ok: false, error: 'PROFILE_NOT_FOUND', message: msg }, null, 2));
        else console.error(msg);
        process.exit(1);
      }
      userDataDir = target.userDataDir;
      if (!profileDir) profileDir = target.profileDir || 'Default';
      if (!metaDir && target.kind === 'existing') {
        metaDir = resolve(userDataDir, profileDir);
      }
    }

    if (!profileDir) {
      const metaPath = resolve(userDataDir, '.webmcp-meta.json');
      if (existsSync(metaPath)) {
        try {
          profileDir = JSON.parse(readFileSync(metaPath, 'utf8'))?.profileDir || null;
        } catch {}
      }
      if (!profileDir) profileDir = 'Default';
    }

    let res;
    try {
      res = detoxForkedManagedProfile(userDataDir, profileDir, metaDir ? { metaDir } : {});
    } catch (err) {
      res = { ok: false, error: err.message };
    }

    if (json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res?.ok) {
      const extCount = res.discoveredExtensions?.length || 0;
      console.log(`✅ Detoxed ${res.userDataDir} [${res.profileDir}] (Web Store extensions preserved: ${extCount})`);
    } else {
      console.error(`❌ Detox failed: ${res?.error || 'target profile directory missing or skipped'}`);
    }
    if (!res?.ok) process.exit(1);
    return;
  }

  console.error(`Unknown profiles command: ${subcommand}`);
  console.error('Usage: webmcp profiles [list|harmonize|fork|warmth|detox] [--json]');
  process.exit(1);
}

export function discoverProjectProfileHint(cwd = process.cwd()) {
  const parseCfg = (raw, cfgPath) => {
    try {
      const cfg = JSON.parse(raw);
      return {
        configPath: cfgPath,
        managedProfileId: cfg.managed_profile_id || null,
        userDataDir: cfg.user_data_dir || null,
        chromeProfile: cfg.chrome_profile || null,
        channelDisplayName: cfg.channel_display_name || null,
        channelId: cfg.channel_id || null,
      };
    } catch (err) {
      throw new Error(`[GUARDRAIL BLOCKED] Invalid JSON in project config ${cfgPath}: ${err.message}`);
    }
  };

  // 1. Env vars
  if (process.env.WEBMCP_BOUND_PROFILE_CONFIG) {
    const cfgPath = resolve(process.env.WEBMCP_BOUND_PROFILE_CONFIG);
    if (existsSync(cfgPath)) {
      return parseCfg(readFileSync(cfgPath, 'utf8'), cfgPath);
    }
    throw new Error(`[GUARDRAIL BLOCKED] WEBMCP_BOUND_PROFILE_CONFIG points to non-existent file: ${cfgPath}`);
  }

  if (process.env.WEBMCP_BOUND_PROFILE) {
    const val = String(process.env.WEBMCP_BOUND_PROFILE).trim();
    if (val.startsWith('{')) {
      return parseCfg(val, 'env:WEBMCP_BOUND_PROFILE');
    }
    return {
      configPath: 'env:WEBMCP_BOUND_PROFILE',
      managedProfileId: val.startsWith('managed:') ? val : `managed:${val}`,
      userDataDir: null,
      chromeProfile: null,
      channelDisplayName: null,
      channelId: null,
    };
  }

  // 2. Traverse upwards from cwd to git root or root filesystem
  let curr = resolve(cwd);
  while (true) {
    const cfgPath = resolve(curr, 'config', 'fb_growth_config.json');
    if (existsSync(cfgPath)) {
      return parseCfg(readFileSync(cfgPath, 'utf8'), cfgPath);
    }
    if (existsSync(resolve(curr, '.git'))) {
      break;
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  return null;
}

const LAUNCH_BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'json',
  'gateway',
  'dry-run',
  'create',
  'force-create',
  'relaunch',
  'require-proxy',
  'skip-proxy-gate',
  'no-aqua-service',
  'include-profiles',
]);

function parseBoolFlag(value) {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normVal = value.trim().toLowerCase();
    return normVal !== '' && normVal !== 'false' && normVal !== '0';
  }
  return false;
}

function emitLaunchErrorAndExit(err, { json, viaAquaService = false }) {
  const payload = err?.payload && typeof err.payload === 'object' ? err.payload : null;
  if (payload?.needsRelaunch || err?.needsRelaunch) {
    const code = payload?.code || err?.code || 'NEEDS_RELAUNCH';
    const message = payload?.message || err?.message || String(err);
    const needsPayload = {
      ...(payload || {
        code,
        error: code,
        message,
        ...(err?.pid !== undefined ? { pid: err.pid } : {}),
        ...(err?.reason ? { reason: err.reason } : {}),
      }),
      ok: false,
      needsRelaunch: true,
      exitCode: 2,
      hint: 'Ask the user before retrying with --relaunch because this may quit their running Chrome windows.',
    };
    console.log(JSON.stringify(needsPayload, null, 2));
    if (message) {
      console.error(`❌ [${code}] ${message}`);
    }
    process.exit(2);
  }
  const code = err?.code || (viaAquaService ? 'ERR_MACOS_AQUA_CALL_FAILED' : 'LAUNCH_FAILED');
  const message = err?.message || String(err);
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      ...(viaAquaService ? { viaAquaService: true } : {}),
      code,
      error: code,
      message,
      ...(err?.details ? { details: err.details } : {}),
    }, null, 2));
  }
  console.error(`❌ [${code}] ${message}`);
  process.exit(1);
}

export async function runLaunch(args) {
  const { flags, positional } = parseFlags(args, { booleanFlags: LAUNCH_BOOLEAN_FLAGS });
  if (flags.help || flags.h) {
    printLaunchUsage();
    return;
  }

  const json = Boolean(flags.json || flags.gateway || flags['dry-run']);
  const dryRun = Boolean(flags['dry-run']);
  const forceCreate = Boolean(flags.create || flags['force-create']);
  const requireProxy = parseBoolFlag(flags['require-proxy']);
  const positionalQuery = (!flags['profile-id'] && !flags.name && !forceCreate && positional[0] && !/^https?:\/\//i.test(String(positional[0])))
    ? String(positional[0])
    : null;
  const requestedProfileId = flags['profile-id'] ? String(flags['profile-id']) : positionalQuery;
  const {
    defaultExtensionPath,
    findManagedProfileByNameOrId,
    findProfileById,
    launchChrome,
    listAllProfiles,
    readManagedProfiles,
    norm,
  } = getChromeLauncher();

  let profile = null;
  let mode = 'managed';
  let projectHint = null;
  try {
    projectHint = discoverProjectProfileHint(process.cwd());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const allowCreateNewManaged = process.env.WEBMCP_ALLOW_PROFILE_CREATE === '1';
  const block = (msg) => {
    console.error(`[GUARDRAIL BLOCKED] ${msg}`);
    process.exit(1);
  };
  const lookupSafe = (fn, arg) => {
    try {
      return fn(arg);
    } catch (err) {
      if (err.code === 'AMBIGUOUS_PROFILE') block(err.message);
      throw err;
    }
  };

  if (projectHint) {
    const managedList = readManagedProfiles ? readManagedProfiles() : (listAllProfiles ? listAllProfiles().managed : []);
    const boundId = projectHint.managedProfileId || projectHint.userDataDir || projectHint.channelDisplayName || projectHint.chromeProfile;
    const matchPath = (a, b) => (existsSync(dirname(resolve(b))) ? resolve(a) === resolve(b) : basename(a) === basename(b));
    const singleMatch = (list, label) => {
      if (list.length > 1) block(`Ambiguous project ${label} matches multiple profiles: ${list.map((m) => m.id).join(', ')}`);
      return list[0] || null;
    };

    const boundProfile =
      (projectHint.managedProfileId && managedList.find((p) => p.id === projectHint.managedProfileId || (norm && norm(p.id) === norm(projectHint.managedProfileId)))) ||
      (projectHint.userDataDir && managedList.find((p) => { try { return matchPath(p.userDataDir, projectHint.userDataDir); } catch { return false; } })) ||
      (projectHint.channelDisplayName && singleMatch(managedList.filter((p) => norm && norm(p.name) === norm(projectHint.channelDisplayName)), `channel_display_name "${projectHint.channelDisplayName}"`)) ||
      (projectHint.chromeProfile && singleMatch(managedList.filter((p) => p.profileDir === projectHint.chromeProfile), `chrome_profile "${projectHint.chromeProfile}"`)) ||
      null;

    if (!boundProfile) {
      if (!(flags.name && allowCreateNewManaged)) {
        block(`Project config (${projectHint.configPath}) pins profile "${boundId}", but this managed profile does not exist on disk. Refusing to fall back or create a blank profile.`);
      }
    } else {
      if (projectHint.managedProfileId && boundProfile.id !== projectHint.managedProfileId) {
        block(`Bound profile "${boundProfile.id}" does not match project managed_profile_id="${projectHint.managedProfileId}".`);
      }
      if (projectHint.userDataDir && !matchPath(boundProfile.userDataDir, projectHint.userDataDir)) {
        block(`Bound profile userDataDir "${boundProfile.userDataDir}" does not match project user_data_dir="${projectHint.userDataDir}".`);
      }
      if (projectHint.chromeProfile) {
        if (boundProfile.profileDir !== projectHint.chromeProfile) {
          block(`Bound profile "${boundProfile.id}" has profileDir="${boundProfile.profileDir}" which does not match project chrome_profile="${projectHint.chromeProfile}".`);
        }
        const subDir = resolve(boundProfile.userDataDir, boundProfile.profileDir);
        if (projectHint.chromeProfile !== 'Default' && !existsSync(subDir)) {
          block(`Bound profile "${boundProfile.id}" is missing subdirectory "${boundProfile.profileDir}" at ${subDir} on disk.`);
        }
      }
    }

    if (requestedProfileId) {
      if (!boundProfile) {
        block(`Project config (${projectHint.configPath}) pins profile "${boundId}", but this managed profile does not exist on disk. Refusing to fall back or create a blank profile.`);
      }
      const reqId = String(requestedProfileId);
      const matchedReq = lookupSafe(findProfileById, reqId);
      if (!matchedReq || matchedReq.id !== boundProfile.id || matchedReq.kind !== 'managed') {
        block(`Project config (${projectHint.configPath}) binds this channel to "${boundProfile.id}" (userDataDir=${boundProfile.userDataDir}, profileDir=${boundProfile.profileDir}). Refusing to launch mismatched --profile-id "${reqId}".`);
      }
      profile = boundProfile;
      mode = 'managed';
    } else if (flags.name) {
      const reqName = String(flags.name);
      const matchedName = lookupSafe(findManagedProfileByNameOrId || findProfileById, reqName);
      if (matchedName && boundProfile && matchedName.id === boundProfile.id) {
        profile = boundProfile;
        mode = 'managed';
      } else if (!matchedName && allowCreateNewManaged) {
        mode = 'managed';
      } else {
        const targetId = boundProfile ? boundProfile.id : boundId;
        block(`Project config (${projectHint.configPath}) binds this channel to "${targetId}". Refusing to launch or create "${reqName}". Use: webmcp launch --profile-id "${targetId}" --gateway`);
      }
    } else {
      profile = boundProfile;
      mode = 'managed';
    }
  } else {
    if (requestedProfileId) {
      profile = lookupSafe(findProfileById, requestedProfileId);
      if (!profile) {
        console.error(`Profile not found: ${requestedProfileId}`);
        console.error('Run `webmcp profiles list --json` to see available ids.');
        process.exit(1);
      }
      mode = profile.kind === 'existing' ? 'existing' : 'managed';
    } else if (flags.name && !forceCreate) {
      const matched = lookupSafe(findProfileById, String(flags.name));
      if (matched) {
        profile = matched;
        mode = matched.kind === 'existing' ? 'existing' : 'managed';
      }
    }
  }

  let extraArgs = [];
  let env = undefined;

  if (profile?.userDataDir) {
    const metaPath = mode === 'existing'
      ? resolve(profile.userDataDir, profile.profileDir || 'Default', '.webmcp-meta.json')
      : resolve(profile.userDataDir, '.webmcp-meta.json');

    if (existsSync(metaPath)) {
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      } catch {}

      if (meta.proxy?.url) {
        if (dryRun || flags['skip-proxy-gate']) {
          extraArgs = [
            `--proxy-server=${meta.proxy.url}`,
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          ];
        } else {
          const gov = await getFleetProxyGovernor();
          if (!gov?.resolveProfileLaunchGate) {
            throw new Error('Profile has proxy binding but fleet proxy governor is unavailable — refusing to launch (use --skip-proxy-gate to override).');
          }
          const gate = await gov.resolveProfileLaunchGate(metaPath, {
            currentNodeId: String(flags.node || process.env.WEBMCP_NODE_ID || 'local'),
          });
          extraArgs = gate.launchArgs || [];
        }
        if (meta.proxy?.timezone) {
          env = { TZ: String(meta.proxy.timezone) };
        }
      }
    }
  }

  if (process.env.WEBMCP_NO_LAUNCH === '1' && !dryRun) {
    const code = 'ERR_WEBMCP_NO_LAUNCH_BLOCKED';
    const message = 'WEBMCP_NO_LAUNCH=1 is set; refusing Chrome launch/spawn — use already-connected browser tabs via WebMCP gateway.';
    if (json) {
      console.log(JSON.stringify({ ok: false, code, error: code, message }, null, 2));
    }
    console.error(`❌ [${code}] ${message}`);
    process.exit(1);
  }

  if (process.platform === 'darwin' && isMacSshOrNonAqua(process.env) && !dryRun && !flags['no-aqua-service']) {
    console.error(`[AQUA-SERVICE] macOS SSH/non-Aqua detected — delegating Chrome launch to authorized Aqua Gateway (${getGatewayBaseUrl()}/api/aqua/launch).`);
    let brokerRes;
    try {
      brokerRes = await callAquaBroker('launch', {
        mode,
        profile,
        newProfileName: flags.name || 'webmcp',
        forceCreate,
        relaunch: Boolean(flags.relaunch),
        dryRun,
        requireProxy,
        cookieMode: flags['cookie-mode'] ? String(flags['cookie-mode']) : undefined,
        extensionPath: flags['extension-path'] || defaultExtensionPath(),
        extraArgs,
        env,
        gateway: Boolean(flags.gateway),
      }, { timeoutMs: 45000 });
    } catch (err) {
      emitLaunchErrorAndExit(err, { json, viaAquaService: true });
    }
    const payload = {
      ...brokerRes,
      gatewayUrl: flags.gateway ? getGatewayBaseUrl() : null,
      gatewayStarted: false,
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
    console.log(`Chrome launched via Aqua Gateway (:7865): ${payload.userDataDir}`);
    if (payload.profileId) console.log(`WebMCP profileId: ${payload.profileId}`);
    if (payload.warning) {
      console.error(`\n⚠️  ${payload.warning}`);
      if (payload.guidance) console.error(payload.guidance);
    }
    return;
  }

  const gateway = flags.gateway ? await ensureGatewayRunning() : null;
  const beforeIds = gateway?.health ? profileIdsFromHealth(gateway.health) : [];
  let launchResult;
  try {
    launchResult = await launchChrome({
      mode,
      profile,
      newProfileName: flags.name || 'webmcp',
      forceCreate,
      relaunch: Boolean(flags.relaunch),
      dryRun,
      requireProxy,
      cookieMode: flags['cookie-mode'] ? String(flags['cookie-mode']) : undefined,
      extensionPath: flags['extension-path'] || defaultExtensionPath(),
      extraArgs,
      env,
    });
  } catch (err) {
    emitLaunchErrorAndExit(err, { json });
  }

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


export async function runClose(args) {
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

export async function runQuit(args) {
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
