import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  normalizeServiceName,
  inspectOnDiskServiceAuth,
  assertOnDiskServiceAuth,
  verifyLiveCdpServiceCookies,
  evaluateCloudBackupRegression,
} from '../../lib/profile/service-auth-guard.mjs';

const WEBKIT_OFFSET_US = 11644473600000000n;
const FUTURE_EXP_US = (BigInt(Date.now() + 86400 * 365 * 1000) * 1000n) + WEBKIT_OFFSET_US;
const PAST_EXP_US = (BigInt(Date.now() - 86400 * 1000) * 1000n) + WEBKIT_OFFSET_US;

function createMockProfile(t, rows = [], meta = null) {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-auth-guard-'));
  t.after(() => fs.rmSync(udd, { recursive: true, force: true }));
  const netDir = path.join(udd, 'Default', 'Network');
  fs.mkdirSync(netDir, { recursive: true });
  const db = new DatabaseSync(path.join(netDir, 'Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER, creation_utc INTEGER, last_access_utc INTEGER);');
  const stmt = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?)');
  const nowUs = (BigInt(Date.now()) * 1000n) + WEBKIT_OFFSET_US;
  for (const r of rows) {
    stmt.run(
      r.host_key,
      r.name,
      r.value ?? '',
      r.encrypted_value ?? Buffer.from('v10cipher'),
      r.expires_utc ?? Number(FUTURE_EXP_US),
      r.creation_utc ?? Number(nowUs),
      r.last_access_utc ?? Number(nowUs),
    );
  }
  db.close();
  if (meta) {
    fs.writeFileSync(path.join(udd, '.webmcp-meta.json'), JSON.stringify(meta));
  }
  return udd;
}

test('normalizeServiceName maps common service aliases cleanly', () => {
  assert.equal(normalizeServiceName('gmail'), 'google');
  assert.equal(normalizeServiceName('FB'), 'facebook');
  assert.equal(normalizeServiceName('twitter'), 'x');
  assert.equal(normalizeServiceName('yt'), 'youtube');
  assert.equal(normalizeServiceName('tiktok'), 'tiktok');
});

test('assertOnDiskServiceAuth validates Google/Gmail, YouTube, Facebook, TikTok, X, Shopee accurately', (t) => {
  const healthyUdd = createMockProfile(t, [
    { host_key: '.google.com', name: 'SID' },
    { host_key: '.google.com', name: 'SAPISID' },
    { host_key: 'accounts.google.com', name: '__Host-1PLSID' },
    { host_key: '.youtube.com', name: 'LOGIN_INFO' },
    { host_key: '.facebook.com', name: 'c_user' },
    { host_key: '.facebook.com', name: 'xs' },
    { host_key: '.tiktok.com', name: 'sessionid' },
    { host_key: '.x.com', name: 'auth_token' },
    { host_key: '.x.com', name: 'ct0' },
    { host_key: '.shopee.vn', name: 'SPC_EC' },
  ]);

  const allOk = assertOnDiskServiceAuth(healthyUdd, ['gmail', 'youtube', 'facebook', 'tiktok', 'twitter', 'shopee']);
  assert.equal(allOk.ok, true);
  assert.deepEqual(allOk.report.brokenPlatforms, []);

  // Expired / missing / broken auth cases fail loudly
  const brokenUdd = createMockProfile(t, [
    { host_key: '.facebook.com', name: 'c_user' }, // missing xs -> broken facebook!
    { host_key: '.tiktok.com', name: 'sid_tt', expires_utc: Number(PAST_EXP_US) }, // expired!
    { host_key: '.google.com', name: 'NID' }, // anonymous only!
  ]);
  const resFail = assertOnDiskServiceAuth(brokenUdd, ['gmail', 'youtube', 'facebook', 'tiktok']);
  assert.equal(resFail.ok, false);
  assert.equal(resFail.code, 'ERR_PROFILE_MISSING_SERVICE_COOKIES');
  assert.deepEqual(resFail.missingServices, ['google', 'youtube', 'facebook', 'tiktok']);
  assert.ok(resFail.brokenPlatforms.includes('facebook'));

  // allowGuestSeed explicit opt-out works
  const guestOk = assertOnDiskServiceAuth(brokenUdd, ['gmail'], { allowGuestSeed: true });
  assert.equal(guestOk.ok, true);
  assert.equal(guestOk.bypassed, 'allowGuestSeed');
});

