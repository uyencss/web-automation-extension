'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { isPidAlive } = require('./sessions');
const {
  ensureDirs,
  MANAGED_PROFILES_DIR,
  SESSIONS_FILE,
  patchJson,
} = require('./config');
const {
  hasLiveManagedSession,
  rememberManagedSession,
  loadSessions,
  saveSessions,
} = require('./sessions');
const { norm, findManagedProfileByNameOrId } = require('./profiles');
const {
  MAC_V10_KEYCHAIN_SHIELD_FEATURES,
  detectMacCookieEncryptionMode,
  resolveMacV10Shield,
  probeMacosAquaKeychainSession,
  assertMacosAquaKeychainSession,
  assertNoForbiddenManagedArgs,
} = require('./mac-keychain-guard');
const {
  resolveManagedProxyConfig,
  hasProxyServerArg,
  applyProxyLaunchArgs,
  assertRequireProxy,
  inspectRunningChromeHasProxy,
  assertRunningChromeHasProxy,
  prepareLaunchProxy,
} = require('./proxy-guard');

const WEBMCP_EXTENSION_ID = 'lbodkmkjbcemodklopcfdmpjomdoapae';
const WEBMCP_EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/webmcp-tools-provider/${WEBMCP_EXTENSION_ID}`;

function defaultExtensionPath() {
  const browserExt = path.resolve(__dirname, '..', 'webmcp-extension', 'dist');
  const vaultCandidates = [
    path.resolve(__dirname, '..', '..', '..', 'apps', 'webmcp-vault-kit', 'webmcp-vault-extension', 'dist'),
    path.resolve(__dirname, '..', '..', 'webmcp-vault-kit', 'webmcp-vault-extension', 'dist'),
  ];
  for (const vaultExt of vaultCandidates) {
    if (fs.existsSync(path.join(vaultExt, 'manifest.json'))) {
      return `${browserExt},${vaultExt}`;
    }
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

const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];

const ON_DEVICE_AI_DISABLED_FEATURES = [
  'OptimizationGuideOnDeviceModel',
  'OnDeviceModelBackgroundDownload',
  'AIApiFoundationalModel',
  'OptimizationGuideModelDownloading',
  'OptimizationGuideModelExecution',
  'OptimizationHintsFetching',
  'OptimizationTargetPrediction',
  'ClientSideDetectionBrandAndIntentForScamDetection',
  'PromptAPIForGeminiNano',
  'SummarizationAPIForGeminiNano',
  'WriterAPIForGeminiNano',
  'RewriterAPIForGeminiNano',
  'AIPromptAPI',
  'AISummarizationAPI',
  'AIWriterAPI',
  'AIRewriterAPI',
  'AIProofreadingAPI',
];

const ON_DEVICE_AI_DISABLED_SET = new Set(ON_DEVICE_AI_DISABLED_FEATURES);

const BASE_MANAGED_DISABLED_FEATURES = [
  'DeviceBoundSessions',
  'DeviceBoundSessionsBypassDeferralsForRefreshRequests',
  'DeviceBoundSessionsClientCertSelection',
  'DeviceBoundSessionsDevTools',
  'DeviceBoundSessionsFederatedRegistration',
  'DeviceBoundSessionsPersistExpiryOnRefresh',
  'DeviceBoundSessionsForRestrictedSites',
  'DeviceBoundSessionsForSingleSignOn',
  'DeviceBoundSessionsIncludeAudienceClaim',
  'DeviceBoundSessionsRetryTransientRefreshErrors',
  'DeviceBoundSessionsDsePrewarmer',
  'EnableBoundSessionCredentials',
  'EnableBoundSessionCredentialsContinuity',
  'EnableCookieBindingCookieUpgrade',
  'EnableChromeRefreshTokenBinding',
  'EnableChromeRefreshTokenBindingUpgrade',
  'EnableOAuthMultiloginCookiesBinding',
  'EnableOAuthMultiloginCookiesBindingServerExperiment',
  'EnableOAuthMultiloginStandardCookiesBinding',
  'EnableOAuthMultiloginStandardCookiesBindingForSecondaryPartitions',
  'EnableOAuthMultiloginYoutubeCookiesBinding',
  'OAuthMultiloginYoutubeCookieBindingEnforced',
  'RefreshTokenBindingUpgrade',
  'UseDeviceBoundSessionsStorageMaskForDeletion',
  'GlicClearDeviceBoundSessionsOnFirstSync',
  'FlashDeprecationWarning',
  'EnablePasswordsAccountStorage',
];

function buildManagedShieldArgs({ allowOnDeviceAi = false, preserveMacV10Keychain = false } = {}) {
  const base = allowOnDeviceAi
    ? BASE_MANAGED_DISABLED_FEATURES.filter((f) => !ON_DEVICE_AI_DISABLED_SET.has(f))
    : [...BASE_MANAGED_DISABLED_FEATURES, ...ON_DEVICE_AI_DISABLED_FEATURES];
  const features = preserveMacV10Keychain ? [...base, ...MAC_V10_KEYCHAIN_SHIELD_FEATURES] : base;
  return [
    '--disable-field-trial-config',
    '--enable-features=BoundSessionCredentialsKillSwitch',
    `--disable-features=${features.join(',')}`,
  ];
}

const MANAGED_SESSION_SHIELD_ARGS = buildManagedShieldArgs({ allowOnDeviceAi: false });

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

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses a CLI flag value from a commandLine string (/ponytail exact parser).
 * Handles:
 *   --flag="val"
 *   --flag='val'
 *   --flag=val (terminated by space before next flag --, protocol://, about:, or end of line)
 * @param {string} commandLine
 * @param {string} flagName
 * @returns {string|null}
 */
function extractCliFlagValue(commandLine, flagName) {
  if (!commandLine || typeof commandLine !== 'string' || !flagName) return null;
  const escaped = escapeRegExp(flagName);
  const re = new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]+)"|'([^']+)'|(.+?))(?=\\s+(?:--|[a-zA-Z]+://|about:)|$)`);
  const match = commandLine.match(re);
  if (!match) return null;
  const val = match[1] ?? match[2] ?? match[3];
  return val != null ? val.trim() : null;
}

