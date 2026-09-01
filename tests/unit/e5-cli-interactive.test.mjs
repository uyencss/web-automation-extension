import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.WEBMCP_ALLOW_TEST_SEAMS = '1';

import {
  canonicalJson,
  digestCanonical,
  digestAction,
  digestResult,
  buildEvidence,
  digestReceiptOrder,
  digestOutput,
  toKeyObject,
  keysMatch,
  validateTrustedContextMessage,
  validatePermitStructure,
  createSafeReceipt,
  redactContext,
  isNormalizedHttpOrigin,
  RECEIPT_DIGEST_DOMAIN,
  ACTION_DIGEST_DOMAIN,
  RECEIPT_ORDER_DOMAIN,
  OUTPUT_DOMAIN,
  SCHEMAS,
} from '../../server/gateway/trusted-context-schema.mjs';

import { PermitStore } from '../../server/gateway/permit-store.mjs';
import { GatewayVerifier, classifyTool } from '../../server/gateway/verifier.mjs';
import { TrustedContextChannel } from '../../server/gateway/trusted-context-channel.mjs';
import { InteractiveRuntime } from '../../server/gateway/interactive-runtime.mjs';
import { createGatewayServer } from '../../server/gateway_server.js';

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { publicKey, privateKey, rawPublicKeyHex, keyId: 'ed25519-runner-key-01' };
}

function buildSignedContext({
  keys = makeKeyPair(),
  seq = 1,
  runId = 'run_e5_001',
  claimGeneration = 2,
  claimDigest = 'sha256:' + '0'.repeat(64),
  projectId = 'project_e5_123',
  profileAlias = 'interactive-profile',
  profileId = null,
  bindingId = 'pb_e5_123',
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
  includeSignature = true,
  overridePublicKey = null,
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
    publicKey: overridePublicKey || keys.rawPublicKeyHex,
    issuedAt: new Date().toISOString(),
    notBefore,
    expiresAt,
    revocations,
  };
  const canonical = canonicalJson(base);
  const contextDigest = digestCanonical('webmcp-digest-v1:trusted-context', base);
  if (!includeSignature) return { message: { ...base, contextDigest }, keys };
  const toSign = Buffer.from(`webmcp-digest-v1:trusted-context\n${canonical}`, 'utf8');
  const signature = sign(null, toSign, keys.privateKey).toString('hex');
  return { message: { ...base, signature, contextDigest }, keys };
}

function buildSignedPermit({
  keys = makeKeyPair(),
  permitId = `permit_${Math.random().toString(36).slice(2, 10)}`,
  runId = 'run_e5_001',
  claimGeneration = 2,
  claimDigest = 'sha256:' + '0'.repeat(64),
  projectId = 'project_e5_123',
  profileAlias = 'interactive-profile',
  profileId = null,
  bindingId = 'pb_e5_123',
  bindingRevision = 2,
  bindingDigest = 'sha256:' + '1'.repeat(64),
  automationStoreRevision = 3,
  automationStoreDigest = 'sha256:' + '2'.repeat(64),
  siteStoreRevision = 4,
  siteStoreDigest = 'sha256:' + '3'.repeat(64),
  actionClasses = ['browser.navigate', 'browser.click', 'browser.batch'],
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
  tamperDigest = false,
  tamperSignature = false,
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
  let signature = sign(null, toSign, keys.privateKey).toString('hex');
  let permitDigest = digestCanonical('webmcp-digest-v1:permit', base);
  if (tamperDigest) permitDigest = 'sha256:' + '0'.repeat(64);
  if (tamperSignature) signature = 'ee'.repeat(64);
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
      try { const parsed = JSON.parse(data.trim()); resolve(parsed); } catch (err) { resolve({ raw: data, error: err.message }); }
    });
    client.on('error', (err) => { reject(err); });
  });
}

