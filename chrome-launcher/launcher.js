'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, execSync, spawn } = require('child_process');
const { isPidAlive } = require('./sessions');
const {
  ensureDirs,
  MANAGED_PROFILES_DIR,
  SESSIONS_FILE,
} = require('./config');
const {
  hasLiveManagedSession,
  rememberManagedSession,
  loadSessions,
  saveSessions,
} = require('./sessions');
const { norm, findManagedProfileByNameOrId } = require('./profiles');

const WEBMCP_EXTENSION_ID = 'lbodkmkjbcemodklopcfdmpjomdoapae';
const WEBMCP_EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/webmcp-tools-provider/${WEBMCP_EXTENSION_ID}`;

function defaultExtensionPath() {
  const browserExt = path.resolve(__dirname, '..', 'webmcp-extension', 'dist');
  const vaultExt = path.resolve(
    __dirname,
    '..',
    '..',
    'webmcp-vault-kit',
    'webmcp-vault-extension',
    'dist'
  );
  if (fs.existsSync(path.join(vaultExt, 'manifest.json'))) {
    return `${browserExt},${vaultExt}`;
  }
  return browserExt;
}

function chromeCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }

  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:/Program Files';
    const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    return [
      path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(pfx86, 'Google/Chrome/Application/chrome.exe'),
      local && path.join(local, 'Google/Chrome/Application/chrome.exe'),
    ].filter(Boolean);
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

function findChromeBinary() {
  if (process.env.WEBMCP_CHROME_BINARY && fs.existsSync(process.env.WEBMCP_CHROME_BINARY)) {
    return process.env.WEBMCP_CHROME_BINARY;
  }
  return chromeCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/**
 * Remove stale Chrome lock files from a user-data directory.
 * Returns the list of files that were removed.
 */
function cleanStaleLocks(userDataDir) {
  const removed = [];
  for (const fileName of LOCK_FILES) {
    const filePath = path.join(userDataDir, fileName);
    try {
      fs.unlinkSync(filePath);
      removed.push(filePath);
    } catch {
      // file doesn't exist or not permitted — skip
    }
  }
  return removed;
}

function findChromePidForUserDataDir(userDataDir) {
  try {
    const out = execSync('ps -ax -o pid=,command=', { encoding: 'utf8' });
    const lines = out.split('\n');
    for (const line of lines) {
      if (line.includes(`--user-data-dir=${userDataDir}`) && !line.includes('--type=')) {
        const match = line.trim().match(/^(\d+)/);
        if (match) return parseInt(match[1], 10);
      }
    }
  } catch {}
  return null;
}

function readLockPid(userDataDir) {
  const lockPath = path.join(userDataDir, 'SingletonLock');
  try {
    const target = fs.readlinkSync(lockPath);
    const match = target.match(/-(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

/**
 * Check whether a Chrome profile directory is locked by a live process.
 * If lock files exist but the owning PID is dead (stale locks), they are
 * automatically cleaned up and the function returns false.
 */
function isProfileLocked(userDataDir) {
  const lockPath = path.join(userDataDir, 'SingletonLock');
  const pid = readLockPid(userDataDir);
  if (pid !== null) {
    if (!isPidAlive(pid)) {
      cleanStaleLocks(userDataDir);
      return false;
    }
    return true;
  }
  if (!fs.existsSync(lockPath)) {
    return LOCK_FILES.some((f) => {
      try {
        return Boolean(fs.lstatSync(path.join(userDataDir, f)));
      } catch {
        return false;
      }
    });
  }
  return true;
}

function slugify(name) {
  return String(name || 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'profile';
}

function nextManagedProfileDir(name, managedProfilesDir = MANAGED_PROFILES_DIR) {
  const base = slugify(name);
  let dir = path.join(managedProfilesDir, base);
  let n = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(managedProfilesDir, `${base}-${n++}`);
  }
  return dir;
}

function findExistingManagedProfileDir(name, managedProfilesDir = MANAGED_PROFILES_DIR) {
  return findManagedProfileByNameOrId(name, { managedProfilesDir })?.userDataDir || null;
}

function createManagedProfile(name, options = {}) {
  const managedProfilesDir = options.managedProfilesDir || MANAGED_PROFILES_DIR;
  ensureDirs({ managedProfilesDir, sessionsFile: options.sessionsFile });
  const userDataDir = nextManagedProfileDir(name, managedProfilesDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  const meta = {
    name: name || path.basename(userDataDir),
    createdAt: Date.now(),
  };
  if (!options.skipFingerprintSeed) {
    meta.fingerprintSeed = crypto.randomInt(0, 0x100000000);
  }
  fs.writeFileSync(
    path.join(userDataDir, '.webmcp-meta.json'),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  return userDataDir;
}

function baseArgs({ extensionPath, userDataDir, profileDir }) {
  // NOTE: we deliberately do NOT pass
  // `--disable-features=DisableLoadExtensionCommandLineSwitch`. That switch was
  // the escape hatch for loading unpacked extensions from the command line on
  // Chrome M120–M136; Chrome removed it in M137, so on modern stable Chrome it
  // is a dead no-op. `loadExtensionSupported()` reports whether --load-extension
  // will actually be honored for the resolved binary so callers can guide the
  // user instead of failing silently.
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--silent-debugger-extension-api',
  ];
  if (profileDir) args.push(`--profile-directory=${profileDir}`);
  return args;
}

// The command-line switch that ships an unpacked extension into a booting
// user-data-dir. Stable/Beta Chrome removed it in M137 for security; Chromium,
// Chrome for Testing, and the Canary/Dev channels still honor it.
const LOAD_EXTENSION_DROPPED_MAJOR = 137;

// Best-effort channel classification from the binary path + `--version` string.
function detectChromeChannel(chromePath, versionOutput) {
  const p = String(chromePath || '').toLowerCase();
  const v = String(versionOutput || '').toLowerCase();
  if (p.includes('for testing') || v.includes('for testing')) return 'testing';
  if (p.includes('canary') || v.includes('canary')) return 'canary';
  if (p.includes('chrome dev') || p.includes('chrome-dev') || p.includes('google-chrome-unstable') || /\bdev\b/.test(v)) return 'dev';
  if (p.includes('chrome beta') || p.includes('chrome-beta') || p.includes('google-chrome-beta') || v.includes('beta')) return 'beta';
  if (p.includes('chromium') || v.includes('chromium')) return 'chromium';
  if (v.includes('google chrome') || p.includes('google chrome') || p.includes('chrome.exe') || p.includes('google-chrome')) return 'stable';
  return 'unknown';
}

// Run `<chrome> --version` once and parse { raw, major, channel }. Never throws.
function detectChromeInfo(chromePath) {
  let raw = '';
  try {
    raw = execFileSync(chromePath, ['--version'], { timeout: 4000, encoding: 'utf8' }).trim();
  } catch {
    raw = '';
  }
  const match = raw.match(/(\d+)\.\d+\.\d+/);
  const major = match ? Number(match[1]) : null;
  return { raw, major, channel: detectChromeChannel(chromePath, raw) };
}

// Whether `--load-extension` is expected to be honored for this build.
function loadExtensionSupported(info) {
  if (!info) return true;
  const { channel, major } = info;
  if (channel === 'testing' || channel === 'chromium' || channel === 'canary' || channel === 'dev') {
    return true;
  }
  if ((channel === 'stable' || channel === 'beta') && major != null && major >= LOAD_EXTENSION_DROPPED_MAJOR) {
    return false;
  }
  return true;
}

// Human-readable remediation for builds that ignore --load-extension.
function loadExtensionGuidance({ extensionPath, info }) {
  const label = info?.raw || (info?.major ? `Chrome ${info.major}` : 'This Chrome build');
  return [
    `${label} ignores the --load-extension command-line switch (removed from stable Chrome in M137), ` +
      'so the WebMCP extension will not auto-load.',
    'Install or load it one of these ways:',
    `  1. Recommended: install WebMCP Tools Provider from the Chrome Web Store: ${WEBMCP_EXTENSION_STORE_URL}`,
    `  2. Development fallback: open chrome://extensions, turn on Developer mode, click "Load unpacked", ` +
      `and select ${extensionPath}. Chrome then remembers it for that profile, so later ` +
      'launches attach with the extension already present.',
    '  3. Point WEBMCP_CHROME_BINARY at Chrome for Testing, Chrome Canary/Dev, or Chromium, ' +
      'where --load-extension still works.',
  ].join('\n');
}

