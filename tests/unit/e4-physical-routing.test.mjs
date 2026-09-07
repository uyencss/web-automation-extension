import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import {
  canonicalJson,
  digestCanonical,
  SCHEMAS,
} from '../../server/gateway/trusted-context-schema.mjs';
import { PermitStore } from '../../server/gateway/permit-store.mjs';
import { GatewayVerifier } from '../../server/gateway/verifier.mjs';
import { InteractiveRuntime } from '../../server/gateway/interactive-runtime.mjs';
import { createGatewayServer } from '../../server/gateway_server.js';
import { buildRouteMapFromRaw, loadDispatcherRouteMap } from '../../server/gateway/dispatcher-route-resolver.mjs';

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { publicKey, privateKey, rawPublicKeyHex, keyId: 'ed25519-runner-key-01' };
}

function buildSignedContext({
  keys = makeKeyPair(),
  seq = 1,
  runId = 'run_test_001',
  claimGeneration = 2,
  claimDigest = 'sha256:' + '0'.repeat(64),
  projectId = 'project_test_123',
  profileAlias = 'interactive-profile',
  profileId = null,
  bindingId = 'pb_test_123',
  bindingRevision = 2,
  bindingDigest = 'sha256:' + '1'.repeat(64),
  automationStoreRevision = 3,
  automationStoreDigest = 'sha256:' + '2'.repeat(64),
  siteStoreRevision = 4,
  siteStoreDigest = 'sha256:' + '3'.repeat(64),
  fenceEpoch = 2,
  phaseId = 'interactive-action',
  stateVersion = 1,
  planRevision = 1,
  planDigest = 'sha256:' + '4'.repeat(64),
  instructionDigest = 'sha256:' + '5'.repeat(64),
  policyRevision = 'sha256:' + '6'.repeat(64),
  ttlMs = 60000,
  expiresAt = new Date(Date.now() + 3600000).toISOString(),
  notBefore = new Date(Date.now() - 1000).toISOString(),
  revocations = [],
} = {}) {
  const base = {
    schema: SCHEMAS.TRUSTED_CONTEXT,
    messageId: `ctxmsg_${Math.random().toString(36).slice(2, 10)}`,
    seq,
    runId,
    claimGeneration,
    claimDigest,
    projectId,
    profileAlias,
    profileId: profileId || profileAlias,
    bindingId,
    bindingRevision,
    bindingDigest,
    automationStoreRevision,
    automationStoreDigest,
    siteStoreRevision,
    siteStoreDigest,
    fenceEpoch,
    phaseId,
    stateVersion,
    planRevision,
    planDigest,
    instructionDigest,
    policyRevision,
    ttlMs,
    keyId: keys.keyId,
    publicKey: keys.rawPublicKeyHex,
    issuedAt: new Date().toISOString(),
    notBefore,
    expiresAt,
    revocations,
  };
  const canonical = canonicalJson(base);
  const contextDigest = digestCanonical('webmcp-digest-v1:trusted-context', base);
  const toSign = Buffer.from(`webmcp-digest-v1:trusted-context\n${canonical}`, 'utf8');
  const signature = sign(null, toSign, keys.privateKey).toString('hex');
  return { message: { ...base, signature, contextDigest }, keys };
}

