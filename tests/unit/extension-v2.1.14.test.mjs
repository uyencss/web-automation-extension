import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// Central chrome mock setup BEFORE any module imports
const onDetachListeners = new Set();
const onEventListeners = new Set();
const onMessageListeners = [];

globalThis.__badgeText = null;
globalThis.__badgeColor = null;
globalThis.__attachError = null;
globalThis.__targets = [];
globalThis.__sendCommandHandler = null;

const localStorageStore = new Map();

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CLOSED;
  }
  send() {}
  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}
globalThis.WebSocket = MockWebSocket;

globalThis.chrome = {
  runtime: {
    id: 'webmcp-test-ext',
    getURL: (p = '') => 'chrome-extension://test-ext-id/' + p,
    getManifest: () => ({ name: 'WebMCP Tools Provider', version: '2.1.14', manifest_version: 3 }),
    onMessage: {
      addListener(fn) {
        onMessageListeners.push(fn);
      },
    },
  },
  action: {
    setBadgeText({ text }) {
      globalThis.__badgeText = text;
    },
    setBadgeBackgroundColor({ color }) {
      globalThis.__badgeColor = color;
    },
  },
  tabs: {
    sendMessage: async () => ({ ok: true }),
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onCreated: { addListener() {} },
    onActivated: { addListener() {} },
    onReplaced: { addListener() {} },
  },
  downloads: {
    onCreated: { addListener() {} },
    onChanged: { addListener() {} },
  },
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === 'string') {
          return { [keys]: localStorageStore.get(keys) };
        }
        if (Array.isArray(keys)) {
          const res = {};
          for (const k of keys) {
            if (localStorageStore.has(k)) res[k] = localStorageStore.get(k);
          }
          return res;
        }
        return Object.fromEntries(localStorageStore.entries());
      },
      async set(items) {
        for (const [k, v] of Object.entries(items || {})) {
          localStorageStore.set(k, v);
        }
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) {
          localStorageStore.delete(k);
        }
      },
    },
  },
  webNavigation: {
    getAllFrames(target, cb) {
      cb([]);
    },
  },
  debugger: {
    async attach(target) {
      if (globalThis.__attachHook) globalThis.__attachHook(target);
      if (globalThis.__attachError) throw globalThis.__attachError;
    },
    async detach() {},
    async getTargets() {
      return globalThis.__targets || [];
    },
    sendCommand(target, method, params, callback) {
      if (globalThis.__sendCommandHandler) {
        return globalThis.__sendCommandHandler(target, method, params, callback);
      }
      callback?.({});
    },
    onDetach: {
      addListener(fn) {
        onDetachListeners.add(fn);
      },
    },
    onEvent: {
      addListener(fn) {
        onEventListeners.add(fn);
      },
    },
  },
};

function emitCDPEvent(source, method, params) {
  for (const fn of onEventListeners) {
    try {
      fn(source, method, params);
    } catch {}
  }
}

test('P0.1 Detach hooks & session cleanup across network and console handlers', async () => {
  const { attachedTabs } = await import('../../webmcp-extension/dist/bg/state.js');
  const { detachDebugger, hasActiveCapture } = await import('../../webmcp-extension/dist/bg/cdp-bridge.js');
  const { startNetworkCapture, waitForNetworkResponse } = await import('../../webmcp-extension/dist/bg/handlers/network-intercept.js');
  const { startConsoleCapture, readConsoleMessages } = await import('../../webmcp-extension/dist/bg/handlers/console-capture.js');

  const tabId = 1001;
  attachedTabs.add(tabId);

  await startNetworkCapture(tabId, { url_pattern: 'api/orders' });
  await startConsoleCapture(tabId);

  assert.equal(hasActiveCapture(tabId), true, 'Active capture checker should return true');

  const waitPromise = waitForNetworkResponse(tabId, {
    url_pattern: 'api/orders',
    timeout_ms: 10000,
  });

  await detachDebugger(tabId);

  assert.equal(hasActiveCapture(tabId), false, 'Active capture checker should return false after detach');

  const waitResult = await waitPromise;
  assert.equal(waitResult.error, 'Debugger detached during capture.');

  await assert.rejects(
    async () => {
      await readConsoleMessages(tabId);
    },
    /Console capture not started/
  );
});

