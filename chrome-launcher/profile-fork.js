'use strict';

const fs = require('fs');
const path = require('path');
const { isProfileLocked, createManagedProfile } = require('./launcher');

const CACHE_RE = /(^|[\\/])(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|CacheStorage)([\\/]|$)/;

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
  };
}

module.exports = {
  CACHE_RE,
  forkExistingProfile,
};
