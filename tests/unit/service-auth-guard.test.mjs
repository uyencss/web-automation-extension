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