test('P0.2 stopConsoleCapture / disableRuntime state synchronization', async () => {
  const {
    startConsoleCapture,
    stopConsoleCapture,
  } = await import('../../webmcp-extension/dist/bg/handlers/console-capture.js');

  const {
    evaluateInFrameMainWorld,
  } = await import('../../webmcp-extension/dist/bg/cdp-bridge.js');

  const tabId = 2002;
  const sentCDP = [];

  globalThis.__sendCommandHandler = (target, method, params, callback) => {
    sentCDP.push({ method, tabId: target.tabId, params });
    if (method === 'Page.getFrameTree') {
      callback?.({
        frameTree: {
          frame: { id: 'root-frame', url: 'https://example.com' },
          childFrames: [
            {
              frame: { id: 'sub-frame-1', url: 'https://example.com/embed' },
            },
          ],
        },
      });
      return;
    }
    if (method === 'Runtime.enable') {
      // Chrome automatically replays executionContextCreated for existing frames
      setTimeout(() => {
        emitCDPEvent({ tabId: target.tabId }, 'Runtime.executionContextCreated', {
          context: {
            id: 101,
            auxData: { frameId: 'sub-frame-1', isDefault: true, type: 'default' },
          },
        });
      }, 5);
      callback?.({});
      return;
    }
    if (method === 'Runtime.evaluate') {
      callback?.({ result: { value: 42 } });
      return;
    }
    callback?.({});
  };

  await startConsoleCapture(tabId);

  // Stop console capture — this must call disableRuntime and clear runtimeEnabledTabs & mainWorldContexts
  await stopConsoleCapture(tabId);

  // Now evaluate in subframe MAIN world
  const res = await evaluateInFrameMainWorld(
    tabId,
    { cdpFrameId: 'sub-frame-1', parentCdpFrameId: 'root-frame' },
    '40 + 2'
  );

  assert.equal(res, 42);

  const runtimeEnables = sentCDP.filter((c) => c.tabId === tabId && c.method === 'Runtime.enable');
  assert.equal(runtimeEnables.length >= 2, true, 'Runtime.enable must be re-sent after stopConsoleCapture');

  globalThis.__sendCommandHandler = null;
});

test('P0.3 Self-attach recovery after service worker restart via sendCommand probe', async () => {
  const { attachedTabs } = await import('../../webmcp-extension/dist/bg/state.js');
  const { ensureDebuggerAttached } = await import('../../webmcp-extension/dist/bg/cdp-bridge.js');

  // Case 1: Already attached by our own extension session (probe succeeds)
  const tabId1 = 3001;
  attachedTabs.delete(tabId1);
  globalThis.__attachError = new Error('Cannot attach to this target as another debugger is already attached');
  globalThis.__sendCommandHandler = (target, method, params, callback) => {
    // Probe command succeeds without lastError
    chrome.runtime.lastError = null;
    callback?.({ result: { value: 1 } });
  };

  await ensureDebuggerAttached(tabId1);
  assert.equal(attachedTabs.has(tabId1), true, 'attachedTabs should recover attachment ownership via probe');

  // Case 2: Attached by another debugger (e.g. Codex) - probe fails with lastError
  const tabId2 = 3002;
  attachedTabs.delete(tabId2);
  globalThis.__attachError = new Error('Another debugger is already attached to the target with id: ' + tabId2);
  globalThis.__sendCommandHandler = (target, method, params, callback) => {
    chrome.runtime.lastError = { message: 'Cannot access target' };
    callback?.(null);
    chrome.runtime.lastError = null;
  };

  await assert.rejects(
    async () => {
      await ensureDebuggerAttached(tabId2);
    },
    /likely Codex/
  );

  globalThis.__attachError = null;
  globalThis.__sendCommandHandler = null;
});

