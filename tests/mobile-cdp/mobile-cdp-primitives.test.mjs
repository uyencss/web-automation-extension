import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createMobileSession } from '../../webmcp-mobile-cdp/session.mjs';
import { ensureIsolatedWorld, getSnapshot, resolveRef, isolatedWorlds, bindSessionEvents } from '../../webmcp-mobile-cdp/aria.mjs';
import { tap, scroll, swipe, key, type, screenshot, cookies, emulation, upload, evalInMain } from '../../webmcp-mobile-cdp/primitives.mjs';
import { CATALOG_MAP } from '../../webmcp-mobile-cdp/catalog-map.mjs';
import { dispatchCommand, connectGateway } from '../../webmcp-mobile-cdp/dispatch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');

function createMockTransportSession(customHandler) {
  const sent = [];
  let onMsg = null;
  const session = createMobileSession({
    transport: {
      send: (payload, handleMsg) => {
        sent.push(payload);
        onMsg = handleMsg;
        setTimeout(() => {
          if (customHandler) {
            const customRes = customHandler(payload);
            if (customRes !== undefined) return handleMsg({ id: payload.id, ...customRes });
          }
          if (payload.method === 'Target.createTarget') {
            handleMsg({ id: payload.id, result: { targetId: 'target-1' } });
            handleMsg({
              method: 'Target.attachedToTarget',
              params: { targetInfo: { targetId: 'target-1', type: 'page' }, sessionId: 'session-1' }
            });
          } else if (payload.method === 'Target.closeTarget') {
            handleMsg({ id: payload.id, result: { success: true } });
          } else if (payload.method === 'Target.activateTarget') {
            handleMsg({ id: payload.id, result: { success: true } });
          } else if (payload.method === 'Target.getTargets') {
            handleMsg({
              id: payload.id,
              result: { targetInfos: [{ targetId: 'target-1', type: 'page', url: 'https://example.com', title: 'Example' }] }
            });
          } else if (payload.method === 'Page.createIsolatedWorld') {
            handleMsg({ id: payload.id, result: { executionContextId: 101 } });
          } else if (payload.method === 'Page.getFrameTree') {
            handleMsg({
              id: payload.id,
              result: {
                frameTree: {
                  frame: { id: 'root-frame', url: 'https://example.com' },
                  childFrames: [
                    { frame: { id: 'child-frame-1', parentId: 'root-frame', url: 'https://iframe.com' } }
                  ]
                }
              }
            });
          } else if (payload.method === 'Runtime.evaluate') {
            let val = true;
            const expr = payload.params?.expression || '';
            if (expr.includes('visualViewport?.scale')) val = 1.0;
            else if (expr.includes('runRefAction')) {
              val = { success: true, pointX: 100, pointY: 150, hit: true, bounds: { x: 80, y: 130, width: 40, height: 40 } };
            } else if (expr.includes('buildSnapshot')) {
              val = 'snapshot tree';
            } else if (expr.includes("querySelectorAll('iframe, frame')")) {
              val = { left: 25, top: 45 };
            } else if (expr.includes('document.querySelector')) {
              val = { x: 120, y: 84 };
            }
            handleMsg({ id: payload.id, result: { result: { value: val } } });
          } else if (payload.method === 'Page.captureScreenshot') {
            handleMsg({ id: payload.id, result: { data: 'dGVzdC1zY3JlZW5zaG90' } });
          } else if (payload.method === 'Network.getCookies') {
            handleMsg({ id: payload.id, result: { cookies: [{ name: 'sid', value: '123' }] } });
          } else if (payload.method === 'DOM.getDocument') {
            handleMsg({ id: payload.id, result: { root: { nodeId: 1 } } });
          } else if (payload.method === 'DOM.querySelector') {
            handleMsg({ id: payload.id, result: { nodeId: 2 } });
          } else {
            handleMsg({ id: payload.id, result: { success: true } });
          }
        }, 0);
      }
    }
  });
  session.triggerEvent = evt => onMsg && onMsg(evt);
  return { session, sent };
}

