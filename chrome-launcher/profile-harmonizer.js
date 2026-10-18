'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const process = require('node:process');

/**
 * Process Guard: Kiểm tra Chrome có đang chạy trên userDataDir hay không.
 * - Linux/macOS: Đọc symlink SingletonLock (hostname-pid).
 *   - Nếu hostname khác os.hostname(): Fail-closed (Chrome coi như đang chạy trên host khác/container).
 *   - Nếu cùng hostname: Kiểm tra process.kill(pid, 0).
 *     - Nếu ESRCH: Stale lock -> tiến trình đã chết, an toàn bỏ qua.
 *     - Nếu không lỗi hoặc EPERM: Tiến trình Chrome vẫn đang chạy -> chặn.
 * - Windows: Kiểm tra lockfile với cờ r+.
 */
function checkProcessGuard(userDataDir) {
  if (!userDataDir || !fs.existsSync(userDataDir)) {
    return { running: false };
  }

  // Windows lock check
  if (process.platform === 'win32') {
    const lockFile = path.join(userDataDir, 'lockfile');
    if (fs.existsSync(lockFile)) {
      try {
        const fd = fs.openSync(lockFile, 'r+');
        fs.closeSync(fd);
        return { running: false };
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          return { running: true, error: 'CHROME_LOCKED_WIN32' };
        }
        return { running: false };
      }
    }
    return { running: false };
  }

  // Linux & macOS SingletonLock check
  const lockPath = path.join(userDataDir, 'SingletonLock');
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isSymbolicLink()) {
      return { running: false };
    }

    const target = fs.readlinkSync(lockPath);
    if (!target) return { running: false };

    let targetHost = '';
    let pidStr = target;
    const lastDash = target.lastIndexOf('-');
    if (lastDash !== -1) {
      targetHost = target.slice(0, lastDash);
      pidStr = target.slice(lastDash + 1);
    } else {
      targetHost = os.hostname();
    }

    const pid = parseInt(pidStr, 10);

    // Nếu hostname khác os.hostname() -> fail-closed an toàn
    if (targetHost && targetHost !== os.hostname()) {
      return { running: true, error: 'CHROME_RUNNING_OTHER_HOST', hostname: targetHost, pid };
    }

    if (isNaN(pid) || pid <= 0) {
      return { running: false, staleLock: true };
    }

    try {
      process.kill(pid, 0);
      return { running: true, pid, hostname: targetHost };
    } catch (err) {
      if (err.code === 'ESRCH') {
        // PID không tồn tại -> Stale lock từ phiên Chrome bị crash/kill
        // Bỏ qua và không xoá symlink (để Chrome tự dọn)
        return { running: false, staleLock: true, pid };
      }
      // EPERM nghĩa là tiến trình còn sống nhưng thuộc user khác
      return { running: true, pid, hostname: targetHost };
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { running: false };
    }
    return { running: true, error: 'GUARD_STAT_ERROR', code: err.code };
  }
}

/**
 * Ghi atomic file JSON an toàn và bảo tồn bản .bak gốc qua mọi lần chạy.
 * Tuân thủ quy chuẩn Ponytail: Chỉ copy .bak khi chưa tồn tại.
 */
function atomicWriteJsonPreserveBak(filePath, jsonObject) {
  const bakPath = `${filePath}.bak`;
  if (!fs.existsSync(bakPath) && fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, bakPath);
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const content = JSON.stringify(jsonObject, null, 2);
  fs.writeFileSync(tempPath, content, 'utf8');

  let attempts = 0;
  while (attempts < 3) {
    try {
      fs.renameSync(tempPath, filePath);
      return true;
    } catch (err) {
      attempts++;
      if (attempts >= 3) {
        try { fs.unlinkSync(tempPath); } catch {}
        throw err;
      }
      const start = Date.now();
      while (Date.now() - start < 50) {}
    }
  }
}

/**
 * Tải ảnh avatar từ URL (Google profile picture) về buffer trong RAM.
 * Thất bại do mạng thì trả về null mà không ngắt luồng đổi tên.
 */
