'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const {
  ensureDirs,
  MANAGED_PROFILES_DIR,
  SESSIONS_FILE,
} = require('./config');
const {
  hasLiveManagedSession,
  rememberManagedSession,
} = require('./sessions');

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

function isProfileLocked(userDataDir) {
  return ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].some((fileName) =>
    fs.existsSync(path.join(userDataDir, fileName)),
  );
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
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ];
  if (profileDir) args.push(`--profile-directory=${profileDir}`);
  return args;
}

function quitChrome() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'tell application "Google Chrome" to quit'], () => resolve());
    } else if (process.platform === 'win32') {
      execFile('taskkill', ['/IM', 'chrome.exe', '/F'], () => resolve());
    } else {
      execFile('pkill', ['-TERM', 'chrome'], () => resolve());
    }
  });
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

  if (mode === 'existing') {
    if (!options.profile?.userDataDir) throw new Error('Missing existing profile info.');
    const userDataDir = options.profile.userDataDir;
    const profileDir = options.profile.profileDir || 'Default';

    if (hasLiveManagedSession(userDataDir, sessionsFile)) {
      return spawnChrome({ chromePath, extensionPath, userDataDir, profileDir, mode: 'existing', attached: true, dryRun: options.dryRun });
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
    return result;
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
  return result;
}

module.exports = {
  defaultExtensionPath,
  chromeCandidates,
  findChromeBinary,
  isProfileLocked,
  slugify,
  nextManagedProfileDir,
  createManagedProfile,
  baseArgs,
  quitChrome,
  waitForUnlock,
  launchChrome,
};
