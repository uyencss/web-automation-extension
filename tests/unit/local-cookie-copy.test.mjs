import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  readLocalCookies,
  resolveCandidateDomains,
  assertSourceProfileOffline,
  resolveSourceCookieDbPath,
  deriveMacAesKey,
  CHROME_EPOCH_OFFSET_SECONDS,
} from '../../lib/local-cookie-reader.mjs';
import {
  copyCookies,
  checkTargetCollisions,
  runCookies,
  parseArgs,
  collectTargetUrlsForCookies,
} from '../../lib/cli/commands/cookies.mjs';

const TEST_PASSWORD = 'synthetic-test-password';
const TEST_KEY = deriveMacAesKey(TEST_PASSWORD);

function encryptTestValue(value, key = TEST_KEY, options = {}) {
  const { hostKey = null, schemaVersion = 0 } = options;
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(true);

  let payloadBuffer = Buffer.from(value, 'utf8');
  if (schemaVersion >= 24 && hostKey) {
    const digest = crypto.createHash('sha256').update(hostKey).digest();
    payloadBuffer = Buffer.concat([digest, payloadBuffer]);
  }

  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(payloadBuffer),
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
      r.has_expires ?? (r.expires_utc ? 1 : 0),
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

function makeDisposableProfile(prefix = 'test-profile') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `webmcp-${prefix}-`));
  const userDataDir = path.join(tmpDir, 'User Data');
  const profileDir = 'Default';
  fs.mkdirSync(path.join(userDataDir, profileDir, 'Network'), { recursive: true });

  const profile = {
    id: `Chrome:${prefix}`,
    browser: 'Chrome',
    userDataDir,
    profileDir,
  };

  return {
    profile,
    tmpDir,
    dbPath: path.join(userDataDir, profileDir, 'Network', 'Cookies'),
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test('domain matching: resolves host-only and domain cookies strictly scoped to URL', () => {
  const domains = resolveCandidateDomains('https://sub.example.com/api/test');
  assert.deepEqual(domains.sort(), ['.sub.example.com', 'sub.example.com'].sort());

  const withParent = resolveCandidateDomains('https://sub.example.com/api/test', 'example.com');
  // Parent domain selector adds only domain cookie (.example.com), never parent host-only (example.com)
  assert.deepEqual(withParent.sort(), ['.example.com', '.sub.example.com', 'sub.example.com'].sort());

  assert.throws(() => {
    resolveCandidateDomains('https://sub.example.com/api/test', 'unrelated.com');
  }, /INVALID_DOMAIN_SELECTOR/);
});

test('reader: reads host-only and domain cookies, excludes unrelated domains and HttpOnly by default', () => {
  const fixture = makeDisposableProfile('reader-basic');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'session_host_only',
        encrypted_value: encryptTestValue('secret_val_1'),
        is_httponly: 0,
      },
      {
        host_key: '.example.com',
        name: 'tracking_domain',
        encrypted_value: encryptTestValue('secret_val_2'),
        is_httponly: 0,
      },
      {
        host_key: '.example.com',
        name: 'admin_httponly',
        encrypted_value: encryptTestValue('secret_admin_val'),
        is_httponly: 1,
      },
      {
        host_key: 'other.com',
        name: 'other_cookie',
        encrypted_value: encryptTestValue('other_val'),
        is_httponly: 0,
      },
    ]);

    const res = readLocalCookies(fixture.profile, {
      url: 'https://example.com/welcome',
      keychainPasswordOverride: TEST_PASSWORD,
      checkProcess: false,
    });

    assert.equal(res.selectedCount, 2);
    assert.equal(res.cookies.length, 2);
    const names = res.cookies.map((c) => c.name);
    assert.ok(names.includes('session_host_only'));
    assert.ok(names.includes('tracking_domain'));
    assert.ok(!names.includes('admin_httponly'));
    assert.ok(!names.includes('other_cookie'));

    const hostOnlyCookie = res.cookies.find((c) => c.name === 'session_host_only');
    assert.equal(hostOnlyCookie.hostOnly, true);
    assert.equal(hostOnlyCookie.domain, undefined);
    assert.equal(hostOnlyCookie.value, 'secret_val_1');

    const domainCookie = res.cookies.find((c) => c.name === 'tracking_domain');
    assert.equal(domainCookie.hostOnly, false);
    assert.equal(domainCookie.domain, '.example.com');
    assert.equal(domainCookie.value, 'secret_val_2');
  } finally {
    fixture.cleanup();
  }
});