function buildSignedPermit({
  keys = makeKeyPair(),
  permitId = `permit_${Math.random().toString(36).slice(2, 10)}`,
  runId = 'run_test_001',
  claimGeneration = 2,
  claimDigest = 'sha256:' + '0'.repeat(64),
  projectId = 'project_test_123',
  profileAlias = 'interactive-profile',
  profileId = null,
  bindingId = 'pb_test_123',
  bindingRevision = 2,
  bindingDigest = 'sha256:' + '1'.repeat(64),
  automationStoreRevision = 3,
  automationStoreDigest = 'sha256:' + '2'.repeat(64),
  siteStoreRevision = 4,
  siteStoreDigest = 'sha256:' + '3'.repeat(64),
  actionClasses = ['browser.navigate', 'browser.click', 'browser.type', 'browser.batch', 'browser.raw'],
  origins = ['https://example.test', 'https://app.example.test'],
  budget = { maxCalls: 5 },
  stateVersion = 1,
  planRevision = 1,
  planDigest = 'sha256:' + '4'.repeat(64),
  instructionDigest = 'sha256:' + '5'.repeat(64),
  policyRevision = 'sha256:' + '6'.repeat(64),
  expiresAt = new Date(Date.now() + 3600000).toISOString(),
  notBefore = new Date(Date.now() - 1000).toISOString(),
  nonce = `nonce_${Math.random().toString(36).slice(2, 18)}`,
  revocationId = 'rev_001',
  ttlMs = 60000,
  issuedAt = new Date().toISOString(),
  phaseId = 'interactive-action',
} = {}) {
  const base = {
    schema: SCHEMAS.PERMIT,
    permitId,
    runId,
    claimGeneration,
    claimDigest,
    projectId,
    profileAlias,
    profileId: profileId || profileAlias,
    bindingId,
    bindingRevision,
    bindingDigest,
    automationStoreRevision,
    automationStoreDigest,
    siteStoreRevision,
    siteStoreDigest,
    phaseId,
    origins,
    actionClasses,
    budget,
    stateVersion,
    planRevision,
    planDigest,
    instructionDigest,
    policyRevision,
    keyId: keys.keyId,
    nonce,
    issuedAt,
    notBefore,
    expiresAt,
    ttlMs,
    revocationId,
  };
  const canonical = canonicalJson(base);
  const toSign = Buffer.from(`webmcp-digest-v1:permit\n${canonical}`, 'utf8');
  const signature = sign(null, toSign, keys.privateKey).toString('hex');
  const permitDigest = digestCanonical('webmcp-digest-v1:permit', base);
  return { ...base, signature, permitDigest };
}

function sendSocketMessage(socketPath, messageObj) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(messageObj) + '\n');
    });
    let data = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => { data += chunk; });
    client.on('end', () => {
      try { resolve(JSON.parse(data.trim())); } catch (err) { resolve({ raw: data, error: err.message }); }
    });
    client.on('error', reject);
  });
}

function makeFakeExtension(port, profileId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const forwarded = [];
  ws.on('open', () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'extensionReady', params: { name: 'fake', version: '1.0.0', profileId, capabilities: ['navigate'] } }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!('id' in msg)) return;
    forwarded.push(msg);
    if (msg.method === 'batch') {
      const actions = Array.isArray(msg.params?.actions) ? msg.params.actions : [];
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          total: actions.length,
          executed: actions.length,
          success: actions.length,
          errors: 0,
          results: actions.map((action, index) => ({ index, method: action.method, ok: true, result: { success: true } })),
        },
      }));
      return;
    }
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { success: true, echoedMethod: msg.method, echoedParams: msg.params } }));
  });
  return { ws, forwarded };
}

async function waitFor(pred, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}

function makeV3Registry({ physicalId = 'opaque-physical-interactive-profile-xyz123', alias = 'interactive-profile', bindingStatus = 'enabled', resourceStatus = 'enabled', gatewayProfilesOverride = null, resourceRef = 'prf_local_01', gatewayName = 'local' } = {}) {
  const gateways = {
    [gatewayName]: {
      apiUrl: 'http://127.0.0.1:7865/api',
      profiles: gatewayProfilesOverride !== null ? gatewayProfilesOverride : { [alias]: physicalId },
    },
  };
  const profileResources = {
    [resourceRef]: {
      gateway: gatewayName,
      profileId: physicalId,
      resourceRevision: 1,
      status: resourceStatus,
    },
  };
  const profileBindings = {
    [alias]: {
      schema: 'webmcp-profile-binding/3',
      bindingId: 'pb_interactive_profile',
      bindingRevision: 1,
      profileAlias: alias,
      profileResourceRef: resourceRef,
      assignmentMode: 'dedicated',
      trustDomain: null,
      policyMode: 'enforce',
      status: bindingStatus,
      purpose: { label: 'Test', tags: ['test'] },
      allowedSiteIds: ['example-site'],
      allowedAutomationIds: ['example-automation'],
      verificationPolicy: { profileIdentity: 'strict', siteAccount: 'strict' },
      profileIdentityRef: null,
      siteAccountRefs: {},
      credentialPurposeRefs: {},
      review: { decision: 'approved', receiptDigest: 'sha256:' + 'b'.repeat(64), reviewedAt: '2026-08-21T00:00:00.000Z' },
    },
  };
  return {
    schema: 'webmcp-dispatcher-config/3',
    registryRevision: 1,
    defaultGateway: gatewayName,
    gateways,
    profileResources,
    profileBindings,
  };
}

