import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  requireMacGuiDomain,
  installAndBootstrapLaunchAgent,
  uninstallLaunchAgent,
} from '../../lib/launchd-helper.mjs';

test('requireMacGuiDomain fails loudly with MACOS_NO_GUI_SESSION when gui/$uid is absent', () => {
  assert.throws(
    () => requireMacGuiDomain(501, {
      spawnSyncFn: () => ({ status: 1, stderr: 'Could not find domain for' }),
    }),
    (err) => err.code === 'MACOS_NO_GUI_SESSION' && err.domain === 'gui/501',
  );
  assert.equal(
    requireMacGuiDomain(501, { spawnSyncFn: () => ({ status: 0 }) }),
    'gui/501',
  );
});

test('installAndBootstrapLaunchAgent checks GUI BEFORE mutating plist, blocks self-bootout, cleans legacy user/$uid, and rolls back on bootstrap failure', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-helper-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const plistPath = path.join(tmp, 'io.webmcp-test.plist');
  fs.writeFileSync(plistPath, '<plist>OLD</plist>', 'utf8');

  // 1. No GUI session -> must NOT overwrite existing plist!
  assert.throws(
    () => installAndBootstrapLaunchAgent({
      label: 'io.webmcp-test',
      plistPath,
      plistContent: '<plist>NEW</plist>',
      uid: 501,
      deps: {
        forceDarwin: true,
        spawnSync: () => ({ status: 1, stderr: 'No GUI' }),
      },
    }),
    (err) => err.code === 'MACOS_NO_GUI_SESSION',
  );
  assert.equal(fs.readFileSync(plistPath, 'utf8'), '<plist>OLD</plist>');

  // 2. Self-bootout protection
  assert.throws(
    () => installAndBootstrapLaunchAgent({
      label: 'io.webmcp-test',
      plistPath,
      plistContent: '<plist>NEW</plist>',
      uid: 501,
      env: { XPC_SERVICE_NAME: 'io.webmcp-test' },
      deps: {
        forceDarwin: true,
        spawnSync: () => ({ status: 0 }),
      },
    }),
    (err) => err.code === 'ERR_LAUNCHD_SELF_BOOTOUT',
  );
  assert.equal(fs.readFileSync(plistPath, 'utf8'), '<plist>OLD</plist>');

  // 3. Rollback on bootstrap failure after cleaning user/$uid and bootout
  const calls = [];
  let printedTargetOnce = false;
  assert.throws(
    () => installAndBootstrapLaunchAgent({
      label: 'io.webmcp-test',
      plistPath,
      plistContent: '<plist>NEW</plist>',
      uid: 501,
      env: {},
      deps: {
        forceDarwin: true,
        sleepSync: () => {},
        spawnSync: (_bin, args) => {
          calls.push(args);
          if (args[0] === 'print' && args[1] === 'gui/501') return { status: 0 };
          if (args[0] === 'print' && args[1] === 'gui/501/io.webmcp-test') {
            if (!printedTargetOnce) { printedTargetOnce = true; return { status: 1 }; }
          }
          if (args[0] === 'bootstrap') return { status: 5, stderr: 'Bootstrap failed: 5' };
          return { status: 0 };
        },
      },
    }),
    (err) => err.code === 'ERR_LAUNCHD_BOOTSTRAP_FAILED',
  );
  assert.equal(fs.readFileSync(plistPath, 'utf8'), '<plist>OLD</plist>', 'must roll back plist on bootstrap failure');
  assert.ok(calls.some((a) => a[0] === 'bootout' && a[1] === 'user/501/io.webmcp-test'));
  assert.ok(calls.some((a) => a[0] === 'enable' && a[1] === 'gui/501/io.webmcp-test'));

  // 4. Uninstall fails cleanly if gui/$uid missing, succeeds otherwise
  assert.throws(
    () => uninstallLaunchAgent({
      label: 'io.webmcp-test',
      plistPath,
      uid: 501,
      deps: { forceDarwin: true, spawnSync: () => ({ status: 1 }) },
    }),
    (err) => err.code === 'MACOS_NO_GUI_SESSION',
  );
});
