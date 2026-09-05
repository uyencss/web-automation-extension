import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COORDINATOR_DISPATCH_REQUEST_SCHEMA,
  COORDINATOR_DISPATCHER_ERROR_CODES,
  COORDINATOR_DISPATCHER_MARKER,
  COORDINATOR_DISPATCHER_TOOLS,
  createCoordinatorDispatcher,
} from '../../server/gateway/coordinator-dispatcher.mjs';

function request(tool, input) {
  return {
    schema: COORDINATOR_DISPATCH_REQUEST_SCHEMA,
    tool,
    input,
    dispatchId: 'disp_browser_adapter_test',
    taskId: 'task_browser_adapter_test',
    fenceEpoch: 4,
  };
}

function permit() {
  return {
    permitId: 'permit_not_worker_data',
    profileAlias: 'research-profile',
    actionClasses: ['browser.invokeTool', 'browser.listTools'],
    origins: ['https://example.test'],
    signature: 'signature-held-by-coordinator',
  };
}

test('coordinator dispatcher posts only the typed WebMCP surface with authority held outside the request', async () => {
  const calls = [];
  const dispatcher = createCoordinatorDispatcher({
    gatewayUrl: 'http://127.0.0.1:7865',
    permitProvider: () => permit(),
    targetOrigin: 'https://example.test',
    gatewayToken: 'gateway-token-held-by-coordinator',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        result: { tabId: 7, parsedContent: { text: 'adaptive result' } },
        receipt: { permitId: 'receipt-stays-outside-worker' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(dispatcher.allowedTools, COORDINATOR_DISPATCHER_TOOLS);
  assert.equal(Object.isFrozen(dispatcher), true);
  assert.equal(Object.isFrozen(dispatcher.allowedTools), true);
  assert.equal(Object.isFrozen(dispatcher.dispatch), true);
  assert.equal(dispatcher.dispatch[COORDINATOR_DISPATCHER_MARKER].owner, 'coordinator');
  assert.equal(dispatcher.dispatch[COORDINATOR_DISPATCHER_MARKER].dispatch, dispatcher.dispatch);

  const result = await dispatcher.dispatch(request('webmcp.invokeTool', {
    toolName: 'read_summary',
    input: { tabId: 7 },
  }));
  assert.deepEqual(result, { tabId: 7, parsedContent: { text: 'adaptive result' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:7865/api');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer gateway-token-held-by-coordinator');
  assert.deepEqual(calls[0].body.params, {
    toolName: 'read_summary',
    input: { tabId: 7 },
    targetOrigin: 'https://example.test',
  });
  assert.equal(calls[0].body.profileId, 'research-profile');
  assert.deepEqual(calls[0].body.permit, permit());
  assert.equal(Object.hasOwn(result, 'permitId'), false);
  assert.equal(JSON.stringify(result).includes('gateway-token-held-by-coordinator'), false);

  await dispatcher.dispatch(request('webmcp.listTools', { tabId: 7 }));
  assert.equal(calls[1].body.method, 'webmcp.listTools');
});

test('coordinator dispatcher rejects direct browser selectors, authority in worker input, and unlisted tools', async () => {
  const dispatcher = createCoordinatorDispatcher({
    permitProvider: () => permit(),
    targetOrigin: 'https://example.test',
    fetchImpl: async () => new Response(JSON.stringify({ result: { ok: true } }), { status: 200 }),
  });

  await assert.rejects(
    () => dispatcher.dispatch(request('browser.navigate', { url: 'https://example.test' })),
    (error) => error.code === COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST,
  );
  await assert.rejects(
    () => dispatcher.dispatch(request('webmcp.invokeTool', { toolName: 'read_summary', profileId: 'physical' })),
    (error) => error.code === COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST,
  );
  await assert.rejects(
    () => dispatcher.dispatch(request('webmcp.invokeTool', { toolName: 'read_summary', input: { token: 'must-deny' } })),
    (error) => error.code === COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST,
  );
  await assert.rejects(
    () => dispatcher.dispatch(request('webmcp.invokeTool', { toolName: 'read_summary', input: { command: 'node' } })),
    (error) => error.code === COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST,
  );
  await assert.rejects(
    () => dispatcher.dispatch(request('webmcp.invokeTool', { toolName: 'read_summary', input: { url: 'https://example.invalid' } })),
    (error) => error.code === COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST,
  );
  await assert.rejects(
    () => dispatcher.dispatch({ ...request('webmcp.invokeTool', { toolName: 'read_summary' }), unexpected: true }),
    (error) => error.code === COORDINATOR_DISPATCHER_ERROR_CODES.INVALID_REQUEST,
  );
});

test('coordinator dispatcher fails closed without permit, target origin, or bounded result', async () => {
  assert.throws(
    () => createCoordinatorDispatcher({
      targetOrigin: 'https://example.test',
      fetchImpl: async () => new Response(JSON.stringify({ result: {} }), { status: 200 }),
    }),
    (error) => error.code === COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING,
  );

  const noOrigin = createCoordinatorDispatcher({
    permitProvider: () => permit(),
    fetchImpl: async () => new Response(JSON.stringify({ result: {} }), { status: 200 }),
  });
  await assert.rejects(
    () => noOrigin.dispatch(request('webmcp.listTools', {})),
    (error) => error.code === COORDINATOR_DISPATCHER_ERROR_CODES.AUTHORITY_MISSING,
  );

  const oversized = createCoordinatorDispatcher({
    permitProvider: () => permit(),
    targetOrigin: 'https://example.test',
    fetchImpl: async () => new Response(JSON.stringify({ result: { text: 'x'.repeat(50_000) } }), { status: 200 }),
  });
  await assert.rejects(
    () => oversized.dispatch(request('webmcp.listTools', {})),
    (error) => error.code === COORDINATOR_DISPATCHER_ERROR_CODES.RESULT_INVALID,
  );

  const callbackFailure = createCoordinatorDispatcher({
    permitProvider: () => permit(),
    targetOrigin: 'https://example.test',
    fetchImpl: async () => {
      throw new Error('bearer secret must not leak');
    },
  });
  await assert.rejects(
    () => callbackFailure.dispatch(request('webmcp.listTools', {})),
    (error) => error.code === COORDINATOR_DISPATCHER_ERROR_CODES.GATEWAY_UNAVAILABLE
      && error.message === 'coordinator gateway request failed'
      && !error.message.includes('bearer'),
  );
});
