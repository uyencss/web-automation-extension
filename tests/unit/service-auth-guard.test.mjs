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
  decodeListAccountsPb,
  snapshotSqliteStable,
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

  // 4. Douyin rule parity (sessionid / sid_tt on .douyin.com)
  const dyUdd = createMockProfile(t, [{ host_key: '.douyin.com', name: 'sid_tt' }]);
  const dyRes = assertOnDiskServiceAuth(dyUdd, ['douyin']);
  assert.equal(dyRes.ok, true);
  assert.ok(dyRes.report.platforms.includes('douyin'));
});

test('inspectOnDiskServiceAuth never creates -wal/-shm on live closed WAL DB and defends torn snapshots, pipe values, protobuf bounds, and nowMs', (t) => {
  // 1. Live closed WAL-mode DB gets ZERO -wal/-shm sidecars materialized during read
  const walCleanUdd = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-wal-clean-'));
  t.after(() => fs.rmSync(walCleanUdd, { recursive: true, force: true }));
  const walNet = path.join(walCleanUdd, 'Default', 'Network');
  fs.mkdirSync(walNet, { recursive: true });
  const cleanDb = path.join(walNet, 'Cookies');
  const db1 = new DatabaseSync(cleanDb);
  db1.exec('PRAGMA journal_mode=WAL; CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER, creation_utc INTEGER, last_access_utc INTEGER);');
  db1.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?)').run('.facebook.com', 'c_user', '123', Buffer.alloc(0), Number(FUTURE_EXP_US), 0, 0);
  db1.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?)').run('.facebook.com', 'xs', 'abc', Buffer.alloc(0), Number(FUTURE_EXP_US), 0, 0);
  db1.close();
  assert.equal(fs.existsSync(`${cleanDb}-wal`), false);
  assert.equal(fs.existsSync(`${cleanDb}-shm`), false);

  const cleanRep = inspectOnDiskServiceAuth(walCleanUdd, { services: ['facebook'] });
  assert.equal(cleanRep.dbOk, true);
  assert.equal(cleanRep.serviceChecks.facebook.ok, true);
  assert.equal(fs.existsSync(`${cleanDb}-wal`), false, 'live dir must stay untouched (no -wal created)');
  assert.equal(fs.existsSync(`${cleanDb}-shm`), false, 'live dir must stay untouched (no -shm created)');

  // 2. Real hot rollback journal + expired cookie containing '|' must stay expired (CLI -json parity)
  const pipeUdd = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-hot-pipe-'));
  t.after(() => fs.rmSync(pipeUdd, { recursive: true, force: true }));
  const pipeNet = path.join(pipeUdd, 'Default', 'Network');
  fs.mkdirSync(pipeNet, { recursive: true });
  const pipeDb = path.join(pipeNet, 'Cookies');
  const writerPipe = new DatabaseSync(pipeDb);
  writerPipe.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER, creation_utc INTEGER, last_access_utc INTEGER);');
  writerPipe.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?)').run('.tiktok.com', 'sessionid', 'a|b', Buffer.alloc(0), Number(PAST_EXP_US), 0, 0);
  writerPipe.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
  writerPipe.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?)').run('.tiktok.com', 'sid_tt', 'uncommitted', Buffer.alloc(0), Number(FUTURE_EXP_US), 0, 0);
  const pipeRep = inspectOnDiskServiceAuth(pipeUdd, { services: ['tiktok'] });
  assert.equal(pipeRep.dbOk, true);
  assert.equal(pipeRep.serviceChecks.tiktok.ok, false, 'expired pipe cookie must not become valid');
  writerPipe.exec('ROLLBACK;');
  writerPipe.close();

  // 3. Torn snapshot retry recovers when attempt 2 settles, and fails closed if every attempt mutates
  let mutCount = 0;
  const retryRep = inspectOnDiskServiceAuth(walCleanUdd, {
    services: ['facebook'],
    _snapshotOpts: {
      maxAttempts: 3,
      retryDelayMs: 1,
      afterSidecarCopyHook(attempt) {
        if (attempt === 0) {
          mutCount++;
          fs.appendFileSync(cleanDb, Buffer.alloc(0));
          const nowS = new Date(Date.now() + 10000);
          fs.utimesSync(cleanDb, nowS, nowS);
        }
      },
    },
  });
  assert.equal(mutCount, 1);
  assert.equal(retryRep.dbOk, true);

  const failClosedRep = inspectOnDiskServiceAuth(walCleanUdd, {
    services: ['facebook'],
    _snapshotOpts: {
      maxAttempts: 2,
      retryDelayMs: 1,
      afterSidecarCopyHook(attempt) {
        const tS = new Date(Date.now() + 20000 + (attempt * 5000));
        fs.utimesSync(cleanDb, tS, tS);
      },
    },
  });
  assert.equal(failClosedRep.dbOk, false);
  assert.equal(snapshotSqliteStable(path.join(walNet, 'Missing'), path.join(walNet, 'Tmp'), { maxAttempts: 1 }), false);

  // 4. Truncated protobuf / 10th-byte overflow / high-bit tag must throw instead of fabricating valid=0
  assert.throws(() => decodeListAccountsPb(Buffer.from([0x0a, 0x03, 0x09, 0x00, 0x00]).toString('base64')));
  assert.throws(() => decodeListAccountsPb(Buffer.from([0x09, 0x01]).toString('base64')));
  assert.throws(() => decodeListAccountsPb(Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]).toString('base64')));
  // High-bit tag >= 2^31 skipped cleanly as BigInt unsigned shift
  const highTagSkip = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x08, 0x01]);
  assert.deepEqual(decodeListAccountsPb(highTagSkip.toString('base64')), []);

  // 5. Invalid/non-positive options.nowMs falls back to Date.now() without reviving post-1970 expired cookies
  for (const badNow of [Number.NaN, Number.POSITIVE_INFINITY, 'not-a-number', 0, -1000, '', false]) {
    const r = inspectOnDiskServiceAuth(pipeUdd, { services: ['tiktok'], nowMs: badNow });
    assert.equal(r.dbOk, true);
    assert.equal(r.serviceChecks.tiktok.ok, false);
  }

  // 6. Table lacking host_key (missing col or legacy host alias) executes cleanly in DatabaseSync
  const legacyUdd = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-legacy-cols-'));
  t.after(() => fs.rmSync(legacyUdd, { recursive: true, force: true }));
  const legacyNet = path.join(legacyUdd, 'Default', 'Network');
  fs.mkdirSync(legacyNet, { recursive: true });
  const legacyDb = new DatabaseSync(path.join(legacyNet, 'Cookies'));
  legacyDb.exec('CREATE TABLE cookies (host TEXT, name TEXT, value TEXT);');
  legacyDb.prepare('INSERT INTO cookies VALUES (?, ?, ?)').run('.douyin.com', 'sessionid', 'tok');
  legacyDb.close();
  const legacyRep = inspectOnDiskServiceAuth(legacyUdd, { services: ['douyin'] });
  assert.equal(legacyRep.dbOk, true);
  assert.equal(legacyRep.serviceChecks.douyin.ok, true);
});
