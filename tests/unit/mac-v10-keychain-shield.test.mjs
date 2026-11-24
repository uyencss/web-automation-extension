import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = require(path.join(ROOT, 'chrome-launcher'));

function createCookiesDb(dbPath, prefixes = []) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB);');
    const stmt = db.prepare('INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)');
    prefixes.forEach((pfx, idx) => {
      const payload = Buffer.concat([Buffer.from(pfx, 'ascii'), Buffer.from(`payload-${idx}`)]);
      stmt.run('.facebook.com', `c_${idx}`, payload);
    });
  } finally {
    db.close();
  }
}

test('buildManagedShieldArgs includes macOS v10 UserDataDirProtection disable flags only when preserveMacV10Keychain is true', () => {
  const defaultDisable = launcher.buildManagedShieldArgs().find((a) => a.startsWith('--disable-features='));
  assert.ok(defaultDisable);
  assert.equal(defaultDisable.includes('kKeychainKeyProviderUserDataDirProtection'), false);
  assert.equal(defaultDisable.includes('KeychainKeyProviderUserDataDirProtection'), false);

  const v10Disable = launcher
    .buildManagedShieldArgs({ preserveMacV10Keychain: true })
    .find((a) => a.startsWith('--disable-features='));
  assert.ok(v10Disable);
  for (const feat of launcher.MAC_V10_KEYCHAIN_SHIELD_FEATURES) {
    assert.ok(v10Disable.includes(feat), `expected ${feat} in ${v10Disable}`);
  }
});

test('detectMacCookieEncryptionMode detects v10 (with spaces in path), v11, and empty DB on darwin', (t) => {
  if (process.platform !== 'darwin') {
    assert.equal(launcher.detectMacCookieEncryptionMode('/tmp/ignored', 'Default'), 'other');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-v10-detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const pV10 = path.join(root, 'thichminhthien0');
  createCookiesDb(path.join(pV10, 'Profile 43', 'Cookies'), ['v10', 'v10', 'v10']);
  assert.equal(launcher.detectMacCookieEncryptionMode(pV10, 'Profile 43'), 'v10');

  const pV11 = path.join(root, 'hieu2906090');
  createCookiesDb(path.join(pV11, 'Default', 'Cookies'), ['v11', 'v11']);
  assert.equal(launcher.detectMacCookieEncryptionMode(pV11, 'Default'), 'v11');

  const pEmpty = path.join(root, 'fresh-empty');
  fs.mkdirSync(path.join(pEmpty, 'Default'), { recursive: true });
  assert.equal(launcher.detectMacCookieEncryptionMode(pEmpty, 'Default'), 'empty');
});

test('launchChrome managed gates Chrome 158 UserDataDirProtection disable flags on v10 vs v11 Cookies DB', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-v10-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const managedDir = path.join(root, 'managed-profiles');
  const extensionPath = path.join(root, 'ext');
  fs.mkdirSync(extensionPath, { recursive: true });
  fs.writeFileSync(path.join(extensionPath, 'manifest.json'), '{"manifest_version":3,"name":"Test","version":"1.0"}');
  const fakeChrome = path.join(root, 'fake-chrome.sh');
  fs.writeFileSync(fakeChrome, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const sessionsFile = path.join(root, 'sessions.json');

  const pV10 = path.join(managedDir, 'legacy-v10');
  createCookiesDb(path.join(pV10, 'Profile 43', 'Cookies'), ['v10', 'v10']);
  fs.writeFileSync(path.join(pV10, '.webmcp-meta.json'), JSON.stringify({ name: 'legacy-v10', profileDir: 'Profile 43' }));

  const resV10 = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: pV10, profileDir: 'Profile 43' },
    managedProfilesDir: managedDir,
    chromePath: fakeChrome,
    extensionPath,
    sessionsFile,
    dryRun: true,
  });
  const disableV10 = resV10.args.find((a) => a.startsWith('--disable-features='));
  assert.ok(disableV10.includes('kKeychainKeyProviderUserDataDirProtection'));
  assert.ok(disableV10.includes('KeychainKeyProviderUserDataDirProtection'));

  const pV11 = path.join(managedDir, 'modern-v11');
  createCookiesDb(path.join(pV11, 'Default', 'Cookies'), ['v11', 'v11']);
  fs.writeFileSync(path.join(pV11, '.webmcp-meta.json'), JSON.stringify({ name: 'modern-v11', profileDir: 'Default' }));

  const resV11 = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: pV11, profileDir: 'Default' },
    managedProfilesDir: managedDir,
    chromePath: fakeChrome,
    extensionPath,
    sessionsFile,
    dryRun: true,
  });
  const disableV11 = resV11.args.find((a) => a.startsWith('--disable-features='));
  assert.equal(disableV11.includes('kKeychainKeyProviderUserDataDirProtection'), false);
  assert.equal(disableV11.includes('KeychainKeyProviderUserDataDirProtection'), false);
});
