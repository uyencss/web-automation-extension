'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getDataDir() {
  // WEBMCP_HOME is the shared kit data dir (used by both this extension and the
  // webmcp-workflow-cli CLI). WEBMCP_DATA_DIR is kept as a back-compat alias.
  return process.env.WEBMCP_HOME
    || process.env.WEBMCP_DATA_DIR
    || path.join(os.homedir(), '.webmcp');
}

function getManagedProfilesDir(dataDir = getDataDir()) {
  return path.join(dataDir, 'managed-profiles');
}

function getSessionsFile(dataDir = getDataDir()) {
  return path.join(dataDir, 'sessions.json');
}

function ensureDirs(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const managedProfilesDir = options.managedProfilesDir || getManagedProfilesDir(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(managedProfilesDir, { recursive: true });
  return {
    dataDir,
    managedProfilesDir,
    sessionsFile: options.sessionsFile || getSessionsFile(dataDir),
  };
}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
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

module.exports = {
  getDataDir,
  getManagedProfilesDir,
  getSessionsFile,
  ensureDirs,
  atomicWriteJson,
  patchJson,
  DATA_DIR: getDataDir(),
  MANAGED_PROFILES_DIR: getManagedProfilesDir(),
  SESSIONS_FILE: getSessionsFile(),
};
