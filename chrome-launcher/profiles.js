'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { MANAGED_PROFILES_DIR } = require('./config');

function chromeUserDataDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      ['Chrome', path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')],
      ['Chrome Beta', path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Beta')],
      ['Chromium', path.join(home, 'Library', 'Application Support', 'Chromium')],
      ['Edge', path.join(home, 'Library', 'Application Support', 'Microsoft Edge')],
    ];
  }

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      ['Chrome', path.join(local, 'Google', 'Chrome', 'User Data')],
      ['Chromium', path.join(local, 'Chromium', 'User Data')],
      ['Edge', path.join(local, 'Microsoft', 'Edge', 'User Data')],
    ];
  }

  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    ['Chrome', path.join(config, 'google-chrome')],
    ['Chromium', path.join(config, 'chromium')],
  ];
}

function initialsFromName(name, email) {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function readBrowserProfiles(browser, userDataDir) {
  const localState = path.join(userDataDir, 'Local State');
  let cache = {};
  try {
    const json = JSON.parse(fs.readFileSync(localState, 'utf8'));
    cache = json?.profile?.info_cache || {};
  } catch {
    return [];
  }

  return Object.entries(cache).map(([dir, info]) => {
    let name = info.name || dir;
    let email = info.user_name || '';
    let gaiaName = info.gaia_name || info.gaia_given_name || '';
    let avatarUrl = '';

    const isDefaultOrGarbageName = !name || /^Person \d+$/i.test(name) || name === 'Your Chrome' || name === 'Default' || name.includes('@');
    if (!email || !gaiaName || isDefaultOrGarbageName) {
      const prefPath = path.join(userDataDir, dir, 'Preferences');
      try {
        if (fs.existsSync(prefPath)) {
          const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
          const accs = pref.account_info;
          if (Array.isArray(accs) && accs.length > 0) {
            const acc = accs[0];
            if (!email && acc.email) email = acc.email;
            if (!gaiaName && (acc.full_name || acc.given_name)) gaiaName = acc.full_name || acc.given_name;
            if (acc.picture_url) avatarUrl = acc.picture_url;
            if (isDefaultOrGarbageName) {
              if (email) name = email.split('@')[0];
              else if (acc.full_name) name = acc.full_name;
            }
          }
        }
      } catch {
        // Safe read fallback: ignore JSON or filesystem errors
      }
    }

    return {
      kind: 'existing',
      browser,
      userDataDir,
      profileDir: dir,
      id: `${browser}:${dir}`,
      name,
      email,
      gaiaName,
      avatarUrl,
      initials: initialsFromName(gaiaName || name, email),
      isSupervised: Boolean(info.is_supervised),
      lastUsed: typeof info.active_time === 'number' ? info.active_time : null,
    };
  });
}

function readManagedProfiles(options = {}) {
  const managedProfilesDir = options.managedProfilesDir || MANAGED_PROFILES_DIR;
  let entries = [];
  try {
    entries = fs.readdirSync(managedProfilesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const userDataDir = path.join(managedProfilesDir, entry.name);
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(userDataDir, '.webmcp-meta.json'), 'utf8'));
      } catch {
        // Profiles created before metadata support are still valid.
      }

      let name = meta.name || entry.name;
      let email = '';
      let gaiaName = '';
      let avatarUrl = '';

      const profileDir = meta.profileDir || 'Default';
      const prefFile = path.join(userDataDir, profileDir, 'Preferences');
      try {
        if (fs.existsSync(prefFile)) {
          const pref = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
          const accs = pref.account_info;
          if (Array.isArray(accs) && accs.length > 0) {
            const acc = accs[0];
            if (acc.email) email = acc.email;
            if (acc.full_name || acc.given_name) gaiaName = acc.full_name || acc.given_name;
            if (acc.picture_url) avatarUrl = acc.picture_url;
          }
        }
      } catch {
        // Safe fallback
      }

      return {
        kind: 'managed',
        browser: 'Managed',
        userDataDir,
        profileDir,
        id: `managed:${entry.name}`,
        name,
        email,
        gaiaName,
        avatarUrl,
        initials: initialsFromName(gaiaName || name, email),
        isSupervised: false,
        lastUsed: meta.createdAt || null,
      };
    });
}

function listAllProfiles(options = {}) {
  const detected = [];
  const seenDirs = new Set();

  for (const [browser, dir] of chromeUserDataDirs()) {
    if (!fs.existsSync(dir) || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    detected.push(...readBrowserProfiles(browser, dir));
  }

  detected.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  return {
    managed: readManagedProfiles(options),
    existing: detected,
  };
}

function norm(s) {
  return String(s || '').normalize('NFC').trim().toLowerCase();
}

function findManagedProfilesMatching(query, options = {}) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const qNorm = norm(raw);
  const qStripped = qNorm.startsWith('managed:') ? qNorm.slice('managed:'.length) : qNorm;
  const managed = readManagedProfiles(options);

  // 1. Exact match on id or dirName
  const idOrDirMatches = managed.filter((p) => {
    const pIdNorm = norm(p.id);
    const pDirNorm = norm(path.basename(p.userDataDir));
    return pIdNorm === qNorm || pDirNorm === qStripped || pDirNorm === qNorm;
  });
  if (idOrDirMatches.length > 0) {
    return idOrDirMatches;
  }

  // 2. Exact match on displayName (meta.name)
  const nameMatches = managed.filter((p) => norm(p.name) === qNorm);
  return nameMatches;
}

function findManagedProfileByNameOrId(query, options = {}) {
  const matches = findManagedProfilesMatching(query, options);
  if (matches.length > 1) {
    const err = new Error(
      `Ambiguous managed profile name "${query}" matches multiple profiles: ${matches.map((m) => m.id).join(', ')}`
    );
    err.code = 'AMBIGUOUS_PROFILE';
    throw err;
  }
  return matches[0] || null;
}

function findProfileById(profileId, options = {}) {
  const raw = String(profileId || '').trim();
  if (!raw) return null;
  const qNorm = norm(raw);
  const profiles = listAllProfiles(options);
  const all = [...profiles.managed, ...profiles.existing];

  // 1. Direct exact id match
  const exactId = all.find((p) => p.id === raw || norm(p.id) === qNorm);
  if (exactId) return exactId;

  // 2. Exact match in managed profiles by dirName or displayName
  const managedMatch = findManagedProfileByNameOrId(raw, options);
  if (managedMatch) return managedMatch;

  // 3. Exact match on existing profile name
  return all.find((p) => norm(p.name) === qNorm) || null;
}

module.exports = {
  chromeUserDataDirs,
  initialsFromName,
  readBrowserProfiles,
  readManagedProfiles,
  listAllProfiles,
  norm,
  findManagedProfilesMatching,
  findManagedProfileByNameOrId,
  findProfileById,
};
