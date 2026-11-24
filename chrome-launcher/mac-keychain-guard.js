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
 * Inspect a managed or existing profile's SQLite Cookies DB on macOS to determine whether its
 * cookies are encrypted with legacy `v10` Keychain Safe Storage, modern `v11`, `mixed`, or `none`.
 * Uses a WAL-safe temp-dir copy + `/usr/bin/sqlite3` without `immutable=1` or `mode=ro` so
 * live WAL frames and hot rollback journals are replayed accurately.
 * @param {string} userDataDir
 * @param {string} [profileDir='Default']
 * @param {object} [opts]
 * @returns {'none'|'v10'|'v11'|'mixed'|'unknown'|'other'}
 */
function detectMacCookieEncryptionMode(userDataDir, profileDir = 'Default', opts = {}) {
  const { platform = process.platform, env = process.env } = opts || {};
  if (platform !== 'darwin') return 'other';

  const override = String((env || process.env)?.WEBMCP_COOKIE_MODE || '').trim().toLowerCase();
  if (override === 'v10' || override === 'v11') return override;

  if (!userDataDir) return 'none';
  const effectiveProfileDir = profileDir || 'Default';
  const candidates = [
    path.join(userDataDir, effectiveProfileDir, 'Network', 'Cookies'),
    path.join(userDataDir, effectiveProfileDir, 'Cookies'),
  ];
  const dbPath = candidates.find((p) => fs.existsSync(p));
  if (!dbPath) return 'none';

  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-ckmode-'));
    fs.chmodSync(tmpDir, 0o700);
    const tmpDb = path.join(tmpDir, 'Cookies');
    fs.copyFileSync(dbPath, tmpDb);
    try { fs.chmodSync(tmpDb, 0o600); } catch {}
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const auxSrc = `${dbPath}${suffix}`;
      if (fs.existsSync(auxSrc)) {
        const auxDst = `${tmpDb}${suffix}`;
        fs.copyFileSync(auxSrc, auxDst);
        try { fs.chmodSync(auxDst, 0o600); } catch {}
      }
    }

    const out = execFileSync(
      '/usr/bin/sqlite3',
      [
        '-noheader',
        '-batch',
        tmpDb,
        "SELECT COALESCE(SUM(CASE WHEN substr(encrypted_value,1,3)=X'763130' THEN 1 ELSE 0 END),0), COALESCE(SUM(CASE WHEN substr(encrypted_value,1,3)=X'763131' THEN 1 ELSE 0 END),0) FROM cookies WHERE length(encrypted_value)>=3;",
      ],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parts = String(out || '').trim().split('|');
    if (parts.length !== 2) return 'unknown';
    const v10 = Number.parseInt(parts[0], 10);
    const v11 = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(v10) || !Number.isFinite(v11)) return 'unknown';
    if (v10 === 0 && v11 === 0) return 'none';
    if (v10 > 0 && v11 === 0) return 'v10';
    if (v11 > 0 && v10 === 0) return 'v11';
    if (v10 > 0 && v11 > 0) return 'mixed';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Resolve whether macOS v10 UserDataDirProtection features must be disabled and fail closed
 * on ambiguous (`mixed`) or unreadable (`unknown`) cookie databases when launching real Chrome.
 * @param {object} [options]
 * @returns {{ preserveMacV10Keychain: boolean, mode: string }}
 */