test('reader: includes HttpOnly when explicitly opted-in', () => {
  const fixture = makeDisposableProfile('reader-httponly');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'admin_httponly',
        encrypted_value: encryptTestValue('secret_admin'),
        is_httponly: 1,
      },
    ]);

    const res = readLocalCookies(fixture.profile, {
      url: 'https://example.com',
      includeHttpOnly: true,
      keychainPasswordOverride: TEST_PASSWORD,
      checkProcess: false,
    });

    assert.equal(res.selectedCount, 1);
    assert.equal(res.cookies[0].name, 'admin_httponly');
    assert.equal(res.cookies[0].httpOnly, true);
    assert.equal(res.cookies[0].value, 'secret_admin');
  } finally {
    fixture.cleanup();
  }
});

test('reader: source database is not modified during read (zero source writes)', () => {
  const fixture = makeDisposableProfile('no-source-writes');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'token',
        encrypted_value: encryptTestValue('abc123xyz'),
      },
    ]);

    const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(fixture.dbPath)).digest('hex');

    readLocalCookies(fixture.profile, {
      url: 'https://example.com',
      keychainPasswordOverride: TEST_PASSWORD,
      checkProcess: false,
    });

    const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(fixture.dbPath)).digest('hex');
    assert.equal(hashBefore, hashAfter, 'Source database file SHA-256 must remain identical');
  } finally {
    fixture.cleanup();
  }
});

test('reader: rejects partitioned cookies before mutation', () => {
  const fixture = makeDisposableProfile('partitioned-check');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'partitioned_cookie',
        top_frame_site_key: 'https://topframe.org',
        encrypted_value: encryptTestValue('val'),
      },
    ]);

    assert.throws(() => {
      readLocalCookies(fixture.profile, {
        url: 'https://example.com',
        keychainPasswordOverride: TEST_PASSWORD,
        checkProcess: false,
      });
    }, (err) => {
      assert.equal(err.code, 'UNSUPPORTED_PARTITIONED_COOKIE');
      return true;
    });
  } finally {
    fixture.cleanup();
  }
});

test('reader: rejects partitioned cookie when is_partitioned=1 and top_frame_site_key is empty', () => {
  const fixture = makeDisposableProfile('is-partitioned-col');
  try {
    fs.mkdirSync(path.dirname(fixture.dbPath), { recursive: true });
    const db = new DatabaseSync(fixture.dbPath);
    db.exec(`
      CREATE TABLE cookies (
        creation_utc INTEGER NOT NULL,
        host_key TEXT NOT NULL,
        top_frame_site_key TEXT NOT NULL,
        is_partitioned INTEGER NOT NULL DEFAULT 0,
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
        source_port INTEGER NOT NULL
      );
      INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, is_partitioned, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port)
      VALUES (13300000000000000, 'example.com', '', 1, 'partitioned_flag_cookie', '', X'', '/', 0, 1, 0, 13300000000000000, 0, 1, 1, 1, 2, 443);
    `);
    db.close();

    assert.throws(() => {
      readLocalCookies(fixture.profile, {
        url: 'https://example.com',
        keychainPasswordOverride: TEST_PASSWORD,
        checkProcess: false,
      });
    }, (err) => {
      assert.equal(err.code, 'UNSUPPORTED_PARTITIONED_COOKIE');
      return true;
    });
  } finally {
    fixture.cleanup();
  }
});

test('reader: skips expired cookies and counts them in expiredCount', () => {
  const fixture = makeDisposableProfile('expired-cookies');
  try {
    const expiredMicroseconds = toChromeMicroseconds(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
    const futureMicroseconds = toChromeMicroseconds(Math.floor(Date.now() / 1000) + 3600); // 1 hour in future

    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'expired_cookie',
        expires_utc: expiredMicroseconds,
        has_expires: 1,
        encrypted_value: encryptTestValue('old_val'),
      },
      {
        host_key: 'example.com',
        name: 'fresh_cookie',
        expires_utc: futureMicroseconds,
        has_expires: 1,
        encrypted_value: encryptTestValue('fresh_val'),
      },
    ]);

    const res = readLocalCookies(fixture.profile, {
      url: 'https://example.com',
      keychainPasswordOverride: TEST_PASSWORD,
      checkProcess: false,
    });

    assert.equal(res.selectedCount, 1);
    assert.equal(res.expiredCount, 1);
    assert.equal(res.cookies[0].name, 'fresh_cookie');
  } finally {
    fixture.cleanup();
  }
});

