// A3 RED #5 — broker fence: enforce mode broker-fill without fence -> typed deny;
// with fence -> pass; no alternative mutation path exists.
// Pins: browser-kit 3d58328, vault-kit e71c764.
// Mode: A3_FENCE_MODE=observe|enforce (default enforce). RED in enforce.
// Baseline RED because: vault broker.js:137-216 mutating calls (evaluateJS,
// webmcp.invokeTool, waitForStable, dispatchClick) lack fence plumbing (R7), so
// enforce rejects even the fenced fill and the deny is not typed end-to-end.
// ADR 0012: PROFILE_FENCE_REQUIRED = physical fence missing;
// EXECUTION_PERMIT_REQUIRED = execution permit missing. They must not conflate.
// All state under fs.mkdtemp(os.tmpdir()); gateway/store are in-process fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ProfileGovernorError } from '../../profile-governor/errors.mjs';

const require = createRequire(import.meta.url);
const broker = require('../../../webmcp-vault-kit/lib/broker.js');

const A3_FENCE_MODE = process.env.A3_FENCE_MODE ?? 'enforce';

function mockStore() {
  return {
    useLease: ({ field }) => ({ value: `secret-for-${field}` }),
  };
}

// Enforce-mode gateway fake: every mutating broker call requires a physical
// fence proof in params; otherwise deny with PROFILE_FENCE_REQUIRED (never the
// permit code). Mirrors the post-slice gateway contract.
function enforcingGateway(calls) {
  return {
    async call(method, params = {}) {
      calls.push({ method, params });
      if (!params.fenceProof && !params.fenceId && !params.fence) {
        throw new ProfileGovernorError('PROFILE_FENCE_REQUIRED', `physical fence missing for ${method}`);
      }
      if (method === 'evaluateJS') {
        const code = String(params.code ?? '');
        if (code.includes('requestSubmit') || code.includes('broker submit')) return { result: { result: { ok: true } } };
        if (code.includes('digest') || code.includes('crypto.subtle')) return { result: { result: { match: true } } };
        if (code.includes('getBoundingClientRect')) return { result: { result: { x: 10, y: 10, tag: 'input', name: null, type: 'password' } } };
        return { result: { result: { x: 10, y: 10, tag: 'input', name: null, type: 'password' } } };
      }
      if (method === 'webmcp.invokeTool') return { ok: true };
      if (method === 'waitForStable') return { ok: true };
      if (method === 'dispatchClick') return { ok: true };
      return { ok: true };
    },
  };
}

function fillOptions(gateway) {
  return {
    store: mockStore(),
    gateway,
    leaseId: 'lease_broker-test-01',
    token: 'token-test',
    siteOrigin: 'https://example.com',
    profileBindingId: 'pb_test-profile',
    purpose: 'login',
    profileId: 'test-profile',
    fields: { username: { selector: '#user' }, password: { selector: '#pass' } },
    submit: { selector: '#submit', mode: 'click' },
  };
}

test('A3 broker fence: fill without fence is denied with PROFILE_FENCE_REQUIRED (not EXECUTION_PERMIT_REQUIRED)', async () => {
  const calls = [];
  const gateway = enforcingGateway(calls);
  let error = null;
  try {
    await broker.fillLoginFormWithLease(fillOptions(gateway));
  } catch (err) {
    error = err;
  }
  assert.ok(error, `broker fill without fence must be denied in ${A3_FENCE_MODE} mode`);
  assert.equal(error?.code, 'PROFILE_FENCE_REQUIRED', `missing physical fence must deny with PROFILE_FENCE_REQUIRED, not EXECUTION_PERMIT_REQUIRED (actual code=${error?.code} message=${error?.message})`);
  assert.notEqual(error?.code, 'EXECUTION_PERMIT_REQUIRED', 'ADR 0012: fence denial must not conflate with EXECUTION_PERMIT_REQUIRED');
});

test('A3 broker fence: fill with fence passes in enforce mode', async () => {
  const calls = [];
  const gateway = enforcingGateway(calls);
  const fenceProof = { fenceId: 'fence_a3broker0001', fenceEpoch: 2, leaseBindingDigest: 'sha256:' + 'd'.repeat(64) };
  const options = { ...fillOptions(gateway), fenceProof, fence: fenceProof };
  let receipt = null;
  let error = null;
  try {
    receipt = await broker.fillLoginFormWithLease(options);
  } catch (err) {
    error = err;
  }
  assert.equal(error, null, `fenced broker fill must complete in ${A3_FENCE_MODE} mode without PROFILE_FENCE_REQUIRED (broker must plumb the fence proof to gateway; got code=${error?.code} message=${error?.message})`);
  assert.equal(receipt?.status, 'completed', `fenced broker fill must complete in ${A3_FENCE_MODE} mode (got ${JSON.stringify(receipt)})`);
  assert.ok(calls.length >= 4, `fenced fill must drive evaluateJS/invokeTool/dispatchClick/waitForStable (saw ${calls.length} calls)`);
});

test('A3 broker fence: no alternative mutation path bypasses the fence', () => {
  const brokerUrl = new URL('../../../webmcp-vault-kit/lib/broker.js', import.meta.url);
  const text = fs.readFileSync(brokerUrl, 'utf8');
  const callSites = text.split('\n').filter((line) => line.includes('gateway.call('));
  assert.ok(callSites.length >= 4, `broker must expose its mutating gateway calls for audit (found ${callSites.length})`);
  const unguarded = callSites.filter((line) => !line.includes('fence'));
  assert.equal(unguarded.length, 0, `every broker mutating gateway.call must carry the fence proof; unguarded paths: ${JSON.stringify(unguarded)} (see broker.js:137-216)`);
});