function expandTilde(p) {
  if (!p) return '';
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function pathsMatch(pathA, pathB) {
  if (!pathA || !pathB) return false;
  const resA = path.resolve(expandTilde(pathA));
  const resB = path.resolve(expandTilde(pathB));
  if (resA === resB) return true;
  try {
    if (fs.existsSync(resA) && fs.existsSync(resB)) {
      return fs.realpathSync(resA) === fs.realpathSync(resB);
    }
  } catch {}
  return false;
}

function resolveRealPathWithFallback(targetPath) {
  let curr = path.resolve(targetPath);
  const segments = [];
  while (!fs.existsSync(curr)) {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    segments.unshift(path.basename(curr));
    curr = parent;
  }
  let realBase = curr;
  try {
    if (fs.existsSync(curr)) {
      realBase = fs.realpathSync(curr);
    }
  } catch {}
  return segments.length ? path.join(realBase, ...segments) : realBase;
}

function matchChromePidInPsOutput(psOutput, { userDataDir, profileDir } = {}) {
  if (!psOutput || typeof psOutput !== 'string' || !userDataDir) return null;
  const lines = psOutput.split('\n');
  for (const line of lines) {
    if (line.includes('--type=') || line.includes('/usr/bin/open')) continue;
    const uddVal = extractCliFlagValue(line, '--user-data-dir');
    if (!uddVal || !pathsMatch(uddVal, userDataDir)) continue;
    if (profileDir) {
      const pdirVal = extractCliFlagValue(line, '--profile-directory');
      if (pdirVal ? pdirVal !== profileDir : profileDir !== 'Default') continue;
    }
    const match = line.trim().match(/^(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

function getPsArgs() {
  return process.platform === 'linux' ? ['-wweo', 'pid=,args='] : ['-axww', '-o', 'pid=,command='];
}

function resolveFingerprintSeedInt(meta = {}) {
  if (typeof meta.fingerprintSeedInt === 'number' && Number.isFinite(meta.fingerprintSeedInt)) {
    return meta.fingerprintSeedInt >>> 0;
  }
  const raw = meta.fingerprintSeed;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw >>> 0;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return Number(trimmed) >>> 0;
    let hash = 2166136261;
    for (let i = 0; i < trimmed.length; i += 1) {
      hash ^= trimmed.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }
  return null;
}

function findChromePidForUserDataDir(userDataDir) {
  return findRunningChromePid({ userDataDir, mode: 'existing' });
}

function findRunningChromePid({ userDataDir, profileDir, mode }) {
  if (mode === 'managed') {
    const lockPid = readLockPid(userDataDir);
    if (lockPid && isPidAlive(lockPid)) return lockPid;
  }
  try {
    const out = execFileSync('ps', getPsArgs(), { encoding: 'utf8' });
    const pid = matchChromePidInPsOutput(out, { userDataDir, profileDir });
    if (pid && isPidAlive(pid)) return pid;
  } catch {}
  return null;
}

async function findRunningChromePidAsync({ userDataDir, profileDir, mode, psOutputFn } = {}) {
  if (mode === 'managed') {
    const lockPid = readLockPid(userDataDir);
    if (lockPid && isPidAlive(lockPid)) return lockPid;
  }
  try {
    let out;
    if (typeof psOutputFn === 'function') {
      out = await psOutputFn();
    } else {
      out = await new Promise((resolve) => {
        execFile('ps', getPsArgs(), { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
          if (err) resolve('');
          else resolve(stdout || '');
        });
      });
    }
    const pid = matchChromePidInPsOutput(out, { userDataDir, profileDir });
    if (pid && isPidAlive(pid)) return pid;
  } catch {}
  return null;
}

function resolveMacAppBundle(chromePath, args = []) {
  if (
    process.platform === 'darwin' &&
    typeof chromePath === 'string' &&
    !(Array.isArray(args) && args.some((a) => String(a).startsWith('--headless')))
  ) {
    let resolved = chromePath;
    try {
      if (fs.existsSync(chromePath)) {
        resolved = fs.realpathSync(chromePath);
      }
    } catch {}
    if (resolved.includes('.app/Contents/MacOS/')) {
      const idx = resolved.indexOf('.app/Contents/MacOS/');
      return resolved.slice(0, idx + 4);
    }
  }
  return null;
}

function readLockDetails(userDataDir) {
  const lockPath = path.join(userDataDir, 'SingletonLock');
  try {
    const target = fs.readlinkSync(lockPath);
    const match = target.match(/^(.*)-(\d+)$/);
    if (match) {
      return { exists: true, isSymlink: true, host: match[1] || null, pid: parseInt(match[2], 10) };
    }
    return { exists: true, isSymlink: true, host: null, pid: null };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, isSymlink: false, host: null, pid: null };
    return { exists: true, isSymlink: false, host: null, pid: null };
  }
}

function readLockPid(userDataDir) {
  return readLockDetails(userDataDir).pid;
}

function findLiveChromePidViaPs(userDataDir) {
  try {
    const out = execFileSync('ps', getPsArgs(), { encoding: 'utf8' });
    const pid = matchChromePidInPsOutput(out, { userDataDir });
    if (pid && isPidAlive(pid)) return pid;
  } catch {}
  return null;
}

/**
 * Check whether a Chrome profile directory is locked by a live process.
 * If lock files exist but the owning local PID is dead (stale locks), they are
 * automatically cleaned up and the function returns false.
 */
function isProfileLocked(userDataDir) {
  const lock = readLockDetails(userDataDir);
  const hasLockfile = (() => {
    try { return Boolean(fs.lstatSync(path.join(userDataDir, 'lockfile'))); } catch { return false; }
  })();

  if (lock.pid !== null) {
    const shortHost = (h) => String(h || '').trim().toLowerCase().split('.')[0];
    const localHost = !lock.host || lock.host === os.hostname() || shortHost(lock.host) === shortHost(os.hostname());
    if (isPidAlive(lock.pid)) {
      return true;
    }
    if (localHost && !hasLockfile) {
      cleanStaleLocks(userDataDir);
      return false;
    }
    if (findLiveChromePidViaPs(userDataDir)) {
      return true;
    }
    if (localHost) {
      cleanStaleLocks(userDataDir);
      return false;
    }
    return true;
  }

  const anyLockExists = LOCK_FILES.some((f) => {
    try {
      return Boolean(fs.lstatSync(path.join(userDataDir, f)));
    } catch {
      return false;
    }
  });
  if (!anyLockExists) {
    return false;
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
    '--disable-blink-features=AutomationControlled',
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

  for (const feat of commaFlagGroups['--enable-features=']) {
    const baseName = feat.split(':')[0];
    commaFlagGroups['--disable-features='].delete(feat);
    commaFlagGroups['--disable-features='].delete(baseName);
  }
  for (const feat of commaFlagGroups['--enable-blink-features=']) {
    commaFlagGroups['--disable-blink-features='].delete(feat);
  }

  for (const [prefix, set] of Object.entries(commaFlagGroups)) {
    if (set.size > 0) {
      otherArgs.push(`${prefix}${Array.from(set).join(',')}`);
    }
  }

  return otherArgs;
}

const mergeChromiumFeatureFlags = mergeChromeLaunchArgs;

async function spawnChrome({ chromePath, extensionPath, userDataDir, profileDir, mode, attached, dryRun, skipGuardForTest = false, cookieMode, extraArgs, env }) {
  const mergedEnv = env ? { ...process.env, ...env } : { ...process.env };
  assertMacosAquaKeychainSession({ dryRun, skipGuardForTest, env: mergedEnv });
  assertNoForbiddenManagedArgs(extraArgs);
  const shield = resolveMacV10Shield({
    userDataDir,
    profileDir: profileDir || 'Default',
    dryRun,
    skipGuardForTest,
    env: mergedEnv,
    cookieMode,
  });
  const shieldArgs = shield.preserveMacV10Keychain
    ? [`--disable-features=${MAC_V10_KEYCHAIN_SHIELD_FEATURES.join(',')}`]
    : [];
  const rawBase = baseArgs({ extensionPath, userDataDir, profileDir });
  const args = mergeChromeLaunchArgs(rawBase, [...(extraArgs || []), ...shieldArgs]);
  if (
    process.platform !== 'darwin' &&
    process.platform !== 'win32' &&
    !mergedEnv.DBUS_SESSION_BUS_ADDRESS &&
    typeof process.getuid === 'function'
  ) {
    const dbusPath = `/run/user/${process.getuid()}/bus`;
    if (fs.existsSync(dbusPath)) {
      mergedEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${dbusPath}`;
    }
  }

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

  const appBundle = resolveMacAppBundle(chromePath, args);
  if (appBundle) {
    const openArgs = ['-na', appBundle];
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        if (v != null && v !== '' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          openArgs.push('--env', `${k}=${v}`);
        }
      }
    }
    openArgs.push('--args', ...args);

    await new Promise((resolve, reject) => {
      execFile('/usr/bin/open', openArgs, { timeout: 10000, stdio: 'ignore' }, (err) => {
        if (err) {
          reject(new Error(`Failed to launch Chrome via LaunchServices (/usr/bin/open): ${err.message}`));
        } else {
          resolve();
        }
      });
    });

    let resolvedPid = null;
    if (attached) {
      resolvedPid = await findRunningChromePidAsync({ userDataDir, profileDir, mode });
    } else {
      resolvedPid = await findRunningChromePidAsync({ userDataDir, profileDir, mode });
      if (!resolvedPid) {
        const start = Date.now();
        while (Date.now() - start < 3000) {
          await new Promise((r) => setTimeout(r, 100));
          resolvedPid = await findRunningChromePidAsync({ userDataDir, profileDir, mode });
          if (resolvedPid) break;
        }
      }
    }

    if (mode === 'managed' && !attached && !resolvedPid && !readLockPid(userDataDir)) {
      throw new Error('Chrome launched via LaunchServices exited before acquiring managed profile lock');
    }

    return {
      ok: true,
      pid: resolvedPid || null,
      launchedViaLaunchServices: true,
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

function activateMacPid(targetPid) {
  const num = Number(targetPid);
  if (!Number.isInteger(num) || num <= 0) return;
  try {
    execFileSync('osascript', [
      '-l', 'JavaScript', '-e',
      `ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${num}); if (a && !a.isNil()) { a.unhide; a.activateWithOptions(3); }`,
    ], { timeout: 1500, stdio: 'ignore' });
  } catch {}
}

function readMetaFileStrict(metaPath) {
  if (!fs.existsSync(metaPath)) return null;
  try {
    const p = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Metadata root must be a JSON object');
    return p;
  } catch (err) {
    const e = new Error(`Corrupt profile metadata at ${metaPath}: ${err.message}`);
    e.code = 'ERR_META_UNREADABLE';
    throw e;
  }
}

async function focusOrOpenRunningChrome({ chromePath, userDataDir, profileDir, mode, initialUrl, dryRun, skipGuardForTest = false, cookieMode, env, requireProxy = false, proxyCfg: explicitProxyCfg = null, extraArgs = [], inspectPidCmdlineFn }) {
  const effectivePdir = profileDir || 'Default';
  const meta = readMetaFileStrict(path.join(userDataDir, '.webmcp-meta.json'))
    || readMetaFileStrict(path.join(userDataDir, effectivePdir, '.webmcp-meta.json'))
    || {};
  const proxyCfg = explicitProxyCfg || resolveManagedProxyConfig(meta?.proxy);
  const proxyPassthrough = (Array.isArray(extraArgs) ? extraArgs : []).filter((a) => /^--(proxy-server|proxy-bypass-list|force-webrtc-ip-handling-policy)=/i.test(String(a)));
  const effectiveRequireProxy = requireProxy === true || meta?.requireProxy === true || Boolean(proxyCfg?.cleanUrl);
  const lockPid = readLockPid(userDataDir);
  const pid = (lockPid && isPidAlive(lockPid)) ? lockPid : await findRunningChromePidAsync({ userDataDir, profileDir: effectivePdir, mode });
  const base = { ok: true, pid: pid || null, chromePath, userDataDir, profileDir: effectivePdir, mode: mode || 'managed', attached: true, focused: true };
  if (dryRun) return { ...base, dryRun: true };
  if (effectiveRequireProxy && pid) {
    await assertRunningChromeHasProxy({ pid, requireProxy: true, dryRun, userDataDir, meta, proxyCfg, inspectPidCmdlineFn });
  }
  const assertSpawnProxyAllowed = () => {
    if (!pid && effectiveRequireProxy && !proxyCfg?.cleanUrl && !hasProxyServerArg(proxyPassthrough)) {
      const err = new Error(`Refusing to launch ${mode || 'managed'} Chrome on direct IP without a bound proxy (${userDataDir}).`);
      err.code = 'ERR_PROXY_UNBOUND_BLOCKED';
      throw err;
    }
  };

  const spawnDetached = (args) => {
    const child = spawn(chromePath, args, { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', () => {});
    child.unref();
  };

  if (process.platform === 'darwin') {
    let winCount = 0;
    if (pid && Number.isInteger(Number(pid)) && Number(pid) > 0) {
      try {
        const raw = execFileSync('osascript', ['-e', `tell application "System Events" to count windows of (first process whose unix id is ${Number(pid)})`], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
        winCount = parseInt(String(raw || '').trim(), 10) || 0;
      } catch { winCount = 0; }
    }
    if (winCount > 0) {
      activateMacPid(pid);
      try {
        execFileSync('osascript', ['-e', `tell application "System Events" to tell (first process whose unix id is ${Number(pid)}) to set value of attribute "AXMinimized" of every window to false`], { timeout: 1000, stdio: 'ignore' });
      } catch {}
      return { ...base, openedNewWindow: false };
    }
    assertSpawnProxyAllowed();
    const mergedEnv = env ? { ...process.env, ...env } : { ...process.env };
    assertMacosAquaKeychainSession({ dryRun, skipGuardForTest, env: mergedEnv });
    const shield = (!pid && !skipGuardForTest)
      ? resolveMacV10Shield({ userDataDir, profileDir: effectivePdir, dryRun, env: mergedEnv, cookieMode })
      : { preserveMacV10Keychain: false, mode: 'running' };
    const v10ShieldArgs = shield.preserveMacV10Keychain
      ? [`--disable-features=${MAC_V10_KEYCHAIN_SHIELD_FEATURES.join(',')}`]
      : [];
    const mergedSpawnArgs = mergeChromeLaunchArgs(
      [`--user-data-dir=${userDataDir}`, `--profile-directory=${effectivePdir}`, '--new-window', ...proxyPassthrough],
      v10ShieldArgs,
    );
    const { extraArgs: proxiedSpawnArgs } = applyProxyLaunchArgs(mergedSpawnArgs, proxyCfg);
    assertRequireProxy({ mode: mode || 'managed', requireProxy: effectiveRequireProxy, meta, proxyCfg, extraArgs: proxiedSpawnArgs, userDataDir });
    const spawnArgs = [
      ...proxiedSpawnArgs,
      initialUrl || 'chrome://newtab',
    ];
    const appBundle = resolveMacAppBundle(chromePath, spawnArgs);
    if (appBundle) {
      await new Promise((resolve, reject) => {
        execFile(
          '/usr/bin/open',
          ['-na', appBundle, '--args', ...spawnArgs],
          { timeout: 10000, stdio: 'ignore' },
          (err) => {
            if (err) reject(new Error(`Failed to launch Chrome via LaunchServices (/usr/bin/open): ${err.message}`));
            else resolve();
          },
        );
      });
    } else {
      spawnDetached(spawnArgs);
    }
    await new Promise((r) => setTimeout(r, 250));
    const finalPid = pid || readLockPid(userDataDir) || await findRunningChromePidAsync({ userDataDir, profileDir: effectivePdir, mode });
    if (finalPid) activateMacPid(finalPid);
    return { ...base, pid: finalPid || null, openedNewWindow: true };
  }

  if (process.platform !== 'win32' && pid && !initialUrl) {
    try {
      const wmOut = execFileSync('wmctrl', ['-lp'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
      const winLine = wmOut.split('\n').find((l) => l.trim().split(/\s+/)[2] === String(Number(pid)));
      if (winLine) {
        execFileSync('wmctrl', ['-ia', winLine.trim().split(/\s+/)[0]], { timeout: 1500, stdio: 'ignore' });
        return { ...base, openedNewWindow: false };
      }
    } catch {}
  }

  assertSpawnProxyAllowed();
  const { extraArgs: nonDarwinArgs } = applyProxyLaunchArgs(
    [`--user-data-dir=${userDataDir}`, `--profile-directory=${effectivePdir}`, ...proxyPassthrough, ...(initialUrl ? [initialUrl] : [])],
    proxyCfg,
  );
  assertRequireProxy({ mode: mode || 'managed', requireProxy: effectiveRequireProxy, meta, proxyCfg, extraArgs: nonDarwinArgs, userDataDir });
  spawnDetached(nonDarwinArgs);
  return base;
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

async function resolveAttachedChromePid({ userDataDir, profileDir, mode, sessionPid }) {
  const lockPid = readLockPid(userDataDir);
  if (lockPid && isPidAlive(lockPid)) return lockPid;
  if (sessionPid && isPidAlive(sessionPid)) return sessionPid;
  return await findRunningChromePidAsync({ userDataDir, profileDir, mode });
}

const warn = (err) => console.warn('[webmcp-browser-kit]', err?.message || err);

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
  let proxyAuthWarning = null;
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
    if (proxyAuthWarning) {
      extras.proxyAuthWarning = proxyAuthWarning;
    }
    return { ...result, ...extras };
  };

  const focusUrl = (Array.isArray(options.extraArgs) ? options.extraArgs : []).find((a) => /^https?:\/\//i.test(String(a || '')));

  if (mode === 'existing') {
    if (!options.profile?.userDataDir) throw new Error('Missing existing profile info.');
    const userDataDir = options.profile.userDataDir;
    const profileDir = options.profile.profileDir || 'Default';
    const proxyState = prepareLaunchProxy({ mode: 'existing', userDataDir, profileDir, options });
    const existingExtraArgs = proxyState.extraArgs;
    if (proxyState.proxyAuthWarning) proxyAuthWarning = proxyState.proxyAuthWarning;

    const targetProfilePath = path.join(userDataDir, profileDir);
    if (!fs.existsSync(targetProfilePath) && !options.dryRun) {
      const err = new Error(`Existing Chrome profile directory does not exist: ${targetProfilePath}`);
      err.code = 'EXISTING_PROFILE_DIR_NOT_FOUND';
      throw err;
    }

    if (!options.focusIfRunning || !isProfileLocked(userDataDir)) {
      assertMacosAquaKeychainSession({ dryRun: options.dryRun, skipGuardForTest: options.skipGuardForTest, env: options.env });
      resolveMacV10Shield({
        userDataDir,
        profileDir,
        dryRun: options.dryRun,
        skipGuardForTest: options.skipGuardForTest,
        env: options.env,
        cookieMode: options.cookieMode,
      });
    }

    if (isProfileLocked(userDataDir)) {
      if (!options.relaunch) {
        if (options.focusIfRunning) {
          await proxyState.assertAttached(() => resolveAttachedChromePid({ userDataDir, profileDir, mode: 'existing' }));
          return annotate(await focusOrOpenRunningChrome({ chromePath, userDataDir, profileDir, mode: 'existing', initialUrl: focusUrl, dryRun: options.dryRun, skipGuardForTest: options.skipGuardForTest, cookieMode: options.cookieMode, env: options.env, requireProxy: Boolean(proxyState.proxyCfg?.cleanUrl) || options.requireProxy === true, proxyCfg: proxyState.proxyCfg, extraArgs: existingExtraArgs, inspectPidCmdlineFn: options.inspectPidCmdlineFn }));
        }
        const hasProxyArg = hasProxyServerArg(existingExtraArgs);
        return {
          ok: false,
          needsRelaunch: true,
          userDataDir,
          profileDir,
          message:
            'Chrome is already running, so the WebMCP extension cannot be injected. ' +
            'Ask the user before quitting Chrome, then retry with --relaunch if approved.' +
            (hasProxyArg ? ' System Chrome is already running; --proxy-server requires closing Chrome first or converting this profile to Managed.' : ''),
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

    const result = await spawnChrome({ chromePath, extensionPath, userDataDir, profileDir, mode: 'existing', dryRun: options.dryRun, skipGuardForTest: options.skipGuardForTest, cookieMode: options.cookieMode, extraArgs: existingExtraArgs, env: options.env });
    return annotate(result);
  }

  assertNoForbiddenManagedArgs(options.extraArgs);

  const existingManagedDir = (!options.profile?.userDataDir && !options.forceCreate)
    ? findExistingManagedProfileDir(options.newProfileName, managedProfilesDir)
    : null;

  if (!options.profile?.userDataDir && !existingManagedDir && !options.dryRun) {
    assertMacosAquaKeychainSession({ dryRun: options.dryRun, skipGuardForTest: options.skipGuardForTest, env: options.env });
  }

  const userDataDir = options.profile?.userDataDir ||
    existingManagedDir ||
    (options.dryRun
      ? nextManagedProfileDir(options.newProfileName, managedProfilesDir)
      : createManagedProfile(options.newProfileName, { managedProfilesDir, sessionsFile }));

  if (options.profile?.userDataDir && !options.allowExternalManagedDir) {
    const resolvedUserDataDir = path.resolve(userDataDir);
    const resolvedManagedRoot = path.resolve(managedProfilesDir);
    let realManagedRoot = resolvedManagedRoot;
    try {
      if (fs.existsSync(resolvedManagedRoot)) {
        realManagedRoot = fs.realpathSync(resolvedManagedRoot);
      }
    } catch {}
    const realManagedPrefix = realManagedRoot.endsWith(path.sep) ? realManagedRoot : realManagedRoot + path.sep;

    const realUserDataDir = resolveRealPathWithFallback(resolvedUserDataDir);
    const isInside = realUserDataDir === realManagedRoot || realUserDataDir.startsWith(realManagedPrefix);
    if (!isInside) {
      const err = new Error(
        `Managed profile directory "${resolvedUserDataDir}" is outside managedProfilesDir root "${resolvedManagedRoot}". ` +
        `Refusing to launch to prevent rogue profile creation.`
      );
      err.code = 'MANAGED_DIR_OUT_OF_ROOT';
      throw err;
    }
  }

  if (options.profile?.userDataDir && !options.dryRun && !fs.existsSync(userDataDir)) {
    const err = new Error(`Managed Chrome profile directory does not exist: ${userDataDir}`);
    err.code = 'MANAGED_PROFILE_DIR_NOT_FOUND';
    throw err;
  }

  const meta = readMetaFileStrict(path.join(userDataDir, '.webmcp-meta.json')) || {};

  if (meta.forkedFrom && !meta.forkedFrom.startsWith('managed:') && !meta.forkedFrom.startsWith('Chromium:') && chromeInfo.channel === 'chromium' && !options.allowCrossChannelFork) {
    throw new Error(
      'Refusing to launch a profile forked from native Chrome on a custom Chromium binary ' +
      '(Keychain/Safe Storage mismatch would wipe encrypted cookies). Launch with native Chrome or create a fresh managed profile.'
    );
  }

  const effectiveProfileDir = options.profile?.profileDir || meta.profileDir || 'Default';

  const proxyState = prepareLaunchProxy({ mode: 'managed', userDataDir, profileDir: effectiveProfileDir, meta, options });
  const { proxyCfg, extraArgs: effectiveExtraArgs } = proxyState;
  if (proxyState.proxyAuthWarning) {
    proxyAuthWarning = proxyState.proxyAuthWarning;
  }
  if (meta.fingerprint?.locale && !effectiveExtraArgs.some((a) => String(a).startsWith('--lang='))) {
    effectiveExtraArgs.push(`--lang=${meta.fingerprint.locale}`);
  }

  const effectiveEnv = { ...(options.env || {}) };
  const resolvedTz = effectiveEnv.TZ || proxyCfg.timezone || meta.fingerprint?.timezone;
  if (!effectiveEnv.TZ && resolvedTz) {
    effectiveEnv.TZ = String(resolvedTz);
  }
  const spawnEnv = Object.keys(effectiveEnv).length > 0 ? effectiveEnv : options.env;

  const resolvedFingerprintSeedInt = resolveFingerprintSeedInt(meta);
  if (chromeInfo.channel === 'chromium' && resolvedFingerprintSeedInt !== null) {
    effectiveExtraArgs.push(`--fingerprint=${resolvedFingerprintSeedInt}`);
    if (resolvedTz) effectiveExtraArgs.push(`--timezone=${resolvedTz}`);
  }

  const allowOnDeviceAi = meta.allowOnDeviceAi === true;
  const hasCallerOrMetaOverrides = effectiveExtraArgs.length > 0 || Boolean(spawnEnv?.TZ);
  const managedExtraArgs = [
    ...buildManagedShieldArgs({ allowOnDeviceAi }),
    ...effectiveExtraArgs,
  ];

  const sessionPid = hasLiveManagedSession(userDataDir, sessionsFile)
    ? (loadSessions(sessionsFile).managedSessions?.[userDataDir]?.pid || null)
    : null;
  const checkAttachedProxy = () => proxyState.assertAttached(
    () => resolveAttachedChromePid({ userDataDir, profileDir: effectiveProfileDir, mode: 'managed', sessionPid }),
  );

  if (!options.relaunch && sessionPid) {
    await checkAttachedProxy();
    const focusRes = await focusOrOpenRunningChrome({ chromePath, userDataDir, profileDir: effectiveProfileDir, mode: 'managed', initialUrl: focusUrl, dryRun: options.dryRun, skipGuardForTest: options.skipGuardForTest, cookieMode: options.cookieMode, env: spawnEnv, inspectPidCmdlineFn: options.inspectPidCmdlineFn });
    if (options.dryRun) {
      const dryShield = resolveMacV10Shield({
        userDataDir,
        profileDir: effectiveProfileDir,
        dryRun: true,
        env: spawnEnv,
        cookieMode: options.cookieMode,
      });
      const dryManagedArgs = [
        ...buildManagedShieldArgs({ allowOnDeviceAi, preserveMacV10Keychain: dryShield.preserveMacV10Keychain }),
        ...effectiveExtraArgs,
      ];
      focusRes.args = mergeChromeLaunchArgs(baseArgs({ extensionPath, userDataDir, profileDir: effectiveProfileDir }), dryManagedArgs);
      focusRes.env = spawnEnv || null;
      focusRes.tz = spawnEnv?.TZ || null;
    }
    if (hasCallerOrMetaOverrides && !options.focusIfRunning) {
      focusRes.attachWarning = 'Chrome is already running for this profile; extraArgs and env (TZ) require --relaunch to take effect.';
    }
    return annotate(focusRes);
  }

  if (isProfileLocked(userDataDir) || (options.relaunch && sessionPid)) {
    if (!options.relaunch) {
      if (options.focusIfRunning) {
        await checkAttachedProxy();
        return annotate(await focusOrOpenRunningChrome({ chromePath, userDataDir, profileDir: effectiveProfileDir, mode: 'managed', initialUrl: focusUrl, dryRun: options.dryRun, skipGuardForTest: options.skipGuardForTest, cookieMode: options.cookieMode, env: spawnEnv, inspectPidCmdlineFn: options.inspectPidCmdlineFn }));
      }
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
    assertMacosAquaKeychainSession({ dryRun: options.dryRun, skipGuardForTest: options.skipGuardForTest, env: spawnEnv });
    resolveMacV10Shield({ userDataDir, profileDir: effectiveProfileDir, dryRun: options.dryRun, skipGuardForTest: options.skipGuardForTest, env: spawnEnv, cookieMode: options.cookieMode });
    let lockPid = readLockPid(userDataDir) || sessionPid;
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

  assertMacosAquaKeychainSession({ dryRun: options.dryRun, skipGuardForTest: options.skipGuardForTest, env: spawnEnv });
  if (!options.dryRun) {
    resolveMacV10Shield({ userDataDir, profileDir: effectiveProfileDir, dryRun: options.dryRun, skipGuardForTest: options.skipGuardForTest, env: spawnEnv, cookieMode: options.cookieMode });
  }

  const hasProvenance = Boolean(meta.forkedFrom || meta.convertedFrom || meta.migratedFrom);
  if (!options.dryRun && hasProvenance && !isProfileLocked(userDataDir)) {
    const {
      DETOX_SCHEMA_VERSION,
      detoxForkedManagedProfile,
      sanitizeManagedLocalState,
      purgeOnDeviceAiBloat,
      stripDbscFiles,
    } = require('./profile-fork');
    let needsDetoxUpgrade = !meta.detoxedForManaged || (Number(meta.detoxVersion) || 0) < DETOX_SCHEMA_VERSION;
    if (!needsDetoxUpgrade) {
      const prefsPath = path.join(userDataDir, effectiveProfileDir, 'Preferences');
      if (fs.existsSync(prefsPath)) {
        try {
          const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
          if (prefs?.signin?.allowed === true) {
            needsDetoxUpgrade = true;
          }
        } catch {}
      }
    }
    if (needsDetoxUpgrade) {
      try {
        detoxForkedManagedProfile(
          userDataDir,
          effectiveProfileDir,
          {
            ...(options.stripDbsc !== undefined ? { stripDbsc: options.stripDbsc } : {}),
            allowOnDeviceAi,
          }
        );
        try {
          meta = JSON.parse(fs.readFileSync(path.join(userDataDir, '.webmcp-meta.json'), 'utf8'));
        } catch (readErr) {
          warn(readErr);
        }
      } catch (err) {
        if (String(err?.message || err).includes('SQLITE_WAL_BUSY')) {
          return annotate({
            ok: false,
            code: 'SQLITE_WAL_BUSY',
            error: 'SQLITE_WAL_BUSY',
            userDataDir,
            profileDir: effectiveProfileDir,
            message: err?.message || String(err),
          });
        }
        warn(err);
      }
    } else {
      try {
        sanitizeManagedLocalState(userDataDir, effectiveProfileDir, meta.name || meta.displayName || path.basename(userDataDir), {
          allowOnDeviceAi,
          enforceOnDeviceAiPolicy: true,
        });
        purgeOnDeviceAiBloat(userDataDir, effectiveProfileDir, { allowOnDeviceAi, skipLockCheck: true });
      } catch {}
      if (options.stripDbsc !== false) {
        stripDbscFiles(path.join(userDataDir, effectiveProfileDir));
      }
    }
  } else if (!options.dryRun && !isProfileLocked(userDataDir)) {
    try {
      const { sanitizeManagedLocalState, purgeOnDeviceAiBloat, stripDbscFiles } = require('./profile-fork');
      sanitizeManagedLocalState(userDataDir, effectiveProfileDir, meta.name || meta.displayName || path.basename(userDataDir), {
        allowOnDeviceAi,
        enforceOnDeviceAiPolicy: true,
      });
      purgeOnDeviceAiBloat(userDataDir, effectiveProfileDir, { allowOnDeviceAi, skipLockCheck: true });
      if (options.stripDbsc !== false) {
        stripDbscFiles(path.join(userDataDir, effectiveProfileDir));
      }
    } catch {}
  }

  const result = await spawnChrome({
    chromePath,
    extensionPath,
    userDataDir,
    profileDir: effectiveProfileDir,
    mode: 'managed',
    dryRun: options.dryRun,
    skipGuardForTest: options.skipGuardForTest,
    cookieMode: options.cookieMode,
    extraArgs: managedExtraArgs,
    env: spawnEnv,
  });
  if (result.pid) rememberManagedSession(userDataDir, result.pid, sessionsFile);
  if (!options.dryRun && result.ok !== false) {
    try {
      const metaPath = path.join(userDataDir, '.webmcp-meta.json');
      patchJson(metaPath, (m) => {
        m.sessionDirty = true;
        m.lastLaunchedAt = new Date().toISOString();
      });
    } catch (err) {
      warn(err);
    }
  }
  return annotate(result);
}

function markManagedSessionClosed(userDataDir) {
  if (!userDataDir) return;
  try {
    const metaPath = path.join(userDataDir, '.webmcp-meta.json');
    if (!fs.existsSync(metaPath)) return;
    patchJson(metaPath, (m) => {
      m.sessionDirty = false;
      m.lastClosedAt = new Date().toISOString();
      m.sessionVersion = (typeof m.sessionVersion === 'number' ? m.sessionVersion : 0) + 1;
    });
  } catch (err) {
    warn(err);
  }
}

async function closeChrome(options = {}) {
  const { profileId, all, gatewayUrl = 'http://127.0.0.1:7865', token = process.env.WEBMCP_GATEWAY_TOKEN } = options;
  const managedProfilesDir = options.managedProfilesDir || MANAGED_PROFILES_DIR;
  const closedManagedDirs = new Set();

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
      targetsToClose.push(d);
    }
  } else if (profileId) {
    const q = norm(profileId);
    for (const d of connectedDetails) {
      if (norm(d.profileId) === q || (d.email && norm(d.email) === q) || (d.name && norm(d.name) === q)) {
        targetsToClose.push(d);
        break;
      }
    }
  }
  
  // 3. Send closeBrowser to targets
  for (const detail of targetsToClose) {
    const targetId = detail.profileId;
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
        if (detail.userDataDir) {
          closedManagedDirs.add(detail.userDataDir);
        } else {
          try {
            const matched = findManagedProfileByNameOrId(targetId, { managedProfilesDir })
              || (detail.name ? findManagedProfileByNameOrId(detail.name, { managedProfilesDir }) : null);
            if (matched?.userDataDir) closedManagedDirs.add(matched.userDataDir);
          } catch {}
        }
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
        let unlocked = false;
        try {
          unlocked = await waitForUnlock(userDataDir, options.gracefulTimeoutMs ?? 10000);
          if (!unlocked && isPidAlive(session.pid)) {
            process.kill(session.pid, 'SIGTERM');
            unlocked = await waitForUnlock(userDataDir, options.killTimeoutMs ?? 5000);
            if (!unlocked && options.forceKill === true && isPidAlive(session.pid)) {
              process.kill(session.pid, 'SIGKILL');
              unlocked = await waitForUnlock(userDataDir, 1000);
            }
          }
        } catch {
          // already dead or not permitted
          unlocked = !isProfileLocked(userDataDir);
        }
        if (unlocked || !isPidAlive(session.pid)) {
          delete state.managedSessions[userDataDir];
          changed = true;
          if (!closedManagedDirs.has(userDataDir)) closedCount++;
          cleanStaleLocks(userDataDir);
          closedManagedDirs.add(userDataDir);
        }
      }
    }
    
    if (changed) {
      saveSessions(state, sessionsFile);
    }
  } catch (err) {
    // ignore
  }

  await Promise.all([...closedManagedDirs].map(async (userDataDir) => {
    const unlocked = await waitForUnlock(userDataDir, 4000);
    if (unlocked !== false) markManagedSessionClosed(userDataDir);
  }));
  
  return { ok: true, closedCount };
}

module.exports = {
  WEBMCP_EXTENSION_ID,
  WEBMCP_EXTENSION_STORE_URL,
  defaultExtensionPath,
  chromeCandidates,
  findChromeBinary,
  readLockPid,
  extractCliFlagValue,
  matchChromePidInPsOutput,
  findRunningChromePid,
  findRunningChromePidAsync,
  findChromePidForUserDataDir,
  isProfileLocked,
  cleanStaleLocks,
  LOCK_FILES,
  ON_DEVICE_AI_DISABLED_FEATURES,
  MAC_V10_KEYCHAIN_SHIELD_FEATURES,
  detectMacCookieEncryptionMode,
  resolveMacV10Shield,
  probeMacosAquaKeychainSession,
  assertMacosAquaKeychainSession,
  assertNoForbiddenManagedArgs,
  buildManagedShieldArgs,
  MANAGED_SESSION_SHIELD_ARGS,
  slugify,
  nextManagedProfileDir,
  findExistingManagedProfileDir,
  createManagedProfile,
  baseArgs,
  mergeChromeLaunchArgs,
  mergeChromiumFeatureFlags,
  detectChromeChannel,
  detectChromeInfo,
  loadExtensionSupported,
  loadExtensionGuidance,
  quitChrome,
  waitForUnlock,
  launchChrome,
  closeChrome,
  markManagedSessionClosed,
  resolveMacAppBundle,
  spawnChrome,
  focusOrOpenRunningChrome,
  resolveManagedProxyConfig,
  assertRequireProxy,
  inspectRunningChromeHasProxy,
  assertRunningChromeHasProxy,
};