test('offline check: rejects when WAL file has active uncheckpointed data', () => {
  const fixture = makeDisposableProfile('wal-check');
  try {
    createSyntheticCookieDb(fixture.dbPath, []);
    fs.writeFileSync(`${fixture.dbPath}-wal`, Buffer.alloc(128, 0x01));

    assert.throws(() => {
      assertSourceProfileOffline(fixture.profile, { checkProcess: false });
    }, (err) => {
      assert.equal(err.code, 'SOURCE_DATABASE_WAL_ACTIVE');
      return true;
    });
  } finally {
    fixture.cleanup();
  }
});

test('offline check: rejects when journal file has active data', () => {
  const fixture = makeDisposableProfile('journal-check');
  try {
    createSyntheticCookieDb(fixture.dbPath, []);
    fs.writeFileSync(`${fixture.dbPath}-journal`, Buffer.alloc(64, 0x01));

    assert.throws(() => {
      assertSourceProfileOffline(fixture.profile, { checkProcess: false });
    }, (err) => {
      assert.equal(err.code, 'SOURCE_DATABASE_JOURNAL_ACTIVE');
      return true;
    });
  } finally {
    fixture.cleanup();
  }
});

test('keychain error: rejects when password cannot be read or decrypt fails', () => {
  const fixture = makeDisposableProfile('keychain-err');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'token',
        encrypted_value: encryptTestValue('val', TEST_KEY),
      },
    ]);

    const wrongKeyPassword = 'completely-wrong-password';
    assert.throws(() => {
      readLocalCookies(fixture.profile, {
        url: 'https://example.com',
        keychainPasswordOverride: wrongKeyPassword,
        checkProcess: false,
      });
    }, (err) => {
      assert.equal(err.code, 'DECRYPT_FAILED');
      return true;
    });
  } finally {
    fixture.cleanup();
  }
});

test('dry-run: checks metadata and does not access keychain or decrypt values', () => {
  const fixture = makeDisposableProfile('dry-run');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'token',
        encrypted_value: encryptTestValue('val', TEST_KEY),
      },
    ]);

    // Pass invalid password; in dry-run it should NEVER be called or used
    const res = readLocalCookies(fixture.profile, {
      url: 'https://example.com',
      dryRun: true,
      keychainPasswordOverride: 'should-not-be-called',
      checkProcess: false,
    });

    assert.equal(res.dryRun, true);
    assert.equal(res.selectedCount, 1);
    assert.equal(res.cookies[0].name, 'token');
    assert.equal(res.cookies[0].value, undefined, 'Dry-run must not expose or extract cookie values');
  } finally {
    fixture.cleanup();
  }
});

test('copyCookies: full execution with read-back verification and collision preflight', async () => {
  const fixture = makeDisposableProfile('copy-full');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'auth_token',
        encrypted_value: encryptTestValue('secure_jwt_token'),
      },
      {
        host_key: '.example.com',
        name: 'pref',
        encrypted_value: encryptTestValue('dark_mode'),
      },
    ]);

    const targetStoredCookies = [];
    const mockGatewayCall = async (method, params, profileId) => {
      assert.equal(profileId, 'connected-target-1');
      if (method === 'getCookies') {
        return { cookies: [...targetStoredCookies], supportsCdpCookieAttributes: true };
      }
      if (method === 'setCookie') {
        targetStoredCookies.push({
          name: params.name,
          value: params.value,
          domain: params.domain,
          path: params.path,
          secure: params.secure,
          httpOnly: params.httpOnly,
          sameSite: params.sameSite,
          priority: params.priority,
        });
        return { success: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const result = await copyCookies(
      {
        sourceProfile: 'Chrome:test-source',
        targetProfile: 'connected-target-1',
        url: 'https://example.com/dashboard',
      },
      {
        profileResolver: () => fixture.profile,
        gatewayCall: mockGatewayCall,
        cookieReader: (p, opts) => readLocalCookies(p, { ...opts, keychainPasswordOverride: TEST_PASSWORD, checkProcess: false }),
      }
    );

    assert.equal(result.status, 'success');
    assert.equal(result.selectedCount, 2);
    assert.equal(result.appliedCount, 2);
    assert.equal(targetStoredCookies.length, 2);

    // Verify host-only vs domain on target
    const hostOnly = targetStoredCookies.find((c) => c.name === 'auth_token');
    assert.equal(hostOnly.value, 'secure_jwt_token');
    assert.equal(hostOnly.domain, undefined);

    const domainC = targetStoredCookies.find((c) => c.name === 'pref');
    assert.equal(domainC.value, 'dark_mode');
    assert.equal(domainC.domain, '.example.com');
  } finally {
    fixture.cleanup();
  }
});