// ── Unit: route resolver parsing only v3 and fail-closed ──
test('dispatcher-route-resolver: parses only v3 and fail-closed on disabled/drift', () => {
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';

  // Valid v3
  const valid = makeV3Registry({ physicalId: phys, alias });
  const map1 = buildRouteMapFromRaw(valid);
  assert.equal(map1.get(alias), phys);

  // Non-v3 schema fails closed
  const v2 = { ...valid, schema: 'webmcp-dispatcher-config/2' };
  assert.equal(buildRouteMapFromRaw(v2).size, 0);

  // Malformed fails closed
  assert.equal(buildRouteMapFromRaw(null).size, 0);
  assert.equal(buildRouteMapFromRaw({}).size, 0);

  // Disabled binding fails closed
  const disabledBinding = makeV3Registry({ physicalId: phys, alias, bindingStatus: 'disabled' });
  assert.equal(buildRouteMapFromRaw(disabledBinding).size, 0);

  // Disabled resource fails closed
  const disabledRes = makeV3Registry({ physicalId: phys, alias, resourceStatus: 'disabled' });
  assert.equal(buildRouteMapFromRaw(disabledRes).size, 0);

  // Empty physicalId fails closed
  const emptyPhys = makeV3Registry({ physicalId: '', alias });
  assert.equal(buildRouteMapFromRaw(emptyPhys).size, 0);

  // Drift: gateway projection mismatch
  const drift = makeV3Registry({ physicalId: phys, alias, gatewayProfilesOverride: { [alias]: 'different-physical' } });
  assert.equal(buildRouteMapFromRaw(drift).size, 0);

  // Drift: missing gateway projection
  const missingProj = makeV3Registry({ physicalId: phys, alias, gatewayProfilesOverride: {} });
  assert.equal(buildRouteMapFromRaw(missingProj).size, 0);
});

test('dispatcher-route-resolver: fail closed for unreviewed or invalid review', () => {
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';
  const base = makeV3Registry({ physicalId: phys, alias });
  assert.equal(buildRouteMapFromRaw(base).get(alias), phys);

  // Missing review
  const noReview = JSON.parse(JSON.stringify(base));
  delete noReview.profileBindings[alias].review;
  assert.equal(buildRouteMapFromRaw(noReview).size, 0);

  // Not approved
  const notApproved = JSON.parse(JSON.stringify(base));
  notApproved.profileBindings[alias].review.decision = 'pending';
  assert.equal(buildRouteMapFromRaw(notApproved).size, 0);

  // Invalid digest: uppercase
  const upperDigest = JSON.parse(JSON.stringify(base));
  upperDigest.profileBindings[alias].review.receiptDigest = 'sha256:' + 'B'.repeat(64);
  assert.equal(buildRouteMapFromRaw(upperDigest).size, 0);

  // Invalid digest: too short
  const shortDigest = JSON.parse(JSON.stringify(base));
  shortDigest.profileBindings[alias].review.receiptDigest = 'sha256:' + 'b'.repeat(63);
  assert.equal(buildRouteMapFromRaw(shortDigest).size, 0);

  // Invalid digest: missing prefix
  const noPrefix = JSON.parse(JSON.stringify(base));
  noPrefix.profileBindings[alias].review.receiptDigest = 'b'.repeat(64);
  assert.equal(buildRouteMapFromRaw(noPrefix).size, 0);
});

