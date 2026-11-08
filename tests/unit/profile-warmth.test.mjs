import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import {
  evaluateProfileWarmth,
  WARMTH_ACTIONS,
} from '../../lib/profile/profile-warmth.mjs';

const CHROME_EPOCH_OFFSET_US = 11644473600000000n;

function createChromeTimestamp(hoursAgo) {
  const msAgo = BigInt(Date.now() - Math.round(hoursAgo * 3600 * 1000));
  return msAgo * 1000n + CHROME_EPOCH_OFFSET_US;
}

function createMockProfile(t, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-warmth-test-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const profileDirName = options.profileDir || 'Default';
  const profileRoot = path.join(tmpDir, profileDirName);
  fs.mkdirSync(profileRoot, { recursive: true });

  if (options.cookies) {
    const cookiesSubdir = options.useNetworkDir ? path.join(profileRoot, 'Network') : profileRoot;
    fs.mkdirSync(cookiesSubdir, { recursive: true });
    const dbPath = path.join(cookiesSubdir, 'Cookies');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, creation_utc INTEGER)');
    const ins = db.prepare('INSERT INTO cookies (host_key, name, creation_utc) VALUES (?, ?, ?)');
    for (const c of options.cookies) {
      const creationUtc = c.creationUtc !== undefined ? c.creationUtc : (c.hoursAgo !== undefined ? createChromeTimestamp(c.hoursAgo) : 0n);
      ins.run(c.host_key || '', c.name || '', creationUtc);
    }
    db.close();
  }

  if (options.cacheSizeBytes) {
    const cacheDir = path.join(profileRoot, 'Cache', 'Cache_Data');
    fs.mkdirSync(cacheDir, { recursive: true });
    const chunkSize = Math.min(options.cacheSizeBytes, 1024 * 1024);
    fs.writeFileSync(path.join(cacheDir, 'data_0'), Buffer.alloc(chunkSize));
    if (options.cacheSizeBytes > chunkSize) {
      fs.writeFileSync(path.join(cacheDir, 'data_1'), Buffer.alloc(options.cacheSizeBytes - chunkSize));
    }
  }

  if (options.hasStorage) {
    fs.mkdirSync(path.join(profileRoot, 'Local Storage', 'leveldb'), { recursive: true });
    fs.writeFileSync(path.join(profileRoot, 'Local Storage', 'leveldb', '000001.log'), 'test');
  }

  return { tmpDir, profileRoot };
}

test('evaluateProfileWarmth: cold empty profile returns COLD with score < 40 and empty actions', (t) => {
  const { tmpDir } = createMockProfile(t);

  const report = evaluateProfileWarmth(tmpDir, { id: 'test-cold' });

  assert.equal(report.profileId, 'test-cold');
  assert.equal(report.verdict, 'COLD');
  assert.ok(report.score < 40, `score must be < 40, got ${report.score}`);
  assert.equal(report.score, 0);
  assert.deepEqual(report.actionsPermitted, []);
  assert.equal(report.soakAgeHours, 0);
  assert.deepEqual(report.thirdPartyDomains, []);
  assert.equal(report.thirdPartyCookiesCount, 0);
  assert.deepEqual(report.googleTokens, []);
  assert.equal(report.cacheSizeBytes, 0);
  assert.deepEqual(report.breakdown.soakAge, { score: 0, max: 30, ageHours: 0 });
  assert.deepEqual(report.breakdown.entropy, { score: 0, max: 25, domainsCount: 0, cookiesCount: 0 });
  assert.deepEqual(report.breakdown.telemetry, { score: 0, max: 30, tokensFound: [] });
  assert.deepEqual(report.breakdown.footprint, { score: 0, max: 15, cacheSizeBytes: 0, hasStorage: false });
});

test('evaluateProfileWarmth: handles non-existent or null profile path gracefully', () => {
  const report1 = evaluateProfileWarmth('/nonexistent/path/for/profile', { id: 'missing' });
  assert.equal(report1.profileId, 'missing');
  assert.equal(report1.verdict, 'COLD');
  assert.equal(report1.score, 0);
  assert.deepEqual(report1.actionsPermitted, []);

  const report2 = evaluateProfileWarmth('', { id: 'empty-path' });
  assert.equal(report2.profileId, 'empty-path');
  assert.equal(report2.verdict, 'COLD');
  assert.equal(report2.score, 0);
});

