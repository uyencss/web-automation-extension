// A3b activation (B2) — client permit plumbing acceptance harness (S1 RED).
//
// Pins: PINS.md (browser-kit 86e104d, vault-kit 0538a80).
// Behavioral only: each test spawns the real client process
// (server/mcp_server.mjs over MCP stdio, or webmcp-vault-kit
// bin/webmcp-vault.mjs) against a loopback stub HTTP gateway
// (http.createServer) and asserts on the received POST body. No browser,
// no network beyond loopback. Permit plumbing is NOT implemented yet, so the
// permit-present assertions fail RED with explicit capability messages while
// the permit-absent assertions pin the unchanged-body half of the contract.
//
// Run: A3_FENCE_MODE=enforce node --test tests/integration/a3b-*.test.mjs
// from source/packages/webmcp-browser-kit.
process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const KIT_ROOT = new URL('../..', import.meta.url);
const MCP_SERVER = fileURLToPath(new URL('../../server/mcp_server.mjs', import.meta.url));
const VAULT_BIN = fileURLToPath(new URL('../../../webmcp-vault-kit/bin/webmcp-vault.mjs', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Loopback stub gateway. Captures every /api POST body. In 'typed-error'
// mode every POST answers 403 with a typed PROFILE_ denial: the REAL
// string shape ({ error: "PROFILE_FENCE_REQUIRED",
// reason: "PROFILE_FENCE_REQUIRED" }) by default, or the legacy object
// shape ({ error: { code, message } }) with errorShape 'object'. Otherwise
// answers stubbed broker-fill shapes (evaluateJS carries both locate bounds
// and the verify match flag; invokeTool acks).
function startStubGateway(t, { mode = 'ok', errorShape = 'string' } = {}) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        if (mode === 'typed-error') {
          res.writeHead(403, { 'content-type': 'application/json' });
          const denial = errorShape === 'object'
            ? { error: { code: 'PROFILE_FENCE_REQUIRED', message: 'A current action fence is required' } }
            : { error: 'PROFILE_FENCE_REQUIRED', reason: 'PROFILE_FENCE_REQUIRED' };
          res.end(JSON.stringify(denial));
          return;
        }
        const body = bodies[bodies.length - 1];
        const result = body.method === 'evaluateJS'
          ? { match: true, x: 1, y: 2, tag: 'input', name: 'username', type: 'text' }
          : { ok: true };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ server, port: server.address().port, bodies });
    });
  });
}