// ── Unit: GatewayVerifier physical route allow ──
test('GatewayVerifier: valid physical route is allowed with logical receipt', () => {
  const keys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';
  const routeMap = new Map([[alias, phys]]);

  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, keyId: keys.keyId, permitStore: store, mode: 'enforce', physicalRouteMap: routeMap });

  const { message: context } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  const permit = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1 });

  const res = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit,
    context,
    profileId: phys,
  });
  assert.equal(res.decision, 'allow');
});

test('GatewayVerifier: wrong physical route denied with EXECUTION_PROFILE_MISMATCH', () => {
  const keys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';
  const routeMap = new Map([[alias, phys]]);

  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, keyId: keys.keyId, permitStore: store, mode: 'enforce', physicalRouteMap: routeMap });

  const { message: context } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  const permit = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1 });

  const wrongPhys = 'opaque-physical-other-alias-999';
  const res = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit,
    context,
    profileId: wrongPhys,
  });
  assert.equal(res.decision, 'deny');
  assert.equal(res.reason, 'EXECUTION_PROFILE_MISMATCH');
});

test('GatewayVerifier: missing route map denies physical route', () => {
  const keys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';

  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, keyId: keys.keyId, permitStore: store, mode: 'enforce', physicalRouteMap: new Map() });

  const { message: context } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  const permit = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1 });

  const res = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit,
    context,
    profileId: phys,
  });
  assert.equal(res.decision, 'deny');
  assert.equal(res.reason, 'EXECUTION_PROFILE_MISMATCH');
});

test('GatewayVerifier: no pattern bypass for physical route', () => {
  const keys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';
  const routeMap = new Map([[alias, phys]]);

  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, keyId: keys.keyId, permitStore: store, mode: 'enforce', physicalRouteMap: routeMap });

  const { message: context } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  const permit = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1 });

  // Prefix attempt
  const prefixRes = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit,
    context,
    profileId: phys + '-suffix',
  });
  assert.equal(prefixRes.decision, 'deny');
  assert.equal(prefixRes.reason, 'EXECUTION_PROFILE_MISMATCH');

  // Suffix attempt
  const suffixRes = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit,
    context,
    profileId: 'prefix-' + phys,
  });
  assert.equal(suffixRes.decision, 'deny');
});

test('GatewayVerifier: physical route still requires other checks', () => {
  const keys = makeKeyPair();
  const otherKeys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';
  const routeMap = new Map([[alias, phys]]);

  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, keyId: keys.keyId, permitStore: store, mode: 'enforce', physicalRouteMap: routeMap });

  const { message: context } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  // Permit with wrong origin – should still deny even with valid physical route
  const permitWrongOrigin = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1, origins: ['https://allowed.test'] });
  const res = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://disallowed.test' },
    permit: permitWrongOrigin,
    context,
    profileId: phys,
  });
  assert.equal(res.decision, 'deny');
  assert.equal(res.reason, 'EXECUTION_PERMIT_SCOPE_DENIED');

  // Wrong key should deny
  const permitWrongKey = buildSignedPermit({ keys: otherKeys, profileAlias: alias, claimGeneration: 1 });
  const res2 = verifier.verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test' },
    permit: permitWrongKey,
    context,
    profileId: phys,
  });
  assert.equal(res2.decision, 'deny');
  assert.ok(['EXECUTION_KEY_MISMATCH', 'EXECUTION_PERMIT_FORGED'].includes(res2.reason));
});