function makeFakeExtension(port, profileId, { behavior = 'success' } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const forwarded = [];
  ws.on('open', () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'extensionReady', params: { name: 'fake-test-ext', version: '1.0.0', profileId, capabilities: ['navigate','click','batch'] }}));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!('id' in msg)) return;
    forwarded.push(msg);
    if (behavior === 'no-response') return;
    if (behavior === 'disconnect') { ws.close(); return; }
    if (behavior === 'jsonrpc-error') {
      ws.send(JSON.stringify({ jsonrpc:'2.0', id: msg.id, error: { code:-32603, message:'simulated extension error' }}));
      return;
    }
    if (behavior === 'page-tool-error') {
      ws.send(JSON.stringify({ jsonrpc:'2.0', id: msg.id, result: { result: { content:[{text: JSON.stringify({error:true, message:'page tool failed'}) }]} }}));
      return;
    }
    ws.send(JSON.stringify({ jsonrpc:'2.0', id: msg.id, result: { success:true, echoedMethod: msg.method, echoedParams: msg.params }}));
  });
  return { ws, forwarded };
}

async function waitFor(predicate, timeoutMs=4000) {
  const start=Date.now();
  while(Date.now()-start<timeoutMs){ if(await predicate()) return; await new Promise(r=>setTimeout(r,50)); }
  throw new Error('waitFor timed out');
}

// ── 1. Applied receipt after real extension success ──
test('live receipt applied after actual extension success (attempted/applied, digest-bound)', async (t)=>{
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `e5-applied-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sock`);
  const app = createGatewayServer({ port:0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, interactiveMode:'enforce', token:'test-token', allowTestSeams:true });
  const { port: actualPort } = await app.start();
  t.after(async()=>{ await app.close(); });
  const fakeExt = makeFakeExtension(actualPort, 'interactive-profile', {behavior:'success'});
  t.after(()=>{ try{ fakeExt.ws.terminate(); }catch{} });
  await waitFor(async()=> app.connectedProfileIds().includes('interactive-profile'));
  const { message: ctx } = buildSignedContext({keys, fenceEpoch:2});
  const ack = await sendSocketMessage(socketPath, ctx);
  assert.equal(ack.ok, true);
  const permit = buildSignedPermit({keys, claimGeneration:2});
  const res = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'browser_navigate', params:{url:'https://example.test'}, profileId:'interactive-profile', permit, targetOrigin:'https://example.test'})
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.receipt);
  assert.equal(body.receipt.schema, SCHEMAS.RECEIPT);
  assert.equal(body.receipt.attempt, 'attempted');
  assert.equal(body.receipt.outcome, 'applied');
  assert.equal(body.receipt.sequence, 1);
  assert.equal(body.receipt.actionClass, 'browser.navigate');
  assert.equal(body.receipt.targetOrigin, 'https://example.test');
  assert.ok(body.receipt.actionDigest.startsWith('sha256:'));
  const expectedActionDigest = digestAction({method:'browser_navigate', params:{url:'https://example.test'}, targetOrigin:'https://example.test'});
  assert.equal(body.receipt.actionDigest, expectedActionDigest);
  assert.ok(body.receipt.resultDigest.startsWith('sha256:'));
  assert.ok(body.receipt.evidence);
  assert.equal(typeof body.receipt.evidence.bytes, 'number');
  assert.ok(Array.isArray(body.receipt.evidence.types));
  // receiptDigest verification
  const { receiptDigest, ...proj } = body.receipt;
  const expectedDigest = digestCanonical(RECEIPT_DIGEST_DOMAIN, proj);
  assert.equal(receiptDigest, expectedDigest);
  // no raw params/results leak
  const rawStr = JSON.stringify(body.receipt);
  assert.equal(rawStr.includes('https://example.test') , true); // targetOrigin is allowed but params raw should not include extra leak? params not in receipt
  assert.equal('params' in body.receipt, false);
  assert.equal('result' in body.receipt, false);
  assert.equal(body.receipt.permitId, permit.permitId);
});

