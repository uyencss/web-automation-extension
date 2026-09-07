import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import { classifyTool } from '../../server/gateway/verifier.mjs';
import { canonicalJson, digestCanonical, SCHEMAS } from '../../server/gateway/trusted-context-schema.mjs';
import {
  createGatewayServer,
  getKnownRawMethods,
  mapGatewayCommand,
  mapGatewayRequest,
  rawOriginScopeError,
} from '../../server/gateway_server.js';
import { digestAction } from '../../server/gateway/trusted-context-schema.mjs';

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor timed out');
}

function makeFakeExtension(port, profileId, responseFactory) {
  const forwarded = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'extensionReady',
      params: { name: 'adapter-test-ext', version: '1.0.0', profileId },
    }));
  });
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (!('id' in message)) return;
    forwarded.push(message);
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: responseFactory(message),
    }));
  });
  return { ws, forwarded };
}

function makeSignedAuthority({ actionClasses = ['browser.raw.getCookies'] } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const now = Date.now();
  const digest = (char) => `sha256:${char.repeat(64)}`;
  const keys = { privateKey, rawPublicKeyHex, keyId: 'adapter-test-key' };
  const shared = {
    runId: 'run_adapter_raw_unknown',
    claimGeneration: 2,
    claimDigest: digest('0'),
    projectId: 'project_adapter_raw_unknown',
    profileAlias: 'adapter-profile',
    profileId: 'adapter-profile',
    bindingId: 'binding_adapter_raw_unknown',
    bindingRevision: 1,
    bindingDigest: digest('1'),
    automationStoreRevision: 1,
    automationStoreDigest: digest('2'),
    siteStoreRevision: 1,
    siteStoreDigest: digest('3'),
    phaseId: 'interactive-action',
    stateVersion: 1,
    planRevision: 1,
    planDigest: digest('4'),
    instructionDigest: digest('5'),
    policyRevision: digest('6'),
    keyId: keys.keyId,
    issuedAt: new Date(now).toISOString(),
    notBefore: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3600000).toISOString(),
    ttlMs: 60000,
  };
  const contextBase = {
    schema: SCHEMAS.TRUSTED_CONTEXT,
    messageId: 'ctxmsg_adapter_raw_unknown',
    seq: 1,
    ...shared,
    fenceEpoch: 2,
    publicKey: rawPublicKeyHex,
    revocations: [],
  };
  const contextCanonical = canonicalJson(contextBase);
  const context = {
    ...contextBase,
    contextDigest: digestCanonical('webmcp-digest-v1:trusted-context', contextBase),
    signature: sign(null, Buffer.from(`webmcp-digest-v1:trusted-context\n${contextCanonical}`), privateKey).toString('hex'),
  };
  const permitBase = {
    schema: SCHEMAS.PERMIT,
    permitId: 'permit_adapter_raw_unknown',
    ...shared,
    origins: ['https://example.test'],
    actionClasses,
    budget: { maxCalls: 2 },
    nonce: 'nonce_adapter_raw_unknown',
    revocationId: 'rev_adapter_raw_unknown',
  };
  const permitCanonical = canonicalJson(permitBase);
  const permit = {
    ...permitBase,
    permitDigest: digestCanonical('webmcp-digest-v1:permit', permitBase),
    signature: sign(null, Buffer.from(`webmcp-digest-v1:permit\n${permitCanonical}`), privateKey).toString('hex'),
  };
  return { context, permit, socketPath: path.join(os.tmpdir(), `adapter-raw-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`), rawPublicKeyHex, publicKey, keyId: keys.keyId };
}

function sendSocketMessage(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => socket.write(`${JSON.stringify(payload)}\n`));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(JSON.parse(data.trim())));
    socket.on('error', reject);
  });
}

async function postBatch(port, actions) {
  return fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      method: 'browser_batch',
      profileId: 'adapter-profile',
      params: { actions },
    }),
  });
}

