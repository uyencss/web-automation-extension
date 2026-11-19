import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = require(path.join(ROOT, 'chrome-launcher', 'launcher'));
const profileFork = require(path.join(ROOT, 'chrome-launcher', 'profile-fork'));

function makeTempDir(prefix = 'webmcp-ondevice-ai-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeExtension(root) {
  const dir = path.join(root, 'fake-ext');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"manifest_version":3,"name":"Test","version":"1.0"}');
  return dir;
}

function seedBloat(userDataDir, profileDir = 'Default') {
  fs.mkdirSync(path.join(userDataDir, 'OptGuideOnDeviceModel', '2025.8.8.1141'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'OptGuideOnDeviceModel', '2025.8.8.1141', 'weights.bin'), 'weights');
  fs.mkdirSync(path.join(userDataDir, 'OptGuideOnDeviceClassifierModel'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'OptGuideOnDeviceClassifierModel', 'cls.bin'), 'cls');
  fs.mkdirSync(path.join(userDataDir, 'download_cache'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'download_cache', '912795F3'), 'crx');
  fs.mkdirSync(path.join(userDataDir, 'optimization_guide_model_store'), { recursive: true });
  fs.mkdirSync(path.join(userDataDir, profileDir, 'optimization_guide_model_store'), { recursive: true });
  fs.mkdirSync(path.join(userDataDir, 'component_crx_cache'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'component_crx_cache', 'small-widevine'), 'tiny');
  const bigCrx = path.join(userDataDir, 'component_crx_cache', 'big-nano.crx3');
  fs.writeFileSync(bigCrx, 'big-crx-payload-over-threshold');
  return bigCrx;
}