test('live receipt failed for explicit JSON-RPC and page-tool failure', async (t)=>{
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `e5-failed-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sock`);
  const app = createGatewayServer({ port:0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, interactiveMode:'enforce', token:'test-token', allowTestSeams:true });
  const { port: actualPort } = await app.start();
  t.after(async()=>{ await app.close(); });
  // JSON-RPC error case
  const fakeErr = makeFakeExtension(actualPort, 'interactive-profile', {behavior:'jsonrpc-error'});
  t.after(()=>{ try{ fakeErr.ws.terminate(); }catch{} });
  await waitFor(async()=> app.connectedProfileIds().includes('interactive-profile'));
  const { message: ctx } = buildSignedContext({keys, fenceEpoch:1});
  await sendSocketMessage(socketPath, ctx);
  const permit = buildSignedPermit({keys, claimGeneration:1});
  const res = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'browser_navigate', params:{url:'https://example.test'}, profileId:'interactive-profile', permit, targetOrigin:'https://example.test'})
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.receipt.attempt, 'attempted');
  assert.equal(body.receipt.outcome, 'failed');
  assert.equal(body.receipt.sequence, 1);
  assert.ok(body.receipt.actionDigest.startsWith('sha256:'));
  assert.ok(body.receipt.resultDigest === null || body.receipt.resultDigest.startsWith('sha256:'));
  fakeErr.ws.close();
  await waitFor(async()=> app.connectedProfileIds().length===0);
  // page-tool error case
  const fakePage = makeFakeExtension(actualPort, 'interactive-profile', {behavior:'page-tool-error'});
  t.after(()=>{ try{ fakePage.ws.terminate(); }catch{} });
  await waitFor(async()=> app.connectedProfileIds().includes('interactive-profile'));
  const permit2 = buildSignedPermit({keys, claimGeneration:1, nonce:'nonce_page2'});
  const res2 = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'browser_navigate', params:{url:'https://example.test'}, profileId:'interactive-profile', permit:permit2, targetOrigin:'https://example.test'})
  });
  assert.equal(res2.status, 422);
  const body2 = await res2.json();
  assert.equal(body2.receipt.attempt, 'attempted');
  assert.equal(body2.receipt.outcome, 'failed');
});

test('live receipt indeterminate for timeout and disconnect', async (t)=>{
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `e5-indet-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sock`);
  const app = createGatewayServer({ port:0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, interactiveMode:'enforce', token:'test-token', allowTestSeams:true, commandTimeoutMs: 200 });
  const { port: actualPort } = await app.start();
  t.after(async()=>{ await app.close(); });
  // timeout case
  const fakeTimeout = makeFakeExtension(actualPort, 'interactive-profile', {behavior:'no-response'});
  t.after(()=>{ try{ fakeTimeout.ws.terminate(); }catch{} });
  await waitFor(async()=> app.connectedProfileIds().includes('interactive-profile'));
  const { message: ctx } = buildSignedContext({keys, fenceEpoch:1});
  await sendSocketMessage(socketPath, ctx);
  const permit = buildSignedPermit({keys, claimGeneration:1});
  const res = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'browser_navigate', params:{url:'https://example.test'}, profileId:'interactive-profile', permit, targetOrigin:'https://example.test'})
  });
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.equal(body.receipt.attempt, 'attempted');
  assert.equal(body.receipt.outcome, 'indeterminate');
  assert.ok(body.receipt.actionDigest.startsWith('sha256:'));
  assert.equal(body.receipt.resultDigest, null);
  fakeTimeout.ws.close();
  await waitFor(async()=> app.connectedProfileIds().length===0);
  // disconnect case
  const fakeDisc = makeFakeExtension(actualPort, 'interactive-profile', {behavior:'disconnect'});
  t.after(()=>{ try{ fakeDisc.ws.terminate(); }catch{} });
  await waitFor(async()=> app.connectedProfileIds().includes('interactive-profile'));
  const permit2 = buildSignedPermit({keys, claimGeneration:1, nonce:'nonce_disc2'});
  const res2 = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'browser_navigate', params:{url:'https://example.test'}, profileId:'interactive-profile', permit:permit2, targetOrigin:'https://example.test'})
  });
  assert.equal(res2.status, 502);
  const body2 = await res2.json();
  assert.equal(body2.receipt.attempt, 'attempted');
  assert.equal(body2.receipt.outcome, 'indeterminate');
});