test('copyCookies: collision policy fails before mutation when cookie already exists on target', async () => {
  const fixture = makeDisposableProfile('collision-fail');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'existing_cookie',
        encrypted_value: encryptTestValue('new_value'),
      },
    ]);

    let setCookieCalled = false;
    const mockGatewayCall = async (method) => {
      if (method === 'getCookies') {
        return {
          cookies: [
            {
              name: 'existing_cookie',
              domain: 'example.com',
              path: '/',
              value: 'old_value',
            },
          ],
          supportsCdpCookieAttributes: true,
        };
      }
      if (method === 'setCookie') {
        setCookieCalled = true;
        return { success: true };
      }
      throw new Error(`Unexpected method ${method}`);
    };

    await assert.rejects(async () => {
      await copyCookies(
        {
          sourceProfile: 'Chrome:test-source',
          targetProfile: 'connected-target-1',
          url: 'https://example.com',
        },
        {
          profileResolver: () => fixture.profile,
          gatewayCall: mockGatewayCall,
          cookieReader: (p, opts) => readLocalCookies(p, { ...opts, keychainPasswordOverride: TEST_PASSWORD, checkProcess: false }),
        }
      );
    }, (err) => {
      assert.equal(err.code, 'COLLISION_DETECTED');
      return true;
    });

    assert.equal(setCookieCalled, false, 'No mutation must occur when collision is detected');
  } finally {
    fixture.cleanup();
  }
});

test('copyCookies: mid-copy mutation failure reports partial without rollback', async () => {
  const fixture = makeDisposableProfile('mid-copy-partial');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'cookie_1',
        encrypted_value: encryptTestValue('val_1'),
      },
      {
        host_key: 'example.com',
        name: 'cookie_2',
        encrypted_value: encryptTestValue('val_2'),
      },
    ]);

    let count = 0;
    const mockGatewayCall = async (method, params) => {
      if (method === 'getCookies') return { cookies: [], supportsCdpCookieAttributes: true };
      if (method === 'setCookie') {
        count++;
        if (count === 2) {
          throw new Error('CDP execution failed');
        }
        return { success: true };
      }
    };

    const res = await copyCookies(
      {
        sourceProfile: 'Chrome:test-source',
        targetProfile: 'connected-target-1',
        url: 'https://example.com',
      },
      {
        profileResolver: () => fixture.profile,
        gatewayCall: mockGatewayCall,
        cookieReader: (p, opts) => readLocalCookies(p, { ...opts, keychainPasswordOverride: TEST_PASSWORD, checkProcess: false }),
      }
    );

    assert.equal(res.status, 'partial');
    assert.equal(res.appliedCount, 1);
    assert.equal(res.failedCount, 1);
    assert.equal(res.error, 'MUTATION_ERROR');
  } finally {
    fixture.cleanup();
  }
});