test('wire aliases map to extension methods while native and raw methods remain unchanged', () => {
  const aliases = {
    browser_navigate: 'navigate',
    browser_click: 'click',
    browser_type: 'type',
    browser_scroll: 'scroll',
    browser_select: 'selectOption',
    browser_hover: 'hover',
    browser_page_text: 'getPageText',
    browser_aria_snapshot: 'getAriaSnapshot',
    browser_element_bounds: 'getElementBounds',
    browser_press: 'pressKey',
    browser_close: 'closeTab',
    browser_getPageText: 'getPageText',
    browser_getAriaSnapshot: 'getAriaSnapshot',
    browser_getElementBounds: 'getElementBounds',
    browser_clickByRef: 'clickByRef',
    browser_typeByRef: 'typeByRef',
    browser_evaluateJS: 'evaluateJS',
    browser_querySelectorAll: 'querySelectorAll',
    browser_waitForStable: 'waitForStable',
    browser_pressKey: 'pressKey',
    browser_selectOption: 'selectOption',
    browser_closeTab: 'closeTab',
    browser_get_page_text: 'getPageText',
    browser_get_aria_snapshot: 'getAriaSnapshot',
    browser_get_element_bounds: 'getElementBounds',
    browser_click_by_ref: 'clickByRef',
    browser_type_by_ref: 'typeByRef',
    browser_evaluate_js: 'evaluateJS',
    browser_query_selector_all: 'querySelectorAll',
    browser_wait_for_stable: 'waitForStable',
    browser_press_key: 'pressKey',
    browser_select_option: 'selectOption',
    browser_close_tab: 'closeTab',
    browser_evaluate: 'evaluateJS',
    browser_screenshot: 'screenshot',
    browser_batch: 'batch',
  };
  for (const [wireMethod, extensionMethod] of Object.entries(aliases)) {
    assert.equal(mapGatewayCommand(wireMethod), extensionMethod, wireMethod);
  }
  assert.equal(mapGatewayCommand('getPageText'), 'getPageText');
  assert.equal(mapGatewayCommand('clickByRef'), 'clickByRef');
  assert.deepEqual(
    mapGatewayRequest('browser_raw_command', { method: 'navigate', params: { url: 'https://example.test' } }),
    { method: 'navigate', params: { url: 'https://example.test' } },
  );
  assert.equal(
    mapGatewayRequest('browser_raw_command', { method: 'navigate', command: 'getPageText', params: {} }).error,
    'TOOL_ACTION_NOT_ALLOWED',
  );
  assert.equal(
    mapGatewayRequest('browser_raw_command', { method: 'list_profiles', params: {} }).error,
    'TOOL_ACTION_NOT_ALLOWED',
  );
  assert.equal(classifyTool('browser_raw_command', { method: 'deleteCookies' }), 'browser.raw.deleteCookies');
  assert.deepEqual(
    mapGatewayRequest('browser_raw_command', { method: 'deleteCookies', params: {} }),
    { method: 'deleteCookies', params: {} },
  );
});

test('raw resolver and verifier agree on every catalogued raw leaf', () => {
  for (const leaf of getKnownRawMethods()) {
    assert.notEqual(classifyTool('browser_raw_command', { method: leaf }), 'browser.raw.unknown', leaf);
    const resolved = mapGatewayRequest('browser_raw_command', { method: leaf, params: {} });
    assert.equal(resolved.error, undefined, leaf);
  }
});