test('DoD-E4: aria-snapshot.js runs in IsolatedWorld without chrome.runtime', () => {
  const ariaPath = path.join(ROOT_DIR, 'webmcp-extension/dist/content-scripts/aria-snapshot.js');
  const code = fs.readFileSync(ariaPath, 'utf8');

  // Verify guard at line 736
  assert.match(code, /if\s*\(typeof chrome !== 'undefined' && chrome\?\.runtime\?\.onMessage\?\.addListener\)/);

  // Run in a bare sandbox without chrome object
  const sandbox = {
    window: {},
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { innerText: '' },
      documentElement: { outerHTML: '<html></html>' }
    },
    console
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;

  assert.doesNotThrow(() => {
    vm.runInNewContext(code, sandbox);
  });

  assert.ok(sandbox.window.__WEBMCP_FAST_ARIA_API__, '__WEBMCP_FAST_ARIA_API__ must be exported on window');
  assert.equal(typeof sandbox.window.__WEBMCP_FAST_ARIA_API__.buildSnapshot, 'function');
  assert.equal(typeof sandbox.window.__WEBMCP_FAST_ARIA_API__.runRefAction, 'function');
  assert.equal(typeof sandbox.window.__WEBMCP_FAST_ARIA_API__.resolveRef, 'function');
});

test('DoD-LOC & Invariants: Total lines <= 500 and zero /json/new in codebase', () => {
  const cdpDir = path.join(ROOT_DIR, 'webmcp-mobile-cdp');
  const files = ['session.mjs', 'aria.mjs', 'primitives.mjs', 'catalog-map.mjs', 'dispatch.mjs', 'index.mjs'];
  let totalLines = 0;

  for (const f of files) {
    const filePath = path.join(cdpDir, f);
    assert.ok(fs.existsSync(filePath), `File ${f} must exist`);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').length;
    totalLines += lines;
    assert.ok(!content.includes('/json/new'), `File ${f} must have ZERO occurrences of /json/new`);
  }

  assert.ok(totalLines <= 500, `Total LOC of all ${files.length} files (${totalLines}) must be <= 500 lines`);
});

test('DoD-E1 & LMK: session.mjs tab lifecycle, single Browser WS and auto-recovery', async () => {
  const { session, sent } = createMockTransportSession();
  await session.init();

  // Create Tab
  const newTabRes = await session.createTab('https://example.com/test');
  assert.equal(newTabRes.targetId, 'target-1');
  assert.equal(session.activeTargetId, 'target-1');
  assert.equal(session.getSessionId('target-1'), 'session-1');

  // Activate Tab
  await session.activateTab('target-1');
  const actCall = sent.find(s => s.method === 'Target.activateTarget');
  assert.ok(actCall);
  assert.equal(actCall.params.targetId, 'target-1');

  // List Tabs
  const tabs = await session.listTabs();
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, 'target-1');
  assert.equal(tabs[0].active, true);

  // Console log buffering
  session.triggerEvent({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'log', args: [{ value: 'hello mobile' }] },
    sessionId: 'session-1'
  });
  const logs = session.consoleLogs.get('target-1');
  assert.ok(logs && logs.length === 1);
  assert.equal(logs[0].args[0].value, 'hello mobile');

  // LMK Crash/Destroy recovery
  session.triggerEvent({
    method: 'Target.targetCrashed',
    params: { targetId: 'target-1', status: 'crashed', errorCode: 1 }
  });
  assert.equal(session.sessions.has('target-1'), false, 'Crashed target must be removed from sessions pool');
  assert.equal(session.sessions.has('session-1'), false, 'Crashed sessionId must be removed');

  // Verify session.on('Target.attachedToTarget', ...) and session.off(...)
  let attachedPayload = null;
  const offListener = session.on('Target.attachedToTarget', (params) => {
    attachedPayload = params;
  });
  session.triggerEvent({
    method: 'Target.attachedToTarget',
    params: { targetInfo: { targetId: 'target-test', type: 'page' }, sessionId: 'session-test' }
  });
  assert.ok(attachedPayload, 'session.on must catch Target.attachedToTarget');
  assert.equal(attachedPayload.sessionId, 'session-test');
  assert.equal(attachedPayload.targetInfo.targetId, 'target-test');

  attachedPayload = null;
  offListener();
  session.triggerEvent({
    method: 'Target.attachedToTarget',
    params: { targetInfo: { targetId: 'target-test2', type: 'page' }, sessionId: 'session-test2' }
  });
  assert.equal(attachedPayload, null, 'session.off must unsubscribe listener');
});