test('copyCookies: target disconnected reports typed TARGET_PROFILE_DISCONNECTED', async () => {
  const fixture = makeDisposableProfile('target-disconnected');
  try {
    createSyntheticCookieDb(fixture.dbPath, []);

    const mockGatewayCall = async () => {
      const err = new Error('No connected Chrome profile');
      err.status = 404;
      throw err;
    };

    await assert.rejects(async () => {
      await copyCookies(
        {
          sourceProfile: 'Chrome:test-source',
          targetProfile: 'missing-target',
          url: 'https://example.com',
        },
        {
          profileResolver: () => fixture.profile,
          gatewayCall: mockGatewayCall,
          cookieReader: (p, opts) => readLocalCookies(p, { ...opts, keychainPasswordOverride: TEST_PASSWORD, checkProcess: false }),
        }
      );
    }, (err) => {
      assert.equal(err.code, 'TARGET_PROFILE_DISCONNECTED');
      return true;
    });
  } finally {
    fixture.cleanup();
  }
});

test('zero secrets: CLI outputs zero plaintext cookie values in json or stdout', async () => {
  const fixture = makeDisposableProfile('zero-secrets');
  try {
    const SECRET = 'SUPER_SECRET_AUTHENTICATION_COOKIE_VALUE_98765';
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'session_key',
        encrypted_value: encryptTestValue(SECRET),
      },
    ]);

    const targetCookies = [];
    const mockGatewayCall = async (method, params) => {
      if (method === 'getCookies') return { cookies: [...targetCookies], supportsCdpCookieAttributes: true };
      if (method === 'setCookie') {
        targetCookies.push({ name: params.name, value: params.value, path: params.path, domain: params.domain });
        return { success: true };
      }
    };

    const res = await copyCookies(
      {
        sourceProfile: 'Chrome:test-source',
        targetProfile: 'target-1',
        url: 'https://example.com',
      },
      {
        profileResolver: () => fixture.profile,
        gatewayCall: mockGatewayCall,
        cookieReader: (p, opts) => readLocalCookies(p, { ...opts, keychainPasswordOverride: TEST_PASSWORD, checkProcess: false }),
      }
    );

    const jsonString = JSON.stringify(res);
    assert.ok(!jsonString.includes(SECRET), 'Plaintext secret must never appear in copy result JSON');
  } finally {
    fixture.cleanup();
  }
});

test('isolation: two profiles, two sites, identical cookie names copies only scoped site from scoped profile', async () => {
  const profileA = makeDisposableProfile('profile-a');
  const profileB = makeDisposableProfile('profile-b');

  try {
    // Profile A has cookie 'sid' for both site-a.com and site-b.com
    createSyntheticCookieDb(profileA.dbPath, [
      {
        host_key: 'site-a.com',
        name: 'sid',
        encrypted_value: encryptTestValue('profile_a_site_a_sid'),
      },
      {
        host_key: 'site-b.com',
        name: 'sid',
        encrypted_value: encryptTestValue('profile_a_site_b_sid'),
      },
    ]);

    // Profile B has cookie 'sid' for site-a.com
    createSyntheticCookieDb(profileB.dbPath, [
      {
        host_key: 'site-a.com',
        name: 'sid',
        encrypted_value: encryptTestValue('profile_b_site_a_sid'),
      },
    ]);

    const targetCookies = [];
    const mockGatewayCall = async (method, params) => {
      if (method === 'getCookies') return { cookies: [...targetCookies], supportsCdpCookieAttributes: true };
      if (method === 'setCookie') {
        targetCookies.push({
          name: params.name,
          value: params.value,
          domain: params.domain,
          path: params.path,
          secure: params.secure,
          httpOnly: params.httpOnly,
          sameSite: params.sameSite,
          priority: params.priority,
        });
        return { success: true };
      }
    };

    const resolver = (id) => (id === 'Chrome:profile-a' ? profileA.profile : profileB.profile);

    // Copy from Profile A for site-a.com
    const result = await copyCookies(
      {
        sourceProfile: 'Chrome:profile-a',
        targetProfile: 'target-1',
        url: 'https://site-a.com/home',
      },
      {
        profileResolver: resolver,
        gatewayCall: mockGatewayCall,
        cookieReader: (p, opts) => readLocalCookies(p, { ...opts, keychainPasswordOverride: TEST_PASSWORD, checkProcess: false }),
      }
    );

    assert.equal(result.status, 'success');
    assert.equal(result.appliedCount, 1);
    assert.equal(targetCookies.length, 1);
    assert.equal(targetCookies[0].name, 'sid');
    assert.equal(targetCookies[0].value, 'profile_a_site_a_sid');
  } finally {
    profileA.cleanup();
    profileB.cleanup();
  }
});

