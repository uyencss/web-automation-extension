'use strict';

const fs = require('fs');
const path = require('path');
const { MANAGED_PROFILES_DIR } = require('./config');
const { isProfileLocked, createManagedProfile } = require('./launcher');

const CACHE_RE = /(^|[\\/])(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|CacheStorage)([\\/]|$)/;
const WEBMCP_STORAGE_RE = /(^|[\\/])(Local|Sync) Extension Settings[\\/]lbodkmkjbcemodklopcfdmpjomdoapae([\\/]|$)/;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'utf8');
const CHROME_WEBSTORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx';
const EXT_ID_RE = /^[a-p]{32}$/;
const BUILTIN_EXTENSION_IDS = new Set([
  'nmmhkkegccagdldgiimedpiccmgmieda',
  'ghbmnnjooekpmoecnnnilnnbdlolhkhi',
]);
// ponytail: 12 native-clean ceiling per host (30 max with --force / micro-farbling) to prevent hardware clustering bans
const DEFAULT_MAX_NATIVE_CLEAN_PROFILES = 12;
const HARD_MAX_FARM_PROFILES = 30;

function countManagedProfiles(managedProfilesDir = MANAGED_PROFILES_DIR) {
  try {
    return fs.readdirSync(managedProfilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function patchJson(filePath, mutator) {
  let data = {};
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Refusing to overwrite corrupt JSON in ${filePath}: ${err.message}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Refusing to overwrite non-object JSON in ${filePath}`);
    }
  }
  mutator(data);
  atomicWriteJson(filePath, data);
}

function isSqliteFile(filePath) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 16) return false;
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buf, 0, 16, 0);
    return bytesRead === 16 && buf.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function extractWebstoreExtensionIds(targetProfilePath, secPrefsPath) {
  const ids = new Set();

  if (fs.existsSync(secPrefsPath)) {
    try {
      const secPrefs = JSON.parse(fs.readFileSync(secPrefsPath, 'utf8'));
      const settings = secPrefs?.extensions?.settings;
      if (settings && typeof settings === 'object') {
        for (const [extId, entry] of Object.entries(settings)) {
          if (
            EXT_ID_RE.test(extId) &&
            !BUILTIN_EXTENSION_IDS.has(extId) &&
            entry &&
            entry.from_webstore === true &&
            ![5, 6, 10].includes(entry.location)
          ) {
            ids.add(extId);
          }
        }
      }
    } catch {
      // Secure Preferences is about to be quarantined; fall through to Extensions dir scan
    }
  }

  const extsRoot = path.join(targetProfilePath, 'Extensions');
  if (fs.existsSync(extsRoot)) {
    let entries = [];
    try {
      entries = fs.readdirSync(extsRoot, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      const extId = entry.name;
      if (!entry.isDirectory() || !EXT_ID_RE.test(extId) || BUILTIN_EXTENSION_IDS.has(extId)) {
        continue;
      }
      const extDir = path.join(extsRoot, extId);
      let versions = [];
      try {
        versions = fs.readdirSync(extDir, { withFileTypes: true });
      } catch {}
      for (const ver of versions) {
        if (!ver.isDirectory()) continue;
        const manifestPath = path.join(extDir, ver.name, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (String(manifest?.update_url || '').includes('clients2.google.com/service/update2/crx')) {
            ids.add(extId);
            break;
          }
        } catch {}
      }
    }
  }

  return Array.from(ids).sort();
}

function forkExistingProfile(profile, name, options = {}) {
  if (!profile || !profile.userDataDir || !profile.profileDir) {
    throw new Error('forkExistingProfile requires a valid source profile with userDataDir and profileDir.');
  }
  if (isProfileLocked(profile.userDataDir)) {
    throw new Error('Source Chrome userDataDir is currently running — close it first so SQLite Cookies are quiescent.');
  }
  const srcProfilePath = path.join(profile.userDataDir, profile.profileDir);
  if (!fs.existsSync(srcProfilePath)) {
    throw new Error(`Source profile directory does not exist: ${srcProfilePath}`);
  }

  const managedProfilesDir = options.managedProfilesDir || MANAGED_PROFILES_DIR;
  const existingCount = countManagedProfiles(managedProfilesDir);
  const ceiling = options.maxProfiles || (options.force ? HARD_MAX_FARM_PROFILES : DEFAULT_MAX_NATIVE_CLEAN_PROFILES);
  if (existingCount >= ceiling) {
    throw new Error(
      `[PROFILE_CEILING_REACHED] Host already has ${existingCount} managed Chrome profiles (limit: ${ceiling}; native-clean: ${DEFAULT_MAX_NATIVE_CLEAN_PROFILES}, micro-farbling max: ${HARD_MAX_FARM_PROFILES}). Run 'webmcp profiles list' to reuse an existing profile, or pass --force if micro-farbling is active.`
    );
  }

  let srcMeta = {};
  try {
    srcMeta = JSON.parse(fs.readFileSync(path.join(profile.userDataDir, '.webmcp-meta.json'), 'utf8'));
  } catch {}
  const forkedFrom = srcMeta.forkedFrom || profile.id || `${profile.browser || 'Chrome'}:${profile.profileDir}`;
  const dst = createManagedProfile(name || profile.name || profile.profileDir, {
    ...options,
    skipFingerprintSeed: true,
  });

  let srcLs = null;
  const srcLocalState = path.join(profile.userDataDir, 'Local State');
  if (fs.existsSync(srcLocalState)) {
    try {
      srcLs = JSON.parse(fs.readFileSync(srcLocalState, 'utf8'));
    } catch (err) {
      throw new Error(`Refusing to fork with corrupt JSON in ${srcLocalState}: ${err.message}`);
    }
  }
  const srcInfo = srcLs?.profile?.info_cache?.[profile.profileDir];
  const minimalLocalState = {
    ...(srcLs?.os_crypt !== undefined ? { os_crypt: srcLs.os_crypt } : {}),
    profile: {
      last_used: profile.profileDir,
      info_cache: srcInfo && typeof srcInfo === 'object' ? { [profile.profileDir]: { ...srcInfo } } : {},
    },
  };

  fs.cpSync(srcProfilePath, path.join(dst, profile.profileDir), {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(srcProfilePath, src);
      return !CACHE_RE.test(rel) && !WEBMCP_STORAGE_RE.test(rel);
    },
  });

  atomicWriteJson(path.join(dst, 'Local State'), minimalLocalState);
  patchJson(path.join(dst, profile.profileDir, 'Preferences'), (j) => {
    (j.profile ??= {}).exit_type = 'Normal';
    j.profile.exited_cleanly = true;
  });
  patchJson(path.join(dst, '.webmcp-meta.json'), (j) => {
    j.profileDir = profile.profileDir;
    j.forkedFrom = forkedFrom;
  });

  detoxForkedManagedProfile(dst, profile.profileDir);

  return {
    ok: true,
    id: `managed:${path.basename(dst)}`,
    userDataDir: dst,
    profileDir: profile.profileDir,
    forkedFrom,
    existingManagedCount: existingCount,
    totalManagedCount: existingCount + 1,
  };
}

function detoxForkedManagedProfile(userDataDir, profileDir, options = {}) {
  if (!userDataDir || !profileDir) {
    return { ok: false, skipped: true };
  }
  const targetProfilePath = path.join(userDataDir, profileDir);
  if (!fs.existsSync(targetProfilePath)) {
    return { ok: false, skipped: true };
  }
  if (isProfileLocked(userDataDir)) {
    return { ok: false, skipped: true, error: 'PROFILE_IN_USE' };
  }

  // 1. Read Preferences (if exists) and .webmcp-meta.json (if exists)
  const metaDir = options.metaDir || userDataDir;
  const prefsPath = path.join(targetProfilePath, 'Preferences');
  const metaPath = path.join(metaDir, '.webmcp-meta.json');
  let prefs = null;
  if (fs.existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    } catch (err) {
      throw new Error(`Refusing detox on corrupt JSON in ${prefsPath}: ${err.message}`);
    }
  }
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (err) {
      throw new Error(`Refusing detox on corrupt JSON in ${metaPath}: ${err.message}`);
    }
  }

  // If account_info[0] exists, preserve email, full_name (gaiaName), picture_url (avatarUrl)
  if (Array.isArray(prefs?.account_info) && prefs.account_info.length > 0) {
    const acc = prefs.account_info[0];
    if (acc && typeof acc === 'object') {
      if ((!meta.email || meta.email === '') && acc.email) meta.email = acc.email;
      const gaiaName = acc.full_name || acc.name || acc.given_name;
      if ((!meta.gaiaName || meta.gaiaName === '') && gaiaName) meta.gaiaName = gaiaName;
      const avatarUrl = acc.picture_url || acc.picture;
      if ((!meta.avatarUrl || meta.avatarUrl === '') && avatarUrl) meta.avatarUrl = avatarUrl;
    }
  }

  // 2. Snapshot <profileDir>/Network/Cookies or <profileDir>/Cookies via VACUUM INTO before mutating prefs
  const cookieCandidates = [
    path.join(targetProfilePath, 'Network', 'Cookies'),
    path.join(targetProfilePath, 'Cookies'),
  ];
  let srcCookiePath = null;
  for (const cand of cookieCandidates) {
    if (fs.existsSync(cand)) {
      const stat = fs.statSync(cand);
      if (stat.size > 0) {
        srcCookiePath = cand;
        break;
      }
    }
  }

  const prebootPath = path.join(metaDir, '.cookies-preboot.sqlite');
  if (srcCookiePath) {
    if (isSqliteFile(srcCookiePath)) {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(srcCookiePath);
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        if (!fs.existsSync(prebootPath)) {
          const tbl = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='cookies'").get();
          const rowCount = tbl && tbl.count > 0
            ? (db.prepare('SELECT count(*) AS count FROM cookies').get()?.count ?? 0)
            : 0;
          if (rowCount > 0) {
            db.exec(`VACUUM INTO '${prebootPath.replace(/'/g, "''")}';`);
            try { fs.chmodSync(prebootPath, 0o600); } catch {}
          }
        }
      } finally {
        db.close();
      }
    } else if (!fs.existsSync(prebootPath)) {
      fs.copyFileSync(srcCookiePath, prebootPath);
      try { fs.chmodSync(prebootPath, 0o600); } catch {}
    }
  }

  // 3. Extract Web Store extension IDs before quarantining Secure Preferences -> .pre-detox
  const secPrefsPath = path.join(targetProfilePath, 'Secure Preferences');
  const discoveredExtensions = extractWebstoreExtensionIds(targetProfilePath, secPrefsPath);
  if (!options.metaDir && discoveredExtensions.length > 0) {
    const extDir = path.join(userDataDir, 'External Extensions');
    fs.mkdirSync(extDir, { recursive: true });
    for (const extId of discoveredExtensions) {
      const extJsonPath = path.join(extDir, `${extId}.json`);
      if (!fs.existsSync(extJsonPath)) {
        atomicWriteJson(extJsonPath, { external_update_url: CHROME_WEBSTORE_UPDATE_URL });
      }
    }
  }

  if (fs.existsSync(secPrefsPath)) {
    const preDetoxPath = `${secPrefsPath}.pre-detox`;
    if (!fs.existsSync(preDetoxPath)) {
      fs.renameSync(secPrefsPath, preDetoxPath);
      try { fs.chmodSync(preDetoxPath, 0o600); } catch {}
    } else {
      fs.unlinkSync(secPrefsPath);
    }
  }

  // 4. Mutate <profileDir>/Preferences (atomic/fail-closed JSON)
  if (fs.existsSync(prefsPath)) {
    patchJson(prefsPath, (p) => {
      delete p.account_info;
      if (p.google) {
        delete p.google.services;
      }
      delete p.protection;
      if (p.prefs) {
        delete p.prefs.tracked_preferences_reset;
        delete p.prefs.preference_reset_time;
      }
      p.signin = { allowed: false, allowed_on_next_startup: false };
      p.profile = {
        ...(p.profile || {}),
        exit_type: 'Normal',
        exited_cleanly: true,
      };
    });
  }

  // 5. Mutate <userDataDir>/Local State (if exists)
  const localStatePath = path.join(userDataDir, 'Local State');
  if (fs.existsSync(localStatePath)) {
    patchJson(localStatePath, (ls) => {
      const infoCache = ls.profile?.info_cache;
      if (infoCache && infoCache[profileDir]) {
        const entry = infoCache[profileDir];
        delete entry.gaia_id;
        delete entry.user_name;
        entry.is_consented_primary_account = false;
        entry.is_ephemeral = false;
      }
    });
  }

  // 6. Mutate Web Data and Account Web Data (only when valid SQLite; real errors fail closed)
  for (const webDataName of ['Web Data', 'Account Web Data']) {
    const webDataPath = path.join(targetProfilePath, webDataName);
    if (fs.existsSync(webDataPath) && isSqliteFile(webDataPath)) {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(webDataPath);
      try {
        const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_service'").get();
        if (tbl) {
          db.exec('DELETE FROM token_service;');
          db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        }
      } finally {
        db.close();
      }
    }
  }

  // 7. Write detoxedForManaged: true LAST and ONLY after all JSON/SQLite steps succeed
  meta.detoxedForManaged = true;
  meta.detoxedAt = new Date().toISOString();
  atomicWriteJson(metaPath, meta);

  return { ok: true, detoxed: true, userDataDir, profileDir, discoveredExtensions };
}