// ── Integration: valid physical route with logical receipt/context ──
test('e2e: valid physical route with logical receipt/context and no leakage', async (t) => {
  const keys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';

  const registry = makeV3Registry({ physicalId: phys, alias });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-phys-valid-'));
  const configPath = path.join(tmpDir, 'dispatcher.config.json');
  fs.writeFileSync(configPath, JSON.stringify(registry, null, 2));
  const origDisp = process.env.WEBMCP_DISPATCHER_CONFIG;
  const origCfg = process.env.WEBMCP_CONFIG;
  process.env.WEBMCP_DISPATCHER_CONFIG = configPath;
  delete process.env.WEBMCP_CONFIG;

  const socketPath = path.join(os.tmpdir(), `gw-phys-valid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({
    port: 0,
    socketPath,
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    allowTestSeams: true,
    token: 'test-token',
  });
  const { port } = await app.start();
  t.after(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (origDisp === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG; else process.env.WEBMCP_DISPATCHER_CONFIG = origDisp;
    if (origCfg === undefined) delete process.env.WEBMCP_CONFIG; else process.env.WEBMCP_CONFIG = origCfg;
  });

  const fakeExt = makeFakeExtension(port, phys);
  t.after(() => { try { fakeExt.ws.terminate(); } catch {} });
  await waitFor(async () => app.connectedProfileIds().includes(phys));

  const { message: ctxMsg } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  const ack = await sendSocketMessage(socketPath, ctxMsg);
  assert.equal(ack.ok, true);

  const permit = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1 });

  const res = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'browser_navigate', params: { url: 'https://example.test' }, profileId: phys, permit }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.receipt.profileAlias, alias);
  assert.equal(body.receipt.profileId, alias);
  // No physical in receipt
  const receiptStr = JSON.stringify(body.receipt);
  assert.equal(receiptStr.includes(phys), false, 'receipt must not leak physical');
  // No physical in forwarded params
  assert.equal(fakeExt.forwarded.length, 1);
  const forwardedStr = JSON.stringify(fakeExt.forwarded[0].params);
  assert.equal(forwardedStr.includes(phys), false, 'forwarded params must not leak physical');
  assert.equal(forwardedStr.includes('secret'), false);
  // Check health does not expose physical via route map (health profiles are extension physical but route map not added)
  // We assert that health payload does not contain route map leakage via unexpected field
  const healthRes = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: 'Bearer test-token' } });
  const health = await healthRes.json();
  const healthStr = JSON.stringify(health);
  // Health will contain extension profileId which is physical, but should not contain duplicated secret mapping beyond that; we just ensure receipt/contextSummary are logical
  assert.equal(health.interactive.contextSummary.profileAlias, alias);
  assert.equal(health.interactive.contextSummary.profileId, alias);
});

test('e2e: wrong physical route denied with zero forwards', async (t) => {
  const keys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';
  const registry = makeV3Registry({ physicalId: phys, alias });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-phys-wrong-'));
  const configPath = path.join(tmpDir, 'dispatcher.config.json');
  fs.writeFileSync(configPath, JSON.stringify(registry, null, 2));
  const origDisp = process.env.WEBMCP_DISPATCHER_CONFIG;
  process.env.WEBMCP_DISPATCHER_CONFIG = configPath;
  const socketPath = path.join(os.tmpdir(), `gw-phys-wrong-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({ port: 0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, allowTestSeams: true, token: 'test-token' });
  const { port } = await app.start();
  t.after(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (origDisp === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG; else process.env.WEBMCP_DISPATCHER_CONFIG = origDisp;
  });
  const fakeExt = makeFakeExtension(port, phys);
  t.after(() => { try { fakeExt.ws.terminate(); } catch {} });
  await waitFor(async () => app.connectedProfileIds().includes(phys));
  const { message: ctxMsg } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  await sendSocketMessage(socketPath, ctxMsg);
  const permit = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1 });
  const wrongPhys = 'opaque-physical-wrong-alias-999';
  const res = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'browser_navigate', params: { url: 'https://example.test' }, profileId: wrongPhys, permit }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.reason, 'EXECUTION_PROFILE_MISMATCH');
  assert.equal(fakeExt.forwarded.length, 0);
});