// Spawns the real MCP client (server/mcp_server.mjs) with the given extra
// env, performs a minimal MCP handshake over stdio, and calls one tool.
// Returns the raw tools/call message.
async function callMcpTool(t, { gatewayPort, extraEnv = {}, deleteEnv = [], toolName = 'navigate', toolArgs = { url: 'https://example.test' } }) {
  const childEnv = {
    ...process.env,
    WEBMCP_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    WEBMCP_TOOLS: 'full',
    WEBMCP_NO_AUTOSTART: '1',
    ...extraEnv,
  };
  for (const key of deleteEnv) delete childEnv[key];
  const child = spawn(process.execPath, [MCP_SERVER], {
    cwd: fileURLToPath(KIT_ROOT),
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const pending = new Map();
  let buf = '';
  let nextId = 0;
  child.stdout.on('data', (data) => {
    buf += String(data);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (obj, timeoutMs = 15000) => new Promise((resolve, reject) => {
    if (obj.id === undefined) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(obj.id);
      reject(new Error(`MCP request timed out: ${obj.method ?? obj.id}`));
    }, timeoutMs);
    pending.set(obj.id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify(obj)}\n`, (error) => {
      if (error) { clearTimeout(timer); pending.delete(obj.id); reject(error); }
    });
  });
  // The client autostart-checks the gateway on boot; poll initialize until it answers.
  let init = null;
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      init = await send({
        jsonrpc: '2.0', id: ++nextId, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'a3b-red', version: '0.0.0' } },
      });
      break;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  assert.ok(init?.result, `MCP client process failed to initialize (server/mcp_server.mjs unreachable): ${lastError?.message ?? JSON.stringify(init)}`);
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return send({
    jsonrpc: '2.0', id: ++nextId, method: 'tools/call',
    params: { name: toolName, arguments: toolArgs },
  });
}

function mcpResultText(message) {
  const content = message?.result?.content;
  if (Array.isArray(content)) return content.map((entry) => entry?.text ?? '').join('\n');
  if (typeof message?.error?.message === 'string') return message.error.message;
  return JSON.stringify(message);
}

test('B2: mcp_server attaches WEBMCP_PERMIT_FILE JSON as top-level permit', async (t) => {
  const { port, bodies } = await startStubGateway(t);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a3b-permit-mcp-'));
  const permit = { permitId: 'permit_a3b-test-01', scope: 'a3b-red' };
  const permitFile = path.join(dir, 'permit.json');
  writeFileSync(permitFile, JSON.stringify(permit));
  const call = await callMcpTool(t, { gatewayPort: port, extraEnv: { WEBMCP_PERMIT_FILE: permitFile } });
  assert.ok(bodies.length >= 1, 'stub gateway must have received the /api POST');
  for (const body of bodies) {
    assert.deepEqual(
      body.permit, permit,
      `RED: server/mcp_server.mjs does not attach WEBMCP_PERMIT_FILE as top-level permit (client permit plumbing not implemented; got ${JSON.stringify(body)})`,
    );
  }
  assert.ok(!call?.error, `MCP tools/call must succeed (got ${JSON.stringify(call)})`);
});

test('B2: mcp_server attaches inline WEBMCP_PERMIT JSON as top-level permit', async (t) => {
  const { port, bodies } = await startStubGateway(t);
  const permit = { permitId: 'permit_a3b-inline-01' };
  const call = await callMcpTool(t, {
    gatewayPort: port,
    extraEnv: { WEBMCP_PERMIT: JSON.stringify(permit) },
    deleteEnv: ['WEBMCP_PERMIT_FILE'],
  });
  assert.ok(bodies.length >= 1, 'stub gateway must have received the /api POST');
  for (const body of bodies) {
    assert.deepEqual(
      body.permit, permit,
      `RED: server/mcp_server.mjs does not attach inline WEBMCP_PERMIT as top-level permit (client permit plumbing not implemented; got ${JSON.stringify(body)})`,
    );
  }
  assert.ok(!call?.error, `MCP tools/call must succeed (got ${JSON.stringify(call)})`);
});

test('B2: mcp_server leaves the /api body unchanged when no permit is set', async (t) => {
  const { port, bodies } = await startStubGateway(t);
  const call = await callMcpTool(t, { gatewayPort: port, deleteEnv: ['WEBMCP_PERMIT_FILE', 'WEBMCP_PERMIT'] });
  assert.ok(bodies.length >= 1, 'stub gateway must have received the /api POST');
  for (const body of bodies) {
    assert.ok(!('permit' in body), `body must stay unchanged with no permit configured (got ${JSON.stringify(body)})`);
  }
  assert.ok(!call?.error, `MCP tools/call must succeed (got ${JSON.stringify(call)})`);
});

test('B2: mcp_server preserves the typed gateway error code (real string shape)', async (t) => {
  const { port } = await startStubGateway(t, { mode: 'typed-error' });
  const call = await callMcpTool(t, { gatewayPort: port });
  assert.equal(call?.result?.isError, true, `MCP tools/call must report isError against a gateway denial (got ${JSON.stringify(call)})`);
  const text = mcpResultText(call);
  assert.ok(
    text.includes('PROFILE_FENCE_REQUIRED'),
    `typed gateway error code is lost by server/mcp_server.mjs (code passthrough not implemented; got ${text.slice(0, 300)})`,
  );
});

test('B2: mcp_server preserves the typed gateway error code (legacy object shape)', async (t) => {
  const { port } = await startStubGateway(t, { mode: 'typed-error', errorShape: 'object' });
  const call = await callMcpTool(t, { gatewayPort: port });
  assert.equal(call?.result?.isError, true, `MCP tools/call must report isError against a gateway denial (got ${JSON.stringify(call)})`);
  const text = mcpResultText(call);
  assert.ok(
    text.includes('PROFILE_FENCE_REQUIRED'),
    `object-form gateway error code is lost by server/mcp_server.mjs (got ${text.slice(0, 300)})`,
  );
});

// --- webmcp-vault lease fill -------------------------------------------------

function runVault(t, args, { env, stdinText = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VAULT_BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`webmcp-vault timed out: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += String(data); });
    child.stderr.on('data', (data) => { stderr += String(data); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (stdinText === null) child.stdin.end();
    else child.stdin.end(stdinText);
  });
}

// Full CLI setup chain (init -> create -> lease issue) in an isolated
// WEBMCP_HOME; only the `lease fill` spawn under test hits the stub gateway.
async function setupVaultLease(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'a3b-vault-'));
  const env = { ...process.env, WEBMCP_HOME: home, WEBMCP_VAULT_KEY: 'a3b-test-key-0123456789abcdef' };
  const init = await runVault(t, ['init', '--json'], { env });
  assert.equal(init.code, 0, `vault init must succeed in test setup (got ${init.code}: ${init.stderr.slice(0, 300)})`);
  const created = await runVault(t, ['create', '--stdin-json', '--json'], {
    env,
    stdinText: JSON.stringify({ title: 'Example', web: 'https://example.test', username: 'alice', password: 's3cret' }),
  });
  assert.equal(created.code, 0, `vault create must succeed in test setup (got ${created.code}: ${created.stderr.slice(0, 300)})`);
  const issued = await runVault(t, ['lease', 'issue', '--stdin-json', '--json'], {
    env,
    stdinText: JSON.stringify({
      query: 'Example', profileBindingId: 'pb_a3b-fill', purpose: 'login',
      siteOrigin: 'https://example.test', fields: ['username'],
      runId: 'run_a3b-fill-01', nodeId: 'node-a3b-1', principalId: 'op_a3b-1',
      receiptDigest: `sha256:${'e'.repeat(64)}`,
    }),
  });
  assert.equal(issued.code, 0, `vault lease issue must succeed in test setup (got ${issued.code}: ${issued.stderr.slice(0, 300)})`);
  const { lease } = JSON.parse(issued.stdout);
  const token = JSON.parse(issued.stdout).token;
  const fillInput = {
    leaseId: lease.leaseId, token, siteOrigin: 'https://example.test',
    profileBindingId: 'pb_a3b-fill', purpose: 'login',
    fields: { username: { selector: '#a3b-user' } },
  };
  const fillInputPath = path.join(home, 'fill-input.json');
  writeFileSync(fillInputPath, JSON.stringify(fillInput));
  return { env, home, fillInputPath };
}

