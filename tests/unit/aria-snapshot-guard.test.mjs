import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Stub globalThis.chrome before importing cdp-bridge.js and handlers
globalThis.chrome = {
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: (_target, _method, _params, callback) => {
      if (typeof callback === 'function') callback({});
    },
    onDetach: { addListener: () => {} },
    onEvent: { addListener: () => {} },
  },
  runtime: {
    lastError: null,
  },
  tabs: {
    onRemoved: { addListener: () => {} },
    sendMessage: () => {},
    query: async () => [{ id: 1 }],
    create: async () => ({ id: 1 }),
  },
};

const { getCDPAriaSnapshot } = await import('../../webmcp-extension/dist/bg/cdp-bridge.js');
const { ariaSnapshotHandlers } = await import('../../webmcp-extension/dist/bg/handlers/aria-snapshot.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ariaSnapshotSource = fs.readFileSync(
  path.resolve(__dirname, '../../webmcp-extension/dist/content-scripts/aria-snapshot.js'),
  'utf8'
);

function createAriaSnapshotEnvironment(initialUrl = 'https://example.com/test') {
  const listeners = [];
  const location = { href: initialUrl };

  const fakeButton = {
    localName: 'button',
    tagName: 'BUTTON',
    nodeType: 1,
    childNodes: [{ nodeType: 3, textContent: 'Submit' }],
    children: [],
    getAttribute(attr) {
      if (attr === 'role') return 'button';
      return null;
    },
    hasAttribute() { return false; },
    getBoundingClientRect() { return { x: 10, y: 10, width: 80, height: 30, top: 10, left: 10, right: 90, bottom: 40 }; },
    matches() { return false; },
    closest() { return null; },
    isConnected: true,
  };

  const body = {
    localName: 'body',
    tagName: 'BODY',
    nodeType: 1,
    childNodes: [fakeButton],
    children: [fakeButton],
    getAttribute() { return null; },
    hasAttribute() { return false; },
    getBoundingClientRect() { return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }; },
    matches() { return false; },
    closest() { return null; },
    isConnected: true,
  };

  const document = {
    title: 'Test Document',
    body,
    documentElement: body,
    querySelector() { return null; },
    getElementById() { return null; },
  };

  const windowStub = {
    location,
    document,
    innerWidth: 1024,
    innerHeight: 768,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle() {
      return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
      };
    },
  };

  const context = {
    window: windowStub,
    document,
    location,
    Node: { TEXT_NODE: 3 },
    HTMLInputElement: class {},
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
        onMessage: {
          addListener(fn) {
            listeners.push(fn);
          },
        },
      },
    },
    fakeButton,
    body,
  };
  context.globalThis = context;
  context.window.window = context.window;

  vm.createContext(context);
  vm.runInContext(ariaSnapshotSource, context);

  return {
    context,
    api: context.window.__WEBMCP_FAST_ARIA_API__,
    listeners,
    fakeButton,
    body,
    location,
    document,
  };
}

test('Stale Ref Guard: getElementByRef / resolveRef fail-fast on detached elements', () => {
  const env = createAriaSnapshotEnvironment();
  const { api, fakeButton } = env;

  assert.ok(api, 'Internal API should be exposed on window');
  assert.equal(typeof api.getElementByRef, 'function');
  assert.equal(typeof api.resolveRef, 'function');

  // Register element to generate a ref
  const ref = api.ensureRef(fakeButton, { role: 'button', name: 'Submit' });
  assert.match(ref, /^R\d+$/);

  // 1. Valid connected element dereferences fine
  fakeButton.isConnected = true;
  const resolved = api.getElementByRef(ref);
  assert.strictEqual(resolved, fakeButton, 'Connected element should resolve');
  assert.strictEqual(api.resolveRef(ref), fakeButton, 'resolveRef alias should resolve connected element');

  // 2. Element detached from DOM throws STALE_ELEMENT_REFERENCE and deletes ref
  fakeButton.isConnected = false;
  assert.throws(
    () => api.getElementByRef(ref),
    {
      name: 'Error',
      message: `STALE_ELEMENT_REFERENCE: Element ${ref} was detached from DOM (page re-rendered). Please take a fresh getAriaSnapshot.`,
    },
    'Should throw STALE_ELEMENT_REFERENCE on detached element'
  );

  // Verify ref was purged from refToElement map
  assert.equal(api.refToElement.has(ref), false, 'Stale ref must be removed from refToElement');

  // 3. Expired or non-existent ref throws REF_EXPIRED
  assert.throws(
    () => api.getElementByRef('R99999'),
    {
      name: 'Error',
      message: 'REF_EXPIRED: Ref R99999 no longer exists in memory.',
    },
    'Non-existent or GC-collected ref should throw REF_EXPIRED'
  );
});