test('blocked receipt for denial (not-attempted/blocked) and local-download', async (t)=>{
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `e5-blocked-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sock`);
  const app = createGatewayServer({ port:0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, interactiveMode:'enforce', token:'test-token', allowTestSeams:true });
  const { port: actualPort } = await app.start();
  t.after(async()=>{ await app.close(); });
  const fakeExt = makeFakeExtension(actualPort, 'interactive-profile', {behavior:'success'});
  t.after(()=>{ try{ fakeExt.ws.terminate(); }catch{} });
  await waitFor(async()=> app.connectedProfileIds().includes('interactive-profile'));
  const { message: ctx } = buildSignedContext({keys, fenceEpoch:1});
  await sendSocketMessage(socketPath, ctx);
  // blocked due to wrong origin
  const badPermit = buildSignedPermit({keys, claimGeneration:1, origins:['https://allowed.test']});
  const res = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'browser_navigate', params:{url:'https://evil.test'}, profileId:'interactive-profile', permit: badPermit, targetOrigin:'https://evil.test'})
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.receipt.attempt, 'not-attempted');
  assert.equal(body.receipt.outcome, 'blocked');
  assert.equal(body.receipt.sequence, 1);
  assert.equal(fakeExt.forwarded.length, 0);
  // local-download should produce applied receipt even though no extension forward
  const goodPermit = buildSignedPermit({keys, claimGeneration:1, nonce:'nonce_local', actionClasses:['browser.listDownloadEvents'], origins:['https://example.test']});
  const res2 = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'listDownloadEvents', params:{targetOrigin:'https://example.test'}, profileId:'interactive-profile', permit: goodPermit, targetOrigin:'https://example.test'})
  });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.receipt.attempt, 'attempted');
  assert.equal(body2.receipt.outcome, 'applied');
});

test('batch order, cardinality, partial deny zero-forward and aggregate', async (t)=>{
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `e5-batch-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sock`);
  const app = createGatewayServer({ port:0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, interactiveMode:'enforce', token:'test-token', allowTestSeams:true });
  const { port: actualPort } = await app.start();
  t.after(async()=>{ await app.close(); });
  const fakeExt = makeFakeExtension(actualPort, 'interactive-profile', {behavior:'success'});
  t.after(()=>{ try{ fakeExt.ws.terminate(); }catch{} });
  await waitFor(async()=> app.connectedProfileIds().includes('interactive-profile'));
  const { message: ctx } = buildSignedContext({keys, fenceEpoch:1});
  await sendSocketMessage(socketPath, ctx);
  const permit = buildSignedPermit({keys, claimGeneration:1, origins:['https://example.test'], actionClasses:['browser.navigate','browser.batch']});
  const actions = [
    { method:'browser_navigate', params:{url:'https://example.test'}, targetOrigin:'https://example.test' },
    { method:'browser_navigate', params:{url:'https://example.test'}, targetOrigin:'https://example.test' },
  ];
  const res = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'batch', params:{actions}, profileId:'interactive-profile', permit })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.receipts));
  assert.equal(body.receipts.length, 2);
  assert.equal(body.receipts[0].sequence, 1);
  assert.equal(body.receipts[1].sequence, 2);
  assert.equal(body.receipt.actionClass, 'browser.batch');
  assert.equal(body.receipt.attempt, 'attempted');
  assert.equal(body.receipt.outcome, 'applied');
  assert.deepEqual(body.receipt.children, body.receipts);
  assert.equal('params' in body.receipt.children[0], false);
  // receipt-order domain check
  const orderDigest = digestReceiptOrder(body.receipts);
  assert.ok(orderDigest.startsWith('sha256:'));
  const outputDigest = digestOutput(body.receipts.map(r=>r.resultDigest));
  assert.ok(outputDigest.startsWith('sha256:'));
  // verifyRegistry via endpoint
  const verifyRes = await fetch(`http://127.0.0.1:${actualPort}/interactive/receipts/verify`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ receipts: body.receipts })
  });
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.verified, true);
  const verifyAllRes = await fetch(`http://127.0.0.1:${actualPort}/interactive/receipts/verify`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ receipts: [body.receipt, ...body.receipts] })
  });
  assert.equal(verifyAllRes.status, 200);
  // partial deny: second action wrong origin
  fakeExt.forwarded.length = 0;
  const permit2 = buildSignedPermit({keys, claimGeneration:1, origins:['https://example.test'], actionClasses:['browser.navigate','browser.batch'], nonce:'nonce_batch2'});
  const mixed = [
    { method:'browser_navigate', params:{url:'https://example.test'}, targetOrigin:'https://example.test' },
    { method:'browser_navigate', params:{url:'https://evil.test'}, targetOrigin:'https://evil.test' },
  ];
  const res2 = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'batch', params:{actions: mixed}, profileId:'interactive-profile', permit: permit2 })
  });
  assert.equal(res2.status, 403);
  const body2 = await res2.json();
  // zero children forwarded to extension
  assert.equal(fakeExt.forwarded.length, 0); // second batch denied, zero forwarded after reset
  // ensure error response does not contain raw params? Should not echo raw receipts? but it returns receipts as blocked
  assert.ok(body2.receipt);
  assert.equal(body2.receipt.attempt, 'not-attempted');
});

