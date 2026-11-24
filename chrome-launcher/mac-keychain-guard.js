'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MAC_V10_KEYCHAIN_SHIELD_FEATURES = [
  'kKeychainKeyProviderUserDataDirProtection',
  'KeychainKeyProviderUserDataDirProtection',
];

/**
 * Copy env and strip macOS SSH_* markers when launching GUI Chrome via LaunchServices
 * so the child never inherits SSH session variables.
 * @param {NodeJS.ProcessEnv} [baseEnv=process.env]
 * @returns {NodeJS.ProcessEnv}
 */
function stripMacSshEnv(baseEnv = process.env) {
  const out = { ...(baseEnv || {}) };
  if (process.platform === 'darwin') {
    delete out.SSH_CONNECTION;
    delete out.SSH_CLIENT;
    delete out.SSH_TTY;
  }
  return out;
}

/**
 * Inspect a managed profile's SQLite Cookies DB on macOS to determine whether its
 * cookies are still encrypted with legacy `v10` Keychain Safe Storage or `v11`.
 * @param {string} userDataDir
 * @param {string} [profileDir='Default']
 * @returns {'v10'|'v11'|'empty'|'unknown'|'other'}
 */
function detectMacCookieEncryptionMode(userDataDir, profileDir = 'Default') {
  if (process.platform !== 'darwin') return 'other';
  if (!userDataDir) return 'empty';
  const effectiveProfileDir = profileDir || 'Default';
  const candidates = [
    path.join(userDataDir, effectiveProfileDir, 'Cookies'),
    path.join(userDataDir, effectiveProfileDir, 'Network', 'Cookies'),
  ];
  const dbPath = candidates.find((p) => fs.existsSync(p));
  if (!dbPath) return 'empty';

  try {
    const uriPath = dbPath
      .replace(/%/g, '%25')
      .replace(/\?/g, '%3F')
      .replace(/#/g, '%23')
      .replace(/ /g, '%20');
    const out = execFileSync(
      '/usr/bin/sqlite3',
      [
        '-noheader',
        '-batch',
        `file:${uriPath}?mode=ro&immutable=1`,
        'SELECT CAST(substr(encrypted_value,1,3) AS TEXT), count(*) FROM cookies WHERE length(encrypted_value)>=3 GROUP BY 1;',
      ],
      { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let v10 = 0;
    let v11 = 0;
    for (const line of String(out || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf('|');
      if (sep <= 0) continue;
      const pfx = trimmed.slice(0, sep);
      const count = Number.parseInt(trimmed.slice(sep + 1), 10) || 0;
      if (pfx === 'v10') v10 += count;
      else if (pfx === 'v11') v11 += count;
    }
    if (v10 > 0 && v10 >= v11) return 'v10';
    if (v11 > 0) return 'v11';
    return 'empty';
  } catch {
    return 'unknown';
  }
}

/**
 * Return true for real Chrome/Chromium binaries; false for Node/shell test stubs.
 * @param {string} chromePath
 * @returns {boolean}
 */
function isRealChromeBinary(chromePath) {
  if (!chromePath || typeof chromePath !== 'string') return false;
  const trimmed = chromePath.trim();
  if (!trimmed || trimmed === process.execPath) return false;
  if (/\.(sh|js|mjs|cmd|bat)$/i.test(trimmed)) return false;
  const base = path.basename(trimmed).toLowerCase();
  if (base.startsWith('node') || base.startsWith('fake-')) return false;
  return true;
}

/**
 * Perform read-only checks verifying an unlocked macOS Aqua GUI session and Keychain access.
 * Never calls `security unlock-keychain` or modifies Keychain state.
 */
function probeMacosAquaKeychainSession(deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    homedir = os.homedir(),
    execFileSyncFn = execFileSync,
  } = deps;
  if (platform !== 'darwin') {
    return { ok: true, platform, skipped: true };
  }

  let managerName = 'unknown';
  try {
    const out = execFileSyncFn('/bin/launchctl', ['managername'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    managerName = String(out || '').trim() || 'unknown';
  } catch {
    managerName = 'unknown';
  }

  const effectiveEnv = env || process.env;
  const hasSshEnv = Boolean(effectiveEnv.SSH_CONNECTION || effectiveEnv.SSH_CLIENT || effectiveEnv.SSH_TTY);

  let keychainOk = false;
  try {
    execFileSyncFn(
      '/usr/bin/security',
      ['show-keychain-info', path.join(homedir, 'Library/Keychains/login.keychain-db')],
      { timeout: 1500, stdio: 'ignore' },
    );
    keychainOk = true;
  } catch {
    keychainOk = false;
  }

  return {
    ok: managerName === 'Aqua' && !hasSshEnv && keychainOk,
    platform,
    managerName,
    hasSshEnv,
    keychainOk,
  };
}

/**
 * Fail closed before launching real Chrome on macOS when outside Aqua GUI / Keychain access.
 */
function assertMacosAquaKeychainSession({ chromePath, dryRun = false, env, probe, forceCheck = false } = {}) {
  if (dryRun) return { ok: true, skipped: 'dryRun' };
  if (!forceCheck && process.platform !== 'darwin') return { ok: true, skipped: 'non-darwin' };
  if (!forceCheck && !isRealChromeBinary(chromePath)) return { ok: true, skipped: 'non-chrome-binary' };

  const res = typeof probe === 'function' ? probe() : probeMacosAquaKeychainSession({ env });
  if (!res || !res.ok) {
    const details = res || { ok: false, platform: process.platform, managerName: 'unknown', hasSshEnv: false, keychainOk: false };
    const err = new Error(
      `ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED: macOS Keychain Safe Storage is inaccessible outside an Aqua GUI session ` +
      `(managerName=${details.managerName}, hasSshEnv=${details.hasSshEnv}, keychainOk=${details.keychainOk}) ` +
      `and launching Chrome here would wipe encrypted cookies. Launch inside the user's gui/$uid Aqua session (e.g. launchctl bootstrap gui/$uid).`
    );
    err.code = 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED';
    err.details = details;
    throw err;
  }
  return res;
}

module.exports = {
  MAC_V10_KEYCHAIN_SHIELD_FEATURES,
  stripMacSshEnv,
  detectMacCookieEncryptionMode,
  isRealChromeBinary,
  probeMacosAquaKeychainSession,
  assertMacosAquaKeychainSession,
};