function detoxAllManagedProfiles(managedProfilesDir = MANAGED_PROFILES_DIR) {
  if (!managedProfilesDir || !fs.existsSync(managedProfilesDir)) {
    return { ok: true, total: 0, detoxedCount: 0, skippedLockedCount: 0, results: [] };
  }
  const entries = fs.readdirSync(managedProfilesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const results = [];
  let detoxedCount = 0;
  let skippedLockedCount = 0;

  for (const entry of entries) {
    const slug = entry.name;
    const ud = path.join(managedProfilesDir, slug);
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(ud, '.webmcp-meta.json'), 'utf8'));
    } catch {}
    let profileDir = meta?.profileDir;
    if (!profileDir) {
      if (fs.existsSync(path.join(ud, 'Default'))) {
        profileDir = 'Default';
      } else {
        try {
          profileDir = fs.readdirSync(ud).find((d) => /^Profile \d+$/.test(d)) || 'Default';
        } catch {
          profileDir = 'Default';
        }
      }
    }
    if (isProfileLocked(ud)) {
      skippedLockedCount += 1;
      results.push({ slug, profileDir, status: 'skipped_locked' });
      continue;
    }
    const res = detoxForkedManagedProfile(ud, profileDir);
    if (res && res.detoxed) {
      detoxedCount += 1;
      results.push({ slug, profileDir, status: 'detoxed' });
    } else {
      results.push({ slug, profileDir, status: 'skipped' });
    }
  }

  return {
    ok: true,
    total: entries.length,
    detoxedCount,
    skippedLockedCount,
    results,
  };
}

module.exports = {
  CACHE_RE,
  WEBMCP_STORAGE_RE,
  DEFAULT_MAX_NATIVE_CLEAN_PROFILES,
  HARD_MAX_FARM_PROFILES,
  countManagedProfiles,
  forkExistingProfile,
  detoxForkedManagedProfile,
  detoxAllManagedProfiles,
};