test('registry forged/self-authored rejection', async (t)=>{
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `e5-registry-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sock`);
  const app = createGatewayServer({ port:0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, interactiveMode:'enforce', token:'test-token', allowTestSeams:true });
  const { port: actualPort } = await app.start();
  t.after(async()=>{ await app.close(); });
  const fakeExt = makeFakeExtension(actualPort, 'interactive-profile');
  t.after(()=>{ try{ fakeExt.ws.terminate(); }catch{} });
  await waitFor(async()=> app.connectedProfileIds().includes('interactive-profile'));
  const { message: ctx } = buildSignedContext({keys, fenceEpoch:1});
  await sendSocketMessage(socketPath, ctx);
  const permit = buildSignedPermit({keys, claimGeneration:1});
  const res = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'browser_navigate', params:{url:'https://example.test'}, profileId:'interactive-profile', permit, targetOrigin:'https://example.test'})
  });
  const body = await res.json();
  const goodReceipt = body.receipt;
  // forged receiptId
  const forged = { ...goodReceipt, receiptId: 'rcpt_forged12345678' };
  const v1 = await fetch(`http://127.0.0.1:${actualPort}/interactive/receipts/verify`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ receipts:[forged] })
  });
  assert.equal(v1.status, 403);
  const vb1 = await v1.json();
  assert.ok(vb1.error.includes('verification'));
  // self-authored: create receipt not in registry
  const selfAuthored = createSafeReceipt({
    permitId: permit.permitId,
    runId: permit.runId,
    projectId: permit.projectId,
    profileAlias: permit.profileAlias,
    profileId: permit.profileId,
    actionClass:'browser.navigate',
    attempt:'attempted',
    outcome:'applied',
    sequence:1,
    method:'browser_navigate',
    params:{url:'https://example.test'},
    targetOrigin:'https://example.test',
    resultDigest: digestResult({ok:true}),
    evidence: buildEvidence({ok:true}),
  });
  const v2 = await fetch(`http://127.0.0.1:${actualPort}/interactive/receipts/verify`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ receipts:[selfAuthored] })
  });
  assert.equal(v2.status, 403);
  // tampered digest
  const tampered = { ...goodReceipt, receiptDigest: 'sha256:'+'ff'.repeat(32) };
  const v3 = await fetch(`http://127.0.0.1:${actualPort}/interactive/receipts/verify`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ receipts:[tampered] })
  });
  assert.equal(v3.status, 403);
  // malformed fails closed and never echos raw
  const v4 = await fetch(`http://127.0.0.1:${actualPort}/interactive/receipts/verify`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ bad:true })
  });
  assert.equal(v4.status, 400);
  const vb4 = await v4.json();
  assert.equal(vb4.error.includes('Malformed'), true);
  assert.equal(JSON.stringify(vb4).includes('rcpt_'), false);
});