test('B2: webmcp-vault --permit-file attaches top-level permit to the broker fill POST', async (t) => {
  const { port, bodies } = await startStubGateway(t);
  const { env, fillInputPath, home } = await setupVaultLease(t);
  const permit = { permitId: 'permit_a3b-vault-01' };
  const permitFile = path.join(home, 'permit.json');
  writeFileSync(permitFile, JSON.stringify(permit));
  const fill = await runVault(t, [
    'lease', 'fill', '--input-json', fillInputPath,
    '--gateway-url', `http://127.0.0.1:${port}/api`,
    '--permit-file', permitFile, '--json',
  ], { env });
  assert.equal(fill.code, 0, `vault lease fill must succeed (got ${fill.code}: ${(fill.stdout + fill.stderr).slice(0, 400)})`);
  assert.ok(bodies.length >= 1, 'stub gateway must have received the broker fill /api POSTs');
  for (const body of bodies) {
    assert.deepEqual(
      body.permit, permit,
      `RED: bin/webmcp-vault.mjs --permit-file does not attach top-level permit (vault permit plumbing not implemented; got ${JSON.stringify(body)})`,
    );
  }
});

test('B2: webmcp-vault falls back to WEBMCP_PERMIT_FILE for the broker fill POST', async (t) => {
  const { port, bodies } = await startStubGateway(t);
  const { env, fillInputPath, home } = await setupVaultLease(t);
  const permit = { permitId: 'permit_a3b-vault-env-01' };
  writeFileSync(path.join(home, 'permit.json'), JSON.stringify(permit));
  const fill = await runVault(t, [
    'lease', 'fill', '--input-json', fillInputPath,
    '--gateway-url', `http://127.0.0.1:${port}/api`, '--json',
  ], { env: { ...env, WEBMCP_PERMIT_FILE: path.join(home, 'permit.json') } });
  assert.equal(fill.code, 0, `vault lease fill must succeed (got ${fill.code}: ${(fill.stdout + fill.stderr).slice(0, 400)})`);
  assert.ok(bodies.length >= 1, 'stub gateway must have received the broker fill /api POSTs');
  for (const body of bodies) {
    assert.deepEqual(
      body.permit, permit,
      `RED: bin/webmcp-vault.mjs ignores WEBMCP_PERMIT_FILE fallback (vault permit plumbing not implemented; got ${JSON.stringify(body)})`,
    );
  }
});