test('Unchanged Short-Circuit: buildSnapshot returns unchanged short-circuit when DOM and URL match', () => {
  const env = createAriaSnapshotEnvironment('https://example.com/checkout');
  const { api, location, fakeButton } = env;

  // 1. Initial snapshot call: returns full snapshot object
  const snap1 = api.buildSnapshot({});
  assert.equal(snap1.source, 'content-script');
  assert.ok(snap1.snapshot.includes('button "Submit"'));
  assert.equal(snap1.unchanged, undefined);

  // 2. Immediate second call with identical URL and DOM: returns short-circuit object
  const snap2 = api.buildSnapshot({});
  assert.equal(snap2.unchanged, true);
  assert.equal(
    snap2.text,
    '[SNAPSHOT_UNCHANGED: URL=https://example.com/checkout, elements unchanged since last step]'
  );
  assert.ok(snap2.snapshot.includes('button "Submit"'), 'Snapshot string must be preserved');
  assert.equal(snap2.nodeCount, snap1.nodeCount, 'nodeCount must be preserved');
  assert.equal(snap2.source, 'content-script', 'source must be preserved');
  assert.equal(snap2.url, 'https://example.com/checkout');

  // 3. Third call with forceFresh: true: bypasses short-circuit and returns full snapshot
  const snap3 = api.buildSnapshot({ forceFresh: true });
  assert.equal(snap3.source, 'content-script');
  assert.ok(snap3.snapshot.includes('button "Submit"'));
  assert.notEqual(snap3.unchanged, true);

  // 4. URL changes: bypasses short-circuit even without forceFresh
  location.href = 'https://example.com/confirmation';
  const snap4 = api.buildSnapshot({});
  assert.equal(snap4.source, 'content-script');
  assert.equal(snap4.url, 'https://example.com/confirmation');
  assert.notEqual(snap4.unchanged, true);

  // 5. DOM content changes (different button name): bypasses short-circuit
  fakeButton.childNodes = [{ nodeType: 3, textContent: 'Place Order' }];
  const snap5 = api.buildSnapshot({});
  assert.equal(snap5.source, 'content-script');
  assert.ok(snap5.snapshot.includes('button "Place Order"'));
  assert.notEqual(snap5.unchanged, true);
});

test('CDP Formatter Pure-Mapping: formatNodes formats flat AXTree nodes correctly', () => {
  const mockNodes = [
    // Ignored node: should be skipped
    {
      nodeId: '1',
      ignored: true,
      role: { value: 'none' },
      name: { value: 'Ignored container' },
    },
    // Node missing role value: should be skipped
    {
      nodeId: '2',
      role: {},
      name: { value: 'No role' },
    },
    // Node without role object: should be skipped
    {
      nodeId: '3',
      name: { value: 'No role prop' },
    },
    // Valid node with role and name
    {
      nodeId: '4',
      role: { value: 'button' },
      name: { value: 'Sign In' },
    },
    // Valid node with role and name containing quotes
    {
      nodeId: '5',
      role: { value: 'link' },
      name: { value: 'Read "Docs"' },
    },
    // Valid node with role and no name
    {
      nodeId: '6',
      role: { value: 'navigation' },
    },
    // Valid node with role and empty name string
    {
      nodeId: '7',
      role: { value: 'searchbox' },
      name: { value: '' },
    },
  ];

  assert.equal(typeof getCDPAriaSnapshot.formatNodes, 'function', 'formatNodes pure-mapper should be available');
  const formatted = getCDPAriaSnapshot.formatNodes(mockNodes);

  const lines = formatted.split('\n');
  assert.equal(lines.length, 4, 'Should contain exactly 4 valid lines');
  assert.equal(lines[0], '- ref=C1 button "Sign In"');
  assert.equal(lines[1], '- ref=C2 link "Read \\"Docs\\""');
  assert.equal(lines[2], '- ref=C3 navigation');
  assert.equal(lines[3], '- ref=C4 searchbox');
});