test('revoke permit blocks later requests and verify fails', async (t)=>{
  const keys = makeKeyPair();
  const socketPath = path.join(os.tmpdir(), `e5-revoke-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sock`);
  const app = createGatewayServer({ port:0, socketPath, publicKey: keys.publicKey, keyId: keys.keyId, interactiveMode:'enforce', token:'test-token', allowTestSeams:true });
  const { port: actualPort } = await app.start();
  t.after(async()=>{ await app.close(); });
  const fakeExt = makeFakeExtension(actualPort, 'interactive-profile');
  t.after(()=>{ try{ fakeExt.ws.terminate(); }catch{} });
  await waitFor(async()=> app.connectedProfileIds().includes('interactive-profile'));
  const { message: ctx } = buildSignedContext({keys, fenceEpoch:1});
  await sendSocketMessage(socketPath, ctx);
  const permit = buildSignedPermit({keys, claimGeneration:1, permitId:'permit_revoke_test', revocationId:'rev_revoke_test'});
  const res = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'browser_navigate', params:{url:'https://example.test'}, profileId:'interactive-profile', permit, targetOrigin:'https://example.test'})
  });
  assert.equal(res.status, 200);
  // revoke
  const revRes = await fetch(`http://127.0.0.1:${actualPort}/interactive/revoke`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ permitId:'permit_revoke_test', revocationId:'rev_revoke_test' })
  });
  assert.equal(revRes.status, 200);
  const revBody = await revRes.json();
  assert.equal(revBody.ok, true);
  // second request with same permit should be blocked
  const permit2 = { ...permit, nonce:'nonce_second_after_revoke' };
  // need to resign? For second request we create new permit with same permitId but different nonce, but same permitId revoked.
  // To avoid signature failure, create new permit with same permitId but resign correctly via helper? Simpler reuse same permit object but change nonce and re-sign manually?
  // We'll create a fresh permit with same revoked id but new nonce via buildSignedPermit with explicit permitId and new nonce.
  const newPermit = buildSignedPermit({keys, permitId:'permit_revoke_test', revocationId:'rev_revoke_test', nonce:'nonce_second_after_revoke', claimGeneration:1});
  const res2 = await fetch(`http://127.0.0.1:${actualPort}/api`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ method:'browser_navigate', params:{url:'https://example.test'}, profileId:'interactive-profile', permit:newPermit, targetOrigin:'https://example.test'})
  });
  assert.equal(res2.status, 403);
  const b2 = await res2.json();
  assert.equal(b2.reason, 'EXECUTION_PERMIT_REVOKED');
  // verify endpoint malformed fails closed
  const badRevoke = await fetch(`http://127.0.0.1:${actualPort}/interactive/revoke`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer test-token'},
    body: JSON.stringify({ })
  });
  assert.equal(badRevoke.status, 400);
});

test('digest/redaction: no raw params/results/creds and digest domains', async (t)=>{
  const receipt = createSafeReceipt({
    permitId:'permit_123', runId:'run_123', projectId:'proj', profileAlias:'alias', profileId:'prof',
    actionClass:'browser.navigate', attempt:'attempted', outcome:'applied', sequence:1,
    method:'browser_navigate', params:{url:'https://example.test', secret:'should_not_appear'}, targetOrigin:'https://example.test',
    resultDigest: digestResult({data:'secret'}), evidence: buildEvidence({data:'secret'})
  });
  const str = JSON.stringify(receipt);
  assert.equal(str.includes('should_not_appear'), false);
  assert.equal(str.includes('secret'), false); // ensure raw not leaked except targetOrigin
  assert.equal(str.includes('privateKey'), false);
  assert.equal(str.includes('cookie'), false);
  assert.ok(receipt.actionDigest.startsWith('sha256:'));
  assert.ok(receipt.receiptDigest.startsWith('sha256:'));
  // domain separation check
  const { receiptDigest, ...proj } = receipt;
  const expected = digestCanonical(RECEIPT_DIGEST_DOMAIN, proj);
  assert.equal(receiptDigest, expected);
  // action digest domain
  const expectedAction = digestAction({method:'browser_navigate', params:{url:'https://example.test', secret:'should_not_appear'}, targetOrigin:'https://example.test'});
  // Our receipt's params includes secret but digest should be over provided params; ensure mismatch if we compute without secret
  assert.ok(expectedAction.startsWith('sha256:'));
  // evidence types/count/bytes present
  assert.ok(receipt.evidence && typeof receipt.evidence.count === 'number' && typeof receipt.evidence.bytes === 'number');
});

test('invalid evidence summaries normalize to an empty redacted summary', () => {
  const receipt = createSafeReceipt({
    permitId:'permit_123', runId:'run_123', projectId:'proj', profileAlias:'alias', profileId:'prof',
    actionClass:'browser.navigate', attempt:'attempted', outcome:'applied', sequence:1,
    method:'browser_navigate', params:{url:'https://example.test'}, targetOrigin:'https://example.test',
    resultDigest: digestResult({ok:true}), evidence: { types: ['INVALID TYPE'], count: 99, bytes: -1 },
  });
  assert.deepEqual(receipt.evidence, { types: [], count: 0, bytes: 0 });
});