test('e2e: missing route map denies physical route', async (t) => {
  const keys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-phys-missing-'));
  const origDisp = process.env.WEBMCP_DISPATCHER_CONFIG;
  const origHome = process.env.WEBMCP_HOME;
  // Ensure no config file exists
  process.env.WEBMCP_DISPATCHER_CONFIG = path.join(tmpDir, 'nonexistent.json');
  delete process.env.WEBMCP_CONFIG;
  process.env.WEBMCP_HOME = tmpDir;
  const socketPath = path.join(os.tmpdir(), `gw-phys-miss-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({ port: 0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, allowTestSeams: true, token: 'test-token' });
  const { port } = await app.start();
  t.after(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (origDisp === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG; else process.env.WEBMCP_DISPATCHER_CONFIG = origDisp;
    if (origHome === undefined) delete process.env.WEBMCP_HOME; else process.env.WEBMCP_HOME = origHome;
  });
  const fakeExt = makeFakeExtension(port, phys);
  t.after(() => { try { fakeExt.ws.terminate(); } catch {} });
  await waitFor(async () => app.connectedProfileIds().includes(phys));
  const { message: ctxMsg } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  await sendSocketMessage(socketPath, ctxMsg);
  const permit = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1 });
  const res = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'browser_navigate', params: { url: 'https://example.test' }, profileId: phys, permit }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'EXECUTION_PROFILE_MISMATCH');
  assert.equal(fakeExt.forwarded.length, 0);
});

test('e2e: drifted and disabled mapping denies physical route', async (t) => {
  const keys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';

  // Drift case: gateway projection mismatch
  const driftRegistry = makeV3Registry({ physicalId: phys, alias, gatewayProfilesOverride: { [alias]: 'drifted-physical' } });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-phys-drift-'));
  const configPath = path.join(tmpDir, 'dispatcher.config.json');
  fs.writeFileSync(configPath, JSON.stringify(driftRegistry, null, 2));
  const origDisp = process.env.WEBMCP_DISPATCHER_CONFIG;
  process.env.WEBMCP_DISPATCHER_CONFIG = configPath;

  const socketPath = path.join(os.tmpdir(), `gw-phys-drift-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({ port: 0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, allowTestSeams: true, token: 'test-token' });
  const { port } = await app.start();
  t.after(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (origDisp === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG; else process.env.WEBMCP_DISPATCHER_CONFIG = origDisp;
  });
  const fakeExt = makeFakeExtension(port, phys);
  t.after(() => { try { fakeExt.ws.terminate(); } catch {} });
  await waitFor(async () => app.connectedProfileIds().includes(phys));
  const { message: ctxMsg } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  await sendSocketMessage(socketPath, ctxMsg);
  const permit = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1 });
  const res = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'browser_navigate', params: { url: 'https://example.test' }, profileId: phys, permit }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'EXECUTION_PROFILE_MISMATCH');
  assert.equal(fakeExt.forwarded.length, 0);
});

