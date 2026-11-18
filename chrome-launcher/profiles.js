'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { MANAGED_PROFILES_DIR } = require('./config');

function chromeUserDataDirs(options = {}) {
  if (Array.isArray(options.chromeUserDataDirs)) {
    return options.chromeUserDataDirs;
  }
  if (process.env.WEBMCP_CHROME_USER_DATA_DIR) {
    return [['Chrome', process.env.WEBMCP_CHROME_USER_DATA_DIR]];
  }
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

  function extractFromPreferences(prefFile) {
    let email = '';
    let gaiaName = '';
    let avatarUrl = '';
    try {
      if (!fs.existsSync(prefFile)) return { email, gaiaName, avatarUrl };
      const pref = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
      const accs = Array.isArray(pref.account_info) ? pref.account_info : [];
      for (const acc of accs) {
        if (!email && acc?.email) email = String(acc.email).trim();
        if (!gaiaName && (acc?.full_name || acc?.given_name)) gaiaName = acc.full_name || acc.given_name;
        if (!avatarUrl && acc?.picture_url) avatarUrl = acc.picture_url;
      }
      if (!email) {
        const candidates = [
          pref.google?.services?.last_username,
          pref.google?.services?.username,
          pref.signin?.allowed_username,
          pref.profile?.user_name,
        ];
        email = candidates.find((c) => typeof c === 'string' && c.includes('@')) || '';
      }
      if (!email && pref.signin?.accounts_metadata_dict && typeof pref.signin.accounts_metadata_dict === 'object') {
        for (const [k, v] of Object.entries(pref.signin.accounts_metadata_dict)) {
          if (v?.email && String(v.email).includes('@')) { email = String(v.email).trim(); break; }
          if (String(k).includes('@')) { email = String(k).trim(); break; }
        }
      }
    } catch {
      // Safe read fallback: ignore JSON or filesystem errors
    }
    return { email, gaiaName, avatarUrl };
  }

  const results = [];
  for (const [dir, info] of Object.entries(cache)) {
    if (!fs.existsSync(path.join(userDataDir, dir))) {
      continue;
    }

    const rawName = info.name || dir;
    let name = rawName;
    let email = info.user_name || info.gaia_email || '';
    let gaiaName = info.gaia_name || info.gaia_given_name || '';
    let avatarUrl = '';

    const isDefaultOrGarbageName = !name || /^Person \d+$/i.test(name) || name === 'Your Chrome' || name === 'Default' || name.includes('@');
    if (!email || !gaiaName || !avatarUrl || isDefaultOrGarbageName) {
      const parsed = extractFromPreferences(path.join(userDataDir, dir, 'Preferences'));
      if (!email && parsed.email) email = parsed.email;
      if (!gaiaName && parsed.gaiaName) gaiaName = parsed.gaiaName;
      if (!avatarUrl && parsed.avatarUrl) avatarUrl = parsed.avatarUrl;
      if (isDefaultOrGarbageName) {
        if (email) name = email.split('@')[0];
        else if (gaiaName) name = gaiaName;
      }
    }

    if (browser !== 'Chrome') {
      const isGarbage = /^(your chromium|your chrome|your cốc cốc|default|person \d+)$/i.test(rawName);
      if (!email && isGarbage && !fs.existsSync(path.join(userDataDir, dir, '.webmcp-meta.json'))) {
        continue;
      }
    }

    results.push({
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
    });
  }

  return results;
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
      let email = meta.email || '';
      let gaiaName = meta.gaiaName || '';
      let avatarUrl = '';

      const profileDir = meta.profileDir || 'Default';
      const prefFile = path.join(userDataDir, profileDir, 'Preferences');
      try {
        if (fs.existsSync(prefFile)) {
          const pref = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
          const accs = Array.isArray(pref.account_info) ? pref.account_info : [];
          for (const acc of accs) {
            if (!email && acc?.email) email = String(acc.email).trim();
            if (!gaiaName && (acc?.full_name || acc?.given_name)) gaiaName = acc.full_name || acc.given_name;
            if (!avatarUrl && acc?.picture_url) avatarUrl = acc.picture_url;
          }
          if (!email) {
            const cand = [
              pref.google?.services?.last_username,
              pref.google?.services?.username,
              pref.signin?.allowed_username,
              pref.profile?.user_name,
            ].find((c) => typeof c === 'string' && c.includes('@'));
            if (cand) email = cand.trim();
          }
        }
        if (!email) {
          const lsPath = path.join(userDataDir, 'Local State');
          if (fs.existsSync(lsPath)) {
            const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
            const info = ls?.profile?.info_cache?.[profileDir];
            if (info?.user_name && String(info.user_name).includes('@')) email = String(info.user_name).trim();
            else if (info?.gaia_email && String(info.gaia_email).includes('@')) email = String(info.gaia_email).trim();
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

  for (const [browser, dir] of chromeUserDataDirs(options)) {
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

function slugifyQuery(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

function findManagedProfilesMatching(query, options = {}) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const qNorm = norm(raw);
  const qStripped = qNorm.startsWith('managed:') ? qNorm.slice('managed:'.length) : qNorm;
  if (!qStripped) return [];
  const qSlug = slugifyQuery(raw);
  const managed = readManagedProfiles(options);

  // 1. Exact match on id or dirName (including slugified unprefixed query)
  const idOrDirMatches = managed.filter((p) => {
    const pIdNorm = norm(p.id);
    const pDirNorm = norm(path.basename(p.userDataDir));
    return (
      pIdNorm === qNorm ||
      pDirNorm === qStripped ||
      pDirNorm === qNorm ||
      (!raw.includes(':') && qSlug && pDirNorm === qSlug)
    );
  });
  if (idOrDirMatches.length > 0) {
    return idOrDirMatches;
  }

  // 2. Exact match on displayName (meta.name) or gaiaName
  const nameMatches = managed.filter((p) => (
    norm(p.name) === qStripped ||
    norm(p.name) === qNorm ||
    (p.gaiaName && (norm(p.gaiaName) === qStripped || norm(p.gaiaName) === qNorm))
  ));
  if (nameMatches.length > 0) {
    return nameMatches;
  }

  // 3. Exact match on email or email local-part
  const emailMatches = managed.filter((p) => (
    (p.email && (norm(p.email) === qStripped || norm(p.email) === qNorm)) ||
    (!qStripped.includes('@') && p.email && norm(p.email.split('@')[0]) === qStripped)
  ));
  if (emailMatches.length > 0) {
    return emailMatches;
  }

  // 4. Exact match on profileDir
  return managed.filter((p) => (
    p.profileDir && (norm(p.profileDir) === qStripped || norm(p.profileDir) === qNorm)
  ));
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

function findExistingProfilesMatching(query, existingProfiles = []) {
  const raw = String(query || '').trim();
  if (!raw || !Array.isArray(existingProfiles) || existingProfiles.length === 0) return [];
  const qNorm = norm(raw);

  // 1. Exact id
  const idMatches = existingProfiles.filter((p) => p.id === raw || norm(p.id) === qNorm);
  if (idMatches.length > 0) {
    return idMatches;
  }

  // 2. Exact name or gaiaName
  const nameMatches = existingProfiles.filter((p) => (
    norm(p.name) === qNorm ||
    (p.gaiaName && norm(p.gaiaName) === qNorm)
  ));
  if (nameMatches.length > 0) {
    return nameMatches;
  }

  // 3. Exact email or email local-part
  const emailMatches = existingProfiles.filter((p) => (
    (p.email && norm(p.email) === qNorm) ||
    (!qNorm.includes('@') && p.email && norm(p.email.split('@')[0]) === qNorm)
  ));
  if (emailMatches.length > 0) {
    return emailMatches;
  }

  // 4. Exact profileDir (prefer Chrome when multiple browsers share the dir)
  const dirMatches = existingProfiles.filter((p) => p.profileDir && norm(p.profileDir) === qNorm);
  if (dirMatches.length > 1) {
    const chromeMatches = dirMatches.filter((p) => p.browser === 'Chrome');
    if (chromeMatches.length === 1) {
      return chromeMatches;
    }
  }
  return dirMatches;
}

function findProfileById(profileId, options = {}) {
  const raw = String(profileId || '').trim();
  if (!raw) return null;
  const qNorm = norm(raw);

  // Explicit managed: prefix resolves only inside managed profiles.
  if (qNorm.startsWith('managed:')) {
    return findManagedProfileByNameOrId(raw, options);
  }

  // Explicit <Browser>:<ProfileDir> prefix resolves only exact existing id.
  if (raw.includes(':')) {
    const existing = listAllProfiles(options).existing;
    return existing.find((p) => p.id === raw) || existing.find((p) => norm(p.id) === qNorm) || null;
  }

  // Tier 1: Managed Profiles
  const managedMatch = findManagedProfileByNameOrId(raw, options);
  if (managedMatch) return managedMatch;

  // Tier 2: Chrome User Data
  const existing = listAllProfiles(options).existing;
  const matches = findExistingProfilesMatching(raw, existing);
  if (matches.length > 1) {
    const err = new Error(
      `Ambiguous Chrome profile query "${profileId}" matches multiple profiles: ${matches.map((m) => m.id).join(', ')}`
    );
    err.code = 'AMBIGUOUS_PROFILE';
    throw err;
  }
  return matches[0] || null;
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
  findExistingProfilesMatching,
  findProfileById,
};
