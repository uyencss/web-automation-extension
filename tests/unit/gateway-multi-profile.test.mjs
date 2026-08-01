import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gatewayPath = join(__dirname, '../../server/gateway_server.js');
const PORT = 7899;
const BASE = `http://localhost:${PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A fake extension: identifies with profileId, then echoes back which profile
// answered each forwarded command. Ignores gateway ping/keepalive notifications.
function makeFakeExtension(profileId, label) {
  const sock = new WebSocket(`ws://localhost:${PORT}`);
  sock.forwarded = [];
  sock.on('open', () => {
    sock.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'extensionReady',
      params: { name: 'fake', version: `2.1.${label}`, profileId, capabilities: ['ping', 'activateTab'] },
    }));
  });
  sock.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (!('id' in msg)) return; // notification (ping/heartbeat) — ignore
    sock.forwarded.push(msg.method);
    // Anything with an id is a forwarded command; echo a result for it.
    sock.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { echoedBy: label, method: msg.method },
    }));
  });
  return sock;
}

async function getHealth() {
  const r = await fetch(`${BASE}/health`);
  return r.json();
}

async function callApi(bodyObj) {
  const r = await fetch(`${BASE}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  return { status: r.status, json: await r.json() };
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // gateway not up yet
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function run() {
  const gateway = spawn(process.execPath, [gatewayPath], {
    env: { ...process.env, WEBMCP_GATEWAY_PORT: String(PORT), WEBMCP_GATEWAY_PING_MS: '500' },
    stdio: 'ignore',
  });

  let a; let b;
  try {
    await waitFor(async () => (await getHealth()).ok === true, 'gateway /health up');

    // Before any extension connects: /api must report no connection.
    const noConn = await callApi({ method: 'ping', params: {} });
    assert.strictEqual(noConn.status, 503, 'no extension connected → 503');

    a = makeFakeExtension('profile-A', 'A');
    b = makeFakeExtension('profile-B', 'B');

    await waitFor(async () => {
      const h = await getHealth();
      return Array.isArray(h.profiles) && h.profiles.length === 2;
    }, 'both profiles registered');

    const health = await getHealth();
    assert.strictEqual(health.schema, 'webmcp-browser-gateway-health/1', 'health schema is pinned');
    assert.ok(health.profiles.includes('profile-A'), 'health lists profile-A');
    assert.ok(health.profiles.includes('profile-B'), 'health lists profile-B');
    assert.strictEqual(health.profileCount, 2, 'profileCount is 2');
    assert.strictEqual(health.extensionConnected, true, 'extensionConnected true');
    assert.ok(
      health.profileDetails.some((profile) =>
        profile.profileId === 'profile-A' &&
        profile.extensionVersion === '2.1.A' &&
        profile.capabilities.includes('activateTab')),
      'profileDetails includes per-profile extension version and capabilities',
    );

    const toA = await callApi({ method: 'ping', params: {}, profileId: 'profile-A' });
    assert.strictEqual(toA.status, 200, 'routed-to-A status 200');
    assert.strictEqual(toA.json.result.echoedBy, 'A', 'profile-A answered');

    const toB = await callApi({ method: 'ping', params: {}, profileId: 'profile-B' });
    assert.strictEqual(toB.status, 200, 'routed-to-B status 200');
    assert.strictEqual(toB.json.result.echoedBy, 'B', 'profile-B answered');

    const ambiguous = await callApi({ method: 'ping', params: {} });
    assert.strictEqual(ambiguous.status, 400, 'no profileId with 2 connected → 400');

    const unknown = await callApi({ method: 'ping', params: {}, profileId: 'nope' });
    assert.strictEqual(unknown.status, 404, 'unknown profileId → 404');

    a.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'downloadStarted',
      params: {
        id: 7,
        url: 'https://cdn.example.test/report.pdf',
        filename: '/private/downloads/report.pdf',
        mime: 'application/pdf',
        fileSize: 123,
        state: 'in_progress',
      },
    }));
    a.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'downloadChanged',
      params: { id: 7, state: 'complete', filename: '/private/downloads/report.pdf' },
    }));
    b.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'downloadStarted',
      params: {
        id: 8,
        url: 'https://cdn.example.test/other.pdf',
        filename: '/private/downloads/other.pdf',
        mime: 'application/pdf',
        fileSize: 456,
        state: 'complete',
      },
    }));
    await waitFor(async () => {
      const listed = await callApi({ method: 'listDownloadEvents', params: {}, profileId: 'profile-A' });
      return listed.json.result?.events?.length === 2;
    }, 'download events recorded');

    const downloadsA = await callApi({ method: 'listDownloadEvents', params: { limit: 10 }, profileId: 'profile-A' });
    assert.strictEqual(downloadsA.status, 200, 'download event list status 200');
    assert.strictEqual(downloadsA.json.result.schema, 'webmcp-download-events/1');
    assert.strictEqual(downloadsA.json.result.profileId, 'profile-A');
    assert.deepStrictEqual(downloadsA.json.result.events.map((event) => event.type), ['downloadStarted', 'downloadChanged']);
    assert.strictEqual(downloadsA.json.result.events[0].sourceOrigin, 'https://cdn.example.test');
    assert.strictEqual(downloadsA.json.result.events[0].mimeType, 'application/pdf');
    assert.strictEqual(downloadsA.json.result.events[0].filename, '/private/downloads/report.pdf');
    assert.strictEqual(a.forwarded.includes('listDownloadEvents'), false, 'local event query is not forwarded to extension');

    const cleared = await callApi({ method: 'clearDownloadEvents', params: {}, profileId: 'profile-A' });
    assert.strictEqual(cleared.status, 200, 'download event clear status 200');
    assert.strictEqual(cleared.json.result.cleared, 2);
    const afterClear = await callApi({ method: 'listDownloadEvents', params: {}, profileId: 'profile-A' });
    assert.strictEqual(afterClear.json.result.events.length, 0);
    const downloadsB = await callApi({ method: 'listDownloadEvents', params: {}, profileId: 'profile-B' });
    assert.strictEqual(downloadsB.json.result.events.length, 1, 'clearing A does not clear B');

    console.log('gateway-multi-profile.test.mjs OK');
  } finally {
    if (a) a.close();
    if (b) b.close();
    gateway.kill('SIGKILL');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
