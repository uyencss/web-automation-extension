'use strict';

const fs = require('fs');
const path = require('path');
const { MANAGED_PROFILES_DIR } = require('./config');
const { isProfileLocked, createManagedProfile } = require('./launcher');

const CACHE_RE = /(^|[\\/])(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|CacheStorage)([\\/]|$)/;
const WEBMCP_STORAGE_RE = /(^|[\\/])(Local|Sync) Extension Settings[\\/]lbodkmkjbcemodklopcfdmpjomdoapae([\\/]|$)/;
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

function patchJson(filePath, mutator) {
  let data = {};
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      data = {};
    }
  }
  mutator(data);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
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

  const srcLocalState = path.join(profile.userDataDir, 'Local State');
  if (fs.existsSync(srcLocalState)) {
    fs.copyFileSync(srcLocalState, path.join(dst, 'Local State'));
  }

  fs.cpSync(srcProfilePath, path.join(dst, profile.profileDir), {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(srcProfilePath, src);
      return !CACHE_RE.test(rel) && !WEBMCP_STORAGE_RE.test(rel);
    },
  });

  patchJson(path.join(dst, 'Local State'), (j) => {
    (j.profile ??= {}).last_used = profile.profileDir;
  });
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

  // 1. Read Preferences (if exists) and .webmcp-meta.json (if exists)
  const prefsPath = path.join(targetProfilePath, 'Preferences');
  const metaPath = path.join(userDataDir, '.webmcp-meta.json');
  let prefs = null;
  if (fs.existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    } catch {}
  }
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {}
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

  // 2. Before mutating anything else: look for <profileDir>/Cookies or <profileDir>/Network/Cookies
  const cookieCandidates = [
    path.join(targetProfilePath, 'Network', 'Cookies'),
    path.join(targetProfilePath, 'Cookies'),
  ];
  let srcCookiePath = null;
  for (const cand of cookieCandidates) {
    if (fs.existsSync(cand)) {
      try {
        const stat = fs.statSync(cand);
        if (stat.size > 0) {
          srcCookiePath = cand;
          break;
        }
      } catch {}
    }
  }

  const prebootPath = path.join(userDataDir, '.cookies-preboot.sqlite');
  if (srcCookiePath && !isProfileLocked(userDataDir) && fs.existsSync(`${srcCookiePath}-wal`)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const dbMerge = new DatabaseSync(srcCookiePath);
      try {
        dbMerge.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } finally {
        dbMerge.close();
      }
    } catch {}
  }

  if (srcCookiePath && !fs.existsSync(prebootPath)) {
    let shouldCopy = true;
    try {
      const { DatabaseSync } = require('node:sqlite');
      let dbTmp;
      try {
        dbTmp = new DatabaseSync(srcCookiePath, { readOnly: true });
        const tbl = dbTmp.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='cookies'").get();
        if (tbl && tbl.count > 0) {
          const rowCount = dbTmp.prepare("SELECT count(*) AS count FROM cookies").get();
          if (rowCount && rowCount.count === 0) {
            shouldCopy = false;
          }
        }
      } finally {
        if (dbTmp) dbTmp.close();
      }
    } catch {
      // If DatabaseSync fails to open (e.g. dummy test file), fallback to copying
      shouldCopy = true;
    }

    if (shouldCopy) {
      try {
        fs.copyFileSync(srcCookiePath, prebootPath);
        try { fs.chmodSync(prebootPath, 0o600); } catch {}
        for (const ext of ['-wal', '-shm']) {
          const auxSrc = `${srcCookiePath}${ext}`;
          if (fs.existsSync(auxSrc)) {
            const auxDst = `${prebootPath}${ext}`;
            fs.copyFileSync(auxSrc, auxDst);
            try { fs.chmodSync(auxDst, 0o600); } catch {}
          }
        }
        if (fs.existsSync(`${prebootPath}-wal`)) {
          try {
            const { DatabaseSync } = require('node:sqlite');
            const dbTmp = new DatabaseSync(prebootPath);
            try {
              dbTmp.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            } finally {
              dbTmp.close();
            }
          } catch {}
        }
      } catch {}
    }
  }

  // 3. Remove <profileDir>/Secure Preferences (unlink if exists)
  const secPrefsPath = path.join(targetProfilePath, 'Secure Preferences');
  if (fs.existsSync(secPrefsPath)) {
    try {
      fs.unlinkSync(secPrefsPath);
    } catch {}
  }

  // 4. Mutate <profileDir>/Preferences (atomic/safe write JSON)
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
      p.signin = { allowed: false };
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

  // 6. Mutate Web Data and Account Web Data (if file exists and is valid SQLite)
  for (const webDataName of ['Web Data', 'Account Web Data']) {
    const webDataPath = path.join(targetProfilePath, webDataName);
    if (fs.existsSync(webDataPath)) {
      try {
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
      } catch {
        // Gracefully ignore parse/open errors on non-sqlite or dummy test files
      }
    }
  }

  // 7. Write detoxedForManaged: true into .webmcp-meta.json
  meta.detoxedForManaged = true;
  meta.detoxedAt = new Date().toISOString();
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

  return { ok: true, detoxed: true, userDataDir, profileDir };
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
