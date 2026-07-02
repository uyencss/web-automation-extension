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
    const name = info.name || dir;
    const email = info.user_name || '';
    return {
      kind: 'existing',
      browser,
      userDataDir,
      profileDir: dir,
      id: `${browser}:${dir}`,
      name,
      email,
      gaiaName: info.gaia_name || info.gaia_given_name || '',
      initials: initialsFromName(info.gaia_name || name, email),
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

      const name = meta.name || entry.name;
      return {
        kind: 'managed',
        browser: 'Managed',
        userDataDir,
        profileDir: 'Default',
        id: `managed:${entry.name}`,
        name,
        email: '',
        gaiaName: '',
        initials: initialsFromName(name, ''),
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