test('default-off On-Device AI shield: launchChrome blocks features, writes Local State policy, and purges bloat unless allowOnDeviceAi=true', async (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const managedDir = path.join(root, 'managed-profiles');
  const extensionPath = makeFakeExtension(root);
  const sessionsFile = path.join(root, 'sessions.json');
  const fakeChrome = path.join(root, 'fake-chrome.sh');
  fs.writeFileSync(fakeChrome, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  // 1. Default Managed profile (no allowOnDeviceAi flag)
  const pDefault = path.join(managedDir, 'giaphaviet0');
  fs.mkdirSync(path.join(pDefault, 'Profile 2'), { recursive: true });
  fs.writeFileSync(path.join(pDefault, '.webmcp-meta.json'), JSON.stringify({ name: 'giaphaviet0', profileDir: 'Profile 2' }));
  fs.writeFileSync(path.join(pDefault, 'Local State'), JSON.stringify({
    optimization_guide: {
      on_device: { last_version: '158.0.0.0' },
      model_execution: { manifest_asset_ledger: { k: 'v' }, last_usage_by_feature: { f: 1 } },
    },
    profile: { info_cache: { 'Profile 2': { name: 'giaphaviet0' } } },
  }));
  seedBloat(pDefault, 'Profile 2');

  const dryDefault = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: pDefault, profileDir: 'Profile 2' },
    managedProfilesDir: managedDir,
    chromePath: fakeChrome,
    extensionPath,
    sessionsFile,
    dryRun: true,
  });
  const disableArg = dryDefault.args.find((a) => a.startsWith('--disable-features='));
  assert.ok(disableArg, 'default managed launch must pass --disable-features');
  for (const feat of launcher.ON_DEVICE_AI_DISABLED_FEATURES) {
    assert.ok(disableArg.includes(feat), `default --disable-features must include ${feat}`);
  }

  // Test purge with explicit smaller CRX threshold + real non-dryRun launch via process.execPath
  profileFork.purgeOnDeviceAiBloat(pDefault, 'Profile 2', { largeCrxThresholdBytes: 10 });
  assert.equal(fs.existsSync(path.join(pDefault, 'OptGuideOnDeviceModel')), false);
  assert.equal(fs.existsSync(path.join(pDefault, 'OptGuideOnDeviceClassifierModel')), false);
  assert.equal(fs.existsSync(path.join(pDefault, 'download_cache')), false);
  assert.equal(fs.existsSync(path.join(pDefault, 'optimization_guide_model_store')), false);
  assert.equal(fs.existsSync(path.join(pDefault, 'Profile 2', 'optimization_guide_model_store')), false);
  assert.equal(fs.existsSync(path.join(pDefault, 'component_crx_cache', 'big-nano.crx3')), false);
  assert.equal(fs.existsSync(path.join(pDefault, 'component_crx_cache', 'small-widevine')), true);

  seedBloat(pDefault, 'Profile 2');
  await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: pDefault, profileDir: 'Profile 2' },
    managedProfilesDir: managedDir,
    chromePath: process.execPath,
    extensionPath,
    sessionsFile,
    extraArgs: ['-e', 'process.exit(0)'],
  });
  assert.equal(fs.existsSync(path.join(pDefault, 'OptGuideOnDeviceModel')), false);
  assert.equal(fs.existsSync(path.join(pDefault, 'download_cache')), false);
  const lsDefault = JSON.parse(fs.readFileSync(path.join(pDefault, 'Local State'), 'utf8'));
  assert.equal(lsDefault.optimization_guide.gen_ai_local_foundational_model_settings, 1);
  assert.equal(lsDefault.optimization_guide.model_execution.genai_local_foundational_model_settings, 1);
  assert.equal(lsDefault.optimization_guide.on_device, undefined);
  assert.equal(lsDefault.optimization_guide.model_execution.manifest_asset_ledger, undefined);
  assert.ok(lsDefault.browser.enabled_labs_experiments.includes('optimization-guide-on-device-model@2'));

  // 2. Opt-in Managed profile (allowOnDeviceAi: true, e.g. hieu2906090)
  const pOptIn = path.join(managedDir, 'hieu2906090');
  fs.mkdirSync(path.join(pOptIn, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(pOptIn, '.webmcp-meta.json'), JSON.stringify({
    name: 'hieu2906090',
    profileDir: 'Default',
    allowOnDeviceAi: true,
  }));
  fs.writeFileSync(path.join(pOptIn, 'Local State'), JSON.stringify({
    optimization_guide: {
      gen_ai_local_foundational_model_settings: 1,
      model_execution: { genai_local_foundational_model_settings: 1 },
    },
    browser: { enabled_labs_experiments: ['optimization-guide-on-device-model@2', 'other-flag@1'] },
    profile: { info_cache: { Default: { name: 'hieu2906090' } } },
  }));
  seedBloat(pOptIn, 'Default');

  await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: pOptIn, profileDir: 'Default' },
    managedProfilesDir: managedDir,
    chromePath: process.execPath,
    extensionPath,
    sessionsFile,
    extraArgs: ['-e', 'process.exit(0)'],
  });
  const optInArgs = launcher.buildManagedShieldArgs({ allowOnDeviceAi: true });
  const optInDisable = optInArgs.find((a) => a.startsWith('--disable-features='));
  assert.ok(optInDisable.includes('DeviceBoundSessions'), 'opt-in must still keep DBSC shield flags');
  for (const feat of launcher.ON_DEVICE_AI_DISABLED_FEATURES) {
    assert.equal(optInDisable.includes(feat), false, `opt-in must NOT disable ${feat}`);
  }
  assert.equal(fs.existsSync(path.join(pOptIn, 'OptGuideOnDeviceModel', '2025.8.8.1141', 'weights.bin')), true);
  const lsOptIn = JSON.parse(fs.readFileSync(path.join(pOptIn, 'Local State'), 'utf8'));
  assert.equal(lsOptIn.optimization_guide.gen_ai_local_foundational_model_settings, undefined);
  assert.equal(lsOptIn.optimization_guide.model_execution.genai_local_foundational_model_settings, undefined);
  assert.deepEqual(lsOptIn.browser.enabled_labs_experiments, ['other-flag@1']);
});

test('CACHE_RE and purgeOnDeviceAiBloat lock safety', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const rel of [
    'OptGuideOnDeviceModel/2025/weights.bin',
    'download_cache/912795F3',
    'optimization_guide_model_store/1',
    'component_crx_cache/abc',
    'WasmTtsEngine/model',
    'screen_ai/lib',
  ]) {
    assert.equal(profileFork.CACHE_RE.test(rel), true, `CACHE_RE must exclude ${rel}`);
  }
  assert.equal(profileFork.CACHE_RE.test('Network/Cookies'), false);

  const lockedDir = path.join(root, 'running-prof');
  seedBloat(lockedDir, 'Default');
  fs.symlinkSync(`localhost-${process.pid}`, path.join(lockedDir, 'SingletonLock'));
  const res = profileFork.purgeOnDeviceAiBloat(lockedDir, 'Default');
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'PROFILE_IN_USE');
  assert.equal(fs.existsSync(path.join(lockedDir, 'OptGuideOnDeviceModel', '2025.8.8.1141', 'weights.bin')), true);
});