test('inspectOnDiskServiceAuth respects googleAuthProbe.signedOut unless fresher cookies were saved', (t) => {
  const oldIso = new Date(Date.now() - 3600_000).toISOString();
  const futureProbeIso = new Date(Date.now() + 60_000).toISOString();
  const rows = [
    { host_key: '.google.com', name: 'SID' },
    { host_key: '.google.com', name: '__Secure-1PSID' },
    { host_key: 'accounts.google.com', name: 'LSID' },
  ];

  const staleSignedOut = createMockProfile(t, rows, { googleAuthProbe: { signedOut: true, checkedAt: futureProbeIso } });
  const r1 = inspectOnDiskServiceAuth(staleSignedOut, { services: ['gmail'] });
  assert.equal(r1.googleSignedOut, true);
  assert.deepEqual(r1.missingServices, ['google']);

  const healedCookies = createMockProfile(t, rows, { googleAuthProbe: { signedOut: true, checkedAt: oldIso } });
  const r2 = inspectOnDiskServiceAuth(healedCookies, { services: ['gmail'] });
  assert.equal(r2.googleSignedOut, false);
  assert.deepEqual(r2.missingServices, []);

  // Bumped last_access_utc alone must NOT clear signedOut (creation_utc < checkedAt governs)
  const oldCreatUs = (BigInt(Date.now() - 7200_000) * 1000n) + WEBKIT_OFFSET_US;
  const freshAccessUs = (BigInt(Date.now() + 300_000) * 1000n) + WEBKIT_OFFSET_US;
  const probeMidIso = new Date(Date.now() - 1800_000).toISOString();
  const bumpedAccessUdd = createMockProfile(
    t,
    rows.map((r) => ({ ...r, creation_utc: Number(oldCreatUs), last_access_utc: Number(freshAccessUs) })),
    { googleAuthProbe: { signedOut: true, checkedAt: probeMidIso } },
  );
  const r3 = inspectOnDiskServiceAuth(bumpedAccessUdd, { services: ['gmail'] });
  assert.equal(r3.googleSignedOut, true);
  assert.deepEqual(r3.missingServices, ['google']);

  // Missing checkedAt on signedOut probe is ignored (parity with Python cookie_auth)
  const noCheckedAtUdd = createMockProfile(t, rows, { googleAuthProbe: { signedOut: true } });
  const r4 = inspectOnDiskServiceAuth(noCheckedAtUdd, { services: ['gmail'] });
  assert.equal(r4.googleSignedOut, false);

  // Preferences gaia_cookie.last_list_accounts_binary_data signedOut (field 1 ListedAccount { field 5 valid=0, field 14 signed_out=1 })
  // Encoded tag1(0x0a), len=4, tag5=0(0x28 0x00), tag14=1(0x70 0x01) -> base64 "CgQoAHA="
  const gaiaUdd = createMockProfile(
    t,
    rows.map((r) => ({ ...r, creation_utc: Number(oldCreatUs) })),
  );
  fs.writeFileSync(
    path.join(gaiaUdd, 'Default', 'Preferences'),
    JSON.stringify({
      gaia_cookie: {
        last_list_accounts_binary_data: Buffer.from([0x0a, 0x04, 0x28, 0x00, 0x70, 0x01]).toString('base64'),
        changed_time: (Date.now() / 1000) + 60,
      },
    }),
  );
  const r5 = inspectOnDiskServiceAuth(gaiaUdd, { services: ['gmail'] });
  assert.equal(r5.googleSignedOut, true);

  // Placeholder string sentinels ('null', 'deleted') must be ignored as empty
  const sentinelUdd = createMockProfile(t, [
    { host_key: '.facebook.com', name: 'c_user', value: 'null', encrypted_value: Buffer.alloc(0) },
    { host_key: '.facebook.com', name: 'xs', value: 'deleted', encrypted_value: Buffer.alloc(0) },
  ]);
  const r6 = inspectOnDiskServiceAuth(sentinelUdd, { services: ['facebook'] });
  assert.equal(r6.serviceChecks.facebook.ok, false);
});