test('P0.5 + P2.1 + P2.2 webmcp-polyfill.js and register-tools.js dual-alias & annotations', async () => {
  const polyfillCode = fs.readFileSync(
    path.join(ROOT, 'webmcp-extension/dist/content-scripts/webmcp-polyfill.js'),
    'utf8'
  );
  const registerToolsCode = fs.readFileSync(
    path.join(ROOT, 'webmcp-extension/dist/content-scripts/register-tools.js'),
    'utf8'
  );

  const messagesPosted = [];
  const sandbox = {
    window: {},
    document: {
      title: 'Polyfill Test Page',
      querySelector: (sel) => {
        if (sel === 'meta[name="description"]') return { content: 'Test Description' };
        return null;
      },
      querySelectorAll: () => [],
      documentElement: { lang: 'vi', scrollHeight: 2000 },
    },
    navigator: {},
    location: { href: 'https://vibe.test/page', origin: 'https://vibe.test' },
    Event: class Event {},
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    postMessage: (data) => messagesPosted.push(data),
    console: {
      debug() {},
      log() {},
      warn() {},
      error() {},
    },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.window.top = sandbox.window;

  // Execute webmcp-polyfill.js
  vm.runInNewContext(polyfillCode, sandbox);

  assert.ok(sandbox.navigator.modelContext, 'navigator.modelContext polyfilled');
  assert.strictEqual(sandbox.document.modelContext, sandbox.navigator.modelContext, 'document.modelContext dual-alias matches');
  assert.ok(sandbox.window.__webmcp_internal__, '__webmcp_internal__ exported');
  assert.equal(typeof sandbox.navigator.modelContext.getTools, 'function');
  assert.equal(typeof sandbox.navigator.modelContext.executeTool, 'function');

  // Execute register-tools.js
  vm.runInNewContext(registerToolsCode, sandbox);

  const tools = sandbox.navigator.modelContext.tools;
  assert.equal(tools.length, 14, 'All 14 tools registered');

  // Verify annotations on all 14 tools
  const readOnlyTools = [
    'get_page_metadata',
    'query_selector_all',
    'extract_table_data',
    'wait_for_element',
    'get_computed_styles',
    'wait_for_network_response',
    'get_captured_requests',
  ];

  const domCaptureTools = [
    'click_element',
    'fill_form_field',
    'scroll_page',
    'submit_form',
    'start_network_capture',
    'stop_network_capture',
  ];

  for (const name of readOnlyTools) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `Tool ${name} exists`);
    assert.equal(t.annotations?.readOnlyHint, true, `${name} has readOnlyHint: true`);
  }

  for (const name of domCaptureTools) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `Tool ${name} exists`);
    assert.equal(t.annotations?.readOnlyHint, false, `${name} has readOnlyHint: false`);
    assert.equal(t.annotations?.consequentialHint, true, `${name} has consequentialHint: true`);
  }

  const jsTool = tools.find((x) => x.name === 'execute_javascript');
  assert.ok(jsTool, 'execute_javascript exists');
  assert.equal(jsTool.annotations?.readOnlyHint, false);
  assert.equal(jsTool.annotations?.consequentialHint, true);
  assert.equal(jsTool.annotations?.untrustedContentHint, true);

  // Verify getTools() and executeTool()
  const asyncTools = await sandbox.navigator.modelContext.getTools();
  assert.equal(asyncTools.length, 14);

  const execRes = await sandbox.document.modelContext.executeTool('get_page_metadata', {});
  assert.ok(execRes?.content?.[0]?.text);
  assert.equal(execRes.content[0].text.includes('Polyfill Test Page'), true);
});

test('P1.1 Action badge status reflects connection and tab count', async () => {
  const { updateActionBadge } = await import('../../webmcp-extension/dist/bg/ws-client.js');
  const { attachedTabs } = await import('../../webmcp-extension/dist/bg/state.js');

  // When WS is closed/null: badge text is '!' and background is #ef4444
  updateActionBadge();
  assert.equal(globalThis.__badgeText, '!');
  assert.equal(globalThis.__badgeColor, '#ef4444');
});