test('cli: parseArgs parses options correctly', () => {
  const args = [
    '--source-profile', 'Chrome:Default',
    '--target-profile', 'target-uuid-123',
    '--url', 'https://example.com/test',
    '--domain', 'example.com',
    '--name', 'sid',
    '--name', 'csrf',
    '--path', '/api',
    '--include-http-only',
    '--dry-run',
    '--json',
  ];

  const opts = parseArgs(args);
  assert.equal(opts.sourceProfile, 'Chrome:Default');
  assert.equal(opts.targetProfile, 'target-uuid-123');
  assert.equal(opts.url, 'https://example.com/test');
  assert.equal(opts.domain, 'example.com');
  assert.deepEqual(opts.names, ['sid', 'csrf']);
  assert.deepEqual(opts.paths, ['/api']);
  assert.equal(opts.includeHttpOnly, true);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.json, true);
});

test('offline check: unparseable SingletonLock symlink fails closed with SOURCE_PROFILE_BUSY', () => {
  const fixture = makeDisposableProfile('lock-fail-closed');
  try {
    const lockPath = path.join(fixture.profile.userDataDir, 'SingletonLock');
    // Create an unparseable lock symlink
    fs.symlinkSync('arbitrary-unparseable-lock', lockPath);

    assert.throws(() => {
      assertSourceProfileOffline(fixture.profile, { checkProcess: true });
    }, (err) => {
      assert.equal(err.code, 'SOURCE_PROFILE_BUSY');
      return true;
    });
  } finally {
    fixture.cleanup();
  }
});

test('collectTargetUrlsForCookies: generates distinct URLs covering all paths and domains', () => {
  const origin = 'https://example.com/home';
  const cookies = [
    { name: 'c1', path: '/api' },
    { name: 'c2', path: '/auth', domain: '.sub.example.com' },
    { name: 'c3', secure: true, path: '/' },
  ];
  const urls = collectTargetUrlsForCookies(origin, cookies);
  assert.ok(urls.includes('https://example.com/home'));
  assert.ok(urls.includes('https://example.com/api'));
  assert.ok(urls.includes('https://sub.example.com/auth'));
  assert.ok(urls.includes('https://example.com/'));
  assert.equal(urls.length, 4);
});

test('symlink escape: rejects cookie db symlink pointing outside profile directory', () => {
  const fixture = makeDisposableProfile('symlink-escape');
  try {
    const outsideTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-target-'));
    const outsideDb = path.join(outsideTmp, 'StolenCookies');
    fs.writeFileSync(outsideDb, 'fake');

    const networkDir = path.join(fixture.profile.userDataDir, fixture.profile.profileDir, 'Network');
    fs.mkdirSync(networkDir, { recursive: true });
    const symlinkTarget = path.join(networkDir, 'Cookies');
    fs.symlinkSync(outsideDb, symlinkTarget);

    assert.throws(() => {
      resolveSourceCookieDbPath(fixture.profile);
    }, (err) => {
      assert.equal(err.code, 'SOURCE_FILE_OUTSIDE_PROFILE');
      return true;
    });

    fs.rmSync(outsideTmp, { recursive: true, force: true });
  } finally {
    fixture.cleanup();
  }
});

test('parent domain scoping: only domain cookies match subdomain, parent host-only is ignored', () => {
  const fixture = makeDisposableProfile('parent-scoping');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'parent_host_only',
        encrypted_value: encryptTestValue('secret_parent'),
      },
      {
        host_key: '.example.com',
        name: 'parent_domain',
        encrypted_value: encryptTestValue('secret_domain'),
      },
      {
        host_key: 'sub.example.com',
        name: 'sub_host_only',
        encrypted_value: encryptTestValue('secret_sub'),
      },
    ]);

    const result = readLocalCookies(fixture.profile, {
      url: 'https://sub.example.com/app',
      domain: 'example.com',
      keychainPasswordOverride: TEST_PASSWORD,
      checkProcess: false,
    });

    const names = result.cookies.map((c) => c.name);
    assert.deepEqual(names.sort(), ['parent_domain', 'sub_host_only'].sort());
    assert.equal(names.includes('parent_host_only'), false, 'Parent host-only cookie must NOT match subdomain');
  } finally {
    fixture.cleanup();
  }
});

