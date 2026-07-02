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

module.exports = {
  getDataDir,
  getManagedProfilesDir,
  getSessionsFile,
  ensureDirs,
  DATA_DIR: getDataDir(),
  MANAGED_PROFILES_DIR: getManagedProfilesDir(),
  SESSIONS_FILE: getSessionsFile(),
};