test('CDP getCDPAriaSnapshot: attaches debugger, executes command, and formats output', async () => {
  const attached = [];
  const commands = [];

  const mockTabId = 42;
  const mockNodes = [
    {
      nodeId: '10',
      role: { value: 'heading' },
      name: { value: 'Welcome' },
    },
    {
      nodeId: '11',
      ignored: true,
      role: { value: 'generic' },
    },
    {
      nodeId: '12',
      role: { value: 'button' },
      name: { value: 'Get Started' },
    },
  ];

  globalThis.chrome.debugger.attach = async ({ tabId }) => {
    attached.push(tabId);
  };
  globalThis.chrome.debugger.sendCommand = ({ tabId }, method, params, callback) => {
    commands.push({ tabId, method, params });
    if (method === 'Accessibility.getFullAXTree') {
      callback({ nodes: mockNodes });
    } else {
      callback({});
    }
  };

  const output = await getCDPAriaSnapshot(mockTabId);
  assert.ok(attached.includes(mockTabId), 'Debugger should be attached');
  assert.ok(commands.some((c) => c.method === 'Accessibility.getFullAXTree'), 'Should call Accessibility.getFullAXTree');

  const expected = [
    '- ref=C1 heading "Welcome"',
    '- ref=C2 button "Get Started"',
  ].join('\n');

  assert.equal(output, expected);
});

test('onMessage Runtime Interface: WEBMCP_FAST_ARIA action and snapshot integration', () => {
  const env = createAriaSnapshotEnvironment('https://example.com/checkout');
  const { listeners, fakeButton, api } = env;

  const onMessage = listeners[0];
  assert.equal(typeof onMessage, 'function', 'Listener should be registered');

  // 1. Snapshot via onMessage returns full result initially
  let snapRes1;
  onMessage({ type: 'WEBMCP_FAST_ARIA', method: 'snapshot', params: {} }, {}, (resp) => {
    snapRes1 = resp;
  });
  assert.equal(snapRes1.ok, true);
  assert.equal(snapRes1.result.source, 'content-script');

  // 2. Snapshot via onMessage returns unchanged short-circuit on immediate repeat
  let snapRes2;
  onMessage({ type: 'WEBMCP_FAST_ARIA', method: 'snapshot', params: {} }, {}, (resp) => {
    snapRes2 = resp;
  });
  assert.equal(snapRes2.ok, true);
  assert.equal(snapRes2.result.unchanged, true);
  assert.equal(
    snapRes2.result.text,
    '[SNAPSHOT_UNCHANGED: URL=https://example.com/checkout, elements unchanged since last step]'
  );

  // 3. Action on detached element returns preserved stale envelope
  const ref = api.ensureRef(fakeButton, { role: 'button', name: 'Submit' });
  fakeButton.isConnected = false;
  let actionRes1;
  onMessage(
    { type: 'WEBMCP_FAST_ARIA', method: 'action', params: { action: 'click', ref } },
    {},
    (resp) => {
      actionRes1 = resp;
    }
  );
  assert.equal(actionRes1.ok, true, 'onMessage should succeed and return envelope result');
  assert.equal(actionRes1.result.success, false);
  assert.equal(actionRes1.result.stale, true);
  assert.equal(actionRes1.result.error, `Ref "${ref}" is stale. Run getAriaSnapshot again.`);

  // 4. Action on expired ref returns preserved stale envelope
  let actionRes2;
  onMessage(
    { type: 'WEBMCP_FAST_ARIA', method: 'action', params: { action: 'click', ref: 'R88888' } },
    {},
    (resp) => {
      actionRes2 = resp;
    }
  );
  assert.equal(actionRes2.ok, true, 'onMessage should succeed and return envelope result');
  assert.equal(actionRes2.result.success, false);
  assert.equal(actionRes2.result.stale, true);
  assert.equal(actionRes2.result.error, 'Ref "R88888" is stale. Run getAriaSnapshot again.');

  // 5. Direct runRefAction calls verify preserved envelope directly
  const directStale = api.runRefAction({ action: 'click', ref });
  assert.equal(directStale.success, false);
  assert.equal(directStale.stale, true);
  assert.equal(directStale.error, `Ref "${ref}" is stale. Run getAriaSnapshot again.`);

  const directExpired = api.runRefAction({ action: 'click', ref: 'R88888' });
  assert.equal(directExpired.success, false);
  assert.equal(directExpired.stale, true);
  assert.equal(directExpired.error, 'Ref "R88888" is stale. Run getAriaSnapshot again.');
});

