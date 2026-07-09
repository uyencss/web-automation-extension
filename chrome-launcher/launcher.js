'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
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

const WEBMCP_EXTENSION_ID = 'lbodkmkjbcemodklopcfdmpjomdoapae';
const WEBMCP_EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/webmcp-tools-provider/${WEBMCP_EXTENSION_ID}`;

function defaultExtensionPath() {
  return path.resolve(__dirname, '..', 'webmcp-extension', 'dist');
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

/**
 * Check whether a Chrome profile directory is locked by a live process.
 * If lock files exist but the owning PID is dead (stale locks), they are
 * automatically cleaned up and the function returns false.
 */
function isProfileLocked(userDataDir) {
  const lockPath = path.join(userDataDir, 'SingletonLock');
  if (!fs.existsSync(lockPath)) {
    return LOCK_FILES.some((f) => fs.existsSync(path.join(userDataDir, f)));
  }

  // On macOS/Linux, SingletonLock is a symlink whose target is "<hostname>-<pid>".
  // On Windows it's a regular file. Try to extract the PID.
  try {
    const target = fs.readlinkSync(lockPath);        // e.g. "Hieu-MBP-17703"
    const match = target.match(/-(\d+)$/);
    if (match) {
      const pid = parseInt(match[1], 10);
      if (!isPidAlive(pid)) {
        // PID is dead → stale lock. Clean up.
        cleanStaleLocks(userDataDir);
        return false;
      }
    }
  } catch {
    // readlinkSync fails if it's a regular file (Windows) or permission error.
    // Fall through to simple existence check.
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

function createManagedProfile(name, options = {}) {
  const managedProfilesDir = options.managedProfilesDir || MANAGED_PROFILES_DIR;
  ensureDirs({ managedProfilesDir, sessionsFile: options.sessionsFile });
  const userDataDir = nextManagedProfileDir(name, managedProfilesDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, '.webmcp-meta.json'),
    `${JSON.stringify({ name: name || path.basename(userDataDir), createdAt: Date.now() }, null, 2)}\n`,
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

function spawnChrome({ chromePath, extensionPath, userDataDir, profileDir, mode, attached, dryRun }) {
  const args = baseArgs({ extensionPath, userDataDir, profileDir });
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
    };
  }

  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
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
  };
}

function validateExtensionPath(extensionPath) {
  if (!extensionPath || !fs.existsSync(extensionPath)) {
    throw new Error(`Extension dist not found at ${extensionPath || '(empty)'}.`);
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
      return annotate(spawnChrome({ chromePath, extensionPath, userDataDir, profileDir, mode: 'existing', attached: true, dryRun: options.dryRun }));
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
      await quitChrome();
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

    const result = spawnChrome({ chromePath, extensionPath, userDataDir, profileDir, mode: 'existing', dryRun: options.dryRun });
    if (result.pid) rememberManagedSession(userDataDir, result.pid, sessionsFile);
    return annotate(result);
  }

  const userDataDir = options.profile?.userDataDir ||
    (options.dryRun
      ? nextManagedProfileDir(options.newProfileName, managedProfilesDir)
      : createManagedProfile(options.newProfileName, { managedProfilesDir, sessionsFile }));
  const result = spawnChrome({
    chromePath,
    extensionPath,
    userDataDir,
    profileDir: options.profile?.profileDir || 'Default',
    mode: 'managed',
    dryRun: options.dryRun,
  });
  if (result.pid) rememberManagedSession(userDataDir, result.pid, sessionsFile);
  return annotate(result);
}

async function closeChrome(options = {}) {
  const { profileId, all, gatewayUrl = 'http://localhost:7865', token = process.env.WEBMCP_GATEWAY_TOKEN } = options;
  
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
    // Find matching profileId by exact id, or by email, or by name
    for (const d of connectedDetails) {
      if (d.profileId.toLowerCase() === profileId.toLowerCase() ||
          (d.email && d.email.toLowerCase() === profileId.toLowerCase()) ||
          (d.name && d.name.toLowerCase() === profileId.toLowerCase())) {
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
        
        if (profileId.toLowerCase() === `managed:${baseName}`.toLowerCase() ||
            profileId.toLowerCase() === baseName.toLowerCase() ||
            (meta.name && meta.name.toLowerCase() === profileId.toLowerCase())) {
          shouldKill = true;
        }
      }
      
      if (shouldKill && session?.pid) {
        try {
          process.kill(session.pid, 'SIGKILL');
          delete state.managedSessions[userDataDir];
          changed = true;
          closedCount++;
        } catch {
          // already dead or not permitted
        }
        // Clean stale lock files left behind by the killed process
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
  isProfileLocked,
  cleanStaleLocks,
  slugify,
  nextManagedProfileDir,
  createManagedProfile,
  baseArgs,
  detectChromeChannel,
  detectChromeInfo,
  loadExtensionSupported,
  loadExtensionGuidance,
  quitChrome,
  waitForUnlock,
  launchChrome,
  closeChrome,
};
