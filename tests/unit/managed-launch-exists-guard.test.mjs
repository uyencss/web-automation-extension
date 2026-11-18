import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const launcher = require('../../chrome-launcher/launcher.js');

test('launchChrome throws MANAGED_PROFILE_DIR_NOT_FOUND when managed profile userDataDir is missing and does not recreate it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-managed-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const managedProfilesDir = path.join(root, 'managed-profiles');
  const extensionPath = path.join(root, 'ext');
  fs.mkdirSync(managedProfilesDir, { recursive: true });
  fs.mkdirSync(extensionPath, { recursive: true });
  fs.writeFileSync(path.join(extensionPath, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Test', version: '1.0' }));

  const missingInsideRoot = path.join(managedProfilesDir, 'renamed-away-profile');

  await assert.rejects(
    async () => {
      await launcher.launchChrome({
        mode: 'managed',
        profile: { kind: 'managed', userDataDir: missingInsideRoot },
        chromePath: process.execPath,
        extensionPath,
        managedProfilesDir,
        dryRun: false,
      });
    },
    (err) => {
      assert.equal(err.code, 'MANAGED_PROFILE_DIR_NOT_FOUND');
      return true;
    },
  );
  assert.equal(fs.existsSync(missingInsideRoot), false, 'Must never recreate missing managed directory on disk');

  const dryRes = await launcher.launchChrome({
    mode: 'managed',
    profile: { kind: 'managed', userDataDir: missingInsideRoot },
    chromePath: process.execPath,
    extensionPath,
    managedProfilesDir,
    dryRun: true,
  });
  assert.equal(dryRes.ok, true);
});
