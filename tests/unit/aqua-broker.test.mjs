import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { handleAquaBrokerRequest, isLoopbackAddress } from '../../server/gateway/aqua-broker.mjs';
import { isMacSshOrNonAqua, callAquaBroker, getAquaServiceStatus } from '../../lib/cli/aqua-broker-client.mjs';

function makeMockRes() {
  let statusCode = 0;
  let headers = {};
  let body = '';
  return {
    writeHead(code, hdrs = {}) {
      statusCode = code;
      headers = hdrs;
    },
    end(chunk = '') {
      body += chunk;
    },
    get result() {
      return {
        statusCode,
        headers,
        json: body ? JSON.parse(body) : null,
      };
    },
  };
}

function makeMockReq({ method = 'GET', url = '/api/aqua/status', remoteAddress = '127.0.0.1', headers = {}, body } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  if (body !== undefined) {
    process.nextTick(() => {
      req.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  } else {
    process.nextTick(() => req.end());
  }
  return req;
}

test('aqua-broker enforces loopback-only, anti-CSRF Origin rejection, and bearer token check', async () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('100.100.207.69'), false);

  // 1. Rejects non-loopback Tailnet / LAN IP
  const resRemote = makeMockRes();
  await handleAquaBrokerRequest(
    makeMockReq({ remoteAddress: '100.100.207.69' }),
    resRemote,
  );
  assert.equal(resRemote.result.statusCode, 403);
  assert.equal(resRemote.result.json.code, 'ERR_AQUA_BROKER_LOOPBACK_ONLY');
  assert.equal(resRemote.result.headers['Access-Control-Allow-Origin'], undefined);

  // 2. Rejects any browser Origin header on loopback
  const resOrigin = makeMockRes();
  await handleAquaBrokerRequest(
    makeMockReq({ remoteAddress: '127.0.0.1', headers: { origin: 'https://evil.example' } }),
    resOrigin,
  );
  assert.equal(resOrigin.result.statusCode, 403);
  assert.equal(resOrigin.result.json.code, 'ERR_AQUA_BROKER_ORIGIN_FORBIDDEN');

  // 3. Rejects missing/invalid token when gateway auth enabled
  const resUnauth = makeMockRes();
  await handleAquaBrokerRequest(
    makeMockReq({ remoteAddress: '127.0.0.1' }),
    resUnauth,
    {
      token: 'secret-tok',
      extractToken: (r) => r.headers.authorization?.replace(/^Bearer\s+/i, '') || '',
      tokenMatches: (a, b) => a === b,
    },
  );
  assert.equal(resUnauth.result.statusCode, 401);
  assert.equal(resUnauth.result.json.code, 'UNAUTHORIZED');

  // 4. Rejects managedProfilesDir outside ~/.webmcp or tmpdir
  const resBadDir = makeMockRes();
  await handleAquaBrokerRequest(
    makeMockReq({
      method: 'POST',
      url: '/api/aqua/launch',
      remoteAddress: '127.0.0.1',
      body: {
        dryRun: true,
        managedProfilesDir: '/etc/evil-managed-profiles',
      },
    }),
    resBadDir,
  );
  if (resBadDir.result.statusCode !== 503) {
    // When running in Aqua GUI on darwin or on Linux, managedProfilesDir escape returns 400
    assert.equal(resBadDir.result.statusCode, 400);
    assert.equal(resBadDir.result.json.code, 'INVALID_REQUEST');
  }

  // 5. Rejects unsupported method & unknown endpoint
  const res405 = makeMockRes();
  await handleAquaBrokerRequest(makeMockReq({ method: 'DELETE', url: '/api/aqua/launch' }), res405);
  assert.equal(res405.result.statusCode, 405);

  // 6. Status endpoint always tags viaAquaService: true
  const resStatus = makeMockRes();
  await handleAquaBrokerRequest(makeMockReq({ method: 'GET', url: '/api/aqua/status' }), resStatus);
  assert.equal(resStatus.result.statusCode, 200);
  assert.equal(resStatus.result.json.viaAquaService, true);
});

test('aqua-broker-client detects SSH env and fails loudly with ERR_MACOS_AQUA_SERVICE_UNAVAILABLE when Gateway is offline', async () => {
  const aquaMgr = () => 'Aqua\n';
  const bgMgr = () => 'Background\n';
  assert.equal(isMacSshOrNonAqua({ SSH_CONNECTION: '1 2 3 4' }, { platform: 'darwin', execFileSyncFn: aquaMgr }), true);
  assert.equal(isMacSshOrNonAqua({}, { platform: 'darwin', execFileSyncFn: bgMgr }), true);
  assert.equal(isMacSshOrNonAqua({}, { platform: 'darwin', execFileSyncFn: aquaMgr }), false);
  assert.equal(isMacSshOrNonAqua({ SSH_CONNECTION: '1 2 3 4' }, { platform: 'linux', execFileSyncFn: aquaMgr }), false);

  // Probe unused high port via local server close
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const deadPort = srv.address().port;
  await new Promise((r) => srv.close(r));
  const deadUrl = `http://127.0.0.1:${deadPort}`;

  const st = await getAquaServiceStatus({ gatewayUrl: deadUrl, timeoutMs: 1000 });
  assert.equal(st.ok, false);
  assert.equal(st.reachable, false);
  assert.equal(st.code, 'ERR_MACOS_AQUA_SERVICE_UNAVAILABLE');

  await assert.rejects(
    () => callAquaBroker('launch', { dryRun: true }, { gatewayUrl: deadUrl, timeoutMs: 1000 }),
    (err) => err.code === 'ERR_MACOS_AQUA_SERVICE_UNAVAILABLE' && err.gatewayUrl === deadUrl,
  );
});

test('webmcp-browser launch refuses launch loudly when WEBMCP_NO_LAUNCH=1', () => {
  const res = spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, '../../bin/webmcp-browser.mjs'),
      'launch',
      '--name',
      'test-no-launch',
      '--json',
    ],
    {
      env: { ...process.env, WEBMCP_NO_LAUNCH: '1' },
      encoding: 'utf8',
    },
  );
  assert.equal(res.status, 1);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ERR_WEBMCP_NO_LAUNCH_BLOCKED');
});

test('N-4: GET /api/aqua/status caches probe result for 5000ms and bypasses cache when ?fresh=1', async () => {
  let probeCalls = 0;
  const mockProbe = () => {
    probeCalls += 1;
    return { ok: true, platform: 'darwin', managerName: 'Aqua', probeSeq: probeCalls };
  };

  const res1 = makeMockRes();
  await handleAquaBrokerRequest(makeMockReq({ method: 'GET', url: '/api/aqua/status' }), res1, { probeAquaSession: mockProbe });
  assert.equal(res1.result.statusCode, 200);
  assert.equal(res1.result.json.probeSeq, 1);

  const res2 = makeMockRes();
  await handleAquaBrokerRequest(makeMockReq({ method: 'GET', url: '/api/aqua/status' }), res2, { probeAquaSession: mockProbe });
  assert.equal(res2.result.json.probeSeq, 1);
  assert.equal(probeCalls, 1, 'second status call within 5000ms must hit cache');

  const resFresh = makeMockRes();
  await handleAquaBrokerRequest(makeMockReq({ method: 'GET', url: '/api/aqua/status?fresh=1' }), resFresh, { probeAquaSession: mockProbe });
  assert.equal(resFresh.result.json.probeSeq, 2);
  assert.equal(probeCalls, 2, '?fresh=1 must bypass status cache');
});
