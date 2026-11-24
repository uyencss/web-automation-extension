import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const CHROME_EPOCH_OFFSET_US = 11644473600000000n;
const EMPTY_SENTINELS = new Set(['0', 'false', 'no']);
const SERVICE_ALIASES = {
  gmail: 'google',
  google: 'google',
  workspace: 'google',
  youtube: 'youtube',
  yt: 'youtube',
  facebook: 'facebook',
  fb: 'facebook',
  tiktok: 'tiktok',
  tt: 'tiktok',
  x: 'x',
  twitter: 'x',
  shopee: 'shopee',
  github: 'github',
};

export const SERVICE_AUTH_RULES = {
  google: {
    description: 'Google/Gmail (.google.com SID + 1PSID/SAPISID and accounts.google.com LSID/PLSID)',
    criticalCookies: ['SID', '__Secure-1PSID', 'SAPISID', '__Secure-3PAPISID', 'LSID', '__Host-1PLSID', '__Host-3PLSID'],
  },
  youtube: {
    description: 'YouTube (LOGIN_INFO or SID+1PSID/SAPISID with Google session)',
    criticalCookies: ['LOGIN_INFO', 'SID', '__Secure-1PSID', 'SAPISID', '__Secure-3PAPISID'],
  },
  facebook: {
    description: 'Facebook (c_user + xs)',
    criticalCookies: ['c_user', 'xs'],
  },
  tiktok: {
    description: 'TikTok (sessionid / sid_tt / sessionid_ss)',
    criticalCookies: ['sessionid', 'sid_tt', 'sessionid_ss'],
  },
  x: {
    description: 'X/Twitter (auth_token + ct0)',
    criticalCookies: ['auth_token', 'ct0'],
  },
  shopee: {
    description: 'Shopee (SPC_EC / SPC_ST)',
    criticalCookies: ['SPC_EC', 'SPC_ST'],
  },
  github: {
    description: 'GitHub (user_session / __Host-user_session_same_site)',
    criticalCookies: ['user_session', '__Host-user_session_same_site'],
  },
};

export function normalizeServiceName(service) {
  const clean = String(service || '').trim().toLowerCase();
  if (!clean) return '';
  return SERVICE_ALIASES[clean] || clean;
}

