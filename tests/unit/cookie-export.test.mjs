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
  findConnectedProfileDetail,
} from '../../lib/cli/commands/cookies-export.mjs';

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
      partitionKey: { topLevelSite: 'https://tiktok.com', hasCrossSiteAncestor: false },
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
    hostOnly: false,
    path: '/',
    expires: 1780000000,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });

  assert.equal(state.cookies[1].hostOnly, true);
  assert.deepEqual(state.cookies[1].partitionKey, { topLevelSite: 'https://tiktok.com', hasCrossSiteAncestor: false });
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

test('parseExportArgs: parses --allow-online flag', () => {
  const optsDefault = parseExportArgs(['--profile', 'Default']);
  assert.equal(optsDefault.allowOnline, false);

  const optsOnline = parseExportArgs(['--profile', 'Default', '--allow-online']);
  assert.equal(optsOnline.allowOnline, true);
});

test('exportLocalCookies: allowOnline bypasses SingletonLock and active WAL, checkpoints snapshot, and cleans up temp directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'online-cookie-test-'));
  try {
    const profileDir = 'Default';
    const profileRoot = path.join(root, profileDir);
    const dbPath = path.join(profileRoot, 'Network', 'Cookies');

    createSyntheticCookieDb(dbPath, [
      {
        host_key: '.example.com',
        name: 'auth_token',
        value: 'plain_secret',
        is_secure: 1,
        is_httponly: 1,
      },
    ]);

    const lockTarget = `host-${process.pid}`;
    fs.symlinkSync(lockTarget, path.join(root, 'SingletonLock'));
    fs.writeFileSync(`${dbPath}-wal`, 'wal-content');

    const profile = { id: 'test-profile', userDataDir: root, profileDir };

    assert.throws(
      () => exportLocalCookies(profile, { allowOnline: false }),
      (err) => err.code === 'SOURCE_PROFILE_BUSY' || err.code === 'SOURCE_DATABASE_WAL_ACTIVE'
    );

    const res = exportLocalCookies(profile, { allowOnline: true });
    assert.equal(res.exportedCount, 1);
    assert.equal(res.data.cookies[0].name, 'auth_token');
    assert.equal(res.data.cookies[0].value, 'plain_secret');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportLocalCookies: allowOnline supports large payload (up to 8 MiB) without throwing LIMIT_EXCEEDED', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'large-cookie-test-'));
  try {
    const profileDir = 'Default';
    const profileRoot = path.join(root, profileDir);
    const dbPath = path.join(profileRoot, 'Network', 'Cookies');

    const bigValue = 'x'.repeat(1500 * 1024);
    createSyntheticCookieDb(dbPath, [
      {
        host_key: '.example.com',
        name: 'large_token',
        value: bigValue,
        is_secure: 1,
      },
    ]);

    const profile = { id: 'test-profile', userDataDir: root, profileDir };

    assert.throws(
      () => exportLocalCookies(profile, { allowOnline: false, checkProcess: false }),
      (err) => err.code === 'LIMIT_EXCEEDED'
    );

    const res = exportLocalCookies(profile, { allowOnline: true, checkProcess: false });
    assert.equal(res.exportedCount, 1);
    assert.equal(res.data.cookies[0].name, 'large_token');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handleExport: allowOnline falls back to Gateway Network.getAllCookies on KEYCHAIN_DENIED', async () => {
  let cdpCalledWith = null;

  const fakeGatewayHealth = async () => ({
    extensionConnected: true,
    profileDetails: [
      { profileId: 'managed:test-online', name: 'Test Online', email: 'online@example.com' },
    ],
  });

  const fakeGatewayCall = async (method, params, profileId) => {
    cdpCalledWith = { method, params, profileId };
    return {
      cookies: [
        {
          name: 'cdp_session',
          value: 'cdp_val_123',
          domain: '.tiktok.com',
          path: '/',
          secure: true,
          httpOnly: true,
          expires: Date.now() / 1000 + 3600,
        },
        {
          name: 'other_domain',
          value: 'other_val',
          domain: '.other.com',
          path: '/',
          secure: true,
          httpOnly: false,
          expires: Date.now() / 1000 + 3600,
        },
      ],
    };
  };

  const fakeProfileResolver = () => ({
    id: 'managed:test-online',
    name: 'Test Online',
    userDataDir: '/tmp/fake',
    profileDir: 'Default',
  });

  const fakeExporterThrowingKeychain = () => {
    const err = new Error('macOS keychain denied');
    err.code = 'KEYCHAIN_DENIED';
    throw err;
  };

  const result = await handleExport(
    {
      profileId: 'test-online',
      allowOnline: true,
      domain: 'tiktok.com',
      format: 'playwright',
    },
    {
      profileResolver: fakeProfileResolver,
      cookieExporter: fakeExporterThrowingKeychain,
      gatewayHealthLookup: fakeGatewayHealth,
      gatewayCaller: fakeGatewayCall,
    }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.exportedCount, 1);
  assert.equal(result.data.cookies[0].name, 'cdp_session');
  assert.equal(result.data.cookies[0].value, 'cdp_val_123');
  assert.equal(cdpCalledWith?.method, 'executeCDP');
  assert.equal(cdpCalledWith?.params?.method, 'Network.getAllCookies');
  assert.equal(cdpCalledWith?.profileId, 'managed:test-online');
});

test('handleExport: allowOnline falls back to Gateway Network.getAllCookies when local DB returns 0 cookies', async () => {
  const fakeGatewayHealth = async () => ({
    profileDetails: [{ profileId: 'managed:empty-local', name: 'Empty' }],
  });

  const fakeGatewayCall = async () => ({
    cookies: [
      {
        name: 'gateway_cookie',
        value: 'found_in_gateway',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: false,
      },
    ],
  });

  const fakeExporterEmpty = () => ({
    profileId: 'managed:empty-local',
    format: 'playwright',
    totalFound: 0,
    exportedCount: 0,
    expiredCount: 0,
    data: { cookies: [] },
  });

  const result = await handleExport(
    {
      profileId: 'empty-local',
      allowOnline: true,
      format: 'playwright',
    },
    {
      profileResolver: () => ({ id: 'managed:empty-local', name: 'Empty' }),
      cookieExporter: fakeExporterEmpty,
      gatewayHealthLookup: fakeGatewayHealth,
      gatewayCaller: fakeGatewayCall,
    }
  );

  assert.equal(result.exportedCount, 1);
  assert.equal(result.data.cookies[0].name, 'gateway_cookie');
});

test('handleExport: rethrows KEYCHAIN_DENIED if Gateway is not connected or profile not found in health', async () => {
  const fakeGatewayHealth = async () => ({
    profileDetails: [],
  });

  const fakeExporterThrowing = () => {
    const err = new Error('keychain denied');
    err.code = 'KEYCHAIN_DENIED';
    throw err;
  };

  await assert.rejects(
    async () => {
      await handleExport(
        { profileId: 'p1', allowOnline: true },
        {
          profileResolver: () => ({ id: 'managed:p1' }),
          cookieExporter: fakeExporterThrowing,
          gatewayHealthLookup: fakeGatewayHealth,
        }
      );
    },
    (err) => err.code === 'KEYCHAIN_DENIED'
  );
});

test('handleExport: allowOnline unwraps real executeCDP { tabId, result: { cookies } } shape and retries via newTab on chrome:// attach error', async () => {
  const calls = [];

  const fakeGatewayHealth = async () => ({
    extensionConnected: true,
    profileDetails: [{ profileId: '7f00-uuid', name: 'thichminhthien0' }],
  });

  const fakeGatewayCall = async (method, params, profileId) => {
    calls.push({ method, params, profileId });
    if (method === 'executeCDP' && calls.length === 1) {
      throw new Error('EXECUTION_FAILED: Cannot access a chrome:// URL');
    }
    if (method === 'newTab') {
      return { tabId: 42 };
    }
    if (method === 'executeCDP') {
      return {
        tabId: 42,
        result: {
          cookies: [
            {
              name: 'c_user',
              value: '1000123',
              domain: '.facebook.com',
              path: '/',
              secure: true,
              httpOnly: false,
              expires: Date.now() / 1000 + 3600,
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const fakeExporterThrowingKeychain = () => {
    const err = new Error('macOS keychain denied');
    err.code = 'KEYCHAIN_DENIED';
    throw err;
  };

  const result = await handleExport(
    {
      profileId: 'managed:thichminhthien0',
      allowOnline: true,
      format: 'playwright',
    },
    {
      profileResolver: () => ({
        id: 'managed:thichminhthien0',
        name: 'thichminhthien0',
        userDataDir: '/tmp/fake',
        profileDir: 'Default',
      }),
      cookieExporter: fakeExporterThrowingKeychain,
      gatewayHealthLookup: fakeGatewayHealth,
      gatewayCaller: fakeGatewayCall,
    }
  );

  assert.deepEqual(
    calls.map((c) => c.method),
    ['executeCDP', 'newTab', 'executeCDP']
  );
  assert.equal(calls[1].params?.url, 'about:blank');
  assert.equal(result.status, 'success');
  assert.equal(result.exportedCount, 1);
  assert.equal(result.data.cookies[0].name, 'c_user');
});

test('findConnectedProfileDetail: prioritizes id/name/dir over email and refuses ambiguous duplicate emails', () => {
  const details = [
    { profileId: 'managed:alpha', name: 'Alpha', email: 'shared@example.com', profileDir: 'Profile 1' },
    { profileId: 'managed:beta', name: 'Beta', email: 'shared@example.com', profileDir: 'Profile 2' },
    { profileId: 'managed:gamma', name: 'Gamma', email: 'unique@example.com', profileDir: 'Profile 3' },
  ];

  // 1. Exact ID match beats earlier duplicate email
  assert.equal(
    findConnectedProfileDetail(
      { id: 'managed:beta', name: 'Other', email: 'shared@example.com', profileDir: 'Profile 1' },
      details
    )?.profileId,
    'managed:beta'
  );

  // 2. Exact name match beats earlier duplicate email
  assert.equal(
    findConnectedProfileDetail(
      { id: 'uuid-unknown', name: 'Beta', email: 'shared@example.com', profileDir: 'Profile 1' },
      details
    )?.profileId,
    'managed:beta'
  );

  // 3. profileDir match beats duplicate email
  assert.equal(
    findConnectedProfileDetail(
      { id: 'uuid-unknown', name: 'Unknown', email: 'shared@example.com', profileDir: 'Profile 2' },
      details
    )?.profileId,
    'managed:beta'
  );

  // 4. Duplicate email without id/name/dir match fails closed (returns null)
  assert.equal(
    findConnectedProfileDetail(
      { id: 'uuid-unknown', name: 'Unknown', email: 'shared@example.com', profileDir: 'Profile 99' },
      details
    ),
    null
  );

  // 5. Unique email matches when id/name/dir don't
  assert.equal(
    findConnectedProfileDetail(
      { id: 'uuid-unknown', name: 'Unknown', email: 'unique@example.com', profileDir: 'Profile 99' },
      details
    )?.profileId,
    'managed:gamma'
  );
});

test('handleExport: allowOnline uses Direct-CDP export fallback on KEYCHAIN_DENIED when offline & unlocked, and skips when locked', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-direct-cdp-export-'));
  try {
    const profile = { id: 'managed:offline-mac', userDataDir: tmpDir, profileDir: 'Default' };
    const throwKeychain = () => {
      const err = new Error('macOS keychain denied');
      err.code = 'KEYCHAIN_DENIED';
      throw err;
    };

    // 1. Unlocked offline profile with injectable directCdpExportFn
    let directCalled = false;
    const res = await handleExport(
      { profileId: 'offline-mac', allowOnline: true, domain: 'google.com', format: 'playwright' },
      {
        profileResolver: () => profile,
        cookieExporter: throwKeychain,
        gatewayHealthLookup: async () => ({ profileDetails: [] }),
        directCdpExportFn: async () => {
          directCalled = true;
          return [
            { name: '__Host-1PLSID', value: 'lsid_val', domain: 'accounts.google.com', path: '/', secure: true, httpOnly: true },
            { name: 'other', value: 'skip_me', domain: '.example.com', path: '/', secure: true, httpOnly: false },
          ];
        },
      }
    );
    assert.equal(directCalled, true);
    assert.equal(res.exportedCount, 1);
    assert.equal(res.data.cookies[0].name, '__Host-1PLSID');
    assert.equal(res.data.cookies[0].hostOnly, true);

    // 2. Locked profile refuses Direct-CDP launch and rethrows KEYCHAIN_DENIED
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(tmpDir, 'SingletonLock'));
    let calledWhenLocked = false;
    await assert.rejects(
      () => handleExport(
        { profileId: 'offline-mac', allowOnline: true },
        {
          profileResolver: () => profile,
          cookieExporter: throwKeychain,
          gatewayHealthLookup: async () => ({ profileDetails: [] }),
          directCdpExportFn: async () => {
            calledWhenLocked = true;
            return [];
          },
        }
      ),
      (err) => err.code === 'KEYCHAIN_DENIED'
    );
    assert.equal(calledWhenLocked, false);
    fs.rmSync(path.join(tmpDir, 'SingletonLock'), { force: true });

    // 3. Real directCdpExportCookies against synthetic mock Chrome binary (DevToolsActivePort + WebSocket Storage.getCookies + Browser.close)
    const mockBin = path.join(tmpDir, 'mock-chrome.js');
    const mockScript = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const udd = path.resolve(process.argv.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length));
fs.mkdirSync(udd, { recursive: true });
fs.symlinkSync('test-' + process.pid, path.join(udd, 'SingletonLock'));
function sendWsText(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const hdr = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  socket.write(Buffer.concat([hdr, payload]));
}
const server = http.createServer();
server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) break;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x8) { socket.end(); continue; }
      if (opcode !== 0x1) continue;
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.method === 'Storage.getCookies') {
        sendWsText(socket, { id: msg.id, result: { cookies: [{ name: 'SID', value: 's1', domain: '.google.com', path: '/', secure: true, httpOnly: true }] } });
      } else if (msg.method === 'Browser.close') {
        sendWsText(socket, { id: msg.id, result: {} });
        try { fs.unlinkSync(path.join(udd, 'SingletonLock')); } catch {}
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 20).unref();
      }
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(path.join(udd, 'DevToolsActivePort'), port + '\\n/devtools/browser/mock\\n', 'utf8');
});
`;
    fs.writeFileSync(mockBin, mockScript, { mode: 0o755 });
    const prevBin = process.env.WEBMCP_CHROME_BINARY;
    process.env.WEBMCP_CHROME_BINARY = mockBin;
    try {
      const e2eRes = await handleExport(
        { profileId: 'offline-mac', allowOnline: true, format: 'playwright' },
        {
          profileResolver: () => profile,
          cookieExporter: throwKeychain,
          gatewayHealthLookup: async () => ({ profileDetails: [] }),
        }
      );
      assert.equal(e2eRes.status, 'success');
      assert.equal(e2eRes.exportedCount, 1);
      assert.equal(e2eRes.data.cookies[0].name, 'SID');
      assert.equal(fs.existsSync(path.join(tmpDir, 'DevToolsActivePort')), false);
    } finally {
      if (prevBin === undefined) delete process.env.WEBMCP_CHROME_BINARY;
      else process.env.WEBMCP_CHROME_BINARY = prevBin;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
