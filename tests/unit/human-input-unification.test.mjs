import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// Setup globalThis.chrome mock before importing background modules
const sentCDPCommands = [];
let sendCommandImpl = null;

globalThis.chrome = {
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: (target, method, params, callback) => {
      sentCDPCommands.push({ tabId: target.tabId, method, params });
      if (sendCommandImpl) {
        return sendCommandImpl(target, method, params, callback);
      }
      if (typeof callback === 'function') callback({});
    },
    onDetach: { addListener: () => {} },
    onEvent: { addListener: () => {} },
  },
  runtime: {
    lastError: null,
    getManifest: () => ({ name: 'WebMCP Tools Provider', version: '2.1.14', manifest_version: 3 }),
  },
  tabs: {
    onRemoved: { addListener: () => {} },
    sendMessage: () => {},
    query: async () => [{ id: 101 }],
    get: async (id) => ({ id, url: 'https://example.com' }),
  },
  webNavigation: {
    getAllFrames: (_target, cb) => cb([]),
  },
};

await import('../../webmcp-extension/dist/bg/ws-client.js');
const { moveTo, clickAt, typeInto, lastMousePos, cdpInputHandlers } = await import(
  '../../webmcp-extension/dist/bg/handlers/cdp-input.js'
);
const { ariaSnapshotHandlers } = await import(
  '../../webmcp-extension/dist/bg/handlers/aria-snapshot.js'
);
const { highLevelHandlers } = await import(
  '../../webmcp-extension/dist/bg/handlers/high-level.js'
);
const { fullControlHandlers } = await import(
  '../../webmcp-extension/dist/bg/handlers/full-control.js'
);
const { waitForPageStable } = await import(
  '../../webmcp-extension/dist/bg/handlers/page-stability.js'
);

test('T1 + T7: clickAt dispatches Bézier mouseMoved (buttons:0), mousePressed (buttons:1), mouseReleased (buttons:0) and double-click pairs', async () => {
  sentCDPCommands.length = 0;
  const tabId = 701;
  lastMousePos.set(tabId, { x: 10, y: 10 });

  const pt = await clickAt(
    tabId,
    { x: 200, y: 150, width: 100, height: 40 },
    { button: 'left', clickCount: 2, human: true }
  );

  // Target point must be within 35%..65% of box [200..300, 150..190]
  assert.ok(pt.x >= 235 && pt.x <= 265, `Expected x in [235, 265], got ${pt.x}`);
  assert.ok(pt.y >= 164 && pt.y <= 176, `Expected y in [164, 176], got ${pt.y}`);

  const mouseEvents = sentCDPCommands.filter((c) => c.method === 'Input.dispatchMouseEvent');
  const moved = mouseEvents.filter((c) => c.params.type === 'mouseMoved');
  const pressed = mouseEvents.filter((c) => c.params.type === 'mousePressed');
  const released = mouseEvents.filter((c) => c.params.type === 'mouseReleased');

  // Bézier curve should generate multiple mouseMoved events (4..12 steps)
  assert.ok(moved.length >= 4 && moved.length <= 13, `Expected 4..13 mouseMoved events, got ${moved.length}`);
  for (const m of moved) {
    assert.equal(m.params.buttons, 0, 'mouseMoved must carry buttons: 0');
  }

  // Double-click must emit 2 press/release pairs with clickCount 1 then 2, and buttons: 1 on press
  assert.equal(pressed.length, 2);
  assert.equal(released.length, 2);
  assert.equal(pressed[0].params.buttons, 1);
  assert.equal(pressed[0].params.clickCount, 1);
  assert.equal(released[0].params.buttons, 0);
  assert.equal(released[0].params.clickCount, 1);
  assert.equal(pressed[1].params.buttons, 1);
  assert.equal(pressed[1].params.clickCount, 2);
  assert.equal(released[1].params.buttons, 0);
  assert.equal(released[1].params.clickCount, 2);
});