test('DoD-META: .webmcp-mobile-meta.json merges ports[serial].localPort schema', async () => {
  const os = await import('node:os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-meta-test-'));
  const metaPath = path.join(tempDir, '.webmcp-mobile-meta.json');
  try {
    fs.writeFileSync(metaPath, JSON.stringify({
      version: 1,
      profiles: { 'pre-existing': { vendor: 'xiaomi' } },
      ports: {
        'existing-serial': {
          localPort: 9222,
          profileId: 'prof-old',
          targetPackage: 'com.android.chrome',
          updatedAt: new Date().toISOString()
        }
      }
    }));

    const mockAdbExec = () => Buffer.from('9225\n');
    const s = createMobileSession({
      serial: 'reup-xm13',
      metaDir: tempDir,
      profileId: 'xm13-p1',
      targetPackage: 'com.chrome.beta',
      adbExec: mockAdbExec,
      fetchFn: async () => { throw new Error('stop before ws'); }
    });
    try { await s.init(); } catch {}

    const metaAfter = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(metaAfter.version, 1);
    assert.ok(metaAfter.profiles['pre-existing']);
    assert.equal(metaAfter.ports['existing-serial'].localPort, 9222);
    assert.equal(metaAfter.ports['reup-xm13'].localPort, 9225);
    assert.equal(metaAfter.ports['reup-xm13'].profileId, 'xm13-p1');
    assert.equal(metaAfter.ports['reup-xm13'].targetPackage, 'com.chrome.beta');
    assert.equal(metaAfter.serial, 'reup-xm13');
    assert.equal(metaAfter.port, 9225);
    assert.ok(metaAfter.updatedAt);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('DoD-E4 & Iframe: aria.mjs IsolatedWorld cache and iframe offset normalization', async () => {
  const { session } = createMockTransportSession();
  isolatedWorlds.clear();

  // Root ref resolve
  session.sessions.set('target-1', 'session-1');
  session.activeTargetId = 'target-1';
  const rootRes = await resolveRef(session, 'session-1', 'r1');
  assert.equal(rootRes.success, true);
  assert.equal(rootRes.pointX, 100);
  assert.equal(rootRes.pointY, 150);

  // Verify IsolatedWorld cache exists
  assert.ok(isolatedWorlds.size > 0);

  // Frame navigated clears isolated worlds
  session.triggerEvent({ method: 'Page.frameNavigated', sessionId: 'session-1', params: {} });
  assert.equal(isolatedWorlds.size, 0, 'IsolatedWorld cache must be cleared on Page.frameNavigated');

  // Iframe ref resolve (e.g. f1r2) - must add iframe offset (left: 25, top: 45)
  const iframeRes = await resolveRef(session, 'session-1', 'f1r2');
  assert.equal(iframeRes.success, true);
  assert.equal(iframeRes.pointX, 100 + 25, 'pointX must include iframe left offset');
  assert.equal(iframeRes.pointY, 150 + 45, 'pointY must include iframe top offset');
  assert.equal(iframeRes.bounds.x, 80 + 25, 'bounds.x must include iframe left offset');
  assert.equal(iframeRes.bounds.y, 130 + 45, 'bounds.y must include iframe top offset');
});

test('DoD-E2, E3, E5, E6: primitives.mjs tap, scroll, type, key, screenshot, upload', async () => {
  let warnedPinch = false;
  const origWarn = console.warn;
  console.warn = (...args) => {
    if (args.join(' ').includes('visualViewport.scale !== 1')) warnedPinch = true;
    origWarn(...args);
  };

  try {
    const { session, sent } = createMockTransportSession(payload => {
      if (payload.params?.expression?.includes('visualViewport?.scale')) {
        return { result: { result: { value: 1.5 } } }; // scale !== 1 to trigger pinch-zoom guard
      }
    });

    // 1. tap with pinch-zoom guard & Input.synthesizeTapGesture (E2)
    const tapRes = await tap(session, 'session-1', 120.4, 84.6, { clickCount: 1 });
    assert.equal(tapRes.success, true);
    assert.equal(tapRes.x, 120);
    assert.equal(tapRes.y, 85);
    assert.ok(warnedPinch, 'Pinch-zoom warning should be emitted when scale !== 1');
    const tapCall = sent.find(s => s.method === 'Input.synthesizeTapGesture');
    assert.ok(tapCall);
    assert.equal(tapCall.params.gestureSourceType, 'touch');

    // 2. scroll default (momentum synthesizeScrollGesture E3)
    await scroll(session, 'session-1', { x: 200, y: 500, deltaX: 0, deltaY: 400 });
    const scrollCall = sent.find(s => s.method === 'Input.synthesizeScrollGesture');
    assert.ok(scrollCall);
    assert.equal(scrollCall.params.gestureSourceType, 'touch');
    assert.equal(scrollCall.params.yDistance, -400);

    // 3. scroll exact (touchStart -> touchMove*6 -> touchEnd)
    sent.length = 0;
    await scroll(session, 'session-1', { x: 200, y: 500, deltaX: 0, deltaY: 300, exact: true });
    const touchEvents = sent.filter(s => s.method === 'Input.dispatchTouchEvent');
    assert.equal(touchEvents.length, 8); // 1 start + 6 moves + 1 end
    assert.equal(touchEvents[0].params.type, 'touchStart');
    assert.equal(touchEvents[7].params.type, 'touchEnd');

    // 4. swipe
    sent.length = 0;
    await swipe(session, 'session-1', 100, 100, 100, 400, 4);
    const swipeEvents = sent.filter(s => s.method === 'Input.dispatchTouchEvent');
    assert.equal(swipeEvents.length, 6); // 1 start + 4 moves + 1 end

    // 5. type Unicode Vietnamese & Enter key (E6)
    sent.length = 0;
    await type(session, 'session-1', 'Xin chào Xiaomi 13 🇻🇳', { submit: true });
    const textCall = sent.find(s => s.method === 'Input.insertText');
    assert.ok(textCall);
    assert.equal(textCall.params.text, 'Xin chào Xiaomi 13 🇻🇳');
    const enterCalls = sent.filter(s => s.method === 'Input.dispatchKeyEvent' && s.params.windowsVirtualKeyCode === 13);
    assert.equal(enterCalls.length, 2); // rawKeyDown + keyUp

    // 6. key Backspace
    sent.length = 0;
    await key(session, 'session-1', 'Backspace');
    const bsCalls = sent.filter(s => s.method === 'Input.dispatchKeyEvent' && s.params.windowsVirtualKeyCode === 8);
    assert.equal(bsCalls.length, 2);

    // 7. screenshot
    const ss = await screenshot(session, 'session-1', { fullPage: true });
    assert.equal(ss.data, 'dGVzdC1zY3JlZW5zaG90');

    // 8. cookies
    const cRes = await cookies(session, 'session-1', 'get', { urls: ['https://example.com'] });
    assert.equal(cRes.cookies[0].name, 'sid');

    // 9. upload with adb push + DOM.setFileInputFiles + cleanup (E5)
    const adbCommands = [];
    session.adbExec = (cmd, args) => {
      adbCommands.push({ cmd, args });
      return Buffer.from('');
    };
    session.serial = 'reup-xm13';
    const upRes = await upload(session, 'session-1', 'input[type=file]', '/tmp/my-image.png');
    assert.equal(upRes.success, true);
    assert.ok(adbCommands.some(c => c.args.includes('push') && c.args.includes('/tmp/my-image.png')));
    assert.ok(adbCommands.some(c => c.args.includes('rm') && c.args.includes('-f')));
  } finally {
    console.warn = origWarn;
  }
});

test('DoD-CATALOG: CATALOG_MAP contains all 67+ commands and dispatch handles batch', async () => {
  const { session } = createMockTransportSession();
  session.sessions.set('target-1', 'session-1');
  session.activeTargetId = 'target-1';

  // Check 67 commands count
  const commandKeys = Object.keys(CATALOG_MAP);
  assert.ok(commandKeys.length >= 67, `CATALOG_MAP should contain at least 67 commands, found ${commandKeys.length}`);

  // Ping
  const pingRes = await dispatchCommand(session, 'ping');
  assert.equal(pingRes.ok, true);

  // Dispatch clickByRef
  const clickRes = await dispatchCommand(session, 'clickByRef', { ref: 'r1' });
  assert.equal(clickRes.success, true);

  // Batch execution
  const batchRes = await dispatchCommand(session, 'batch', {
    actions: [
      { method: 'ping' },
      { method: 'dispatchClick', params: { x: 50, y: 50 } },
      { method: 'pressKey', params: { key: 'Enter' } }
    ],
    screenshotAfter: true
  });

  assert.equal(batchRes.total, 3);
  assert.equal(batchRes.executed, 3);
  assert.equal(batchRes.success, true);
  assert.equal(batchRes.results.length, 3);
  assert.equal(batchRes.results[0].ok, true);
  assert.equal(batchRes.results[0].screenshot, 'dGVzdC1zY3JlZW5zaG90');
});

test('DoD-STEALTH: createMobileSession integrates @webmcp/fingerprint-kit/mobile and fails closed on error', async () => {
  const sent = [];
  const s = createMobileSession({
    transport: {
      send(payload, handleMsg) {
        sent.push(payload);
        setImmediate(() => {
          handleMsg({ id: payload.id, result: { identifier: '1' } });
          if (payload.method === 'Target.setAutoAttach' && !payload.sessionId) {
            handleMsg({
              method: 'Target.attachedToTarget',
              params: {
                sessionId: 'sid-stealth-1',
                targetInfo: { targetId: 'page-1', type: 'page', url: 'https://example.com' },
                waitingForDebugger: true
              }
            });
          }
        });
      }
    },
    stealthConfig: { mode: 'mobile-blueprint', blueprintId: 'android_xm13_adreno740', seed: 12345 }
  });

  await s.init();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(sent.some(m => m.method === 'Page.addScriptToEvaluateOnNewDocument' && m.sessionId === 'sid-stealth-1'));
  assert.ok(sent.some(m => m.method === 'Emulation.setUserAgentOverride' && m.sessionId === 'sid-stealth-1'));
  assert.ok(sent.some(m => m.method === 'Runtime.runIfWaitingForDebugger' && m.sessionId === 'sid-stealth-1'));

  const failingSession = createMobileSession({
    transport: {
      send(payload, handleMsg) {
        setImmediate(() => handleMsg({ id: payload.id, error: { message: 'Stealth Target.setAutoAttach failed' } }));
      }
    },
    stealthConfig: { mode: 'mobile-blueprint', blueprintId: 'android_xm13_adreno740', seed: 999 }
  });
  await assert.rejects(() => failingSession.init(), /Stealth Target\.setAutoAttach failed/);
});
