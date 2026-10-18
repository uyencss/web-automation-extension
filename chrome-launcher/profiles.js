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

    const isDefaultOrGarbageName = !name || /^Person \d+$/i.test(name) || name === 'Your Chrome' || name === 'Default';
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

      const prefFile = path.join(userDataDir, 'Default', 'Preferences');
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
        profileDir: 'Default',
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

function findProfileById(profileId, options = {}) {
  const profiles = listAllProfiles(options);
  return [...profiles.managed, ...profiles.existing].find((profile) => profile.id === profileId) || null;
}

module.exports = {
  chromeUserDataDirs,
  initialsFromName,
  readBrowserProfiles,
  readManagedProfiles,
  listAllProfiles,
  findProfileById,
};
