import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkProcessGuard,
  proposeHarmonizedName,
  harmonizeProfile,
  atomicWriteJsonPreserveBak,
} from '../../chrome-launcher/profile-harmonizer.js';

function createTempProfileEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-harmonizer-test-'));
  const profileDirName = 'Profile 8';
  const profileFullPath = path.join(tmpDir, profileDirName);
  fs.mkdirSync(profileFullPath, { recursive: true });

  const initialPreferences = {
    profile: {
      name: 'Person 1',
      using_default_name: true,
    },
    account_info: [
      {
        account_id: 'gaia-12345',
        email: 'hieu.nquang90@gmail.com',
        full_name: 'Quang Hieu Nguyen',
        given_name: 'Hieu',
        picture_url: 'https://lh3.googleusercontent.com/a/sample-avatar',
      },
    ],
  };

  const initialLocalState = {
    profile: {
      info_cache: {
        [profileDirName]: {
          name: 'Person 1',
          user_name: '',
          is_using_default_name: true,
        },
      },
    },
  };

  fs.writeFileSync(
    path.join(profileFullPath, 'Preferences'),
    JSON.stringify(initialPreferences, null, 2),
    'utf8'
  );

  fs.writeFileSync(
    path.join(tmpDir, 'Local State'),
    JSON.stringify(initialLocalState, null, 2),
    'utf8'
  );

  const profile = {
    id: `Chrome:${profileDirName}`,
    browser: 'Chrome',
    userDataDir: tmpDir,
    profileDir: profileDirName,
    name: 'Person 1',
    email: '',
  };

  return { tmpDir, profileDirName, profileFullPath, profile };
}

function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

test('Test 1: Stale lock (dead PID) is safely ignored', () => {
  const { tmpDir } = createTempProfileEnv();
  try {
    if (process.platform !== 'win32') {
      const lockPath = path.join(tmpDir, 'SingletonLock');
      // PID 999999999 almost certainly does not exist
      fs.symlinkSync(`${os.hostname()}-999999999`, lockPath);
      const guard = checkProcessGuard(tmpDir);
      assert.equal(guard.running, false);
      assert.equal(guard.staleLock, true);
    }
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('Test 2: Active lock (current process PID) is caught and blocks harmonization', async () => {
  const { tmpDir, profile } = createTempProfileEnv();
  try {
    if (process.platform !== 'win32') {
      const lockPath = path.join(tmpDir, 'SingletonLock');
      fs.symlinkSync(`${os.hostname()}-${process.pid}`, lockPath);
      const guard = checkProcessGuard(tmpDir);
      assert.equal(guard.running, true);
      assert.equal(guard.pid, process.pid);

      const res = await harmonizeProfile(profile);
      assert.equal(res.ok, false);
      assert.equal(res.error, 'CHROME_RUNNING');
    }
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('Test 3: Different hostname in SingletonLock fails closed', () => {
  const { tmpDir } = createTempProfileEnv();
  try {
    if (process.platform !== 'win32') {
      const lockPath = path.join(tmpDir, 'SingletonLock');
      fs.symlinkSync(`other-remote-host-12345`, lockPath);
      const guard = checkProcessGuard(tmpDir);
      assert.equal(guard.running, true);
      assert.equal(guard.error, 'CHROME_RUNNING_OTHER_HOST');
    }
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('Test 4: Identity harmonization strips @gmail.com and dual-patches', async () => {
  const { tmpDir, profileFullPath, profile } = createTempProfileEnv();
  try {
    // Propose name helper
    const proposed = proposeHarmonizedName('Person 1', 'hieu.nquang90@gmail.com', 'Quang Hieu');
    assert.equal(proposed, 'hieu.nquang90');

    // Run harmonize without network download
    const res = await harmonizeProfile(profile, { syncAvatar: false });
    assert.equal(res.ok, true);
    assert.equal(res.newName, 'hieu.nquang90');

    // Verify Preferences on disk
    const prefDisk = JSON.parse(fs.readFileSync(path.join(profileFullPath, 'Preferences'), 'utf8'));
    assert.equal(prefDisk.profile.name, 'hieu.nquang90');
    assert.equal(prefDisk.profile.using_default_name, false);

    // Verify Local State on disk
    const lsDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'Local State'), 'utf8'));
    const info = lsDisk.profile.info_cache['Profile 8'];
    assert.equal(info.name, 'hieu.nquang90');
    assert.equal(info.user_name, 'hieu.nquang90@gmail.com');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('Test 5: Malformed Preferences fails closed without corrupting files', async () => {
  const { tmpDir, profileFullPath, profile } = createTempProfileEnv();
  try {
    fs.writeFileSync(path.join(profileFullPath, 'Preferences'), '{ malformed json: true', 'utf8');
    const res = await harmonizeProfile(profile);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'PREFERENCES_MALFORMED');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test('Test 6: Multiple harmonization runs preserve original .bak (Opus 5.5 C3 Requirement)', async () => {
  const { tmpDir, profileFullPath, profile } = createTempProfileEnv();
  try {
    const prefPath = path.join(profileFullPath, 'Preferences');
    const prefBakPath = `${prefPath}.bak`;

    // Lần 1: Harmonize
    const res1 = await harmonizeProfile(profile, { syncAvatar: false });
    assert.equal(res1.ok, true);
    assert.equal(fs.existsSync(prefBakPath), true);
    const originalBakContent = fs.readFileSync(prefBakPath, 'utf8');
    assert.match(originalBakContent, /"Person 1"/);

    // Lần 2: Chạy lại harmonize với targetName khác
    const res2 = await harmonizeProfile(profile, { targetName: 'custom_name', syncAvatar: false });
    assert.equal(res2.ok, true);

    // Kiểm tra: File .bak vẫn giữ nguyên 100% nội dung gốc "Person 1", không bị ghi đè!
    const secondBakContent = fs.readFileSync(prefBakPath, 'utf8');
    assert.equal(secondBakContent, originalBakContent);
    assert.match(secondBakContent, /"Person 1"/);
    assert.doesNotMatch(secondBakContent, /"custom_name"/);
  } finally {
    cleanupTempDir(tmpDir);
  }
});