test('verifyLiveCdpServiceCookies detects decrypt loss (ERR_SESSION_COOKIE_DECRYPT_LOSS) vs logged out', (t) => {
  const diskUdd = createMockProfile(t, [
    { host_key: '.facebook.com', name: 'c_user' },
    { host_key: '.facebook.com', name: 'xs' },
    { host_key: '.youtube.com', name: 'LOGIN_INFO' },
    { host_key: '.google.com', name: 'SID' },
  ]);
  const preReport = inspectOnDiskServiceAuth(diskUdd, { services: ['facebook', 'youtube'] });

  // Live Chrome decrypted empty strings due to Keychain loss
  const lostRes = verifyLiveCdpServiceCookies(
    [{ domain: '.facebook.com', name: 'c_user', value: '' }, { domain: '.facebook.com', name: 'datr', value: 'abc' }],
    ['facebook'],
    { preLaunchReport: preReport }
  );
  assert.equal(lostRes.ok, false);
  assert.equal(lostRes.code, 'ERR_SESSION_COOKIE_DECRYPT_LOSS');
  assert.equal(lostRes.hardQuarantine, true);

  // Without preLaunch auth cookies, classifies cleanly as ERR_WARMUP_NOT_LOGGED_IN
  const notLoggedIn = verifyLiveCdpServiceCookies(
    [{ domain: '.youtube.com', name: 'YSC', value: 'anon' }],
    ['youtube'],
    { preLaunchReport: { serviceChecks: { youtube: { ok: false } } } }
  );
  assert.equal(notLoggedIn.ok, false);
  assert.equal(notLoggedIn.code, 'ERR_WARMUP_NOT_LOGGED_IN');
  assert.equal(notLoggedIn.hardQuarantine, false);

  // Failed live cookie read (null/unavailable) returns soft ERR_LIVE_COOKIE_READ_FAILED without hard quarantine
  const readFailed = verifyLiveCdpServiceCookies(null, ['facebook'], { preLaunchReport: preReport });
  assert.equal(readFailed.ok, false);
  assert.equal(readFailed.code, 'ERR_LIVE_COOKIE_READ_FAILED');
  assert.equal(readFailed.hardQuarantine, false);

  // Valid decrypted live cookies pass
  const okLive = verifyLiveCdpServiceCookies(
    [{ domain: '.tiktok.com', name: 'sessionid', value: 'valid-sess', expires: (Date.now() / 1000) + 3600 }],
    ['tiktok'],
    { preLaunchReport: preReport }
  );
  assert.equal(okLive.ok, true);
});

test('evaluateCloudBackupRegression blocks wiped, broken, signedOut, lost-platform, and cliff backups', () => {
  assert.equal(evaluateCloudBackupRegression({ signedOut: true }).code, 'ERR_BACKUP_COOKIE_REGRESSION_BLOCKED');
  assert.equal(evaluateCloudBackupRegression({ currentReport: { brokenPlatforms: ['facebook'] } }).code, 'ERR_BACKUP_COOKIE_REGRESSION_BLOCKED');
  assert.equal(evaluateCloudBackupRegression({ prevItem: { cookieCount: 10 }, currentCookieCount: 0 }).code, 'ERR_BACKUP_COOKIE_REGRESSION_BLOCKED');
  assert.equal(
    evaluateCloudBackupRegression({
      prevItem: { cookieCount: 100, platforms: ['google', 'facebook'] },
      currentReport: { platforms: ['google'], brokenPlatforms: [], googleSignedOut: false },
      currentCookieCount: 80,
    }).code,
    'ERR_BACKUP_COOKIE_REGRESSION_BLOCKED'
  );
  assert.equal(
    evaluateCloudBackupRegression({
      prevItem: { cookieCount: 200, platforms: ['google'] },
      currentReport: { platforms: ['google'], brokenPlatforms: [], googleSignedOut: false },
      currentCookieCount: 5,
    }).code,
    'ERR_BACKUP_COOKIE_REGRESSION_BLOCKED'
  );
  assert.equal(evaluateCloudBackupRegression({ signedOut: true, force: true }).ok, true);
  assert.equal(
    evaluateCloudBackupRegression({
      prevItem: { cookieCount: 200, platforms: ['google'] },
      currentReport: { platforms: ['google'], brokenPlatforms: [], googleSignedOut: false },
      currentCookieCount: 195,
    }).ok,
    true
  );
});