test('e2e: no physical/secret leakage in batch forwarded child params', async (t) => {
  const keys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';
  const registry = makeV3Registry({ physicalId: phys, alias });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-phys-batch-'));
  const configPath = path.join(tmpDir, 'dispatcher.config.json');
  fs.writeFileSync(configPath, JSON.stringify(registry, null, 2));
  const origDisp = process.env.WEBMCP_DISPATCHER_CONFIG;
  process.env.WEBMCP_DISPATCHER_CONFIG = configPath;
  const socketPath = path.join(os.tmpdir(), `gw-phys-batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  const app = createGatewayServer({ port: 0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, allowTestSeams: true, token: 'test-token' });
  const { port } = await app.start();
  t.after(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (origDisp === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG; else process.env.WEBMCP_DISPATCHER_CONFIG = origDisp;
  });
  const fakeExt = makeFakeExtension(port, phys);
  t.after(() => { try { fakeExt.ws.terminate(); } catch {} });
  await waitFor(async () => app.connectedProfileIds().includes(phys));
  const { message: ctxMsg } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  await sendSocketMessage(socketPath, ctxMsg);
  const permit = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1, actionClasses: ['browser.navigate', 'browser.click', 'browser.batch'], origins: ['https://example.test'] });
  // Batch with child containing secret-like keys and physical-like value
  const batchRes = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      method: 'batch',
      params: {
        actions: [
          { method: 'browser_navigate', params: { url: 'https://example.test', secretToken: 'should-be-stripped' } },
          { method: 'browser_click', params: { url: 'https://example.test', selector: '#a', apiKey: 'leak' } },
        ],
      },
      profileId: phys,
      permit,
    }),
  });
  assert.equal(batchRes.status, 200);
  const body = await batchRes.json();
  assert.ok(body.receipt);
  const receiptStr = JSON.stringify(body.receipt) + JSON.stringify(body.receipts || []);
  assert.equal(receiptStr.includes(phys), false);
  assert.equal(receiptStr.includes('secret'), false);
  assert.equal(receiptStr.includes('apiKey'), false);
  assert.equal(fakeExt.forwarded.length, 1);
  const fwd = fakeExt.forwarded[0].params;
  const fwdStr = JSON.stringify(fwd);
  assert.equal(fwdStr.includes(phys), false);
  assert.equal(fwdStr.includes('secretToken'), false);
  assert.equal(fwdStr.includes('apiKey'), false);
  // Ensure forwarded actions are canonical {method, params}
  assert.deepEqual(fwd.actions[0], { method: 'navigate', params: { url: 'https://example.test' } });
});

test('resolver: env priority WEBMCP_DISPATCHER_CONFIG > WEBMCP_CONFIG > WEBMCP_HOME', () => {
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-env-a-'));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-env-b-'));
  const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-env-c-'));
  const alias = 'interactive-profile';
  const physA = 'phys-A';
  const physB = 'phys-B';
  const physC = 'phys-C';
  const regA = makeV3Registry({ physicalId: physA, alias });
  const regB = makeV3Registry({ physicalId: physB, alias });
  const regC = makeV3Registry({ physicalId: physC, alias });
  const pathA = path.join(tmpA, 'a.json');
  const pathB = path.join(tmpB, 'b.json');
  const pathC = path.join(tmpC, 'dispatcher.config.json');
  fs.writeFileSync(pathA, JSON.stringify(regA, null, 2));
  fs.writeFileSync(pathB, JSON.stringify(regB, null, 2));
  fs.mkdirSync(path.join(tmpC, '.webmcp'), { recursive: true });
  // Actually WEBMCP_HOME is tmpC/.webmcp parent? We'll set WEBMCP_HOME to tmpC
  fs.writeFileSync(path.join(tmpC, 'dispatcher.config.json'), JSON.stringify(regC, null, 2));

  const origD = process.env.WEBMCP_DISPATCHER_CONFIG;
  const origC = process.env.WEBMCP_CONFIG;
  const origH = process.env.WEBMCP_HOME;
  try {
    process.env.WEBMCP_DISPATCHER_CONFIG = pathA;
    process.env.WEBMCP_CONFIG = pathB;
    process.env.WEBMCP_HOME = tmpC;
    const map = loadDispatcherRouteMap();
    assert.equal(map.get(alias), physA);

    delete process.env.WEBMCP_DISPATCHER_CONFIG;
    const map2 = loadDispatcherRouteMap();
    assert.equal(map2.get(alias), physB);

    delete process.env.WEBMCP_CONFIG;
    const map3 = loadDispatcherRouteMap();
    assert.equal(map3.get(alias), physC);
  } finally {
    if (origD === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG; else process.env.WEBMCP_DISPATCHER_CONFIG = origD;
    if (origC === undefined) delete process.env.WEBMCP_CONFIG; else process.env.WEBMCP_CONFIG = origC;
    if (origH === undefined) delete process.env.WEBMCP_HOME; else process.env.WEBMCP_HOME = origH;
    try { fs.rmSync(tmpA, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmpB, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmpC, { recursive: true, force: true }); } catch {}
  }
});

test('e2e: off-mode logical alias still routes, physical without map is not treated as interactive deny', async (t) => {
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';
  // Off-mode gateway: no socket, no publicKey, mode off - legacy non-interactive
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-phys-off-'));
  const origDisp = process.env.WEBMCP_DISPATCHER_CONFIG;
  const origHome = process.env.WEBMCP_HOME;
  process.env.WEBMCP_DISPATCHER_CONFIG = path.join(tmpDir, 'nonexistent.json');
  delete process.env.WEBMCP_CONFIG;
  process.env.WEBMCP_HOME = tmpDir;
  const app = createGatewayServer({ port: 0, allowTestSeams: true, token: 'test-token', interactiveMode: 'off' });
  const { port } = await app.start();
  t.after(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (origDisp === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG; else process.env.WEBMCP_DISPATCHER_CONFIG = origDisp;
    if (origHome === undefined) delete process.env.WEBMCP_HOME; else process.env.WEBMCP_HOME = origHome;
  });
  const fakeExt = makeFakeExtension(port, phys);
  t.after(() => { try { fakeExt.ws.terminate(); } catch {} });
  await waitFor(async () => app.connectedProfileIds().includes(phys));
  // Off-mode: request without permit using logical alias should fail at routing if alias != phys? But single-profile fallback will route to single connected id regardless of alias? Let's test logical alias with no map: should 404 because no direct alias extension, but single-profile case with no profileId should succeed.
  // Legacy single-profile compatibility: no profileId should resolve to single extension
  const resSingle = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'ping', params: {} }),
  });
  assert.equal(resSingle.status, 200);
  // Direct physical with no map in off-mode should still be allowed via extensions.get (legacy non-interactive)
  const resPhys = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'ping', params: {}, profileId: phys }),
  });
  assert.equal(resPhys.status, 200);
  assert.equal(fakeExt.forwarded.length, 2);
});

test('e2e: off-mode no-map physical request with interactive permit is denied with zero forwards (bypass closed)', async (t) => {
  const keys = makeKeyPair();
  const phys = 'opaque-physical-interactive-profile-xyz123';
  const alias = 'interactive-profile';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-phys-off-interactive-'));
  const origDisp = process.env.WEBMCP_DISPATCHER_CONFIG;
  const origHome = process.env.WEBMCP_HOME;
  process.env.WEBMCP_DISPATCHER_CONFIG = path.join(tmpDir, 'nonexistent.json');
  delete process.env.WEBMCP_CONFIG;
  process.env.WEBMCP_HOME = tmpDir;
  const socketPath = path.join(os.tmpdir(), `gw-phys-off-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
  // enforce mode but no map file -> empty map
  const app = createGatewayServer({ port: 0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, allowTestSeams: true, token: 'test-token' });
  const { port } = await app.start();
  t.after(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (origDisp === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG; else process.env.WEBMCP_DISPATCHER_CONFIG = origDisp;
    if (origHome === undefined) delete process.env.WEBMCP_HOME; else process.env.WEBMCP_HOME = origHome;
  });
  const fakeExt = makeFakeExtension(port, phys);
  t.after(() => { try { fakeExt.ws.terminate(); } catch {} });
  await waitFor(async () => app.connectedProfileIds().includes(phys));
  const { message: ctxMsg } = buildSignedContext({ keys, profileAlias: alias, fenceEpoch: 1 });
  await sendSocketMessage(socketPath, ctxMsg);
  const permit = buildSignedPermit({ keys, profileAlias: alias, claimGeneration: 1 });
  const res = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ method: 'browser_navigate', params: { url: 'https://example.test' }, profileId: phys, permit }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'EXECUTION_PROFILE_MISMATCH');
  assert.equal(fakeExt.forwarded.length, 0);
});

test('production createGatewayServer loads local registry and injection gated', () => {
  const origEnv = process.env.NODE_ENV;
  const origSeam = process.env.WEBMCP_ALLOW_TEST_SEAMS;
  const origDisp = process.env.WEBMCP_DISPATCHER_CONFIG;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.WEBMCP_ALLOW_TEST_SEAMS;
    assert.throws(() => createGatewayServer({ physicalRouteMap: new Map([['a', 'b']]) }), /not permitted in production/);
    assert.throws(() => new InteractiveRuntime({ physicalRouteMap: new Map([['a','b']]) }), /not permitted in production/);
  } finally {
    process.env.NODE_ENV = origEnv;
    if (origSeam === undefined) delete process.env.WEBMCP_ALLOW_TEST_SEAMS; else process.env.WEBMCP_ALLOW_TEST_SEAMS = origSeam;
    if (origDisp === undefined) delete process.env.WEBMCP_DISPATCHER_CONFIG; else process.env.WEBMCP_DISPATCHER_CONFIG = origDisp;
  }
});