/**
 * Force-quit all Chrome processes on the machine.
 * If options.cleanLocks is true (default), also removes stale lock files
 * from all managed profile directories.
 */
async function quitChrome(options = {}) {
  const { cleanLocks = true, managedProfilesDir = MANAGED_PROFILES_DIR } = options;

  await new Promise((resolve) => {
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'tell application "Google Chrome" to quit'], () => resolve());
    } else if (process.platform === 'win32') {
      execFile('taskkill', ['/IM', 'chrome.exe', '/F'], () => resolve());
    } else {
      execFile('pkill', ['-TERM', 'chrome'], () => resolve());
    }
  });

  // Wait briefly for processes to fully terminate before cleaning locks
  await new Promise((r) => setTimeout(r, 1000));

  if (cleanLocks) {
    try {
      const dirs = fs.readdirSync(managedProfilesDir, { withFileTypes: true });
      for (const entry of dirs) {
        if (entry.isDirectory()) {
          cleanStaleLocks(path.join(managedProfilesDir, entry.name));
        }
      }
    } catch {
      // managed-profiles dir may not exist yet
    }
  }
}

async function waitForUnlock(userDataDir, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProfileLocked(userDataDir)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return !isProfileLocked(userDataDir);
}

/**
 * Merge base Chrome launch args with extra args.
 * Merges multiple comma-separated Chromium flags into single deduplicated flags:
 *   --disable-features=, --enable-features=, --disable-blink-features=, --enable-blink-features=
 * and deduplicates identical standalone flags while preserving their order.
 */