async function tryFetchAvatarBuffer(avatarUrl) {
  if (!avatarUrl || typeof avatarUrl !== 'string') return null;
  try {
    let fetchUrl = avatarUrl;
    if (fetchUrl.includes('googleusercontent.com') && !fetchUrl.includes('=s')) {
      fetchUrl = `${fetchUrl}=s256-c-ns`;
    }
    const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

/**
 * Đề xuất tên profile chuẩn hóa từ email và tên hiện tại.
 * Hỗ trợ fallbackName (từ .webmcp-meta.json hoặc profile.name) khi tên hiện tại là rác.
 */
function proposeHarmonizedName(currentName, email, gaiaName, fallbackName = '') {
  const isGarbage = !currentName || /^Person \d+$/i.test(currentName) || currentName === 'Your Chrome' || currentName === 'Default' || currentName.includes('@');
  if (email && typeof email === 'string' && email.includes('@')) {
    const username = email.split('@')[0].trim();
    if (isGarbage) return username;
  }
  if (isGarbage && fallbackName && fallbackName !== 'Your Chrome' && fallbackName !== 'Default') {
    return fallbackName;
  }
  return isGarbage ? (gaiaName || fallbackName || 'Profile') : currentName;
}

/**
 * Harmonize 1 profile cụ thể trên đĩa.
 */
async function harmonizeProfile(profile, options = {}) {
  const { userDataDir, profileDir } = profile;
  const dryRun = Boolean(options.dryRun);
  const syncAvatar = options.syncAvatar !== false;

  if (!userDataDir || !profileDir) {
    return { ok: false, error: 'INVALID_PROFILE_ARGUMENTS' };
  }

  // Bước 1: Process Guard check lần 1
  const guard = checkProcessGuard(userDataDir);
  if (guard.running) {
    return {
      ok: false,
      error: 'CHROME_RUNNING',
      guard,
      message: 'Chrome is currently running. Please close Chrome before harmonizing on-disk files, or use gateway set_profile_name.',
    };
  }

  const prefPath = path.join(userDataDir, profileDir, 'Preferences');
  const localStatePath = path.join(userDataDir, 'Local State');
  const avatarFilePath = path.join(userDataDir, profileDir, 'Google Profile Picture.png');

  if (!fs.existsSync(prefPath)) {
    return { ok: false, error: 'PREFERENCES_NOT_FOUND', path: prefPath };
  }

  // Parse Preferences (fail-closed nếu malformed)
  let pref = {};
  try {
    pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
  } catch (err) {
    return { ok: false, error: 'PREFERENCES_MALFORMED', message: err.message };
  }

  // Parse Local State nếu có (fail-closed nếu malformed)
  let ls = null;
  if (fs.existsSync(localStatePath)) {
    try {
      ls = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    } catch (err) {
      return { ok: false, error: 'LOCAL_STATE_MALFORMED', message: err.message };
    }
  }

  // Trích xuất danh tính
  const acc = Array.isArray(pref.account_info) && pref.account_info.length > 0 ? pref.account_info[0] : null;
  const email = acc?.email || profile.email || '';
  const gaiaName = acc?.full_name || acc?.given_name || profile.gaiaName || '';
  const picUrl = acc?.picture_url || profile.avatarUrl || '';
  const currentName = pref.profile?.name || profile.name || '';

  const targetName = options.targetName || proposeHarmonizedName(currentName, email, gaiaName, profile.name);

  // Avatar download vào RAM buffer trước (chưa chạm đĩa)
  let avatarBuffer = null;
  const avatarAlreadyOnDisk = fs.existsSync(avatarFilePath);
  if (!dryRun && syncAvatar && picUrl && !avatarAlreadyOnDisk) {
    avatarBuffer = await tryFetchAvatarBuffer(picUrl);
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      profileId: profile.id,
      currentName,
      targetName,
      email,
      gaiaName,
      avatarExists: avatarAlreadyOnDisk,
      avatarWillDownload: !avatarAlreadyOnDisk && Boolean(picUrl),
    };
  }

  // Bước 2: Re-check Process Guard ngay trước khi bắt đầu ghi đĩa
  const preWriteGuard = checkProcessGuard(userDataDir);
  if (preWriteGuard.running) {
    return {
      ok: false,
      error: 'CHROME_STARTED_DURING_HARMONIZATION',
      guard: preWriteGuard,
      message: 'Chrome was started while harmonizing was in progress. Write aborted to prevent corruption.',
    };
  }

  // Ghi avatar ra đĩa nếu đã tải được buffer
  if (avatarBuffer && !fs.existsSync(avatarFilePath)) {
    fs.writeFileSync(avatarFilePath, avatarBuffer);
  }
  const avatarExists = fs.existsSync(avatarFilePath);

  // Bước 3: Cập nhật RAM Preferences
  pref.profile = pref.profile || {};
  pref.profile.name = targetName;
  pref.profile.using_default_name = false;
  pref.profile.using_gaia_name = false;

  // Bước 4: Cập nhật RAM Local State
  if (ls) {
    ls.profile = ls.profile || {};
    ls.profile.info_cache = ls.profile.info_cache || {};
    ls.profile.info_cache[profileDir] = ls.profile.info_cache[profileDir] || {};
    const info = ls.profile.info_cache[profileDir];
    info.name = targetName;
    info.is_using_default_name = false;
    if (email) info.user_name = email;
    if (gaiaName) info.gaia_name = gaiaName;
    if (avatarExists) {
      info.gaia_picture_file_name = 'Google Profile Picture.png';
      info.use_gaia_picture = true;
      info.is_using_default_avatar = false;
    }
  }

  // Bước 5: Ghi atomic và bảo tồn .bak
  atomicWriteJsonPreserveBak(prefPath, pref);
  if (ls) {
    atomicWriteJsonPreserveBak(localStatePath, ls);
  }

  return {
    ok: true,
    profileId: profile.id,
    oldName: currentName,
    newName: targetName,
    email,
    gaiaName,
    avatarSynced: avatarExists,
  };
}

module.exports = {
  checkProcessGuard,
  atomicWriteJsonPreserveBak,
  tryFetchAvatarBuffer,
  proposeHarmonizedName,
  harmonizeProfile,
};