test('Public Handler Regression: getAriaSnapshot unchanged short-circuit, forceFresh forwarding, and stale envelope', async () => {
  const env = createAriaSnapshotEnvironment('https://example.com/checkout');
  const { listeners, fakeButton } = env;
  const onMessage = listeners[0];

  let cdpCommandCount = 0;
  globalThis.chrome.debugger.sendCommand = (_target, _method, _params, callback) => {
    cdpCommandCount++;
    if (typeof callback === 'function') callback({});
  };

  // Route chrome.tabs.sendMessage to content-script onMessage listener
  globalThis.chrome.tabs.sendMessage = (tabId, message, options, callback) => {
    onMessage(message, { tab: { id: tabId } }, (response) => {
      if (typeof callback === 'function') callback(response);
    });
  };

  // 1. Initial snapshot through public handler
  const initial = await ariaSnapshotHandlers.getAriaSnapshot({ tabId: 1, mode: 'auto' });
  assert.equal(initial.tabId, 1);
  assert.equal(initial.source, 'content-script');
  assert.equal(initial.unchanged, undefined);
  assert.ok(initial.snapshot.includes('button "Submit"'));
  assert.equal(cdpCommandCount, 0, 'Initial snapshot should not escalate to CDP');

  // 2. Immediate second call with identical DOM/URL and forceFresh: false (or omitted)
  const unchanged = await ariaSnapshotHandlers.getAriaSnapshot({ tabId: 1, mode: 'auto' });
  assert.equal(unchanged.tabId, 1);
  assert.equal(unchanged.unchanged, true);
  assert.equal(
    unchanged.text,
    '[SNAPSHOT_UNCHANGED: URL=https://example.com/checkout, elements unchanged since last step]'
  );
  assert.ok(unchanged.snapshot.includes('button "Submit"'), 'Snapshot string must be preserved');
  assert.equal(unchanged.source, 'content-script');
  assert.equal(cdpCommandCount, 0, 'Unchanged snapshot must NOT escalate to CDP fallback');

  // 3. Third call with forceFresh: true forwards param and bypasses short-circuit
  const fresh = await ariaSnapshotHandlers.getAriaSnapshot({ tabId: 1, mode: 'auto', forceFresh: true });
  assert.equal(fresh.tabId, 1);
  assert.equal(fresh.source, 'content-script');
  assert.equal(fresh.unchanged, undefined, 'forceFresh must bypass unchanged short-circuit');
  assert.equal(cdpCommandCount, 0, 'Fast snapshot with forceFresh should not escalate to CDP');

  // 4. Stale ref action through public handler clickByRef
  const match = initial.snapshot.match(/ref=([^\s]+)/);
  assert.ok(match, 'Snapshot should contain a ref');
  const qualifiedRef = match[1];

  // Detach element
  fakeButton.isConnected = false;

  await assert.rejects(
    () => ariaSnapshotHandlers.clickByRef({ tabId: 1, ref: qualifiedRef }),
    (err) => {
      assert.ok(err.message.includes('is stale'), 'Error should indicate ref is stale');
      assert.ok(err.message.includes('Run getAriaSnapshot again'), 'Error should include guidance hint');
      return true;
    }
  );
});

test('Native Fallback Guard: consecutive calls in auto mode with nearly-empty fast snapshot both reach Accessibility.getFullAXTree', async () => {
  const env = createAriaSnapshotEnvironment('https://example.com/canvas-app');
  const { listeners, body } = env;
  const onMessage = listeners[0];

  // Remove elements from body so fast snapshot is nearly empty (nodeCount <= 1)
  body.childNodes = [];
  body.children = [];

  let fullAXTreeCalls = 0;
  const mockNodes = [
    {
      nodeId: '1',
      role: { value: 'RootWebArea' },
      childIds: ['2'],
    },
    {
      nodeId: '2',
      role: { value: 'button' },
      name: { value: 'Native Canvas Control' },
    },
  ];

  globalThis.chrome.debugger.sendCommand = (_target, method, _params, callback) => {
    if (method === 'Accessibility.getFullAXTree') {
      fullAXTreeCalls++;
      if (typeof callback === 'function') callback({ nodes: mockNodes });
    } else {
      if (typeof callback === 'function') callback({});
    }
  };

  // Route chrome.tabs.sendMessage to content-script onMessage listener
  globalThis.chrome.tabs.sendMessage = (tabId, message, options, callback) => {
    onMessage(message, { tab: { id: tabId } }, (response) => {
      if (typeof callback === 'function') callback(response);
    });
  };

  // 1. First call in auto mode: fast snapshot is nearly empty, must reach Accessibility.getFullAXTree
  const snap1 = await ariaSnapshotHandlers.getAriaSnapshot({ tabId: 1, mode: 'auto' });
  assert.equal(fullAXTreeCalls, 1, 'First call must reach Accessibility.getFullAXTree');
  assert.ok(snap1.snapshot.includes('button "Native Canvas Control"'));

  // 2. Second call in auto mode: unchanged fast snapshot must not skip native fallback
  const snap2 = await ariaSnapshotHandlers.getAriaSnapshot({ tabId: 1, mode: 'auto' });
  assert.equal(fullAXTreeCalls, 2, 'Second call must also reach Accessibility.getFullAXTree');
  assert.ok(snap2.snapshot.includes('button "Native Canvas Control"'));
});

