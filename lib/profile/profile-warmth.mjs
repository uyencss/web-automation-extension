import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const CHROME_EPOCH_OFFSET_US = 11644473600000000n;
const GOOGLE_YOUTUBE_RE = /(?:^|\.)(?:google\.[a-z.]+|youtube\.com|doubleclick\.net|gstatic\.com|googlevideo\.com|googleusercontent\.com|googlesyndication\.com|gvt1\.com|ytimg\.com)$/i;

export const WARMTH_ACTIONS = {
  COLD: [],
  SEEDED: ['CREATE_ACCOUNT_RESIDENTIAL_4G'],
  SOAKED: ['CREATE_ACCOUNT_RESIDENTIAL_4G', 'ENABLE_2FA_TOTP', 'ASSIGN_RECOVERY_EMAIL'],
  MATURE: ['CREATE_ACCOUNT_RESIDENTIAL_4G', 'ENABLE_2FA_TOTP', 'ASSIGN_RECOVERY_EMAIL', 'MIGRATE_SESSION', 'PROD_FARM_AUTOMATION'],
};

function resolveCookiesPath(targetPath, profileDir = 'Default') {
  if (!targetPath) return null;
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) return targetPath;
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

function getDirSizeBytes(dirPath, maxBytes = 10 * 1024 * 1024) {
  let total = 0;
  function traverse(current) {
    if (total >= maxBytes) return;
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (total >= maxBytes) break;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) traverse(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      }
    } catch {}
  }
  traverse(dirPath);
  return total;
}

function readCookiesSafe(cookiesPath) {
  if (!cookiesPath || !fs.existsSync(cookiesPath)) return [];
  let db;
  try {
    db = new DatabaseSync(cookiesPath, { readOnly: true });
    return db.prepare('SELECT host_key, name, CAST(creation_utc AS TEXT) AS creation_utc FROM cookies').all();
  } catch {
    try {
      const raw = execFileSync(
        'sqlite3',
        [`file:${cookiesPath}?mode=ro&immutable=1`, 'SELECT host_key, name, CAST(creation_utc AS TEXT) FROM cookies;'],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 5000 }
      );
      return raw.trim().split('\n').filter(Boolean).map((line) => {
        const [host_key, name, creation_utc] = line.split('|');
        return { host_key, name, creation_utc };
      });
    } catch {
      return [];
    }
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}

