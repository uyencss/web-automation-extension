import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

export function resolveMacUid(uid, execFileSyncFn = execFileSync) {
  if (uid !== undefined && uid !== null && `${uid}`.trim() !== '') return Number(uid);
  if (typeof process.getuid === 'function') return process.getuid();
  return Number(String(execFileSyncFn('/usr/bin/id', ['-u'], { encoding: 'utf8' })).trim());
}

export function requireMacGuiDomain(uid, { spawnSyncFn = spawnSync } = {}) {
  const resolvedUid = resolveMacUid(uid);
  const guiDomain = `gui/${resolvedUid}`;
  const chk = spawnSyncFn('/bin/launchctl', ['print', guiDomain], { encoding: 'utf8' });
  if (chk.status !== 0) {
    const stderr = String(chk.stderr || chk.stdout || '').trim();
    const err = new Error(`MACOS_NO_GUI_SESSION: launchctl print ${guiDomain} failed${stderr ? ` (${stderr})` : ''}`);
    err.code = 'MACOS_NO_GUI_SESSION';
    err.domain = guiDomain;
    throw err;
  }
  return guiDomain;
}

function waitForLaunchctlUnload(target, spawnSyncFn, sleepFn, waitMs = 3000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const chk = spawnSyncFn('/bin/launchctl', ['print', target], { encoding: 'utf8' });
    if (chk.status !== 0) return true;
    sleepFn(50);
  }
  return spawnSyncFn('/bin/launchctl', ['print', target], { encoding: 'utf8' }).status !== 0;
}

/**
 * Safely install and reload a macOS LaunchAgent in gui/$uid:
 * checks GUI session BEFORE mutating plist, prevents self-bootout, cleans legacy user/$uid,
 * waits for bootout completion before launchctl enable + bootstrap, and rolls back on failure.
 */
export function installAndBootstrapLaunchAgent({
  label,
  plistPath,
  plistContent,
  uid,
  env = process.env,
  cleanupLegacyUserDomain = true,
  refuseSelf = true,
  bootoutWaitMs = 3000,
  dryRun = false,
  deps = {},
} = {}) {
  if (process.platform !== 'darwin' && !deps.forceDarwin) {
    const err = new Error('LAUNCHD_UNSUPPORTED_PLATFORM');
    err.code = 'LAUNCHD_UNSUPPORTED_PLATFORM';
    throw err;
  }
  const spawnSyncFn = deps.spawnSync || spawnSync;
  const fsApi = deps.fs || fs;
  const sleepFn = deps.sleepSync || sleepSync;

  const resolvedUid = resolveMacUid(uid, deps.execFileSync);
  const guiDomain = requireMacGuiDomain(resolvedUid, { spawnSyncFn });
  const serviceTarget = `${guiDomain}/${label}`;

  if (refuseSelf && env?.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME === label) {
    const err = new Error(`ERR_LAUNCHD_SELF_BOOTOUT: Refusing to bootout own active LaunchAgent '${label}'.`);
    err.code = 'ERR_LAUNCHD_SELF_BOOTOUT';
    throw err;
  }
  if (dryRun) {
    return { ok: true, dryRun: true, domain: guiDomain, label, plistPath };
  }

  let prevContent = null;
  let hadPrev = false;
  if (fsApi.existsSync(plistPath)) {
    hadPrev = true;
    prevContent = fsApi.readFileSync(plistPath, 'utf8');
  }

  fsApi.mkdirSync(path.dirname(plistPath), { recursive: true });
  fsApi.writeFileSync(plistPath, plistContent, { encoding: 'utf8', mode: 0o644 });

  const rollback = () => {
    try {
      if (hadPrev && prevContent !== null) fsApi.writeFileSync(plistPath, prevContent, 'utf8');
      else if (!hadPrev && fsApi.existsSync(plistPath)) fsApi.unlinkSync(plistPath);
    } catch {}
  };

  if (cleanupLegacyUserDomain) {
    try {
      spawnSyncFn('/bin/launchctl', ['bootout', `user/${resolvedUid}/${label}`], { encoding: 'utf8' });
    } catch {}
  }

  spawnSyncFn('/bin/launchctl', ['bootout', serviceTarget], { encoding: 'utf8' });
  spawnSyncFn('/bin/launchctl', ['bootout', guiDomain, plistPath], { encoding: 'utf8' });
  const unloaded = waitForLaunchctlUnload(serviceTarget, spawnSyncFn, sleepFn, bootoutWaitMs);
  if (!unloaded) {
    rollback();
    const err = new Error(`ERR_LAUNCHD_BOOTOUT_TIMEOUT: ${serviceTarget} stayed loaded after ${bootoutWaitMs}ms`);
    err.code = 'ERR_LAUNCHD_BOOTOUT_TIMEOUT';
    throw err;
  }

  spawnSyncFn('/bin/launchctl', ['enable', serviceTarget], { encoding: 'utf8' });
  const boot = spawnSyncFn('/bin/launchctl', ['bootstrap', guiDomain, plistPath], { encoding: 'utf8' });
  if (boot.status !== 0) {
    rollback();
    const detail = String(boot.stderr || boot.stdout || `exit ${boot.status}`).trim();
    const err = new Error(`ERR_LAUNCHD_BOOTSTRAP_FAILED: launchctl bootstrap ${guiDomain} ${plistPath} failed: ${detail}`);
    err.code = 'ERR_LAUNCHD_BOOTSTRAP_FAILED';
    err.stderr = detail;
    throw err;
  }

  return { ok: true, domain: guiDomain, label, plistPath };
}

export function uninstallLaunchAgent({
  label,
  plistPath,
  uid,
  env = process.env,
  removePlist = false,
  cleanupLegacyUserDomain = true,
  refuseSelf = true,
  deps = {},
} = {}) {
  const spawnSyncFn = deps.spawnSync || spawnSync;
  const fsApi = deps.fs || fs;
  const sleepFn = deps.sleepSync || sleepSync;
  const resolvedUid = resolveMacUid(uid, deps.execFileSync);
  const guiDomain = requireMacGuiDomain(resolvedUid, { spawnSyncFn });
  const serviceTarget = `${guiDomain}/${label}`;

  if (refuseSelf && env?.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME === label) {
    const err = new Error(`ERR_LAUNCHD_SELF_BOOTOUT: Refusing to bootout own active LaunchAgent '${label}'.`);
    err.code = 'ERR_LAUNCHD_SELF_BOOTOUT';
    throw err;
  }

  const res = spawnSyncFn('/bin/launchctl', ['bootout', serviceTarget], { encoding: 'utf8' });
  if (res.status !== 0) {
    const out = `${res.stderr || ''} ${res.stdout || ''}`.trim();
    const isNotLoaded = res.status === 3 || res.status === 113 || /could not find service|no such process/i.test(out);
    if (!isNotLoaded) {
      const err = new Error(`ERR_LAUNCHD_BOOTOUT_FAILED: ${serviceTarget}: ${out || `exit ${res.status}`}`);
      err.code = 'ERR_LAUNCHD_BOOTOUT_FAILED';
      throw err;
    }
  }
  if (cleanupLegacyUserDomain) {
    try { spawnSyncFn('/bin/launchctl', ['bootout', `user/${resolvedUid}/${label}`], { encoding: 'utf8' }); } catch {}
  }
  waitForLaunchctlUnload(serviceTarget, spawnSyncFn, sleepFn, 2000);
  if (removePlist && plistPath && fsApi.existsSync(plistPath)) {
    fsApi.unlinkSync(plistPath);
  }
  return { ok: true, domain: guiDomain, label, plistPath: plistPath || null };
}