test('allowed raw leaves unwrap to native extension commands while receipt input remains the raw wrapper', async (t) => {
  const app = createGatewayServer({ port: 0, interactiveMode: 'off', token: 'test-token', allowTestSeams: true });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'adapter-profile', (message) => ({ success: true, echoedMethod: message.method }));
  t.after(() => fakeExt.ws.terminate());
  await waitFor(() => app.connectedProfileIds().includes('adapter-profile'));

  const rawCalls = [
    { method: 'navigate', params: { url: 'https://example.test' } },
    { method: 'getPageText', params: {} },
  ];
  for (const rawCall of rawCalls) {
    const response = await fetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({
        method: 'browser_raw_command',
        profileId: 'adapter-profile',
        params: rawCall,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.receipt.outcome, 'applied');
    assert.equal(body.receipt.actionDigest, digestAction({
      method: 'browser_raw_command',
      params: rawCall,
      targetOrigin: null,
    }));
  }
  assert.deepEqual(fakeExt.forwarded.map((message) => message.method), ['navigate', 'getPageText']);
  assert.deepEqual(fakeExt.forwarded[0].params, { url: 'https://example.test' });
  assert.deepEqual(fakeExt.forwarded[1].params, {});
});

test('conflicting raw aliases are denied before extension forwarding', async (t) => {
  const app = createGatewayServer({ port: 0, interactiveMode: 'off', token: 'test-token', allowTestSeams: true });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'adapter-profile', () => ({ success: true }));
  t.after(() => fakeExt.ws.terminate());
  await waitFor(() => app.connectedProfileIds().includes('adapter-profile'));

  const response = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      method: 'browser_raw_command',
      profileId: 'adapter-profile',
      params: { method: 'navigate', command: 'getPageText', params: {} },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error, 'TOOL_ACTION_NOT_ALLOWED');
  assert.equal(fakeExt.forwarded.length, 0);
});

test('download wire aliases use Gateway-local handlers and never reach the extension', async (t) => {
  const app = createGatewayServer({ port: 0, interactiveMode: 'off', token: 'test-token', allowTestSeams: true });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'adapter-profile', () => ({ success: true }));
  t.after(() => fakeExt.ws.terminate());
  await waitFor(() => app.connectedProfileIds().includes('adapter-profile'));

  for (const method of ['browser_list_download_events', 'browser_clear_download_events']) {
    const response = await fetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ method, profileId: 'adapter-profile', params: {} }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.match(body.result.schema, /^webmcp-download-events/);
  }
  assert.equal(fakeExt.forwarded.length, 0);
});

test('download aliases fail closed when no effective profile exists', async (t) => {
  const app = createGatewayServer({ port: 0, interactiveMode: 'off', token: 'test-token', allowTestSeams: true });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });

  const response = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'browser_list_download_events', params: {} }),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, 'PROFILE_REQUIRED');
  assert.equal(body.receipt.outcome, 'blocked');
});

test('unknown raw leaf is denied before extension forwarding', async (t) => {
  const authority = makeSignedAuthority();
  const app = createGatewayServer({
    port: 0,
    socketPath: authority.socketPath,
    publicKey: authority.publicKey,
    keyId: authority.keyId,
    interactiveMode: 'enforce',
    token: 'test-token',
    allowTestSeams: true,
  });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'adapter-profile', () => ({ success: true }));
  t.after(() => fakeExt.ws.terminate());
  await waitFor(() => app.connectedProfileIds().includes('adapter-profile'));
  const contextAck = await sendSocketMessage(authority.socketPath, authority.context);
  assert.equal(contextAck.ok, true);

  const response = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      method: 'browser_raw_command',
      profileId: 'adapter-profile',
      params: { method: 'not-a-known-leaf', params: { url: 'https://example.test' } },
      permit: authority.permit,
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error, 'TOOL_ACTION_NOT_ALLOWED');
  assert.equal(body.reason, 'TOOL_ACTION_NOT_ALLOWED');
  assert.equal(fakeExt.forwarded.length, 0);
  assert.equal(body.receipt.outcome, 'blocked');
});