test('T2 + T3: typeInto handles ASCII keystrokes with full metadata, Vietnamese/Emoji via insertText, >120 chars paste, and empty clear via Backspace', async () => {
  const tabId = 702;

  // 1. Short mixed ASCII + Vietnamese + Emoji string: "Aờ "
  sentCDPCommands.length = 0;
  await typeInto(tabId, 'Aờ ', { human: true });

  // 'A' -> keyDown + keyUp with KeyA, keyCode 65, modifiers 8
  // 'ờ' -> Input.insertText
  // ' ' -> keyDown + keyUp with Space, keyCode 32, modifiers 0
  assert.equal(sentCDPCommands.length, 5);
  assert.equal(sentCDPCommands[0].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCDPCommands[0].params.type, 'keyDown');
  assert.equal(sentCDPCommands[0].params.key, 'A');
  assert.equal(sentCDPCommands[0].params.code, 'KeyA');
  assert.equal(sentCDPCommands[0].params.windowsVirtualKeyCode, 65);
  assert.equal(sentCDPCommands[0].params.modifiers, 8);

  assert.equal(sentCDPCommands[1].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCDPCommands[1].params.type, 'keyUp');
  assert.equal(sentCDPCommands[1].params.code, 'KeyA');

  assert.equal(sentCDPCommands[2].method, 'Input.insertText');
  assert.equal(sentCDPCommands[2].params.text, 'ờ');

  assert.equal(sentCDPCommands[3].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCDPCommands[3].params.type, 'keyDown');
  assert.equal(sentCDPCommands[3].params.code, 'Space');
  assert.equal(sentCDPCommands[3].params.windowsVirtualKeyCode, 32);
  assert.equal(sentCDPCommands[3].params.modifiers, 0);

  // 2. Long string (> 120 chars) -> single Input.insertText
  sentCDPCommands.length = 0;
  const longText = 'Xin chào Việt Nam '.repeat(10); // 180 chars
  const longRes = await typeInto(tabId, longText, { human: true });
  assert.equal(longRes.mode, 'insertText');
  assert.equal(sentCDPCommands.length, 1);
  assert.equal(sentCDPCommands[0].method, 'Input.insertText');
  assert.equal(sentCDPCommands[0].params.text, longText);

  // 3. Empty string with clearEmptyWithBackspace: true -> Backspace rawKeyDown + keyUp
  sentCDPCommands.length = 0;
  const clearRes = await typeInto(tabId, '', { human: true, clearEmptyWithBackspace: true });
  assert.equal(clearRes.cleared, true);
  assert.equal(sentCDPCommands.length, 2);
  assert.equal(sentCDPCommands[0].params.type, 'rawKeyDown');
  assert.equal(sentCDPCommands[0].params.key, 'Backspace');
  assert.equal(sentCDPCommands[0].params.windowsVirtualKeyCode, 8);
  assert.equal(sentCDPCommands[1].params.type, 'keyUp');
  assert.equal(sentCDPCommands[1].params.key, 'Backspace');

  // 4. pressKey({ key: 'Enter' }) dispatches keyDown with text: '\r' and no extra char event
  sentCDPCommands.length = 0;
  await cdpInputHandlers.pressKey({ tabId, key: 'Enter' });
  assert.equal(sentCDPCommands.length, 2);
  assert.equal(sentCDPCommands[0].params.type, 'keyDown');
  assert.equal(sentCDPCommands[0].params.text, '\r');
  assert.equal(sentCDPCommands[0].params.unmodifiedText, '\r');
  assert.equal(sentCDPCommands[1].params.type, 'keyUp');
});

