'use strict';

const fs = require('fs');
const path = require('path');
const { SESSIONS_FILE } = require('./config');

function emptyState() {
  return {
    version: 1,
    managedSessions: {},
    gateway: null,
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;

  if (raw.managedSessions && typeof raw.managedSessions === 'object') {
    state.managedSessions = raw.managedSessions;
  }
  if (raw.gateway && typeof raw.gateway === 'object') {
    state.gateway = raw.gateway;
  }

  return state;
}

function loadSessions(sessionsFile = SESSIONS_FILE) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(sessionsFile, 'utf8')));
  } catch {
    return emptyState();
  }
}

function saveSessions(state, sessionsFile = SESSIONS_FILE) {
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  fs.writeFileSync(sessionsFile, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
  return normalizeState(state);
}

function pruneDeadSessions(sessionsFile = SESSIONS_FILE) {
  const state = loadSessions(sessionsFile);
  let changed = false;

  for (const [userDataDir, session] of Object.entries(state.managedSessions)) {
    if (!isPidAlive(session?.pid)) {
      delete state.managedSessions[userDataDir];
      changed = true;
    }
  }

  if (state.gateway && !isPidAlive(state.gateway.pid)) {
    state.gateway = null;
    changed = true;
  }

  if (changed) saveSessions(state, sessionsFile);
  return state;
}

function rememberManagedSession(userDataDir, pid, sessionsFile = SESSIONS_FILE) {
  const state = pruneDeadSessions(sessionsFile);
  state.managedSessions[userDataDir] = {
    pid,
    startedAt: new Date().toISOString(),
  };
  saveSessions(state, sessionsFile);
  return state.managedSessions[userDataDir];
}

function hasLiveManagedSession(userDataDir, sessionsFile = SESSIONS_FILE) {
  const state = pruneDeadSessions(sessionsFile);
  return isPidAlive(state.managedSessions[userDataDir]?.pid);
}

function rememberGatewaySession(pid, options = {}) {
  const sessionsFile = options.sessionsFile || SESSIONS_FILE;
  const state = pruneDeadSessions(sessionsFile);
  state.gateway = {
    pid,
    url: options.url || null,
    startedAt: new Date().toISOString(),
  };
  saveSessions(state, sessionsFile);
  return state.gateway;
}

function getGatewaySession(sessionsFile = SESSIONS_FILE) {
  return pruneDeadSessions(sessionsFile).gateway;
}

module.exports = {
  emptyState,
  isPidAlive,
  loadSessions,
  saveSessions,
  pruneDeadSessions,
  rememberManagedSession,
  hasLiveManagedSession,
  rememberGatewaySession,
  getGatewaySession,
};