test('B2: webmcp-vault leaves the broker fill POST unchanged when no permit is set', async (t) => {
  const { port, bodies } = await startStubGateway(t);
  const { env, fillInputPath } = await setupVaultLease(t);
  const fillEnv = { ...env };
  delete fillEnv.WEBMCP_PERMIT_FILE;
  delete fillEnv.WEBMCP_PERMIT;
  const fill = await runVault(t, [
    'lease', 'fill', '--input-json', fillInputPath,
    '--gateway-url', `http://127.0.0.1:${port}/api`, '--json',
  ], { env: fillEnv });
  assert.equal(fill.code, 0, `vault lease fill must succeed (got ${fill.code}: ${(fill.stdout + fill.stderr).slice(0, 400)})`);
  assert.ok(bodies.length >= 1, 'stub gateway must have received the broker fill /api POSTs');
  for (const body of bodies) {
    assert.ok(!('permit' in body), `fill body must stay unchanged with no permit configured (got ${JSON.stringify(body)})`);
  }
});

test('B2: webmcp-vault preserves the typed gateway error code on fill', async (t) => {
  const { port } = await startStubGateway(t, { mode: 'typed-error' });
  const { env, fillInputPath } = await setupVaultLease(t);
  const fill = await runVault(t, [
    'lease', 'fill', '--input-json', fillInputPath,
    '--gateway-url', `http://127.0.0.1:${port}/api`, '--json',
  ], { env });
  assert.notEqual(fill.code, 0, 'vault lease fill must fail against a typed gateway denial');
  const output = fill.stdout + fill.stderr;
  assert.ok(
    output.includes('PROFILE_FENCE_REQUIRED'),
    `typed gateway error code is lost by bin/webmcp-vault.mjs (code passthrough not implemented; got ${output.slice(0, 300)})`,
  );
  assert.ok(
    !output.includes('gateway fill failed'),
    `vault swallowed the typed denial behind a generic wrapper (got ${output.slice(0, 300)})`,
  );
});

test('B2: webmcp-vault --permit-file= (empty value) is a typed usage error', async (t) => {
  const { port, bodies } = await startStubGateway(t);
  const { env, fillInputPath, home } = await setupVaultLease(t);
  const permit = { permitId: 'permit_a3b-vault-env-01' };
  const envPermitFile = path.join(home, 'permit.json');
  writeFileSync(envPermitFile, JSON.stringify(permit));
  const fill = await runVault(t, [
    'lease', 'fill', '--input-json', fillInputPath,
    '--gateway-url', `http://127.0.0.1:${port}/api`, '--permit-file=', '--json',
  ], { env: { ...env, WEBMCP_PERMIT_FILE: envPermitFile } });
  assert.notEqual(fill.code, 0, 'vault lease fill with an empty --permit-file value must fail');
  const output = fill.stdout + fill.stderr;
  assert.ok(
    output.includes('WEBMCP_PERMIT_INVALID'),
    `empty --permit-file= must be a typed usage error (got ${output.slice(0, 300)})`,
  );
  assert.equal(bodies.length, 0, 'empty --permit-file= must not fall through to the env permit and hit the gateway');
});