test('T1 + T4 + T6 + T8: clickByRef and typeByRef route to CDP when hit/focused, and fall back to content-script when occluded', async () => {
  const ariaSnapshotSource = fs.readFileSync(
    path.join(ROOT, 'webmcp-extension/dist/content-scripts/aria-snapshot.js'),
    'utf8'
  );

  const listeners = [];
  let topElementAtPoint = null;
  let activeEl = null;
  let selectCalled = false;
  let syntheticClickCalled = false;

  class MockHTMLInputElement {}

  const fakeButton = {
    localName: 'button',
    tagName: 'BUTTON',
    nodeType: 1,
    childNodes: [{ nodeType: 3, textContent: 'Buy Now' }],
    children: [],
    getAttribute: (attr) => (attr === 'role' ? 'button' : null),
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 80, height: 40, top: 100, left: 100, right: 180, bottom: 140 }),
    scrollIntoView: () => {},
    contains: (other) => other === fakeButton,
    matches: () => false,
    closest: () => null,
    click: () => { syntheticClickCalled = true; },
    dispatchEvent: () => {},
    isConnected: true,
  };

  const fakeLabel = {
    localName: 'label',
    tagName: 'LABEL',
    nodeType: 1,
    contains: (other) => other === fakeLabel,
  };

  const fakeInput = Object.assign(new MockHTMLInputElement(), {
    localName: 'input',
    tagName: 'INPUT',
    type: 'text',
    value: 'old_value',
    nodeType: 1,
    childNodes: [],
    children: [],
    labels: [fakeLabel],
    getAttribute: (attr) => (attr === 'placeholder' ? 'Search' : null),
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 100, y: 200, width: 120, height: 32, top: 200, left: 100, right: 220, bottom: 232 }),
    scrollIntoView: () => {},
    focus: () => { activeEl = fakeInput; },
    select: () => { selectCalled = true; },
    contains: (other) => other === fakeInput,
    matches: () => false,
    closest: () => null,
    dispatchEvent: () => {},
    isConnected: true,
  });

  const body = {
    localName: 'body',
    tagName: 'BODY',
    nodeType: 1,
    childNodes: [fakeButton, fakeInput],
    children: [fakeButton, fakeInput],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1024, height: 768, top: 0, left: 0, right: 1024, bottom: 768 }),
    contains: () => true,
    matches: () => false,
    closest: () => null,
    isConnected: true,
  };

  const documentStub = {
    title: 'Seam Test',
    body,
    documentElement: body,
    get activeElement() { return activeEl; },
    querySelector: () => null,
    getElementById: () => null,
    elementFromPoint: (x, y) => {
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `elementFromPoint got non-finite (${x}, ${y})`);
      return topElementAtPoint;
    },
  };

  const context = {
    window: {
      location: { href: 'https://example.com/seam' },
      document: documentStub,
      innerWidth: 1024,
      innerHeight: 768,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    },
    document: documentStub,
    location: { href: 'https://example.com/seam' },
    Node: { TEXT_NODE: 3 },
    HTMLInputElement: MockHTMLInputElement,
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    MouseEvent: class {},
    InputEvent: class {},
    KeyboardEvent: class {},
    Event: class {},
    WeakRef,
    WeakMap,
    Map,
    Set,
    Date,
    Math,
    Number,
    String,
    Boolean,
    RegExp,
    Array,
    Object,
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    },
  };
  context.globalThis = context;
  context.window.window = context.window;

  vm.createContext(context);
  vm.runInContext(ariaSnapshotSource, context);

  globalThis.chrome.tabs.sendMessage = (tabId, message, _options, callback) => {
    listeners[0](message, { tab: { id: tabId } }, (response) => callback(response));
  };

  // Take snapshot to register r1 (button) and r2 (input)
  const snap = await ariaSnapshotHandlers.getAriaSnapshot({ tabId: 101, mode: 'fast', forceFresh: true });
  assert.ok(snap.snapshot.includes('ref=r1 button "Buy Now"'));
  assert.ok(snap.snapshot.includes('ref=r2 textbox "Search"'));

  // Case 1: Button is NOT occluded (elementFromPoint returns fakeButton) -> routes to CDP!
  topElementAtPoint = fakeButton;
  syntheticClickCalled = false;
  sentCDPCommands.length = 0;

  const clickRes1 = await ariaSnapshotHandlers.clickByRef({ tabId: 101, ref: 'r1' });
  assert.equal(clickRes1.trusted, true);
  assert.equal(clickRes1.source, 'cdp');
  assert.equal(syntheticClickCalled, false, 'Must not call synthetic element.click() when CDP path succeeds');
  assert.ok(sentCDPCommands.some((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed' && c.params.buttons === 1));

  // Case 2: Button IS occluded by body/wrapper (elementFromPoint returns body) -> T1: body.contains(fakeButton) must NOT pass!
  topElementAtPoint = body;
  syntheticClickCalled = false;
  sentCDPCommands.length = 0;

  const clickRes2 = await ariaSnapshotHandlers.clickByRef({ tabId: 101, ref: 'r1' });
  assert.equal(clickRes2.trusted, false);
  assert.equal(clickRes2.reason, 'occluded');
  assert.equal(syntheticClickCalled, true, 'Should fall back to synthetic click when occluded');

  // Case 2b: Input hit-tested via associated <label> (element.labels) -> T1: routes to CDP!
  topElementAtPoint = fakeLabel;
  sentCDPCommands.length = 0;
  const labelClickRes = await ariaSnapshotHandlers.clickByRef({ tabId: 101, ref: 'r2' });
  assert.equal(labelClickRes.trusted, true);
  assert.equal(labelClickRes.source, 'cdp');

  // Case 3: typeByRef focuses and selects input, gates on focused === true (even if topElementAtPoint is an overlay!), and types via CDP without clicking in between!
  topElementAtPoint = body; // overlay on top, but input can still be focused!
  selectCalled = false;
  sentCDPCommands.length = 0;

  const typeRes = await ariaSnapshotHandlers.typeByRef({ tabId: 101, ref: 'r2', text: 'Hi', submit: true });
  assert.equal(typeRes.trusted, true);
  assert.equal(typeRes.source, 'cdp');
  assert.equal(typeRes.submitted, true);
  assert.equal(selectCalled, true, 'Must call element.select() to replace existing text');
  assert.equal(
    sentCDPCommands.some((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed'),
    false,
    'T6 Invariant: Must NOT dispatch mousePressed after select()'
  );
  const keyDowns = sentCDPCommands.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown');
  assert.equal(keyDowns.length, 3);
  assert.equal(keyDowns[0].params.key, 'H');
  assert.equal(keyDowns[1].params.key, 'i');
  assert.equal(keyDowns[2].params.key, 'Enter');
  assert.equal(keyDowns[2].params.text, '\r', 'Enter keyDown must include text: "\\r" to submit forms');
  assert.equal(keyDowns[2].params.unmodifiedText, '\r');

  // Case 4: typeByRef with explicit synthetic mode (human: false, trusted: false) bypasses resolve/CDP
  selectCalled = false;
  sentCDPCommands.length = 0;
  const synthTypeRes = await ariaSnapshotHandlers.typeByRef({
    tabId: 101,
    ref: 'r2',
    text: 'x',
    human: false,
    trusted: false,
  });
  assert.equal(synthTypeRes.trusted, false);
  assert.equal(synthTypeRes.reason, 'synthetic');
  assert.equal(selectCalled, false, 'Synthetic mode must skip resolve prepareType');
  assert.equal(sentCDPCommands.some((c) => c.method.startsWith('Input.')), false);
});

test('T5: waitForPageStable runs in a single self-contained Promise expression with zero window.__webmcp_* globals', async () => {
  sentCDPCommands.length = 0;
  let evaluatedExpression = '';
  let evaluatedParams = null;

  sendCommandImpl = (_target, method, params, callback) => {
    if (method === 'Runtime.evaluate') {
      evaluatedExpression = params.expression;
      evaluatedParams = params;
      callback({ result: { value: { stable: true, waited: 800 } } });
      return;
    }
    callback({});
  };

  let res;
  try {
    res = await waitForPageStable(101, { minStableMs: 200, maxWaitMs: 1000 });
  } finally {
    sendCommandImpl = null;
  }

  assert.equal(res.stable, true);
  assert.equal(sentCDPCommands.filter((c) => c.method === 'Runtime.evaluate').length, 1, 'Should only issue 1 Runtime.evaluate call');
  assert.equal(evaluatedParams.awaitPromise, true, 'Runtime.evaluate must await the returned Promise');
  assert.equal(evaluatedExpression.includes('__webmcp_stability_observer'), false, 'Must not leak __webmcp_stability_observer onto window');
  assert.equal(evaluatedExpression.includes('__webmcp_mutation_count'), false, 'Must not leak __webmcp_mutation_count onto window');
});

test('CHIPS partitionKey & getExtensionInfo: setCookie normalizes partitionKey with hasCrossSiteAncestors and getExtensionInfo returns websocketUrl', async () => {
  sentCDPCommands.length = 0;
  sendCommandImpl = (_target, method, _params, callback) => {
    if (method === 'Network.setCookie') {
      callback({ success: true });
      return;
    }
    callback({});
  };

  try {
    await fullControlHandlers.setCookie({
      tabId: 101,
      name: 'chip_str',
      value: '1',
      url: 'https://example.com',
      partitionKey: 'https://top.example.com',
    });

    await fullControlHandlers.setCookie({
      tabId: 101,
      name: 'chip_obj',
      value: '2',
      url: 'https://example.com',
      partitionKey: { topLevelSite: 'https://top.example.com', hasCrossSiteAncestors: true },
    });
  } finally {
    sendCommandImpl = null;
  }

  const setCookieCalls = sentCDPCommands.filter((c) => c.method === 'Network.setCookie');
  assert.equal(setCookieCalls.length, 2);
  assert.deepEqual(setCookieCalls[0].params.partitionKey, {
    topLevelSite: 'https://top.example.com',
    hasCrossSiteAncestors: false,
  });
  assert.deepEqual(setCookieCalls[1].params.partitionKey, {
    topLevelSite: 'https://top.example.com',
    hasCrossSiteAncestors: true,
  });

  const extInfo = await fullControlHandlers.getExtensionInfo();
  assert.equal(extInfo.websocketUrl, 'ws://localhost:7865', 'getExtensionInfo must resolve static ws-client gateway URL');
});