test('raw inner origin must match the outer target assertion and permit origins', async (t) => {
  const authority = makeSignedAuthority({ actionClasses: ['browser.raw.navigate'] });
  const app = createGatewayServer({
    port: 0,
    socketPath: authority.socketPath,
    publicKey: authority.publicKey,
    keyId: authority.keyId,
    interactiveMode: 'enforce',
    token: 'test-token',
    allowTestSeams: true,
  });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'adapter-profile', () => ({ success: true }));
  t.after(() => fakeExt.ws.terminate());
  await waitFor(() => app.connectedProfileIds().includes('adapter-profile'));
  assert.equal((await sendSocketMessage(authority.socketPath, authority.context)).ok, true);
  assert.equal(
    rawOriginScopeError(
      'browser_raw_command',
      { method: 'navigate', params: { url: 'https://evil.test' } },
      'https://example.test',
      authority.permit,
    ),
    'EXECUTION_PERMIT_SCOPE_DENIED',
  );

  const response = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      method: 'browser_raw_command',
      profileId: 'adapter-profile',
      targetOrigin: 'https://example.test',
      params: { method: 'navigate', params: { url: 'https://evil.test' } },
      permit: authority.permit,
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');
  assert.equal(fakeExt.forwarded.length, 0);
});

test('single wire alias forwards only after the gateway decision and keeps its original receipt digest', async (t) => {
  const app = createGatewayServer({ port: 0, interactiveMode: 'off', token: 'test-token', allowTestSeams: true });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'adapter-profile', (message) => ({ success: true, echoedMethod: message.method }));
  t.after(() => fakeExt.ws.terminate());
  await waitFor(() => app.connectedProfileIds().includes('adapter-profile'));

  const params = { url: 'https://example.test' };
  const response = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'browser_navigate', profileId: 'adapter-profile', params }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(fakeExt.forwarded[0].method, 'navigate');
  assert.equal(body.receipt.outcome, 'applied');
  assert.equal(body.receipt.actionDigest, digestAction({
    method: 'browser_navigate',
    params,
    targetOrigin: 'https://example.test',
  }));
});

test('batch forwards mapped methods in order and preserves original action digests', async (t) => {
  const app = createGatewayServer({ port: 0, interactiveMode: 'off', token: 'test-token', allowTestSeams: true });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'adapter-profile', () => ({
    total: 3,
    executed: 3,
    success: 3,
    errors: 0,
    results: [
      { index: 0, method: 'navigate', ok: true, result: { success: true } },
      { index: 1, method: 'click', ok: true, result: { success: true } },
      { index: 2, method: 'getPageText', ok: true, result: { text: 'ok' } },
    ],
  }));
  t.after(() => fakeExt.ws.terminate());
  await waitFor(() => app.connectedProfileIds().includes('adapter-profile'));

  const actions = [
    { method: 'browser_navigate', params: { url: 'https://example.test' } },
    { method: 'browser_click', params: { selector: '#go' } },
    { method: 'browser_page_text', params: {} },
  ];
  const response = await postBatch(port, actions);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(fakeExt.forwarded.length, 1);
  assert.equal(fakeExt.forwarded[0].method, 'batch');
  assert.deepEqual(
    fakeExt.forwarded[0].params.actions.map((action) => action.method),
    ['navigate', 'click', 'getPageText'],
  );
  assert.equal(body.receipt.outcome, 'applied');
  assert.deepEqual(body.receipts.map((receipt) => receipt.outcome), ['applied', 'applied', 'applied']);
  assert.equal(
    body.receipts[0].actionDigest,
    digestAction({ method: actions[0].method, params: actions[0].params, targetOrigin: 'https://example.test' }),
  );
  assert.equal(
    body.receipts[1].actionDigest,
    digestAction({ method: actions[1].method, params: actions[1].params, targetOrigin: null }),
  );
});

