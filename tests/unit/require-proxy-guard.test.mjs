import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const launcher = require('../../chrome-launcher/launcher.js');

function makeFixture(t, meta = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-require-proxy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const managedProfilesDir = path.join(root, 'managed-profiles');
  const userDataDir = path.join(managedProfilesDir, 'acc-1');
  const extensionPath = path.join(root, 'ext');
  const sessionsFile = path.join(root, 'sessions.json');
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  fs.mkdirSync(extensionPath, { recursive: true });
  fs.writeFileSync(
    path.join(extensionPath, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'Test', version: '1.0' }),
  );
  fs.writeFileSync(path.join(userDataDir, '.webmcp-meta.json'), JSON.stringify(meta));
  return { managedProfilesDir, userDataDir, extensionPath, sessionsFile };
}

test('launchChrome blocks unbound or direct-mode managed profiles with ERR_PROXY_UNBOUND_BLOCKED when requireProxy is set', async (t) => {
  const fNoProxy = makeFixture(t, { name: 'unbound-acc' });
  await assert.rejects(
    () => launcher.launchChrome({
      mode: 'managed',
      profile: { kind: 'managed', userDataDir: fNoProxy.userDataDir },
      chromePath: process.execPath,
      extensionPath: fNoProxy.extensionPath,
      managedProfilesDir: fNoProxy.managedProfilesDir,
      sessionsFile: fNoProxy.sessionsFile,
      requireProxy: true,
      dryRun: true,
    }),
    (err) => {
      assert.equal(err.code, 'ERR_PROXY_UNBOUND_BLOCKED');
      return true;
    },
  );

  const fDirect = makeFixture(t, { name: 'direct-acc', requireProxy: true, proxy: { mode: 'direct' } });
  await assert.rejects(
    () => launcher.launchChrome({
      mode: 'managed',
      profile: { kind: 'managed', userDataDir: fDirect.userDataDir },
      chromePath: process.execPath,
      extensionPath: fDirect.extensionPath,
      managedProfilesDir: fDirect.managedProfilesDir,
      sessionsFile: fDirect.sessionsFile,
      dryRun: true,
    }),
    (err) => {
      assert.equal(err.code, 'ERR_PROXY_UNBOUND_BLOCKED');
      return true;
    },
  );

  const fBound = makeFixture(t, { name: 'bound-acc', proxy: { url: 'socks5://10.0.0.2:1080' } });
  const okRes = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: fBound.userDataDir },
    chromePath: process.execPath,
    extensionPath: fBound.extensionPath,
    managedProfilesDir: fBound.managedProfilesDir,
    sessionsFile: fBound.sessionsFile,
    requireProxy: true,
    dryRun: true,
  });
  assert.equal(okRes.ok, true);
  assert.ok(okRes.args.includes('--proxy-server=socks5://10.0.0.2:1080'));
  assert.ok(okRes.args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
});