test('read-back verification: rejects host-only target cookie when source cookie is domain cookie', async () => {
  const fixture = makeDisposableProfile('readback-scope-mismatch');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: '.example.com',
        name: 'domain_cookie',
        encrypted_value: encryptTestValue('val_domain'),
      },
    ]);

    let getCookiesCount = 0;
    const mockGatewayCall = async (method, params) => {
      if (method === 'getCookies') {
        getCookiesCount++;
        if (getCookiesCount === 1) {
          // Preflight: no collisions
          return { cookies: [], supportsCdpCookieAttributes: true };
        }
        // Read-back: target profile returns a cookie that is HOST-ONLY instead of domain-scoped
        return {
          cookies: [
            {
              name: 'domain_cookie',
              value: 'val_domain',
              domain: 'example.com',
              hostOnly: true, // host-only mismatch!
              path: '/',
            },
          ],
          supportsCdpCookieAttributes: true,
        };
      }
      if (method === 'setCookie') {
        return { success: true };
      }
      throw new Error(`Unexpected method ${method}`);
    };

    const res = await copyCookies(
      {
        sourceProfile: 'Chrome:test-source',
        targetProfile: 'connected-target-1',
        url: 'https://example.com',
      },
      {
        profileResolver: () => fixture.profile,
        gatewayCall: mockGatewayCall,
        cookieReader: (p, opts) => readLocalCookies(p, { ...opts, keychainPasswordOverride: TEST_PASSWORD, checkProcess: false }),
      }
    );

    assert.equal(res.status, 'partial');
    assert.equal(res.appliedCount, 1);
    assert.equal(res.verifiedCount, 0);
    assert.equal(res.error, 'READ_BACK_MISMATCH: Read-back verification count did not match applied count');
  } finally {
    fixture.cleanup();
  }
});

test('schema 24: correctly strips and verifies 32-byte host_key SHA-256 digest on modern Chrome databases', async () => {
  const fixture = makeDisposableProfile('schema-24-modern');
  try {
    const rawSecret = 'super-secret-session-token-xyz-123';
    createSyntheticCookieDb(
      fixture.dbPath,
      [
        {
          host_key: 'example.com',
          name: 'session_v24',
          encrypted_value: encryptTestValue(rawSecret, TEST_KEY, { schemaVersion: 24, hostKey: 'example.com' }),
        },
      ],
      { metaVersion: 24 }
    );

    // 1. Verify readLocalCookies strips the 32-byte SHA-256 host digest cleanly
    const readResult = readLocalCookies(fixture.profile, {
      url: 'https://example.com/app',
      keychainPasswordOverride: TEST_PASSWORD,
      checkProcess: false,
    });

    assert.equal(readResult.selectedCount, 1);
    assert.equal(readResult.cookies[0].name, 'session_v24');
    assert.equal(readResult.cookies[0].value, rawSecret, 'Decrypted value must equal original plaintext without 32-byte digest');

    // 2. Verify copyCookies passes the pure plaintext value to target profile
    let targetReceivedValue = null;
    const targetStoredCookies = [];
    let getCookiesCount = 0;
    const mockGateway = async (method, params) => {
      if (method === 'getCookies') {
        getCookiesCount++;
        if (getCookiesCount === 1) return { cookies: [], supportsCdpCookieAttributes: true };
        return { cookies: [...targetStoredCookies], supportsCdpCookieAttributes: true };
      }
      if (method === 'setCookie') {
        targetReceivedValue = params.value;
        targetStoredCookies.push({
          name: params.name,
          value: params.value,
          domain: params.domain,
          path: params.path,
          secure: params.secure,
          httpOnly: params.httpOnly,
          sameSite: params.sameSite,
          priority: params.priority,
        });
        return { success: true };
      }
    };

    const copyResult = await copyCookies(
      {
        sourceProfile: 'Chrome:test-source',
        targetProfile: 'connected-target-1',
        url: 'https://example.com/app',
      },
      {
        profileResolver: () => fixture.profile,
        gatewayCall: mockGateway,
        cookieReader: (p, opts) => readLocalCookies(p, { ...opts, keychainPasswordOverride: TEST_PASSWORD, checkProcess: false }),
      }
    );

    assert.equal(copyResult.status, 'success');
    assert.equal(targetReceivedValue, rawSecret, 'Target gateway must receive clean uncorrupted plaintext');
  } finally {
    fixture.cleanup();
  }
});