test('P0-1 No re-attach on disable commands when tab is detached', async () => {
  const { attachedTabs } = await import('../../webmcp-extension/dist/bg/state.js');
  const { disableRuntime, sendCDPCommand } = await import('../../webmcp-extension/dist/bg/cdp-bridge.js');

  const tabId = 4001;
  attachedTabs.delete(tabId);

  let attachCallCount = 0;
  globalThis.__attachHook = () => {
    attachCallCount++;
  };

  // Calling disableRuntime on unattached tab should not trigger attach
  await disableRuntime(tabId);
  assert.equal(attachCallCount, 0, 'disableRuntime must not call debugger.attach when tab is detached');

  // Calling Network.disable on unattached tab should not trigger attach
  const res = await sendCDPCommand(tabId, 'Network.disable', {});
  assert.equal(attachCallCount, 0, 'sendCDPCommand(Network.disable) must not call debugger.attach when tab is detached');
  assert.deepEqual(res, {});

  globalThis.__attachHook = null;
});

test('P0-2 Polyfill wraps and preserves tools when native navigator.modelContext exists (Chrome 150+)', async () => {
  const polyfillCode = fs.readFileSync(
    path.join(ROOT, 'webmcp-extension/dist/content-scripts/webmcp-polyfill.js'),
    'utf8'
  );
  const registerToolsCode = fs.readFileSync(
    path.join(ROOT, 'webmcp-extension/dist/content-scripts/register-tools.js'),
    'utf8'
  );

  let nativeRegisteredCount = 0;
  const nativeModelContext = {
    registerTool(def) {
      nativeRegisteredCount++;
    },
    unregisterTool(name) {},
  };

  const sandbox = {
    window: {},
    document: {
      title: 'Chrome 150 Native WebMCP Test Page',
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { lang: 'en', scrollHeight: 1500 },
    },
    navigator: {
      modelContext: nativeModelContext,
    },
    location: { href: 'https://vibe.test/native', origin: 'https://vibe.test' },
    Event: class Event {},
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    postMessage: () => {},
    console: {
      debug() {},
      log() {},
      warn() {},
      error() {},
    },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.window.top = sandbox.window;

  // Execute webmcp-polyfill.js with native navigator.modelContext present
  vm.runInNewContext(polyfillCode, sandbox);

  assert.strictEqual(sandbox.navigator.modelContext, nativeModelContext, 'Uses native object');
  assert.strictEqual(sandbox.document.modelContext, nativeModelContext, 'document.modelContext alias matches');
  assert.equal(typeof sandbox.navigator.modelContext.getTools, 'function');
  assert.equal(typeof sandbox.navigator.modelContext.executeTool, 'function');
  assert.equal(typeof sandbox.navigator.modelContext.invokeTool, 'function');
  assert.ok(Array.isArray(sandbox.navigator.modelContext.tools));

  // Execute register-tools.js
  vm.runInNewContext(registerToolsCode, sandbox);

  // Both native registerTool was invoked AND internal registry recorded all 14 tools
  assert.equal(nativeRegisteredCount, 14, 'Native registerTool was called for all 14 tools');
  assert.equal(sandbox.navigator.modelContext.tools.length, 14, 'tools getter lists 14 tools');

  const tools = await sandbox.document.modelContext.getTools();
  assert.equal(tools.length, 14, 'document.modelContext.getTools() returns 14 tools');

  const execRes = await sandbox.document.modelContext.executeTool('get_page_metadata', {});
  assert.ok(execRes?.content?.[0]?.text);
  assert.equal(execRes.content[0].text.includes('Chrome 150 Native WebMCP Test Page'), true);
});

test('F1 Emulation override prevents idle detach and clears properly', async () => {
  const { attachedTabs } = await import('../../webmcp-extension/dist/bg/state.js');
  const {
    sendCDPCommand,
    hasActiveCapture,
    detachDebugger,
  } = await import('../../webmcp-extension/dist/bg/cdp-bridge.js');

  const tabId = 5001;
  attachedTabs.add(tabId);

  // Set device metrics override -> emulation active
  await sendCDPCommand(tabId, 'Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080 });
  assert.equal(hasActiveCapture(tabId), true, 'hasActiveCapture must be true while emulation override is active');

  // Clear device metrics override -> emulation cleared
  await sendCDPCommand(tabId, 'Emulation.clearDeviceMetricsOverride', {});
  assert.equal(hasActiveCapture(tabId), false, 'hasActiveCapture must be false after clearDeviceMetricsOverride');

  // Set again, then detachDebugger -> emulation override cleaned up
  await sendCDPCommand(tabId, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 720 });
  assert.equal(hasActiveCapture(tabId), true);
  await detachDebugger(tabId);
  assert.equal(hasActiveCapture(tabId), false, 'cleanupDetachedTab must clear emulationOverrideTabs');
});

test('F10 Iframe receiver security checks (source and origin validation)', async () => {
  const polyfillCode = fs.readFileSync(
    path.join(ROOT, 'webmcp-extension/dist/content-scripts/webmcp-polyfill.js'),
    'utf8'
  );

  const postedResponses = [];
  const parentWindow = {
    postMessage(data, origin) {
      postedResponses.push({ data, origin });
    },
  };

  let messageListener = null;
  const sandbox = {
    window: {
      parent: parentWindow,
      top: {}, // window !== window.top
      addEventListener(type, fn) {
        if (type === 'message') messageListener = fn;
      },
      removeEventListener() {},
      postMessage() {},
    },
    document: {
      title: 'Iframe Security Test',
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    navigator: {},
    location: { href: 'https://inner.test/frame', origin: 'https://inner.test' },
    Event: class Event {},
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    console: { debug() {}, log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  sandbox.window.window = sandbox.window;

  vm.runInNewContext(polyfillCode, sandbox);
  assert.ok(messageListener, 'Message listener registered in iframe');

  // 1. Message from non-parent source is rejected
  postedResponses.length = 0;
  messageListener({
    source: {}, // not window.parent
    origin: 'https://inner.test',
    data: { type: 'WEBMCP_IFRAME_CMD', cmd: 'get_page_metadata', id: 1 },
  });
  assert.equal(postedResponses.length, 0, 'Must ignore message when event.source !== window.parent');

  // 2. Cross-origin execute_javascript is blocked
  postedResponses.length = 0;
  messageListener({
    source: parentWindow,
    origin: 'https://attacker.test', // different from location.origin 'https://inner.test'
    data: { type: 'WEBMCP_IFRAME_CMD', cmd: 'execute_javascript', params: { code: '1+1' }, id: 2 },
  });
  assert.equal(postedResponses.length, 1, 'Should respond with error');
  assert.equal(postedResponses[0].data.id, 2);
  assert.equal(postedResponses[0].data.result?.content?.[0]?.text?.includes('Cross-origin iframe execute_javascript is blocked'), true);
});

test('M4.1 Dynamic Service Endpoints URL Normalization', async () => {
  const { normalizeGatewayUrl, normalizeVaultUrl, DEFAULT_WS_URL, DEFAULT_VAULT_URL } = await import(
    '../../webmcp-extension/dist/bg/ws-client.js'
  );

  // Default fallbacks
  assert.equal(normalizeGatewayUrl(''), DEFAULT_WS_URL);
  assert.equal(normalizeGatewayUrl(null), DEFAULT_WS_URL);
  assert.equal(normalizeVaultUrl(''), DEFAULT_VAULT_URL);
  assert.equal(normalizeVaultUrl(undefined), DEFAULT_VAULT_URL);

  // Valid inputs
  assert.equal(normalizeGatewayUrl('ws://127.0.0.1:9999/'), 'ws://127.0.0.1:9999');
  assert.equal(normalizeGatewayUrl('wss://gateway.company.internal:8443'), 'wss://gateway.company.internal:8443');
  assert.equal(normalizeVaultUrl('http://127.0.0.1:8888/'), 'http://127.0.0.1:8888');
  assert.equal(normalizeVaultUrl('http://127.0.0.1:8888/api/'), 'http://127.0.0.1:8888/api');
  assert.equal(normalizeVaultUrl('https://vault.company.internal:7876'), 'https://vault.company.internal:7876');

  // Invalid protocol errors
  assert.throws(() => normalizeGatewayUrl('http://localhost:7865'), /bắt đầu bằng ws:\/\/ hoặc wss:\/\//);
  assert.throws(() => normalizeGatewayUrl('ftp://localhost:7865'), /bắt đầu bằng ws:\/\/ hoặc wss:\/\//);
  assert.throws(() => normalizeVaultUrl('ws://127.0.0.1:7876'), /bắt đầu bằng http:\/\/ hoặc https:\/\//);
  assert.throws(() => normalizeVaultUrl('javascript:alert(1)'), /bắt đầu bằng http:\/\/ hoặc https:\/\//);
});

test('M4.2 Dynamic Service Endpoints Storage Persistence & Retrieval', async () => {
  const { saveServiceUrls, getServiceUrls, DEFAULT_WS_URL, DEFAULT_VAULT_URL, getCurrentGatewayUrl, closeWebSocket } = await import(
    '../../webmcp-extension/dist/bg/ws-client.js'
  );

  // Save custom endpoints
  const saved = await saveServiceUrls({
    gatewayUrl: 'ws://127.0.0.1:8888',
    vaultUrl: 'http://127.0.0.1:9999',
  });
  assert.equal(saved.gatewayUrl, 'ws://127.0.0.1:8888');
  assert.equal(saved.vaultUrl, 'http://127.0.0.1:9999');
  assert.equal(getCurrentGatewayUrl(), 'ws://127.0.0.1:8888');

  // Verify retrieval
  const retrieved = await getServiceUrls();
  assert.equal(retrieved.gatewayUrl, 'ws://127.0.0.1:8888');
  assert.equal(retrieved.vaultUrl, 'http://127.0.0.1:9999');

  // Reset to default (removes from chrome.storage.local)
  const reset = await saveServiceUrls({
    gatewayUrl: DEFAULT_WS_URL,
    vaultUrl: DEFAULT_VAULT_URL,
  });
  assert.equal(reset.gatewayUrl, DEFAULT_WS_URL);
  assert.equal(reset.vaultUrl, DEFAULT_VAULT_URL);
  assert.equal(getCurrentGatewayUrl(), DEFAULT_WS_URL);

  closeWebSocket();
});

test('M4.3 Anti-Bot Stealth (__webmcp_internal__ deleted) & Popup Gateway Settings Security', async () => {
  const polyfillCode = fs.readFileSync(
    path.join(ROOT, 'webmcp-extension/dist/content-scripts/webmcp-polyfill.js'),
    'utf8'
  );
  const registerCode = fs.readFileSync(
    path.join(ROOT, 'webmcp-extension/dist/content-scripts/register-tools.js'),
    'utf8'
  );
  const sandbox = {
    window: {
      top: null,
      addEventListener() {},
      removeEventListener() {},
      postMessage() {},
    },
    document: { title: 'Stealth Test', querySelector: () => null, querySelectorAll: () => [] },
    navigator: {},
    location: { href: 'https://stealth.test/', origin: 'https://stealth.test' },
    Event: class Event {},
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    console: { debug() {}, log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.top = sandbox.window;

  vm.runInNewContext(polyfillCode, sandbox);
  vm.runInNewContext(registerCode, sandbox);
  assert.equal(
    '__webmcp_internal__' in sandbox.window,
    false,
    'window.__webmcp_internal__ must be deleted immediately after register-tools.js loads'
  );

  await import('../../webmcp-extension/dist/bg/events.js');
  const listener = onMessageListeners[onMessageListeners.length - 1];
  assert.ok(listener, 'events.js onMessage listener must be registered');

  // 1. Unauthorized sender (from a web tab) is rejected
  const unauthRes = await new Promise((resolve) => {
    listener(
      { type: 'WEBMCP_POPUP', method: 'status' },
      { tab: { id: 10 }, url: 'https://evil.com' },
      resolve
    );
  });
  assert.equal(unauthRes.ok, false);
  assert.match(unauthRes.error, /Unauthorized popup sender/);

  // 2. Authorized popup saveSettings updates gatewayUrl
  const saveRes = await new Promise((resolve) => {
    listener(
      { type: 'WEBMCP_POPUP', method: 'saveSettings', params: { gatewayUrl: 'ws://127.0.0.1:7865' } },
      { url: 'chrome-extension://test-ext-id/popup.html' },
      resolve
    );
  });
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.gatewayUrl, 'ws://127.0.0.1:7865');
});