function resolveMacV10Shield({
  userDataDir,
  profileDir = 'Default',
  chromePath,
  dryRun = false,
  env = process.env,
  platform = process.platform,
  detectFn,
} = {}) {
  if (platform !== 'darwin') {
    return { preserveMacV10Keychain: false, mode: 'other' };
  }
  const detector = typeof detectFn === 'function' ? detectFn : detectMacCookieEncryptionMode;
  const mode = detector(userDataDir, profileDir, { env, platform });

  const enforceFailClosed = !dryRun && (chromePath === undefined || isRealChromeBinary(chromePath));
  if (enforceFailClosed) {
    if (mode === 'mixed') {
      const err = new Error(
        `ERR_MACOS_COOKIE_MODE_MIXED: Cookies DB in "${userDataDir}" (${profileDir}) contains mixed v10 and v11 cookies. ` +
        `Refusing to guess Keychain shield flags because a wrong choice could wipe cookies. ` +
        `Set WEBMCP_COOKIE_MODE=v10|v11 to override.`
      );
      err.code = 'ERR_MACOS_COOKIE_MODE_MIXED';
      err.mode = mode;
      err.userDataDir = userDataDir;
      throw err;
    }
    if (mode === 'unknown') {
      const err = new Error(
        `ERR_MACOS_COOKIE_MODE_UNKNOWN: Could not determine cookie encryption mode for "${userDataDir}" (${profileDir}). ` +
        `Refusing to launch real Chrome without knowing cookie format; set WEBMCP_COOKIE_MODE=v10|v11 to override.`
      );
      err.code = 'ERR_MACOS_COOKIE_MODE_UNKNOWN';
      err.mode = mode;
      err.userDataDir = userDataDir;
      throw err;
    }
  }

  return {
    preserveMacV10Keychain: mode === 'v10',
    mode,
  };
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
 * Never calls `security unlock-keychain` or touches Keychain when outside Aqua / under SSH_*.
 * Uses non-interactive JXA `SecKeychainGetStatus` (<50ms) instead of `security show-keychain-info`.
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

  const effectiveEnv = env || process.env;
  const hasSshEnv = Object.keys(effectiveEnv).some(
    (k) => /^SSH_(CONNECTION|CLIENT|TTY)$/.test(k) && Boolean(effectiveEnv[k]),
  );

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

  if (hasSshEnv || managerName !== 'Aqua') {
    return {
      ok: false,
      reason: 'non-aqua',
      code: 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED',
      platform,
      managerName,
      hasSshEnv,
      keychainOk: false,
    };
  }

  const kcPath = path.join(homedir, 'Library', 'Keychains', 'login.keychain-db');
  const jxa = `ObjC.import('Security');$.SecKeychainSetUserInteractionAllowed(false);const k=Ref(),s=Ref();if($.SecKeychainOpen(${JSON.stringify(kcPath)},k)||$.SecKeychainGetStatus(k[0],s)||!(s[0]&1))throw 'locked';`;
  try {
    execFileSyncFn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], {
      timeout: 3000,
      stdio: 'ignore',
    });
  } catch {
    return {
      ok: false,
      reason: 'keychain-locked',
      code: 'ERR_MACOS_KEYCHAIN_LOCKED',
      platform,
      managerName,
      hasSshEnv,
      keychainOk: false,
    };
  }

  return {
    ok: true,
    platform,
    managerName,
    hasSshEnv: false,
    keychainOk: true,
  };
}

/**
 * Fail closed before launching real Chrome or querying Keychain on macOS when outside Aqua GUI / Keychain access.
 */
function assertMacosAquaKeychainSession({ chromePath, dryRun = false, env, probe, forceCheck = false } = {}) {
  if (dryRun) return { ok: true, skipped: 'dryRun' };
  if (!forceCheck && process.platform !== 'darwin') return { ok: true, skipped: 'non-darwin' };
  if (!forceCheck && !isRealChromeBinary(chromePath)) return { ok: true, skipped: 'non-chrome-binary' };

  const res = typeof probe === 'function' ? probe() : probeMacosAquaKeychainSession({ env });
  if (!res || !res.ok) {
    const details = res || {
      ok: false,
      platform: process.platform,
      managerName: 'unknown',
      hasSshEnv: false,
      keychainOk: false,
    };
    const code = details.code || (details.reason === 'keychain-locked'
      ? 'ERR_MACOS_KEYCHAIN_LOCKED'
      : 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED');
    const msg = code === 'ERR_MACOS_KEYCHAIN_LOCKED'
      ? `${code}: macOS login.keychain-db is locked or inaccessible ` +
        `(managerName=${details.managerName}, hasSshEnv=${details.hasSshEnv}, keychainOk=${details.keychainOk}) ` +
        `and launching Chrome here would wipe encrypted cookies. Unlock login.keychain-db in the gui/$uid Aqua session first.`
      : `${code}: macOS Keychain Safe Storage is inaccessible outside an Aqua GUI session ` +
        `(managerName=${details.managerName}, hasSshEnv=${details.hasSshEnv}, keychainOk=${details.keychainOk}) ` +
        `and launching Chrome here would wipe encrypted cookies. Launch inside the user's gui/$uid Aqua session (e.g. launchctl bootstrap gui/$uid).`;
    const err = new Error(msg);
    err.code = code;
    err.details = details;
    throw err;
  }
  return res;
}

module.exports = {
  MAC_V10_KEYCHAIN_SHIELD_FEATURES,
  detectMacCookieEncryptionMode,
  resolveMacV10Shield,
  isRealChromeBinary,
  probeMacosAquaKeychainSession,
  assertMacosAquaKeychainSession,
};
