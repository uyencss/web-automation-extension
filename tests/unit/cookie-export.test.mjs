import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  deriveMacAesKey,
  deriveLinuxAesKey,
  getPlatformAesKey,
  decryptCookieValue,
  exportLocalCookies,
  formatPlaywrightStorageState,
  formatNetscapeCookies,
  mapSameSite,
  getPlatformKeyContext,
  CHROME_EPOCH_OFFSET_SECONDS,
} from '../../lib/local-cookie-reader.mjs';

import {
  parseExportArgs,
  handleExport,
  resolveProfile,
} from '../../lib/cli/commands/cookies.mjs';

const MAC_PASSWORD = 'mac-test-pass';
const MAC_KEY = deriveMacAesKey(MAC_PASSWORD);

const LINUX_PASSWORD = 'peanuts';
const LINUX_KEY = deriveLinuxAesKey(LINUX_PASSWORD);

function encryptCookie(value, key, options = {}) {
  const { hostKey = null, schemaVersion = 0, prefix = 'v10' } = options;
  const iv = Buffer.alloc(16, 0x20); // 16 spaces
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(true);

  let payload = Buffer.from(value, 'utf8');
  if (schemaVersion >= 24 && hostKey) {
    const digest = crypto.createHash('sha256').update(hostKey).digest();
    payload = Buffer.concat([digest, payload]);
  }

  return Buffer.concat([
    Buffer.from(prefix),
    cipher.update(payload),
    cipher.final(),
  ]);
}

function toChromeMicroseconds(unixSeconds) {
  return (BigInt(unixSeconds) + BigInt(CHROME_EPOCH_OFFSET_SECONDS)) * 1000000n;
}