test('evaluateProfileWarmth: mock seeded profile returns SEEDED (score 40-69) and single action', (t) => {
  // Requirements for SEEDED: score 40-69
  // 15 pts soak age (2h)
  // 15 pts entropy (12 cookies from 1 domain)
  // 15 pts telemetry (NID + SEARCH_SAMESITE)
  // Total = 45 pts
  const cookies = [
    { host_key: '.google.com', name: 'NID', hoursAgo: 2 },
    { host_key: '.google.com', name: 'SEARCH_SAMESITE', hoursAgo: 2 },
  ];
  for (let i = 0; i < 12; i += 1) {
    cookies.push({ host_key: '.example.com', name: `c_${i}`, hoursAgo: 2 });
  }

  const { tmpDir } = createMockProfile(t, { cookies });
  const report = evaluateProfileWarmth(tmpDir, { id: 'test-seeded' });

  assert.equal(report.profileId, 'test-seeded');
  assert.equal(report.verdict, 'SEEDED');
  assert.ok(report.score >= 40 && report.score < 70, `Score expected in 40-69, got ${report.score}`);
  assert.deepEqual(report.actionsPermitted, ['CREATE_ACCOUNT_RESIDENTIAL_4G']);
  assert.equal(report.breakdown.soakAge.score, 15);
  assert.equal(report.breakdown.entropy.score, 15);
  assert.equal(report.breakdown.telemetry.score, 15);
  assert.equal(report.breakdown.footprint.score, 0);
});

test('evaluateProfileWarmth: mock soaked profile returns SOAKED (score 70-89) and three actions', (t) => {
  // Requirements for SOAKED: score 70-89
  // 25 pts soak age (30h)
  // 25 pts entropy (>= 3 unique 3P domains)
  // 20 pts telemetry (AEC: 10 + VISITOR_INFO1_LIVE: 5 + YSC: 5)
  // 10 pts footprint (Cache > 5MB = 10, no storage)
  // Total = 80 pts
  const cookies = [
    { host_key: '.google.com', name: 'AEC', hoursAgo: 30 },
    { host_key: '.youtube.com', name: 'VISITOR_INFO1_LIVE', hoursAgo: 30 },
    { host_key: '.youtube.com', name: 'YSC', hoursAgo: 30 },
    { host_key: '.shopee.vn', name: 'sp_session', hoursAgo: 30 },
    { host_key: '.vnexpress.net', name: 'vne_id', hoursAgo: 30 },
    { host_key: '.github.com', name: 'user_session', hoursAgo: 30 },
  ];

  const { tmpDir } = createMockProfile(t, {
    cookies,
    cacheSizeBytes: 6 * 1024 * 1024, // > 5MB => 10 pts
    hasStorage: false,
  });

  const report = evaluateProfileWarmth(tmpDir, { id: 'test-soaked' });

  assert.equal(report.profileId, 'test-soaked');
  assert.equal(report.verdict, 'SOAKED');
  assert.ok(report.score >= 70 && report.score < 90, `Score expected in 70-89, got ${report.score}`);
  assert.deepEqual(report.actionsPermitted, [
    'CREATE_ACCOUNT_RESIDENTIAL_4G',
    'ENABLE_2FA_TOTP',
    'ASSIGN_RECOVERY_EMAIL',
  ]);
  assert.equal(report.breakdown.soakAge.score, 25);
  assert.equal(report.breakdown.entropy.score, 25);
  assert.equal(report.breakdown.telemetry.score, 20);
  assert.equal(report.breakdown.footprint.score, 10);
});

test('evaluateProfileWarmth: mock mature profile returns MATURE (score 90-100) and all five actions', (t) => {
  // Requirements for MATURE: score >= 90
  // 30 pts soak age (> 48h)
  // 25 pts entropy (>= 3 unique 3P domains)
  // 30 pts telemetry (AEC, NID, SEARCH_SAMESITE, VISITOR_INFO1_LIVE, YSC, PREF)
  // 15 pts footprint (Cache > 5MB: 10 + Local Storage: 5)
  // Total = 100 pts
  const cookies = [
    { host_key: '.google.com', name: 'AEC', hoursAgo: 50 },
    { host_key: '.google.com', name: 'NID', hoursAgo: 50 },
    { host_key: '.google.com', name: 'SEARCH_SAMESITE', hoursAgo: 50 },
    { host_key: '.youtube.com', name: 'VISITOR_INFO1_LIVE', hoursAgo: 50 },
    { host_key: '.youtube.com', name: 'YSC', hoursAgo: 50 },
    { host_key: '.youtube.com', name: 'PREF', hoursAgo: 50 },
    { host_key: '.yahoo.com', name: 'B', hoursAgo: 50 },
    { host_key: '.amazon.com', name: 'session-id', hoursAgo: 50 },
    { host_key: '.cloudflare.com', name: 'cf_clearance', hoursAgo: 50 },
  ];

  const { tmpDir } = createMockProfile(t, {
    cookies,
    cacheSizeBytes: 7 * 1024 * 1024,
    hasStorage: true,
  });

  const report = evaluateProfileWarmth(tmpDir, { id: 'test-mature' });

  assert.equal(report.profileId, 'test-mature');
  assert.equal(report.verdict, 'MATURE');
  assert.equal(report.score, 100);
  assert.deepEqual(report.actionsPermitted, [
    'CREATE_ACCOUNT_RESIDENTIAL_4G',
    'ENABLE_2FA_TOTP',
    'ASSIGN_RECOVERY_EMAIL',
    'MIGRATE_SESSION',
    'PROD_FARM_AUTOMATION',
  ]);
  assert.equal(report.breakdown.soakAge.score, 30);
  assert.equal(report.breakdown.entropy.score, 25);
  assert.equal(report.breakdown.telemetry.score, 30);
  assert.equal(report.breakdown.footprint.score, 15);
});