function mergeChromeLaunchArgs(baseArgsList, extraArgs = []) {
  const combined = [...(baseArgsList || []), ...(extraArgs || [])];
  const commaFlagGroups = {
    '--disable-features=': new Set(),
    '--enable-features=': new Set(),
    '--disable-blink-features=': new Set(),
    '--enable-blink-features=': new Set(),
  };
  const otherArgs = [];
  const seenArgs = new Set();

  for (const arg of combined) {
    if (typeof arg !== 'string' || !arg) continue;
    let matchedGroup = false;
    for (const prefix of Object.keys(commaFlagGroups)) {
      if (arg.startsWith(prefix)) {
        const feats = arg.slice(prefix.length).split(',').map((f) => f.trim()).filter(Boolean);
        for (const f of feats) commaFlagGroups[prefix].add(f);
        matchedGroup = true;
        break;
      }
    }
    if (!matchedGroup) {
      if (!seenArgs.has(arg)) {
        seenArgs.add(arg);
        otherArgs.push(arg);
      }
    }
  }

  for (const [prefix, set] of Object.entries(commaFlagGroups)) {
    if (set.size > 0) {
      otherArgs.push(`${prefix}${Array.from(set).join(',')}`);
    }
  }

  return otherArgs;
}

function spawnChrome({ chromePath, extensionPath, userDataDir, profileDir, mode, attached, dryRun, extraArgs, env }) {
  const rawBase = baseArgs({ extensionPath, userDataDir, profileDir });
  const args = mergeChromeLaunchArgs(rawBase, extraArgs);
  const mergedEnv = env ? { ...process.env, ...env } : process.env;

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      pid: null,
      chromePath,
      userDataDir,
      profileDir,
      mode: mode || 'managed',
      attached: Boolean(attached),
      args,
      env: env || null,
      tz: env?.TZ || null,
    };
  }

  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore', env: mergedEnv });
  child.unref();
  return {
    ok: true,
    pid: child.pid,
    chromePath,
    userDataDir,
    profileDir,
    mode: mode || 'managed',
    attached: Boolean(attached),
    args,
    env: env || null,
    tz: env?.TZ || null,
  };
}

