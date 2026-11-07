'use strict';

const fs = require('fs');
const path = require('path');
const { MANAGED_PROFILES_DIR } = require('./config');
const { isProfileLocked, createManagedProfile } = require('./launcher');

const CACHE_RE = /(^|[\\/])(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|CacheStorage)([\\/]|$)/;
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
    filter: (src) => !CACHE_RE.test(path.relative(srcProfilePath, src)),
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

module.exports = {
  CACHE_RE,
  DEFAULT_MAX_NATIVE_CLEAN_PROFILES,
  HARD_MAX_FARM_PROFILES,
  countManagedProfiles,
  forkExistingProfile,
};