export function evaluateProfileWarmth(userDataDir, options = {}) {
  const profileId = options.id || options.profileId || path.basename(userDataDir || 'unknown');
  const profileDir = options.profileDir || 'Default';
  const profileRoot = fs.existsSync(path.join(userDataDir, profileDir))
    ? path.join(userDataDir, profileDir)
    : userDataDir;

  const cookiesPath = resolveCookiesPath(userDataDir, profileDir);
  const rows = readCookiesSafe(cookiesPath);

  // Pillar 1: Session Soak Age (30 pts)
  let earliestMs = Infinity;
  for (const r of rows) {
    if (r.creation_utc) {
      try {
        const rawUs = BigInt(r.creation_utc);
        if (rawUs > CHROME_EPOCH_OFFSET_US) {
          const unixMs = Number((rawUs - CHROME_EPOCH_OFFSET_US) / 1000n);
          if (unixMs > 0 && unixMs < earliestMs) earliestMs = unixMs;
        }
      } catch {}
    }
  }
  if (earliestMs === Infinity && cookiesPath && fs.existsSync(cookiesPath)) {
    try {
      const st = fs.statSync(cookiesPath);
      earliestMs = st.birthtimeMs || st.mtimeMs || st.ctimeMs || Date.now();
    } catch {}
  }
  const now = Date.now();
  const soakAgeHours = earliestMs < now ? Math.round(((now - earliestMs) / (1000 * 60 * 60)) * 10) / 10 : 0;
  let soakAgeScore = 0;
  if (soakAgeHours > 48) soakAgeScore = 30;
  else if (soakAgeHours >= 24) soakAgeScore = 25;
  else if (soakAgeHours >= 1) soakAgeScore = 15;

  // Pillar 2: 3rd-Party Browsing Entropy (25 pts)
  const thirdPartyDomainsSet = new Set();
  let thirdPartyCookiesCount = 0;
  for (const r of rows) {
    const host = (r.host_key || '').replace(/^\./, '').toLowerCase().trim();
    if (host && !GOOGLE_YOUTUBE_RE.test(host)) {
      thirdPartyCookiesCount += 1;
      thirdPartyDomainsSet.add(host);
    }
  }
  const thirdPartyDomains = Array.from(thirdPartyDomainsSet);
  let entropyScore = 0;
  if (thirdPartyCookiesCount >= 50 || (thirdPartyDomains.length >= 3 && thirdPartyCookiesCount >= 15)) {
    entropyScore = 25;
  } else if (thirdPartyCookiesCount >= 10 || thirdPartyDomains.length >= 3) {
    entropyScore = 15;
  } else if (thirdPartyCookiesCount > 0) {
    entropyScore = 5;
  }

  // Pillar 3: Google & YouTube Core Telemetry (30 pts)
  const googleCookieNames = new Set(
    rows
      .filter((r) => GOOGLE_YOUTUBE_RE.test((r.host_key || '').replace(/^\./, '').toLowerCase().trim()))
      .map((r) => r.name)
      .filter(Boolean)
  );
  let telemetryScore = 0;
  const googleTokens = [];

  if (googleCookieNames.has('AEC') || googleCookieNames.has('NID')) {
    telemetryScore += 10;
    if (googleCookieNames.has('AEC')) googleTokens.push('AEC');
    if (googleCookieNames.has('NID')) googleTokens.push('NID');
  }
  const samesiteFound = ['SEARCH_SAMESITE', '1P_JAR', 'OGPC'].filter((t) => googleCookieNames.has(t));
  if (samesiteFound.length > 0) {
    telemetryScore += 5;
    for (const t of samesiteFound) if (!googleTokens.includes(t)) googleTokens.push(t);
  }
  if (googleCookieNames.has('VISITOR_INFO1_LIVE')) {
    telemetryScore += 5;
    googleTokens.push('VISITOR_INFO1_LIVE');
  }
  if (googleCookieNames.has('YSC')) {
    telemetryScore += 5;
    googleTokens.push('YSC');
  }
  const prefFound = ['PREF', 'GPS'].filter((t) => googleCookieNames.has(t));
  if (prefFound.length > 0) {
    telemetryScore += 5;
    for (const t of prefFound) if (!googleTokens.includes(t)) googleTokens.push(t);
  }

  // Pillar 4: Local Storage & Cache Footprint (15 pts)
  const cacheCandidates = [
    path.join(profileRoot, 'Cache', 'Cache_Data'),
    path.join(profileRoot, 'Cache'),
    path.join(userDataDir, 'Default', 'Cache', 'Cache_Data'),
    path.join(userDataDir, 'Default', 'Cache'),
  ];
  let cacheSizeBytes = 0;
  for (const cand of cacheCandidates) {
    if (fs.existsSync(cand)) {
      cacheSizeBytes = getDirSizeBytes(cand);
      if (cacheSizeBytes > 0) break;
    }
  }
  let footprintScore = 0;
  if (cacheSizeBytes > 5 * 1024 * 1024) footprintScore += 10;
  else if (cacheSizeBytes > 0) footprintScore += 5;

  const storageCandidates = [
    path.join(profileRoot, 'Local Storage', 'leveldb'),
    path.join(profileRoot, 'IndexedDB'),
    path.join(userDataDir, 'Default', 'Local Storage', 'leveldb'),
    path.join(userDataDir, 'Default', 'IndexedDB'),
  ];
  const hasStorage = storageCandidates.some((c) => fs.existsSync(c));
  if (hasStorage) footprintScore += 5;

  // Final Score & Verdict Mapping
  const score = Math.min(100, soakAgeScore + entropyScore + telemetryScore + footprintScore);
  let verdict = 'COLD';
  if (score >= 90) verdict = 'MATURE';
  else if (score >= 70) verdict = 'SOAKED';
  else if (score >= 40) verdict = 'SEEDED';
  const actionsPermitted = WARMTH_ACTIONS[verdict] || [];

  return {
    profileId,
    score,
    verdict,
    soakAgeHours,
    thirdPartyDomains,
    thirdPartyCookiesCount,
    googleTokens,
    cacheSizeBytes,
    actionsPermitted,
    breakdown: {
      soakAge: { score: soakAgeScore, max: 30, ageHours: soakAgeHours },
      entropy: { score: entropyScore, max: 25, domainsCount: thirdPartyDomains.length, cookiesCount: thirdPartyCookiesCount },
      telemetry: { score: telemetryScore, max: 30, tokensFound: googleTokens },
      footprint: { score: footprintScore, max: 15, cacheSizeBytes, hasStorage },
    },
  };
}