function resolveCookiesDbPath(targetPath, profileDir = 'Default') {
  if (!targetPath) return null;
  try {
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) return targetPath;
  } catch {
    return null;
  }
  const candidates = [
    path.join(targetPath, profileDir, 'Network', 'Cookies'),
    path.join(targetPath, profileDir, 'Cookies'),
    path.join(targetPath, 'Network', 'Cookies'),
    path.join(targetPath, 'Cookies'),
    path.join(targetPath, 'Default', 'Network', 'Cookies'),
    path.join(targetPath, 'Default', 'Cookies'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function readCookiesRowsReadOnly(cookiesPath) {
  if (!cookiesPath || !fs.existsSync(cookiesPath)) return { dbOk: false, rows: [], totalRows: 0 };
  let db;
  try {
    db = new DatabaseSync(cookiesPath, { readOnly: true });
    const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cookies'").get();
    if (!tbl) return { dbOk: false, rows: [], totalRows: 0 };
    const cols = new Set(db.prepare('PRAGMA table_info(cookies)').all().map((c) => c?.name));
    const hCol = cols.has('host_key') ? 'host_key' : (cols.has('host') ? 'host' : "'' AS host_key");
    const vExpr = cols.has('value') ? 'LENGTH(value) AS vlen' : '0 AS vlen';
    const eExpr = cols.has('encrypted_value') ? 'LENGTH(encrypted_value) AS elen' : '0 AS elen';
    const vsExpr = cols.has('value') ? "CASE WHEN LENGTH(value) <= 16 THEN value ELSE '' END AS val_short" : "'' AS val_short";
    const expExpr = cols.has('expires_utc') ? 'CAST(COALESCE(expires_utc, 0) AS TEXT) AS expires_utc' : "'0' AS expires_utc";
    const creExpr = cols.has('creation_utc') ? 'CAST(COALESCE(creation_utc, 0) AS TEXT) AS creation_utc' : "'0' AS creation_utc";
    const accExpr = cols.has('last_access_utc') ? 'CAST(COALESCE(last_access_utc, 0) AS TEXT) AS last_access_utc' : "'0' AS last_access_utc";
    const rows = db.prepare(`SELECT ${hCol} AS host_key, name, ${vExpr}, ${eExpr}, ${vsExpr}, ${expExpr}, ${creExpr}, ${accExpr} FROM cookies`).all();
    return { dbOk: true, rows, totalRows: rows.length };
  } catch {
    try {
      const sql = "SELECT host_key, name, LENGTH(COALESCE(value,'')), LENGTH(COALESCE(encrypted_value,'')), CASE WHEN LENGTH(COALESCE(value,'')) <= 16 THEN COALESCE(value,'') ELSE '' END, CAST(COALESCE(expires_utc,0) AS TEXT), CAST(COALESCE(creation_utc,0) AS TEXT), CAST(COALESCE(last_access_utc,0) AS TEXT) FROM cookies;";
      const raw = execFileSync('sqlite3', [`file:${cookiesPath}?mode=ro&immutable=1`, sql], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 5000,
      });
      const rows = raw.trim().split('\n').filter(Boolean).map((line) => {
        const [host_key, name, vlen, elen, val_short, expires_utc, creation_utc, last_access_utc] = line.split('|');
        return { host_key, name, vlen: Number(vlen || 0), elen: Number(elen || 0), val_short: val_short || '', expires_utc, creation_utc, last_access_utc };
      });
      return { dbOk: true, rows, totalRows: rows.length };
    } catch {
      return { dbOk: false, rows: [], totalRows: 0 };
    }
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}

function toUnixSeconds(rawVal) {
  if (!rawVal) return 0;
  const n = Number(rawVal);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 100_000_000_000_000) return n / 1_000_000 - 11644473600;
  if (n > 100_000_000_000) return n / 1000;
  return n;
}

function hostMatches(hostKey, domain) {
  const clean = String(hostKey || '').trim().toLowerCase().replace(/^\./, '');
  return clean === domain || clean.endsWith(`.${domain}`);
}

function readSiblingSignedOutSignal(userDataDir, profileDir, cookiesPath, authMaxTs) {
  let rootDir = userDataDir;
  if (!rootDir && cookiesPath) {
    const dbDir = path.dirname(path.resolve(cookiesPath));
    const prof = path.basename(dbDir) === 'Network' ? path.dirname(dbDir) : dbDir;
    rootDir = path.dirname(prof);
  }
  const cands = [rootDir, path.join(rootDir || '', profileDir || 'Default'), cookiesPath ? path.dirname(cookiesPath) : null].filter(Boolean);
  for (const dir of cands) {
    const metaPath = path.join(dir, '.webmcp-meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const probe = meta?.googleAuthProbe;
      if (probe && typeof probe === 'object' && probe.signedOut === true) {
        const checkedSec = probe.checkedAt ? Date.parse(probe.checkedAt) / 1000 : 0;
        if (!checkedSec || !authMaxTs || authMaxTs <= checkedSec + 5) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

function evaluatePlatformRows(validRows, { googleSignedOut = false } = {}) {
  const hostSets = new Map();
  const distinctHosts = new Set();
  const byDomain = (dom) => {
    const out = new Set();
    for (const [hk, names] of hostSets.entries()) {
      if (hostMatches(hk, dom)) {
        for (const n of names) out.add(n);
      }
    }
    return out;
  };

  for (const r of validRows) {
    const hk = String(r.host_key || '').trim();
    const name = String(r.name || '').trim();
    if (!hk || !name) continue;
    distinctHosts.add(hk);
    if (!hostSets.has(hk)) hostSets.set(hk, new Set());
    hostSets.get(hk).add(name);
  }

  const platforms = [];
  const brokenPlatforms = [];
  const serviceChecks = {};

  // Google / Gmail
  const dotGoogle = new Set([...(hostSets.get('.google.com') || []), ...(hostSets.get('google.com') || [])]);
  const acctsGoogle = hostSets.get('accounts.google.com') || new Set();
  const hasDotGoogle = dotGoogle.has('SID') && (dotGoogle.has('__Secure-1PSID') || dotGoogle.has('SAPISID') || dotGoogle.has('__Secure-3PAPISID'));
  const hasAcctsGoogle = ['LSID', '__Host-1PLSID', '__Host-3PLSID'].some((n) => acctsGoogle.has(n));
  const googleOkRaw = hasDotGoogle && hasAcctsGoogle;
  const googlePartial = !googleOkRaw && (hasDotGoogle || hasAcctsGoogle || dotGoogle.has('SID') || dotGoogle.has('__Secure-1PSID'));
  const googleOk = googleOkRaw && !googleSignedOut;
  if (googleOk) platforms.push('google');
  else if (googlePartial || googleSignedOut) brokenPlatforms.push('google');
  serviceChecks.google = { ok: googleOk, reason: googleSignedOut ? 'signed_out' : (googleOk ? 'ok' : (googlePartial ? 'incomplete_google_cookies' : 'missing_google_cookies')) };

  // YouTube
  const ytNames = byDomain('youtube.com');
  const hasYtAuth = ytNames.has('LOGIN_INFO') || (ytNames.has('SID') && (ytNames.has('__Secure-1PSID') || ytNames.has('SAPISID') || ytNames.has('__Secure-3PAPISID')));
  const ytGooglePrecond = googleOkRaw || dotGoogle.has('SID');
  const ytOk = hasYtAuth && ytGooglePrecond && !googleSignedOut;
  if (ytOk) platforms.push('youtube');
  else if (hasYtAuth && (!ytGooglePrecond || googleSignedOut)) brokenPlatforms.push('youtube');
  serviceChecks.youtube = { ok: ytOk, reason: googleSignedOut ? 'signed_out' : (ytOk ? 'ok' : 'missing_youtube_cookies') };

  // Facebook
  const fbNames = byDomain('facebook.com');
  const fbOk = fbNames.has('c_user') && fbNames.has('xs');
  const fbPartial = (fbNames.has('c_user') && !fbNames.has('xs')) || (!fbNames.has('c_user') && fbNames.has('xs'));
  if (fbOk) platforms.push('facebook');
  else if (fbPartial) brokenPlatforms.push('facebook');
  serviceChecks.facebook = { ok: fbOk, reason: fbOk ? 'ok' : (fbPartial ? 'incomplete_fb_cookies' : 'missing_fb_cookies') };

  // TikTok
  const ttNames = byDomain('tiktok.com');
  const ttOk = ['sessionid', 'sid_tt', 'sessionid_ss'].some((n) => ttNames.has(n));
  if (ttOk) platforms.push('tiktok');
  serviceChecks.tiktok = { ok: ttOk, reason: ttOk ? 'ok' : 'missing_tiktok_cookies' };

  // X / Twitter
  const xNames = new Set([...byDomain('x.com'), ...byDomain('twitter.com')]);
  const xOk = xNames.has('auth_token') && xNames.has('ct0');
  const xPartial = xNames.has('auth_token') !== xNames.has('ct0');
  if (xOk) platforms.push('x');
  else if (xPartial) brokenPlatforms.push('x');
  serviceChecks.x = { ok: xOk, reason: xOk ? 'ok' : (xPartial ? 'incomplete_x_cookies' : 'missing_x_cookies') };

  // Shopee
  const spNames = new Set();
  for (const [hk, names] of hostSets.entries()) {
    const clean = hk.toLowerCase().replace(/^\./, '');
    if (clean === 'shopee.vn' || clean.endsWith('.shopee.vn') || /^shopee\.[a-z.]+$/.test(clean) || /\.shopee\.[a-z.]+$/.test(clean)) {
      for (const n of names) spNames.add(n);
    }
  }
  const spOk = spNames.has('SPC_EC') || spNames.has('SPC_ST');
  if (spOk) platforms.push('shopee');
  serviceChecks.shopee = { ok: spOk, reason: spOk ? 'ok' : 'missing_shopee_cookies' };

  // GitHub
  const ghNames = byDomain('github.com');
  const ghOk = ghNames.has('user_session') || ghNames.has('__Host-user_session_same_site');
  if (ghOk) platforms.push('github');
  serviceChecks.github = { ok: ghOk, reason: ghOk ? 'ok' : 'missing_github_cookies' };

  return { hostCount: distinctHosts.size, platforms, brokenPlatforms, serviceChecks };
}

export function inspectOnDiskServiceAuth(userDataDir, options = {}) {
  const profileDir = options.profileDir || 'Default';
  const nowMs = Number(options.nowMs || Date.now());
  const nowWebkitUs = (BigInt(Math.floor(nowMs)) * 1000n) + CHROME_EPOCH_OFFSET_US;
  const cookiesPath = resolveCookiesDbPath(userDataDir, profileDir);
  const { dbOk, rows, totalRows } = readCookiesRowsReadOnly(cookiesPath);

  if (!dbOk) {
    return {
      dbOk: false,
      cookiesPath,
      cookieCount: 0,
      hostCount: 0,
      platforms: [],
      brokenPlatforms: [],
      googleSignedOut: false,
      serviceChecks: {},
      missingServices: (Array.isArray(options.services) ? options.services : []).map(normalizeServiceName).filter(Boolean),
      authMaxTs: 0,
    };
  }

  let authMaxTs = 0;
  const validRows = [];
  for (const r of rows) {
    const vlen = Number(r.vlen || 0);
    const elen = Number(r.elen || 0);
    const valShort = String(r.val_short || '').trim().toLowerCase();
    if (vlen + elen <= 0) continue;
    if (EMPTY_SENTINELS.has(valShort)) continue;
    let unexpired = true;
    try {
      const exp = BigInt(r.expires_utc || '0');
      if (exp !== 0n && exp <= nowWebkitUs) unexpired = false;
    } catch {}
    if (!unexpired) continue;
    validRows.push(r);

    if (
      (r.host_key === '.google.com' && (r.name === 'SID' || r.name === '__Secure-1PSID')) ||
      (r.host_key === 'accounts.google.com' && ['LSID', '__Host-1PLSID', '__Host-3PLSID'].includes(r.name))
    ) {
      const ts = Math.max(toUnixSeconds(r.creation_utc), toUnixSeconds(r.last_access_utc));
      if (ts > authMaxTs) authMaxTs = ts;
    }
  }

  const googleSignedOut = options.ignoreMetaSignal ? false : readSiblingSignedOutSignal(userDataDir, profileDir, cookiesPath, authMaxTs);
  const evalRes = evaluatePlatformRows(validRows, { googleSignedOut });
  const requested = Array.isArray(options.services) ? options.services.map(normalizeServiceName).filter(Boolean) : [];
  const missingServices = requested.filter((s) => SERVICE_AUTH_RULES[s] && !evalRes.serviceChecks[s]?.ok);

  return {
    dbOk: true,
    cookiesPath,
    cookieCount: totalRows,
    hostCount: evalRes.hostCount,
    platforms: evalRes.platforms,
    brokenPlatforms: evalRes.brokenPlatforms,
    googleSignedOut,
    serviceChecks: evalRes.serviceChecks,
    missingServices,
    authMaxTs,
  };
}

export function assertOnDiskServiceAuth(userDataDir, services, options = {}) {
  const list = (Array.isArray(services) ? services : [services]).map(normalizeServiceName).filter(Boolean);
  const report = inspectOnDiskServiceAuth(userDataDir, { ...options, services: list });
  if (options.allowGuestSeed === true) {
    return { ok: true, bypassed: 'allowGuestSeed', services: list, report };
  }
  const known = list.filter((s) => Boolean(SERVICE_AUTH_RULES[s]));
  if (known.length === 0) {
    return { ok: true, unknownServices: list, report };
  }
  const missing = known.filter((s) => !report.dbOk || !report.serviceChecks[s]?.ok);
  if (missing.length === 0) {
    return { ok: true, code: 'OK', services: known, cookieCount: report.cookieCount, report };
  }
  const msg = !report.dbOk
    ? `ERR_PROFILE_MISSING_SERVICE_COOKIES: Missing/unreadable Cookies DB for [${missing.join(', ')}]`
    : `ERR_PROFILE_MISSING_SERVICE_COOKIES: Profile lacks valid on-disk auth cookies for [${missing.join(', ')}] (cookieCount=${report.cookieCount}, signedOut=${report.googleSignedOut})`;
  return {
    ok: false,
    code: 'ERR_PROFILE_MISSING_SERVICE_COOKIES',
    missingServices: missing,
    brokenPlatforms: report.brokenPlatforms,
    cookieCount: report.cookieCount,
    report,
    message: msg,
  };
}

export function verifyLiveCdpServiceCookies(liveCookies, services, { preLaunchReport = null, nowSec = Date.now() / 1000 } = {}) {
  const list = (Array.isArray(services) ? services : [services]).map(normalizeServiceName).filter(Boolean);
  const known = list.filter((s) => Boolean(SERVICE_AUTH_RULES[s]));
  const rawList = Array.isArray(liveCookies) ? liveCookies : [];
  const validLiveRows = [];

  for (const c of rawList) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) continue;
    const val = typeof c.value === 'string' ? c.value.trim() : '';
    if (!val || EMPTY_SENTINELS.has(val.toLowerCase())) continue;
    const hk = c.domain || c.host_key || c.hostKey || '';
    if (!hk) continue;
    if (c.expires !== undefined && c.expires !== null) {
      let expSec = Number(c.expires);
      if (Number.isFinite(expSec) && expSec > 0) {
        if (expSec > 1e13) expSec = toUnixSeconds(expSec);
        else if (expSec > 1e11) expSec = expSec / 1000;
        if (expSec <= nowSec) continue;
      }
    }
    validLiveRows.push({ host_key: hk, name: c.name });
  }

  if (known.length === 0) {
    return { ok: true, code: 'OK', unknownServices: list, liveCookieCount: validLiveRows.length };
  }

  const liveEval = evaluatePlatformRows(validLiveRows, { googleSignedOut: false });
  const missingServices = known.filter((s) => !liveEval.serviceChecks[s]?.ok);
  if (missingServices.length === 0) {
    return {
      ok: true,
      code: 'OK',
      verifiedServices: known,
      platforms: liveEval.platforms,
      liveCookieCount: validLiveRows.length,
    };
  }

  const decryptLostServices = missingServices.filter((s) => preLaunchReport?.serviceChecks?.[s]?.ok === true);
  if (decryptLostServices.length > 0) {
    return {
      ok: false,
      code: 'ERR_SESSION_COOKIE_DECRYPT_LOSS',
      hardQuarantine: true,
      missingServices,
      decryptLostServices,
      preLaunchCookieCount: preLaunchReport?.cookieCount ?? null,
      liveCookieCount: validLiveRows.length,
      message: `ERR_SESSION_COOKIE_DECRYPT_LOSS: Disk had valid cookies for [${decryptLostServices.join(', ')}] pre-launch, but live Chrome decrypted empty/missing (possible Keychain/os_crypt loss)`,
    };
  }

  return {
    ok: false,
    code: 'ERR_WARMUP_NOT_LOGGED_IN',
    hardQuarantine: false,
    missingServices,
    decryptLostServices: [],
    preLaunchCookieCount: preLaunchReport?.cookieCount ?? null,
    liveCookieCount: validLiveRows.length,
    message: `ERR_WARMUP_NOT_LOGGED_IN: Live browser session lacks valid auth cookies for [${missingServices.join(', ')}]`,
  };
}

export function evaluateCloudBackupRegression({ prevItem = null, currentReport = null, currentCookieCount = null, signedOut = false, force = false } = {}) {
  if (force === true) {
    return { ok: true, bypassed: 'force', reasons: [] };
  }
  const reasons = [];
  const effectiveCount = (currentCookieCount !== null && currentCookieCount !== undefined)
    ? Number(currentCookieCount)
    : Number(currentReport?.cookieCount ?? 0);

  if (signedOut === true || currentReport?.googleSignedOut === true) {
    reasons.push('signed_out');
  }
  const broken = Array.isArray(currentReport?.brokenPlatforms) ? currentReport.brokenPlatforms : [];
  if (broken.length > 0) {
    reasons.push(`broken_platforms:${broken.join(',')}`);
  }
  const prevCount = Number(prevItem?.cookieCount || 0);
  if (prevCount > 0 && effectiveCount === 0) {
    reasons.push('zero_cookies_regression');
  }
  const prevPlatforms = Array.isArray(prevItem?.platforms) ? prevItem.platforms : [];
  const curPlatformSet = new Set(Array.isArray(currentReport?.platforms) ? currentReport.platforms : []);
  if (prevPlatforms.length > 0 && currentReport) {
    for (const p of prevPlatforms) {
      if (!curPlatformSet.has(p)) reasons.push(`lost_platform:${p}`);
    }
  }
  if (prevCount >= 20 && effectiveCount < Math.max(5, Math.floor(prevCount * 0.15))) {
    reasons.push(`cookie_cliff:${effectiveCount}/${prevCount}`);
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      code: 'ERR_BACKUP_COOKIE_REGRESSION_BLOCKED',
      reasons,
      message: `ERR_BACKUP_COOKIE_REGRESSION_BLOCKED: Refusing to overwrite healthy backup (${reasons.join(', ')})`,
    };
  }
  return { ok: true, code: 'OK', reasons: [] };
}
