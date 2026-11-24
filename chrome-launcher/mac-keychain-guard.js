'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MAC_V10_KEYCHAIN_SHIELD_FEATURES = [
  'KeychainKeyProviderUserDataDirProtection',
];

const ALLOWED_COOKIE_MODES = new Set(['none', 'v10', 'v11']);

/**
 * Inspect a managed or existing profile's SQLite Cookies DB on macOS to determine whether its
 * cookies are encrypted with legacy `v10` Keychain Safe Storage, modern `v11`, `mixed`, or `none`.
 * Uses a WAL-safe temp-dir copy + `/usr/bin/sqlite3 -noheader -batch` so live WAL frames and
 * hot rollback journals are replayed accurately without holding Chrome locks.
 * @param {string} userDataDir
 * @param {string} [profileDir='Default']
 * @param {object} [opts]
 * @returns {'none'|'v10'|'v11'|'mixed'|'unknown'|'other'}
 */
function detectMacCookieEncryptionMode(userDataDir, profileDir = 'Default', opts = {}) {
  const { platform = process.platform, env = process.env, cookieMode } = opts || {};
  if (platform !== 'darwin') return 'other';

  const perCallOverride = String(cookieMode || '').trim().toLowerCase();
  if (perCallOverride === 'v10' || perCallOverride === 'v11') return perCallOverride;

  const envOverride = String((env || process.env)?.WEBMCP_COOKIE_MODE || '').trim().toLowerCase();
  if (envOverride === 'v10' || envOverride === 'v11') return envOverride;

  if (!userDataDir) return 'none';
  const effectiveProfileDir = profileDir || 'Default';
  const candidates = [
    path.join(userDataDir, effectiveProfileDir, 'Network', 'Cookies'),
    path.join(userDataDir, effectiveProfileDir, 'Cookies'),
  ];
  const dbPath = candidates.find((p) => fs.existsSync(p));
  if (!dbPath) return 'none';

  try {
    if (fs.statSync(dbPath).size === 0) return 'none';
  } catch {
    return 'unknown';
  }

  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-ckmode-'));
    fs.chmodSync(tmpDir, 0o700);
    const tmpDb = path.join(tmpDir, 'Cookies');
    fs.copyFileSync(dbPath, tmpDb);
    try { fs.chmodSync(tmpDb, 0o600); } catch {}
    for (const suffix of ['-wal', '-journal']) {
      const auxSrc = `${dbPath}${suffix}`;
      if (fs.existsSync(auxSrc)) {
        const auxDst = `${tmpDb}${suffix}`;
        fs.copyFileSync(auxSrc, auxDst);
        try { fs.chmodSync(auxDst, 0o600); } catch {}
      }
    }

    const tblOut = execFileSync(
      '/usr/bin/sqlite3',
      ['-noheader', '-batch', tmpDb, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='cookies';"],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (String(tblOut || '').trim() === '0') return 'none';

    const out = execFileSync(
      '/usr/bin/sqlite3',
      [
        '-noheader',
        '-batch',
        tmpDb,
        "SELECT COALESCE(SUM(CASE WHEN length(encrypted_value)>=3 AND substr(encrypted_value,1,3)=X'763130' THEN 1 ELSE 0 END),0), " +
        "COALESCE(SUM(CASE WHEN length(encrypted_value)>=3 AND substr(encrypted_value,1,3)=X'763131' THEN 1 ELSE 0 END),0), " +
        "COALESCE(SUM(CASE WHEN length(encrypted_value)>0 AND (length(encrypted_value)<3 OR substr(encrypted_value,1,3) NOT IN (X'763130',X'763131')) THEN 1 ELSE 0 END),0) " +
        'FROM cookies WHERE length(encrypted_value)>0;',
      ],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parts = String(out || '').trim().split('|');
    if (parts.length !== 3) return 'unknown';
    const v10 = Number.parseInt(parts[0], 10);
    const v11 = Number.parseInt(parts[1], 10);
    const other = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(v10) || !Number.isFinite(v11) || !Number.isFinite(other)) return 'unknown';
    if (other > 0) return 'unknown';
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
 * unless mode is in allowlist ('none' | 'v10' | 'v11').
 * @param {object} [options]
 * @returns {{ preserveMacV10Keychain: boolean, mode: string }}
 */
function resolveMacV10Shield({
  userDataDir,
  profileDir = 'Default',
  dryRun = false,
  skipGuardForTest = false,
  env = process.env,
  platform = process.platform,
  cookieMode,
  detectFn,
} = {}) {
  if (platform !== 'darwin') {
    return { preserveMacV10Keychain: false, mode: 'other' };
  }
  const detector = typeof detectFn === 'function' ? detectFn : detectMacCookieEncryptionMode;
  const mode = detector(userDataDir, profileDir, { env, platform, cookieMode });

  if (!dryRun && !skipGuardForTest && !ALLOWED_COOKIE_MODES.has(mode)) {
    if (mode === 'mixed') {
      const err = new Error(
        `ERR_MACOS_COOKIE_MODE_MIXED: Cookies DB in "${userDataDir}" (${profileDir}) contains mixed v10 and v11 cookies. ` +
        'Refusing to guess Keychain shield flags because a wrong choice could wipe cookies. ' +
        'Pass cookieMode="v10"|"v11" or set WEBMCP_COOKIE_MODE=v10|v11 to override.'
      );
      err.code = 'ERR_MACOS_COOKIE_MODE_MIXED';
      err.mode = mode;
      err.userDataDir = userDataDir;
      throw err;
    }
    const err = new Error(
      `ERR_MACOS_COOKIE_MODE_UNKNOWN: Could not determine cookie encryption mode (${mode}) for "${userDataDir}" (${profileDir}). ` +
      'Refusing to launch Chrome without knowing cookie format; pass cookieMode="v10"|"v11" or set WEBMCP_COOKIE_MODE=v10|v11 to override.'
    );
    err.code = 'ERR_MACOS_COOKIE_MODE_UNKNOWN';
    err.mode = mode;
    err.userDataDir = userDataDir;
    throw err;
  }

  return {
    preserveMacV10Keychain: mode === 'v10',
    mode,
  };
}

/**
 * Perform read-only checks verifying an unlocked macOS Aqua GUI session and Keychain access.
 * Never calls `security unlock-keychain` or touches Keychain when outside Aqua / under SSH_*.
 * Uses non-interactive JXA `SecKeychainCopyDefault` + `SecKeychainGetStatus` + `CFRelease`.
 */
function probeMacosAquaKeychainSession(deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    homedir,
    execFileSyncFn = execFileSync,
  } = deps;
  if (platform !== 'darwin') {
    return { ok: true, platform, skipped: true };
  }

  const effectiveEnv = env || process.env;
  const effectiveHomedir = homedir || effectiveEnv.HOME || os.homedir();
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

  const fallbackKc = path.join(effectiveHomedir, 'Library', 'Keychains', 'login.keychain-db');
  const jxa = [
    "ObjC.import('Security');",
    '$.SecKeychainSetUserInteractionAllowed(false);',
    'const k=Ref(),s=Ref();',
    `let rc=Number($.SecKeychainCopyDefault(k));if(rc!==0||!k[0]){rc=Number($.SecKeychainOpen(${JSON.stringify(fallbackKc)},k));}`,
    "if(rc!==0||!k[0])throw new Error('PROBE_ERR:open='+rc);",
    'const st=Number($.SecKeychainGetStatus(k[0],s));',
    "if(st!==0)throw new Error('PROBE_ERR:status='+st);",
    "if(!(Number(s[0])&1))throw new Error('LOCKED');",
  ].join('');

  try {
    execFileSyncFn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err || '').trim();
    const isLocked = /\bLOCKED\b|\blocked\b/i.test(detail) && !detail.includes('PROBE_ERR:');
    return {
      ok: false,
      reason: isLocked ? 'keychain-locked' : 'keychain-probe-error',
      code: isLocked ? 'ERR_MACOS_KEYCHAIN_LOCKED' : 'ERR_MACOS_KEYCHAIN_PROBE_ERROR',
      platform,
      managerName,
      hasSshEnv,
      keychainOk: false,
      ...(detail ? { probeError: detail.slice(0, 300) } : {}),
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
 * Fail closed before launching Chrome or querying Keychain on macOS when outside Aqua GUI / Keychain access.
 */
function assertMacosAquaKeychainSession({ dryRun = false, skipGuardForTest = false, env, probe, forceCheck = false } = {}) {
  if (dryRun) return { ok: true, skipped: 'dryRun' };
  if (skipGuardForTest) return { ok: true, skipped: 'test-guard' };
  if (!forceCheck && process.platform !== 'darwin') return { ok: true, skipped: 'non-darwin' };

  const res = typeof probe === 'function' ? probe() : probeMacosAquaKeychainSession({ env });
  if (!res || !res.ok) {
    const details = res || {
      ok: false,
      platform: process.platform,
      managerName: 'unknown',
      hasSshEnv: false,
      keychainOk: false,
    };
    const code = details.code || (
      details.reason === 'keychain-locked'
        ? 'ERR_MACOS_KEYCHAIN_LOCKED'
        : details.reason === 'keychain-probe-error'
          ? 'ERR_MACOS_KEYCHAIN_PROBE_ERROR'
          : 'ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED'
    );
    let msg;
    if (code === 'ERR_MACOS_KEYCHAIN_LOCKED') {
      msg = `${code}: macOS default/login Keychain is locked (managerName=${details.managerName}, hasSshEnv=${details.hasSshEnv}). ` +
        'Unlock Keychain in the macOS Aqua GUI session first.';
    } else if (code === 'ERR_MACOS_KEYCHAIN_PROBE_ERROR') {
      msg = `${code}: macOS Keychain status probe failed (${details.probeError || 'unknown error'}; managerName=${details.managerName}).`;
    } else {
      msg = `${code}: macOS Keychain Safe Storage is inaccessible outside an Aqua GUI session ` +
        `(managerName=${details.managerName}, hasSshEnv=${details.hasSshEnv}). ` +
        'SSH commands needing Keychain/Chrome must delegate through the authorized Aqua Gateway (:7865 /api/aqua/*) or run from the Aqua GUI.';
    }
    const err = new Error(msg);
    err.code = code;
    err.details = details;
    throw err;
  }
  return res;
}

function assertNoForbiddenManagedArgs(extraArgs) {
  if (!Array.isArray(extraArgs)) return;
  for (let i = 0; i < extraArgs.length; i += 1) {
    const raw = String(extraArgs[i] || '').trim();
    const lower = raw.toLowerCase();
    if (
      lower === '--use-mock-keychain' ||
      lower.startsWith('--use-mock-keychain=') ||
      lower === '--password-store=basic' ||
      (lower === '--password-store' && String(extraArgs[i + 1] || '').trim().toLowerCase() === 'basic')
    ) {
      const err = new Error(
        `ERR_FORBIDDEN_MOCK_KEYCHAIN: Flag "${raw}" is forbidden on Managed profiles because mock/basic password stores break Keychain Safe Storage cookie persistence.`,
      );
      err.code = 'ERR_FORBIDDEN_MOCK_KEYCHAIN';
      throw err;
    }
  }
}

module.exports = {
  MAC_V10_KEYCHAIN_SHIELD_FEATURES,
  ALLOWED_COOKIE_MODES,
  detectMacCookieEncryptionMode,
  resolveMacV10Shield,
  probeMacosAquaKeychainSession,
  assertMacosAquaKeychainSession,
  assertNoForbiddenManagedArgs,
};