function validateExtensionPath(extensionPath) {
  const parts = String(extensionPath || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error('Extension dist not found at (empty).');
  }
  for (const p of parts) {
    if (!fs.existsSync(p)) {
      throw new Error(`Extension dist not found at ${p}.`);
    }
  }
}

async function launchChrome(options = {}) {
  const mode = options.mode || (options.profile?.kind === 'existing' ? 'existing' : 'managed');
  const extensionPath = options.extensionPath || defaultExtensionPath();
  const sessionsFile = options.sessionsFile || SESSIONS_FILE;
  const managedProfilesDir = options.managedProfilesDir || MANAGED_PROFILES_DIR;

  validateExtensionPath(extensionPath);
  const chromePath = options.chromePath || findChromeBinary();
  if (!chromePath) {
    throw new Error('Google Chrome was not found. Set WEBMCP_CHROME_BINARY to its path.');
  }

  const chromeInfo = detectChromeInfo(chromePath);
  const extensionLoadable = loadExtensionSupported(chromeInfo);
  // Merge Chrome-version + extension-loadability context into a successful
  // launch result so the CLI/skill can warn (instead of silently failing) when
  // the resolved Chrome build no longer honors --load-extension.
  const annotate = (result) => {
    if (!result || result.ok === false) return result;
    const extras = {
      chromeVersion: chromeInfo.raw || null,
      chromeMajor: chromeInfo.major,
      chromeChannel: chromeInfo.channel,
      extensionPath,
      extensionLoadable,
      extensionId: WEBMCP_EXTENSION_ID,
      extensionStoreUrl: WEBMCP_EXTENSION_STORE_URL,
    };
    if (!extensionLoadable) {
      extras.warning = 'Chrome will open, but the WebMCP extension will not auto-load on this build.';
      extras.guidance = loadExtensionGuidance({ extensionPath, info: chromeInfo });
    }
    return { ...result, ...extras };
  };

  if (mode === 'existing') {
    if (!options.profile?.userDataDir) throw new Error('Missing existing profile info.');
    const userDataDir = options.profile.userDataDir;
    const profileDir = options.profile.profileDir || 'Default';

    if (hasLiveManagedSession(userDataDir, sessionsFile)) {
      const spawnRes = spawnChrome({
        chromePath,
        extensionPath,
        userDataDir,
        profileDir,
        mode: 'existing',
        attached: true,
        dryRun: options.dryRun,
        extraArgs: options.extraArgs,
        env: options.env,
      });
      if ((options.extraArgs && options.extraArgs.length > 0) || options.env?.TZ) {
        spawnRes.attachWarning = 'Chrome is already running for this profile; extraArgs and env (TZ) require --relaunch to take effect.';
      }
      return annotate(spawnRes);
    }

    if (isProfileLocked(userDataDir)) {
      if (!options.relaunch) {
        return {
          ok: false,
          needsRelaunch: true,
          userDataDir,
          profileDir,
          message:
            'Chrome is already running, so the WebMCP extension cannot be injected. ' +
            'Ask the user before quitting Chrome, then retry with --relaunch if approved.',
        };
      }
      const lockPid = readLockPid(userDataDir);
      if (lockPid && isPidAlive(lockPid)) {
        try { process.kill(lockPid, 'SIGTERM'); } catch {}
      } else {
        await quitChrome();
      }
      const unlocked = await waitForUnlock(userDataDir);
      if (!unlocked) {
        return {
          ok: false,
          needsRelaunch: true,
          userDataDir,
          profileDir,
          message: 'Could not quit the running Chrome automatically. Quit Chrome manually, then try again.',
        };
      }
    }

    const result = spawnChrome({ chromePath, extensionPath, userDataDir, profileDir, mode: 'existing', dryRun: options.dryRun, extraArgs: options.extraArgs, env: options.env });
    if (result.pid) rememberManagedSession(userDataDir, result.pid, sessionsFile);
    return annotate(result);
  }

  const existingManagedDir = (!options.profile?.userDataDir && !options.forceCreate)
    ? findExistingManagedProfileDir(options.newProfileName, managedProfilesDir)
    : null;

  const userDataDir = options.profile?.userDataDir ||
    existingManagedDir ||
    (options.dryRun
      ? nextManagedProfileDir(options.newProfileName, managedProfilesDir)
      : createManagedProfile(options.newProfileName, { managedProfilesDir, sessionsFile }));

  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(userDataDir, '.webmcp-meta.json'), 'utf8'));
  } catch {}

  if (meta.forkedFrom && !meta.forkedFrom.startsWith('managed:') && !meta.forkedFrom.startsWith('Chromium:') && chromeInfo.channel === 'chromium' && !options.allowCrossChannelFork) {
    throw new Error(
      'Refusing to launch a profile forked from native Chrome on a custom Chromium binary ' +
      '(Keychain/Safe Storage mismatch would wipe encrypted cookies). Launch with native Chrome or create a fresh managed profile.'
    );
  }

  const effectiveProfileDir = options.profile?.profileDir || meta.profileDir || 'Default';
  const effectiveExtraArgs = [...(options.extraArgs || [])];
  if (chromeInfo.channel === 'chromium' && typeof meta.fingerprintSeed === 'number') {
    effectiveExtraArgs.push(`--fingerprint=${meta.fingerprintSeed}`);
    const tz = options.env?.TZ || meta.proxy?.timezone;
    if (tz) effectiveExtraArgs.push(`--timezone=${tz}`);
  }

  if (hasLiveManagedSession(userDataDir, sessionsFile)) {
    const spawnRes = spawnChrome({
      chromePath,
      extensionPath,
      userDataDir,
      profileDir: effectiveProfileDir,
      mode: 'managed',
      attached: true,
      dryRun: options.dryRun,
      extraArgs: effectiveExtraArgs,
      env: options.env,
    });
    if ((effectiveExtraArgs && effectiveExtraArgs.length > 0) || options.env?.TZ) {
      spawnRes.attachWarning = 'Chrome is already running for this profile; extraArgs and env (TZ) require --relaunch to take effect.';
    }
    return annotate(spawnRes);
  }

  if (isProfileLocked(userDataDir)) {
    if (!options.relaunch) {
      return annotate({
        ok: false,
        mode: 'managed',
        attached: true,
        needsRelaunch: true,
        userDataDir,
        profileDir: effectiveProfileDir,
        profileDirectory: effectiveProfileDir,
        pid: null,
        sessionId: null,
        attachWarning:
          'Chrome is already running with this managed profile outside WebMCP session tracking; refusing to spawn a duplicate process (which would drop --proxy-server / --load-extension). Close the existing Chrome window first or relaunch via WebMCP.',
        message:
          'Chrome is already running with this managed profile outside WebMCP session tracking; refusing to spawn a duplicate process (which would drop --proxy-server / --load-extension). Close the existing Chrome window first or relaunch via WebMCP.',
      });
    }
    let lockPid = readLockPid(userDataDir);
    if (!lockPid) {
      lockPid = findChromePidForUserDataDir(userDataDir);
    }
    if (lockPid && isPidAlive(lockPid)) {
      try { process.kill(lockPid, 'SIGTERM'); } catch {}
      const unlocked = await waitForUnlock(userDataDir);
      if (!unlocked) {
        return annotate({
          ok: false,
          mode: 'managed',
          needsRelaunch: true,
          userDataDir,
          profileDir: effectiveProfileDir,
          message: 'Could not quit the running Chrome process for this profile automatically. Quit Chrome manually, then try again.',
        });
      }
    } else {
      return annotate({
        ok: false,
        mode: 'managed',
        needsRelaunch: true,
        userDataDir,
        profileDir: effectiveProfileDir,
        message: 'Profile lock file exists without a readable PID; refusing global quitChrome() to protect other running channels. Remove stale Singleton* files in userDataDir or close the specific window manually.',
      });
    }
  }

  const result = spawnChrome({
    chromePath,
    extensionPath,
    userDataDir,
    profileDir: effectiveProfileDir,
    mode: 'managed',
    dryRun: options.dryRun,
    extraArgs: effectiveExtraArgs,
    env: options.env,
  });
  if (result.pid) rememberManagedSession(userDataDir, result.pid, sessionsFile);
  return annotate(result);
}