test('evaluateProfileWarmth: resolves Network/Cookies path and custom profileDir', (t) => {
  const cookies = [
    { host_key: '.google.com', name: 'NID', hoursAgo: 2 },
    { host_key: '.reddit.com', name: 'token', hoursAgo: 2 },
  ];

  const { tmpDir } = createMockProfile(t, {
    profileDir: 'Profile 1',
    useNetworkDir: true,
    cookies,
    cacheSizeBytes: 1024,
    hasStorage: true,
  });

  const report = evaluateProfileWarmth(tmpDir, {
    id: 'custom-subprofile',
    profileDir: 'Profile 1',
  });

  assert.equal(report.profileId, 'custom-subprofile');
  assert.ok(report.thirdPartyCookiesCount >= 1);
  assert.ok(report.googleTokens.includes('NID'));
  assert.ok(report.breakdown.footprint.hasStorage);
});

test('evaluateProfileWarmth: evaluates real profile gmail-mobi-warmed if present', () => {
  const mobiDir = path.join(os.homedir(), '.webmcp', 'managed-profiles', 'gmail-mobi-warmed');
  if (!fs.existsSync(mobiDir)) {
    return;
  }

  const report = evaluateProfileWarmth(mobiDir, { id: 'gmail-mobi-warmed' });

  assert.equal(report.profileId, 'gmail-mobi-warmed');
  assert.ok(['SOAKED', 'MATURE'].includes(report.verdict), `Expected SOAKED or MATURE, got ${report.verdict}`);
  assert.ok(report.score >= 70, `Score expected >= 70, got ${report.score}`);
  assert.ok(report.soakAgeHours > 0);
  assert.ok(report.thirdPartyCookiesCount >= 10);
  assert.ok(report.thirdPartyDomains.length >= 3);
  assert.ok(report.googleTokens.includes('AEC') || report.googleTokens.includes('NID'));
  assert.ok(report.actionsPermitted.includes('CREATE_ACCOUNT_RESIDENTIAL_4G'));
  assert.ok(report.actionsPermitted.includes('ENABLE_2FA_TOTP'));
  assert.ok(report.actionsPermitted.includes('ASSIGN_RECOVERY_EMAIL'));
  assert.ok(report.cacheSizeBytes > 0);
});

test('evaluateProfileWarmth: evaluates real profile gmail-vnmobile-warmed if present', () => {
  const vnmDir = path.join(os.homedir(), '.webmcp', 'managed-profiles', 'gmail-vnmobile-warmed');
  if (!fs.existsSync(vnmDir)) {
    return;
  }

  const report = evaluateProfileWarmth(vnmDir, { id: 'gmail-vnmobile-warmed' });

  assert.equal(report.profileId, 'gmail-vnmobile-warmed');
  assert.ok(['SOAKED', 'MATURE'].includes(report.verdict), `Expected SOAKED or MATURE, got ${report.verdict}`);
  assert.ok(report.score >= 70, `Score expected >= 70, got ${report.score}`);
  assert.ok(report.soakAgeHours > 0);
  assert.ok(report.thirdPartyCookiesCount >= 50);
  assert.ok(report.thirdPartyDomains.length >= 10);
  assert.ok(report.actionsPermitted.length >= 3);
  assert.ok(report.cacheSizeBytes > 0);
});

test('CLI webmcp profiles warmth runs and outputs formatted text and JSON', () => {
  const root = path.resolve(import.meta.dirname, '../../bin/webmcp-browser.mjs');

  // JSON output test on real existing profile
  const outJson = execFileSync(
    process.execPath,
    [root, 'profiles', 'warmth', 'gmail-mobi-warmed', '--json'],
    { encoding: 'utf8' }
  );
  const parsed = JSON.parse(outJson);
  assert.equal(parsed.profileId, 'managed:gmail-mobi-warmed');
  assert.equal(parsed.verdict, 'SOAKED');
  assert.ok(parsed.score >= 70 && parsed.score <= 89);
  assert.ok(parsed.thirdPartyDomains.length >= 3);
  assert.ok(parsed.actionsPermitted.includes('CREATE_ACCOUNT_RESIDENTIAL_4G'));

  // Formatted human-readable output test
  const outText = execFileSync(
    process.execPath,
    [root, 'profiles', 'warmth', 'gmail-mobi-warmed'],
    { encoding: 'utf8' }
  );
  assert.match(outText, /\[SOAKED\] Profile Warmth:/);
  assert.match(outText, /Score:\s+85\/100/);
  assert.match(outText, /Actions Permitted:/);
  assert.match(outText, /✅ CREATE_ACCOUNT_RESIDENTIAL_4G/);
});

