import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_GATEWAY_URL, ROOT, parseFlags } from '../context.mjs';
import { getChromeLauncher, getFleetProxyGovernor } from '../component-resolver.mjs';
import { getGatewayBaseUrl, getGatewayHealth } from '../gateway-client.mjs';

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
      console.error('Usage: webmcp profiles fork --profile-id <id> [--name <new-name>] [--json]');
      process.exit(1);
    }
    const srcProfile = findProfileById(profileId);
    if (!srcProfile) {
      console.error(`Profile not found: ${profileId}`);
      process.exit(1);
    }
    const res = forkExistingProfile(srcProfile, flags.name ? String(flags.name) : undefined);
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`✅ Forked ${res.forkedFrom} -> ${res.id} (${res.userDataDir})`);
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

  console.error(`Unknown profiles command: ${subcommand}`);
  console.error('Usage: webmcp profiles [list|harmonize|fork] [--json]');
  process.exit(1);
}

function discoverProjectProfileHint(cwd = process.cwd()) {
  const candidates = [
    resolve(cwd, 'config', 'fb_growth_config.json'),
    resolve(cwd, '..', 'config', 'fb_growth_config.json'),
  ];
  for (const cfgPath of candidates) {
    if (!existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      return {
        configPath: cfgPath,
        managedProfileId: cfg.managed_profile_id || null,
        userDataDir: cfg.user_data_dir || null,
        chromeProfile: cfg.chrome_profile || null,
        channelDisplayName: cfg.channel_display_name || null,
        channelId: cfg.channel_id || null,
      };
    } catch {}
  }
  return null;
}

export async function runLaunch(args) {
  const { flags } = parseFlags(args);
  if (flags.help || flags.h) {
    printLaunchUsage();
    return;
  }

  const json = Boolean(flags.json || flags.gateway || flags['dry-run']);
  const dryRun = Boolean(flags['dry-run']);
  const forceCreate = Boolean(flags.create || flags['force-create']);
  const {
    defaultExtensionPath,
    findManagedProfileByNameOrId,
    findProfileById,
    launchChrome,
    listAllProfiles,
  } = getChromeLauncher();

  let profile = null;
  let mode = 'managed';
  const projectHint = discoverProjectProfileHint(process.cwd());

  if (flags['profile-id']) {
    profile = findProfileById(String(flags['profile-id']));
    if (!profile) {
      console.error(`Profile not found: ${flags['profile-id']}`);
      console.error('Run `webmcp profiles list --json` to see available ids.');
      process.exit(1);
    }
    mode = profile.kind === 'existing' ? 'existing' : 'managed';
  } else if (flags.name && !forceCreate) {
    const matched = findManagedProfileByNameOrId
      ? findManagedProfileByNameOrId(String(flags.name))
      : findProfileById(String(flags.name));
    if (matched) {
      profile = matched;
      mode = matched.kind === 'existing' ? 'existing' : 'managed';
    } else if (projectHint && (projectHint.managedProfileId || projectHint.chromeProfile)) {
      const boundId = projectHint.managedProfileId || projectHint.chromeProfile;
      console.error(
        `[GUARDRAIL BLOCKED] Project config (${projectHint.configPath}) binds this channel to profile "${boundId}". ` +
        `Refusing to create a new blank browser profile ("${flags.name}"). ` +
        `Use --profile-id "${boundId}" (or pass --create if you intentionally want a new blank profile).`
      );
      process.exit(1);
    }
  } else if (!flags.name && !forceCreate && projectHint) {
    const query = projectHint.managedProfileId || projectHint.channelDisplayName || projectHint.channelId || projectHint.chromeProfile;
    if (query) {
      const matched = (findManagedProfileByNameOrId && findManagedProfileByNameOrId(String(query))) || findProfileById(String(query));
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

  const gateway = flags.gateway ? await ensureGatewayRunning() : null;
  const beforeIds = gateway?.health ? profileIdsFromHealth(gateway.health) : [];
  const launchResult = await launchChrome({
    mode,
    profile,
    newProfileName: flags.name || 'webmcp',
    forceCreate,
    relaunch: Boolean(flags.relaunch),
    dryRun,
    extensionPath: flags['extension-path'] || defaultExtensionPath(),
    extraArgs,
    env,
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