function createSyntheticCookieDb(dbPath, rows = [], options = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  if (options.metaVersion !== undefined) {
    db.exec(`
      CREATE TABLE meta (
        key TEXT NOT NULL UNIQUE PRIMARY KEY,
        value TEXT
      );
      INSERT INTO meta (key, value) VALUES ('version', '${options.metaVersion}');
    `);
  }

  db.exec(`
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL,
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL,
      has_expires INTEGER NOT NULL,
      is_persistent INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL,
      source_port INTEGER NOT NULL,
      last_update_utc INTEGER NOT NULL,
      source_type INTEGER NOT NULL,
      has_cross_site_ancestor INTEGER NOT NULL
    );
  `);

  const stmt = db.prepare(`
    INSERT INTO cookies (
      creation_utc, host_key, top_frame_site_key, name, value, encrypted_value,
      path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires,
      is_persistent, priority, samesite, source_scheme, source_port,
      last_update_utc, source_type, has_cross_site_ancestor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(
      r.creation_utc ?? 13300000000000000n,
      r.host_key,
      r.top_frame_site_key ?? '',
      r.name,
      r.value ?? '',
      r.encrypted_value ?? Buffer.alloc(0),
      r.path ?? '/',
      r.expires_utc ?? 0n,
      r.is_secure ?? 1,
      r.is_httponly ?? 0,
      r.last_access_utc ?? 13300000000000000n,
      r.has_expires ?? 0,
      r.is_persistent ?? 1,
      r.priority ?? 1,
      r.samesite ?? 1,
      r.source_scheme ?? 2,
      r.source_port ?? 443,
      r.last_update_utc ?? 13300000000000000n,
      r.source_type ?? 0,
      r.has_cross_site_ancestor ?? 0
    );
  }

  db.close();
}

test('deriveLinuxAesKey: derives standard 16-byte key using 1 PBKDF2 iteration', () => {
  const defaultKey = deriveLinuxAesKey('peanuts');
  assert.equal(defaultKey.length, 16);

  const customKey = deriveLinuxAesKey('custom-password');
  assert.equal(customKey.length, 16);
  assert.notDeepEqual(defaultKey, customKey);
});

test('getPlatformAesKey: correctly routes between darwin and linux platform handlers', () => {
  const macKey = getPlatformAesKey({ platform: 'darwin', keychainPasswordOverride: MAC_PASSWORD });
  assert.deepEqual(macKey, MAC_KEY);

  const linuxKey = getPlatformAesKey({ platform: 'linux', linuxPasswordOverride: 'peanuts' });
  assert.deepEqual(linuxKey, LINUX_KEY);

  assert.throws(() => {
    getPlatformAesKey({ platform: 'freebsd' });
  }, /UNSUPPORTED_PLATFORM/);
});

test('decryptCookieValue: decrypts Linux Chromium encrypted payload with schema 24 host digest', () => {
  const secret = 'secret_session_token_12345';
  const encrypted = encryptCookie(secret, LINUX_KEY, { hostKey: '.douyin.com', schemaVersion: 24 });
  const decrypted = decryptCookieValue(encrypted, LINUX_KEY, { hostKey: '.douyin.com', schemaVersion: 24 });
  assert.equal(decrypted, secret);
});

test('formatPlaywrightStorageState: correctly produces Playwright StorageState format', () => {
  const sampleCookies = [
    {
      name: 'sessionid',
      value: 'abc123xyz',
      domain: '.tiktok.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
      expires: 1780000000,
      sameSite: 'Lax',
    },
    {
      name: 'csrftoken',
      value: 'token999',
      domain: 'tiktok.com',
      hostOnly: true,
      path: '/api',
      secure: true,
      httpOnly: false,
      expires: -1,
      sameSite: 'Strict',
    },
  ];

  const state = formatPlaywrightStorageState(sampleCookies);
  assert.ok(Array.isArray(state.cookies));
  assert.ok(Array.isArray(state.origins));
  assert.equal(state.cookies.length, 2);

  assert.deepEqual(state.cookies[0], {
    name: 'sessionid',
    value: 'abc123xyz',
    domain: '.tiktok.com',
    path: '/',
    expires: 1780000000,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });

  assert.equal(state.cookies[1].expires, -1);
  assert.equal(state.cookies[1].httpOnly, false);
});

test('formatNetscapeCookies: correctly outputs Netscape cookies.txt format', () => {
  const sampleCookies = [
    {
      name: 'sessionid',
      value: 'abc123xyz',
      domain: '.douyin.com',
      path: '/',
      secure: true,
      expires: 1780000000,
    },
  ];

  const txt = formatNetscapeCookies(sampleCookies);
  assert.ok(txt.startsWith('# Netscape HTTP Cookie File'));
  assert.ok(txt.includes('.douyin.com\tTRUE\t/\tTRUE\t1780000000\tsessionid\tabc123xyz'));
});

test('exportLocalCookies: exports and decrypts cookies with domain and attribute filtering', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-export-test-'));
  const dbPath = path.join(tmpDir, 'Default', 'Network', 'Cookies');

  const futureSeconds = Math.floor(Date.now() / 1000) + 86400;
  const expiredSeconds = Math.floor(Date.now() / 1000) - 3600;

  const rows = [
    {
      host_key: '.douyin.com',
      name: 'passport_csrf_token',
      value: '',
      encrypted_value: encryptCookie('csrf_val', LINUX_KEY, { hostKey: '.douyin.com', schemaVersion: 24 }),
      is_secure: 1,
      is_httponly: 0,
      has_expires: 1,
      expires_utc: toChromeMicroseconds(futureSeconds),
    },
    {
      host_key: '.douyin.com',
      name: 'sessionid_ss',
      value: '',
      encrypted_value: encryptCookie('sess_val', LINUX_KEY, { hostKey: '.douyin.com', schemaVersion: 24 }),
      is_secure: 1,
      is_httponly: 1, // HttpOnly session token
      has_expires: 0, // Session cookie
      expires_utc: 0n,
    },
    {
      host_key: '.douyin.com',
      name: 'old_expired',
      value: 'expired_val',
      is_secure: 1,
      is_httponly: 0,
      has_expires: 1,
      expires_utc: toChromeMicroseconds(expiredSeconds),
    },
    {
      host_key: '.facebook.com',
      name: 'c_user',
      value: '',
      encrypted_value: encryptCookie('fb_user_123', LINUX_KEY, { hostKey: '.facebook.com', schemaVersion: 24 }),
      is_secure: 1,
      is_httponly: 1,
      has_expires: 1,
      expires_utc: toChromeMicroseconds(futureSeconds),
    },
  ];

  createSyntheticCookieDb(dbPath, rows, { metaVersion: '24' });

  const profile = {
    id: 'Chrome:Default',
    userDataDir: tmpDir,
    profileDir: 'Default',
  };

  // 1. Export douyin.com (default: playwright format, includes HttpOnly, skips expired)
  const resDouyin = exportLocalCookies(profile, {
    dbPathOverride: dbPath,
    domain: 'douyin.com',
    keyOverride: LINUX_KEY,
    checkProcess: false,
  });

  assert.equal(resDouyin.format, 'playwright');
  assert.equal(resDouyin.totalFound, 3);
  assert.equal(resDouyin.expiredCount, 1);
  assert.equal(resDouyin.exportedCount, 2);

  const cookies = resDouyin.data.cookies;
  assert.equal(cookies.length, 2);
  const sessCookie = cookies.find((c) => c.name === 'sessionid_ss');
  assert.ok(sessCookie);
  assert.equal(sessCookie.value, 'sess_val');
  assert.equal(sessCookie.httpOnly, true);
  assert.equal(sessCookie.expires, -1);

  // 2. Export with includeHttpOnly: false
  const resNoHttpOnly = exportLocalCookies(profile, {
    dbPathOverride: dbPath,
    domain: 'douyin.com',
    includeHttpOnly: false,
    keyOverride: LINUX_KEY,
    checkProcess: false,
  });
  assert.equal(resNoHttpOnly.exportedCount, 1);
  assert.equal(resNoHttpOnly.data.cookies[0].name, 'passport_csrf_token');

  // 3. Export netscape format
  const resNetscape = exportLocalCookies(profile, {
    dbPathOverride: dbPath,
    domain: 'facebook.com',
    format: 'netscape',
    keyOverride: LINUX_KEY,
    checkProcess: false,
  });
  assert.equal(resNetscape.format, 'netscape');
  assert.ok(typeof resNetscape.data === 'string');
  assert.ok(resNetscape.data.includes('.facebook.com'));
  assert.ok(resNetscape.data.includes('c_user'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('parseExportArgs: correctly parses flags for export subcommand', () => {
  const args = [
    '--profile-id', 'Profile 2',
    '-d', 'douyin.com',
    '-n', 'sessionid',
    '-f', 'netscape',
    '-o', '/tmp/cookies.txt',
    '--secure-only',
    '--no-http-only',
    '--json',
  ];

  const parsed = parseExportArgs(args);
  assert.equal(parsed.profileId, 'Profile 2');
  assert.equal(parsed.domain, 'douyin.com');
  assert.deepEqual(parsed.names, ['sessionid']);
  assert.equal(parsed.format, 'netscape');
  assert.equal(parsed.output, '/tmp/cookies.txt');
  assert.equal(parsed.secureOnly, true);
  assert.equal(parsed.includeHttpOnly, false);
  assert.equal(parsed.json, true);
});

test('handleExport: executes export and writes file to disk', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-export-handle-'));
  const outFile = path.join(tmpDir, 'exported_state.json');

  const mockProfile = { id: 'test-profile', userDataDir: tmpDir, profileDir: 'Default' };
  const mockExporter = () => ({
    format: 'playwright',
    totalFound: 1,
    exportedCount: 1,
    expiredCount: 0,
    data: {
      cookies: [
        {
          name: 'mock_sid',
          value: 'mock_val_789',
          domain: '.douyin.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    },
  });

  const res = await handleExport(
    {
      profileId: 'test-profile',
      format: 'playwright',
      output: outFile,
      pretty: true,
    },
    {
      profileResolver: () => mockProfile,
      cookieExporter: mockExporter,
    }
  );

  assert.equal(res.status, 'success');
  assert.equal(res.exportedCount, 1);
  assert.ok(fs.existsSync(outFile));

  const saved = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(saved.cookies[0].name, 'mock_sid');
  assert.equal(saved.cookies[0].value, 'mock_val_789');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('mapSameSite: maps Chrome integers correctly and returns undefined for unspecified (-1)', () => {
  assert.equal(mapSameSite(1), 'Lax');
  assert.equal(mapSameSite(2), 'Strict');
  assert.equal(mapSameSite(0), 'None');
  assert.equal(mapSameSite(-1), undefined);
  assert.equal(mapSameSite(undefined), undefined);
  assert.equal(mapSameSite(99), undefined);

  // When sameSite is undefined in cookie object, formatPlaywrightStorageState defaults to 'Lax'
  const state = formatPlaywrightStorageState([
    { name: 'unspecified_cookie', value: 'val', domain: '.example.com', sameSite: undefined, secure: false },
  ]);
  assert.equal(state.cookies[0].sameSite, 'Lax');
});

test('getPlatformKeyContext (Linux): resolves v10 to peanuts, v11 to keyring, and fails closed when keyring missing', () => {
  // 1. With keyring password provided
  const ctxWithKeyring = getPlatformKeyContext({
    platform: 'linux',
    linuxPasswordOverride: 'custom_keyring_secret',
  });
  assert.equal(ctxWithKeyring.platform, 'linux');
  assert.equal(ctxWithKeyring.hasKeyring, true);

  const v10Key = ctxWithKeyring.resolveKeyForPrefix('v10');
  assert.deepEqual(v10Key, LINUX_KEY); // peanuts key

  const v11Key = ctxWithKeyring.resolveKeyForPrefix('v11');
  const expectedKeyringKey = deriveLinuxAesKey('custom_keyring_secret');
  assert.deepEqual(v11Key, expectedKeyringKey);

  // 2. Without keyring password (headless/no secret-tool)
  const ctxNoKeyring = getPlatformKeyContext({
    platform: 'linux',
    linuxPasswordOverride: null,
    exec: () => { throw new Error('secret-tool not found'); },
  });
  assert.equal(ctxNoKeyring.platform, 'linux');
  assert.equal(ctxNoKeyring.hasKeyring, false);

  // v10 still works
  assert.deepEqual(ctxNoKeyring.resolveKeyForPrefix('v10'), LINUX_KEY);

  // v11 throws typed LINUX_KEYRING_UNAVAILABLE error
  assert.throws(
    () => ctxNoKeyring.resolveKeyForPrefix('v11'),
    (err) => err.code === 'LINUX_KEYRING_UNAVAILABLE'
  );
});

test('decryptCookieValue (Linux Dual-Key): decrypts v10 (peanuts) and v11 (keyring), rejects v11 without keyring', () => {
  const secretV10 = 'token_v10_peanuts_val';
  const secretV11 = 'token_v11_keyring_val';
  const keyringPass = 'my-gnome-keyring-pwd';
  const keyringKey = deriveLinuxAesKey(keyringPass);

  const encV10 = encryptCookie(secretV10, LINUX_KEY, { prefix: 'v10', hostKey: '.tiktok.com', schemaVersion: 24 });
  const encV11 = encryptCookie(secretV11, keyringKey, { prefix: 'v11', hostKey: '.tiktok.com', schemaVersion: 24 });

  // 1. Context with keyring password
  const ctxWithKeyring = getPlatformKeyContext({
    platform: 'linux',
    linuxPasswordOverride: keyringPass,
  });

  const decV10 = decryptCookieValue(encV10, ctxWithKeyring, { hostKey: '.tiktok.com', schemaVersion: 24 });
  assert.equal(decV10, secretV10);

  const decV11 = decryptCookieValue(encV11, ctxWithKeyring, { hostKey: '.tiktok.com', schemaVersion: 24 });
  assert.equal(decV11, secretV11);

  // 2. Context without keyring password: v10 succeeds, v11 throws LINUX_KEYRING_UNAVAILABLE
  const ctxNoKeyring = getPlatformKeyContext({
    platform: 'linux',
    linuxPasswordOverride: null,
    exec: () => { throw new Error('no keyring'); },
  });

  assert.equal(decryptCookieValue(encV10, ctxNoKeyring, { hostKey: '.tiktok.com', schemaVersion: 24 }), secretV10);
  assert.throws(
    () => decryptCookieValue(encV11, ctxNoKeyring, { hostKey: '.tiktok.com', schemaVersion: 24 }),
    (err) => err.code === 'LINUX_KEYRING_UNAVAILABLE'
  );
});