test('batch raw children unwrap known leaves and reject unknown leaves before any forward', async (t) => {
  const app = createGatewayServer({ port: 0, interactiveMode: 'off', token: 'test-token', allowTestSeams: true });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'adapter-profile', (message) => ({
    total: message.params.actions.length,
    executed: message.params.actions.length,
    success: true,
    errors: 0,
    results: message.params.actions.map((action, index) => ({
      index,
      method: action.method,
      ok: true,
      result: { success: true },
    })),
  }));
  t.after(() => fakeExt.ws.terminate());
  await waitFor(() => app.connectedProfileIds().includes('adapter-profile'));

  const knownActions = [
    { method: 'browser_raw_command', params: { method: 'navigate', params: { url: 'https://example.test' } } },
    { method: 'browser_raw_command', params: { method: 'getPageText', params: {} } },
  ];
  const knownResponse = await postBatch(port, knownActions);
  const knownBody = await knownResponse.json();
  assert.equal(knownResponse.status, 200);
  assert.deepEqual(fakeExt.forwarded[0].params.actions.map((action) => action.method), ['navigate', 'getPageText']);
  assert.equal(knownBody.receipts[0].actionDigest, digestAction({
    method: knownActions[0].method,
    params: knownActions[0].params,
    targetOrigin: null,
  }));

  const unknownResponse = await postBatch(port, [
    { method: 'browser_raw_command', params: { method: 'not-a-known-leaf', params: {} } },
  ]);
  const unknownBody = await unknownResponse.json();
  assert.equal(unknownResponse.status, 403);
  assert.equal(unknownBody.error, 'TOOL_ACTION_NOT_ALLOWED');
  assert.equal(fakeExt.forwarded.length, 1);

  for (const nestedAction of [
    { method: 'batch', params: { actions: [] } },
    { method: 'browser_raw_command', params: { method: 'batch', params: { actions: [] } } },
  ]) {
    const nestedResponse = await postBatch(port, [nestedAction]);
    const nestedBody = await nestedResponse.json();
    assert.equal(nestedResponse.status, 403);
    assert.equal(nestedBody.error, 'TOOL_ACTION_NOT_ALLOWED');
    assert.equal(fakeExt.forwarded.length, 1);
  }
});

test('batch rejects reordered or mismatched child indexes before issuing an applied aggregate', async (t) => {
  const app = createGatewayServer({ port: 0, interactiveMode: 'off', token: 'test-token', allowTestSeams: true });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'adapter-profile', () => ({
    total: 2,
    executed: 2,
    success: true,
    errors: 0,
    results: [
      { index: 1, method: 'click', ok: true, result: { success: true } },
      { index: 0, method: 'navigate', ok: true, result: { success: true } },
    ],
  }));
  t.after(() => fakeExt.ws.terminate());
  await waitFor(() => app.connectedProfileIds().includes('adapter-profile'));

  const response = await postBatch(port, [
    { method: 'browser_navigate', params: { url: 'https://example.test' } },
    { method: 'browser_click', params: { selector: '#go' } },
  ]);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error, 'EXECUTION_FAILED');
  assert.equal(body.receipt.outcome, 'failed');
  assert.equal(body.receipt.decision, 'deny');
  assert.deepEqual(body.receipts.map((receipt) => receipt.outcome), ['failed', 'failed']);
  assert.deepEqual(body.receipts.map((receipt) => receipt.decision), ['deny', 'deny']);
});