test('inspectOnDiskServiceAuth reads uncheckpointed -wal cookies under exclusive lock and handles 64-bit protobuf varints', (t) => {
  // 1. Exclusive SQLite lock with uncheckpointed -wal frames (must NOT drop -wal via immutable=1)
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-auth-wal-'));
  t.after(() => fs.rmSync(udd, { recursive: true, force: true }));
  const netDir = path.join(udd, 'Default', 'Network');
  fs.mkdirSync(netDir, { recursive: true });
  const dbPath = path.join(netDir, 'Cookies');

  const writer = new DatabaseSync(dbPath);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    writer.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER, creation_utc INTEGER, last_access_utc INTEGER);');
    writer.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
    const nowUs = Number((BigInt(Date.now()) * 1000n) + WEBKIT_OFFSET_US);
    const ins = writer.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run('.facebook.com', 'c_user', '', Buffer.from('v10c'), Number(FUTURE_EXP_US), nowUs, nowUs);
    ins.run('.facebook.com', 'xs', '', Buffer.from('v10x'), Number(FUTURE_EXP_US), nowUs, nowUs);
    writer.exec('COMMIT;');
    // Re-acquire exclusive lock so direct DatabaseSync(..., { readOnly: true }) fails with database is locked
    writer.exec('BEGIN EXCLUSIVE;');
    writer.exec("INSERT INTO cookies VALUES ('.facebook.com', 'datr', '', X'763130', 0, 0, 0);");

    const walRes = assertOnDiskServiceAuth(udd, ['facebook']);
    assert.equal(walRes.ok, true);
    assert.equal(walRes.report.dbOk, true);
    assert.equal(walRes.report.serviceChecks.facebook.ok, true);
  } finally {
    try { writer.exec('ROLLBACK;'); } catch {}
    try { writer.close(); } catch {}
  }

  // 2. Hot -journal fallback via temp copy + sqlite3 CLI
  const journalUdd = createMockProfile(t, [
    { host_key: '.facebook.com', name: 'c_user' },
    { host_key: '.facebook.com', name: 'xs' },
  ]);
  fs.writeFileSync(path.join(journalUdd, 'Default', 'Network', 'Cookies-journal'), 'dummy rollback journal bytes');
  const journalRes = assertOnDiskServiceAuth(journalUdd, ['facebook']);
  assert.equal(journalRes.ok, true);
  assert.equal(journalRes.report.serviceChecks.facebook.ok, true);

  // 3. 64-bit protobuf varint (e.g. negative int64 field before valid=0, signed_out=1) must not overflow 32-bit
  const oldCreatUs = (BigInt(Date.now() - 7200_000) * 1000n) + WEBKIT_OFFSET_US;
  const pbUdd = createMockProfile(
    t,
    [
      { host_key: '.google.com', name: 'SID', creation_utc: Number(oldCreatUs) },
      { host_key: '.google.com', name: '__Secure-1PSID', creation_utc: Number(oldCreatUs) },
      { host_key: 'accounts.google.com', name: 'LSID', creation_utc: Number(oldCreatUs) },
    ],
  );
  // Field 20 wireType 0 (0xa0 0x01) + 10-byte negative int64 (-1), then field 5 valid=0 (0x28 0x00), field 14 signed_out=1 (0x70 0x01)
  const innerAcc = Buffer.from([
    0xa0, 0x01,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    0x28, 0x00,
    0x70, 0x01,
  ]);
  const outerPb = Buffer.concat([Buffer.from([0x0a, innerAcc.length]), innerAcc]);
  fs.writeFileSync(
    path.join(pbUdd, 'Default', 'Preferences'),
    JSON.stringify({
      gaia_cookie: {
        last_list_accounts_binary_data: outerPb.toString('base64'),
        changed_time: (Date.now() / 1000) + 60,
      },
    }),
  );
  const pbRes = inspectOnDiskServiceAuth(pbUdd, { services: ['gmail'] });
  assert.equal(pbRes.googleSignedOut, true);
  assert.deepEqual(pbRes.missingServices, ['google']);
});