async function closeChrome(options = {}) {
  const { profileId, all, gatewayUrl = 'http://127.0.0.1:7865', token = process.env.WEBMCP_GATEWAY_TOKEN } = options;
  
  // 1. Collect connected profiles from the gateway health endpoint if it is running
  let connectedDetails = [];
  let gatewayRunning = false;
  try {
    const res = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      connectedDetails = data.profileDetails || [];
      gatewayRunning = true;
    }
  } catch {
    // Gateway not running or timeout
  }
  
  let closedCount = 0;
  
  // 2. Identify which profileIds to close
  const targetsToClose = [];
  if (all) {
    for (const d of connectedDetails) {
      targetsToClose.push(d.profileId);
    }
  } else if (profileId) {
    const q = norm(profileId);
    for (const d of connectedDetails) {
      if (norm(d.profileId) === q || (d.email && norm(d.email) === q) || (d.name && norm(d.name) === q)) {
        targetsToClose.push(d.profileId);
        break;
      }
    }
  }
  
  // 3. Send closeBrowser to targets
  for (const targetId of targetsToClose) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${gatewayUrl}/api`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          method: 'closeBrowser',
          params: {},
          profileId: targetId
        })
      });
      if (res.ok) {
        closedCount++;
      }
    } catch (err) {
      // ignore
    }
  }
  
  // 4. Force-kill any managed session processes we have recorded in sessions.json
  try {
    const sessionsFile = options.sessionsFile || SESSIONS_FILE;
    const state = loadSessions(sessionsFile);
    let changed = false;
    
    for (const [userDataDir, session] of Object.entries(state.managedSessions)) {
      let shouldKill = false;
      
      if (all) {
        shouldKill = true;
      } else if (profileId) {
        // Match managed session by userDataDir path, or name in .webmcp-meta.json
        const baseName = path.basename(userDataDir);
        let meta = {};
        try {
          meta = JSON.parse(fs.readFileSync(path.join(userDataDir, '.webmcp-meta.json'), 'utf8'));
        } catch {}
        
        const q = norm(profileId);
        if (q === norm(`managed:${baseName}`) || q === norm(baseName) || (meta.name && q === norm(meta.name))) {
          shouldKill = true;
        }
      }
      
      if (shouldKill && session?.pid) {
        try {
          process.kill(session.pid, 'SIGTERM');
          const unlocked = await waitForUnlock(userDataDir, options.killTimeoutMs ?? 5000);
          if (!unlocked && isPidAlive(session.pid)) {
            process.kill(session.pid, 'SIGKILL');
          }
        } catch {
          // already dead or not permitted
        }
        delete state.managedSessions[userDataDir];
        changed = true;
        closedCount++;
        cleanStaleLocks(userDataDir);
      }
    }
    
    if (changed) {
      saveSessions(state, sessionsFile);
    }
  } catch (err) {
    // ignore
  }
  
  return { ok: true, closedCount };
}

module.exports = {
  WEBMCP_EXTENSION_ID,
  WEBMCP_EXTENSION_STORE_URL,
  defaultExtensionPath,
  chromeCandidates,
  findChromeBinary,
  readLockPid,
  findChromePidForUserDataDir,
  isProfileLocked,
  cleanStaleLocks,
  slugify,
  nextManagedProfileDir,
  findExistingManagedProfileDir,
  createManagedProfile,
  baseArgs,
  mergeChromeLaunchArgs,
  detectChromeChannel,
  detectChromeInfo,
  loadExtensionSupported,
  loadExtensionGuidance,
  quitChrome,
  waitForUnlock,
  launchChrome,
  closeChrome,
};