test('batch child failure or unknown ok state returns typed failure without an allow aggregate', async (t) => {
  const app = createGatewayServer({ port: 0, interactiveMode: 'off', token: 'test-token', allowTestSeams: true });
  const { port } = await app.start();
  t.after(async () => { await app.close(); });
  const fakeExt = makeFakeExtension(port, 'adapter-profile', () => ({
    total: 3,
    executed: 3,
    success: false,
    errors: 2,
    results: [
      { index: 0, method: 'navigate', ok: true, result: { success: true } },
      { index: 1, method: 'click', ok: false, error: { code: -32601, message: 'Method not found: click' } },
      { index: 2, method: 'getPageText', result: { text: 'unknown ok state' } },
    ],
  }));
  t.after(() => fakeExt.ws.terminate());
  await waitFor(() => app.connectedProfileIds().includes('adapter-profile'));

  const actions = [
    { method: 'browser_navigate', params: { url: 'https://example.test' } },
    { method: 'browser_click', params: { selector: '#go' } },
    { method: 'browser_page_text', params: {} },
  ];
  const response = await postBatch(port, actions);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error, 'EXECUTION_FAILED');
  assert.equal(body.errorType, 'EXECUTION_FAILED');
  assert.equal(body.receipt.outcome, 'failed');
  assert.notEqual(body.receipt.outcome, 'applied');
  assert.notEqual(body.receipt.decision, 'allow');
  assert.equal(body.receipt.decision, 'deny');
  assert.deepEqual(body.receipts.map((receipt) => receipt.outcome), ['applied', 'failed', 'failed']);
  assert.deepEqual(body.receipts.map((receipt) => receipt.decision), ['allow', 'deny', 'deny']);
  assert.deepEqual(body.receipts.map((receipt) => receipt.sequence), [1, 2, 3]);
  assert.equal(body.receipts[1].reason, 'BATCH_CHILD_FAILED');
  assert.equal(body.receipts[2].reason, 'BATCH_CHILD_FAILED');
  assert.equal(body.receipts[1].actionDigest, digestAction({
    method: actions[1].method,
    params: actions[1].params,
    targetOrigin: null,
  }));
});

test('batch failure/indeterminate decisions deny consistently and permitless aggregates keep null permitId', () => {
  const app = createGatewayServer({ port: 0, interactiveMode: 'off', allowTestSeams: true });
  const context = { runId: 'context-only-run', profileAlias: 'adapter-profile', profileId: 'adapter-profile' };
  const actions = [{ method: 'navigate', params: { url: 'https://example.test' } }];
  const applied = app.runtime.createBatchAppliedReceipts({
    permit: null,
    context,
    actions,
    results: [{ index: 0, ok: true }],
  });
  assert.equal(applied.aggregate.permitId, null);

  const failed = app.runtime.createBatchResultReceipts({
    permit: null,
    context,
    actions,
    results: [{ index: 0, ok: false }],
  });
  assert.equal(failed.aggregate.permitId, null);
  assert.equal(failed.aggregate.decision, 'deny');
  assert.equal(failed.children[0].decision, 'deny');

  const methodMismatch = app.runtime.createBatchResultReceipts({
    permit: null,
    context,
    actions: [{ method: 'browser_navigate', forwardedMethod: 'navigate', params: actions[0].params }],
    results: [{ index: 0, method: 'click', ok: true }],
  });
  assert.equal(methodMismatch.aggregate.outcome, 'failed');
  assert.equal(methodMismatch.aggregate.decision, 'deny');
  assert.equal(methodMismatch.children[0].outcome, 'failed');
  assert.equal(methodMismatch.children[0].decision, 'deny');

  const noReasonFailed = app.runtime.createFailedReceipt({
    permit: null,
    context,
    method: 'navigate',
    params: actions[0].params,
  });
  const noReasonIndeterminate = app.runtime.createIndeterminateReceipt({
    permit: null,
    context,
    method: 'navigate',
    params: actions[0].params,
  });
  assert.equal(noReasonFailed.decision, 'deny');
  assert.equal(noReasonIndeterminate.decision, 'deny');

  const indeterminateChild = app.runtime.createIndeterminateReceipt({
    permit: null,
    context,
    method: 'navigate',
    params: actions[0].params,
    reason: 'GATEWAY_TIMEOUT',
  });
  const indeterminateAggregate = app.runtime.createIndeterminateReceipt({
    permit: null,
    context,
    method: 'batch',
    params: { count: 1 },
    reason: 'GATEWAY_TIMEOUT',
    children: [indeterminateChild],
  });
  assert.equal(indeterminateAggregate.decision, 'deny');
  assert.equal(indeterminateAggregate.children[0].decision, 'deny');
});