test('fixtures: e5-cli-interactive-vectors.json vectors pass strict verification', ()=>{
  const fixturePath = fileURLToPath(new URL('../fixtures/e5-cli-interactive-vectors.json', import.meta.url));
  const fixture = JSON.parse(fs.readFileSync(fixturePath,'utf8'));
  assert.equal(fixture.contract, 'webmcp-browser-e5-cli-interactive-vectors/1');
  const pubKey = toKeyObject(fixture.keys.spkiPublicKeyPem);
  assert.ok(pubKey);
  // Verify sample receipts digests
  const appliedVec = fixture.vectors.find(v=>v.id==='sample-applied-receipt');
  assert.ok(appliedVec);
  const { receiptDigest, ...proj } = appliedVec.receipt;
  const expected = digestCanonical(RECEIPT_DIGEST_DOMAIN, proj);
  assert.equal(receiptDigest, expected);
  assert.equal(appliedVec.receipt.attempt, 'attempted');
  assert.equal(appliedVec.receipt.outcome, 'applied');
  const batchVec = fixture.vectors.find(v=>v.id==='batch-receipts');
  assert.equal(batchVec.receipts.length, 2);
  assert.equal(batchVec.receipts[0].sequence, 1);
  assert.equal(batchVec.receipts[1].sequence, 2);
  const orderDigest = digestReceiptOrder(batchVec.receipts);
  assert.equal(orderDigest, batchVec.receiptOrderDigest);
  const outputDigest = digestOutput(batchVec.receipts.map(r=>r.resultDigest));
  assert.equal(outputDigest, batchVec.outputDigest);
});

test('existing E4 negative behavior preserved (tampered digest, expired, wrong profile etc)', ()=>{
  const keys = makeKeyPair();
  const store = new PermitStore();
  const verifier = new GatewayVerifier({ publicKey: keys.publicKey, keyId: keys.keyId, permitStore: store, mode:'enforce'});
  const { message: ctx } = buildSignedContext({keys, fenceEpoch:2, bindingRevision:2});
  const fixtureTime = new Date();
  // Use valid permit for baseline
  const validPermit = buildSignedPermit({keys, claimGeneration:2, bindingRevision:2, expiresAt: new Date(Date.now()+3600000).toISOString()});
  // tampered digest should be denied
  const tampered = { ...validPermit, permitDigest:'sha256:'+'ff'.repeat(32) };
  const r1 = verifier.verifyRequest({ tool:'browser_navigate', params:{url:'https://example.test'}, permit: tampered, context: ctx, now: fixtureTime });
  assert.equal(r1.decision, 'deny');
  assert.equal(r1.reason, 'EXECUTION_PERMIT_FORGED');
  // expired permit
  const expired = buildSignedPermit({keys, claimGeneration:2, bindingRevision:2, expiresAt: new Date(Date.now()-10000).toISOString()});
  const r2 = verifier.verifyRequest({ tool:'browser_navigate', params:{url:'https://example.test'}, permit: expired, context: ctx, now: fixtureTime });
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.reason, 'EXECUTION_PERMIT_EXPIRED');
  // wrong profile
  const wrongProf = buildSignedPermit({keys, claimGeneration:2, bindingRevision:2, profileAlias:'wrong-profile'});
  const r3 = verifier.verifyRequest({ tool:'browser_navigate', params:{url:'https://example.test'}, permit: wrongProf, context: ctx, now: fixtureTime });
  assert.equal(r3.decision, 'deny');
  assert.equal(r3.reason, 'EXECUTION_PROFILE_MISMATCH');
  // wrong key
  const other = makeKeyPair();
  const wrongKey = buildSignedPermit({keys: other, claimGeneration:2, bindingRevision:2});
  const r4 = verifier.verifyRequest({ tool:'browser_navigate', params:{url:'https://example.test'}, permit: wrongKey, context: ctx, now: fixtureTime });
  assert.ok(['EXECUTION_KEY_MISMATCH','EXECUTION_PERMIT_FORGED'].includes(r4.reason));
});
