import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const launcher = require('../../chrome-launcher');

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-close-graceful-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spawnSigtermTrappingChild(t, markerPath) {
  const script = [
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(markerPath)};`,
    "process.on('SIGTERM', () => { try { fs.appendFileSync(marker, 'SIGTERM\\n'); } catch {} });",
    "setInterval(() => {}, 1000);",
  ].join(' ');
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  t.after(() => {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  });
  return child;
}

test('closeChrome waits for graceful unlock after closeBrowser before SIGTERM', async (t) => {
  const root = makeTmpDir(t);
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const userDataDir = path.join(managedProfilesDir, 'graceful-prof');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, '.webmcp-meta.json'), JSON.stringify({ name: 'graceful-prof', sessionDirty: true }));
  const sessionsFile = path.join(root, 'sessions.json');
  const markerPath = path.join(root, 'signals.log');

  const child = spawnSigtermTrappingChild(t, markerPath);
  fs.symlinkSync(`${os.hostname()}-${child.pid}`, path.join(userDataDir, 'SingletonLock'));
  launcher.saveSessions({
    version: 1,
    managedSessions: {
      [userDataDir]: { pid: child.pid, startedAt: new Date().toISOString() },
    },
    gateway: null,
  }, sessionsFile);

  let closeBrowserCalled = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        profileDetails: [{ profileId: 'managed:graceful-prof', name: 'graceful-prof', userDataDir }],
      }));
      return;
    }
    if (req.url === '/api' && req.method === 'POST') {
      closeBrowserCalled += 1;
      // Simulate Chrome flushing SQLite WAL and releasing SingletonLock 150ms after closeBrowser
      setTimeout(() => {
        try { fs.unlinkSync(path.join(userDataDir, 'SingletonLock')); } catch {}
      }, 150);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const closeRes = await launcher.closeChrome({
    profileId: 'managed:graceful-prof',
    gatewayUrl: `http://127.0.0.1:${port}`,
    managedProfilesDir,
    sessionsFile,
    gracefulTimeoutMs: 2500,
    killTimeoutMs: 500,
  });

  assert.equal(closeBrowserCalled, 1);
  assert.equal(closeRes.ok, true);
  assert.equal(closeRes.closedCount, 1);
  assert.equal(fs.existsSync(markerPath), false, 'Must NOT send SIGTERM when profile unlocks within gracefulTimeoutMs');
  const meta = JSON.parse(fs.readFileSync(path.join(userDataDir, '.webmcp-meta.json'), 'utf8'));
  assert.equal(meta.sessionDirty, false);
});

test('closeChrome does NOT escalate to SIGKILL by default, and only sends SIGKILL when forceKill: true', async (t) => {
  const root = makeTmpDir(t);
  const managedProfilesDir = path.join(root, 'managed-profiles');
  const userDataDir = path.join(managedProfilesDir, 'stubborn-prof');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, '.webmcp-meta.json'), JSON.stringify({ name: 'stubborn-prof', sessionDirty: true }));
  const sessionsFile = path.join(root, 'sessions.json');
  const markerPath = path.join(root, 'stubborn-signals.log');

  const child = spawnSigtermTrappingChild(t, markerPath);
  const lockPath = path.join(userDataDir, 'SingletonLock');
  fs.symlinkSync(`${os.hostname()}-${child.pid}`, lockPath);
  launcher.saveSessions({
    version: 1,
    managedSessions: {
      [userDataDir]: { pid: child.pid, startedAt: new Date().toISOString() },
    },
    gateway: null,
  }, sessionsFile);

  // Wait briefly for child SIGTERM handler to register before signaling
  await new Promise((r) => setTimeout(r, 150));

  // 1. Default forceKill (omitted/false): sends SIGTERM, does NOT SIGKILL or strip live lock
  await launcher.closeChrome({
    profileId: 'managed:stubborn-prof',
    managedProfilesDir,
    sessionsFile,
    gracefulTimeoutMs: 100,
    killTimeoutMs: 200,
  });

  assert.equal(launcher.isPidAlive(child.pid), true, 'Default closeChrome must NOT SIGKILL a live process');
  assert.equal(launcher.isProfileLocked(userDataDir), true, 'Live process lock must remain intact when process did not exit');
  assert.match(fs.readFileSync(markerPath, 'utf8'), /SIGTERM/);

  // 2. Explicit forceKill: true escalates to SIGKILL and cleans lock + session state
  const forceRes = await launcher.closeChrome({
    profileId: 'managed:stubborn-prof',
    managedProfilesDir,
    sessionsFile,
    gracefulTimeoutMs: 50,
    killTimeoutMs: 150,
    forceKill: true,
  });
  assert.equal(forceRes.ok, true);
  assert.equal(forceRes.closedCount, 1);
  assert.equal(launcher.isPidAlive(child.pid), false);
  assert.equal(launcher.isProfileLocked(userDataDir), false);
  assert.equal(launcher.loadSessions(sessionsFile).managedSessions[userDataDir], undefined);
});