test('schema 24: rejects cookie when host digest does not match host_key', () => {
  const fixture = makeDisposableProfile('schema-24-mismatch');
  try {
    createSyntheticCookieDb(
      fixture.dbPath,
      [
        {
          host_key: 'example.com',
          name: 'tampered_cookie',
          // Encrypt with mismatched hostKey (e.g. injected from another domain)
          encrypted_value: encryptTestValue('tampered_val', TEST_KEY, { schemaVersion: 24, hostKey: 'attacker.com' }),
        },
      ],
      { metaVersion: 24 }
    );

    assert.throws(() => {
      readLocalCookies(fixture.profile, {
        url: 'https://example.com',
        keychainPasswordOverride: TEST_PASSWORD,
        checkProcess: false,
      });
    }, (err) => {
      assert.equal(err.code, 'COOKIE_HOST_DIGEST_MISMATCH');
      return true;
    });
  } finally {
    fixture.cleanup();
  }
});

test('unsupported extension: fails before mutation when target extension lacks full CDP cookie attributes', async () => {
  const fixture = makeDisposableProfile('unsupported-ext');
  try {
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'test_cookie',
        encrypted_value: encryptTestValue('secret_val'),
      },
    ]);

    let setCookieCalled = false;
    const mockGateway = async (method) => {
      if (method === 'getCookies') {
        // Legacy extension response: no supportsCdpCookieAttributes
        return { cookies: [] };
      }
      if (method === 'setCookie') {
        setCookieCalled = true;
        return { success: true };
      }
    };

    await assert.rejects(async () => {
      await copyCookies(
        {
          sourceProfile: 'Chrome:test-source',
          targetProfile: 'legacy-target',
          url: 'https://example.com',
        },
        {
          profileResolver: () => fixture.profile,
          gatewayCall: mockGateway,
          cookieReader: (p, opts) => readLocalCookies(p, { ...opts, keychainPasswordOverride: TEST_PASSWORD, checkProcess: false }),
        }
      );
    }, (err) => {
      assert.equal(err.code, 'TARGET_EXTENSION_UNSUPPORTED');
      return true;
    });

    assert.equal(setCookieCalled, false, 'Mutation must never execute on unsupported extension');
  } finally {
    fixture.cleanup();
  }
});

test('read-back verification: fails when cookie expires differs between source and target', async () => {
  const fixture = makeDisposableProfile('expires-mismatch');
  try {
    const futureExpires = toChromeMicroseconds(Math.floor(Date.now() / 1000) + 3600);
    createSyntheticCookieDb(fixture.dbPath, [
      {
        host_key: 'example.com',
        name: 'expiring_cookie',
        expires_utc: futureExpires,
        encrypted_value: encryptTestValue('exp_val'),
      },
    ]);

    let getCookiesCount = 0;
    const mockGateway = async (method, params) => {
      if (method === 'getCookies') {
        getCookiesCount++;
        if (getCookiesCount === 1) return { cookies: [], supportsCdpCookieAttributes: true };
        return {
          cookies: [
            {
              name: 'expiring_cookie',
              value: 'exp_val',
              domain: undefined,
              hostOnly: true,
              path: '/',
              expires: -1, // Session cookie on target instead of persistent expiry!
            },
          ],
          supportsCdpCookieAttributes: true,
        };
      }
      if (method === 'setCookie') {
        return { success: true };
      }
    };

    const res = await copyCookies(
      {
        sourceProfile: 'Chrome:test-source',
        targetProfile: 'connected-target-1',
        url: 'https://example.com',
      },
      {
        profileResolver: () => fixture.profile,
        gatewayCall: mockGateway,
        cookieReader: (p, opts) => readLocalCookies(p, { ...opts, keychainPasswordOverride: TEST_PASSWORD, checkProcess: false }),
      }
    );

    assert.equal(res.status, 'partial');
    assert.equal(res.appliedCount, 1);
    assert.equal(res.verifiedCount, 0);
    assert.equal(res.error, 'READ_BACK_MISMATCH: Read-back verification count did not match applied count');
  } finally {
    fixture.cleanup();
  }
});
