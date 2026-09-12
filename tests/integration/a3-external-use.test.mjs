// A3 S2b #4 — external use (reshaped v2 onto the spec's real case).
// Pins: browser-kit 3d58328, vault-kit e71c764.
// Mode: A3_FENCE_MODE=observe|enforce (default enforce).
// GUARD (governor, GREEN today — verified by probe, not RED): with NO current
// lease and liveness externalUse:true (browser alive, extension disconnected),
// detectExternalUse yields external_use, and a contender acquire is denied
// PROFILE_EXTERNAL_USE. Both are governor-supported today, so this test guards
// the contract rather than failing.
// Gateway-side external-use detection wiring is not reachable via any existing
// seam, so it is an explicit test.todo (S3 acceptance debt), not a faked
// assertion. See SCENARIO_DEBT_4 in S2b-writer-report.md (no RED keepable here:
// a RED against governor behavior could never flip GREEN under S3's frozen
// write-set, which excludes profile-governor).
// All state under fs.mkdtemp(os.tmpdir()); no real browser/network/profiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { A3_FENCE_MODE, DIGEST_A, tmpDir, leaseRequest, makeGovernor } from './a3-helpers.mjs';

test('S3: gateway external-use detection wiring', async () => {
  const { createGatewayGovernor, checkGatewayExternalUse } =
    await import('../../server/gateway_server.js');
  const adapters = (dir, liveness) => ({
    statePath: path.join(dir, 'governor-state.json'),
    registry: {
      resolve: async () => ({
        physicalResourceId: 'prsc_a3-extwire',
        bindingId: 'pb_test-profile',
        bindingRevision: 1,
        bindingDigest: DIGEST_A,
        allowedActions: ['browser-read', 'browser-write'],
      }),
    },
    claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read', 'browser-write'], ...req }) },
    liveness,
    revokeGrants: async () => true,
  });
  const externalUseLiveness = async () => ({
    governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false,
  });
  const healthyLiveness = async () => ({
    governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true,
  });
  const expectDeny = A3_FENCE_MODE === 'observe' ? 'would-deny' : 'deny';
  const expectAllow = A3_FENCE_MODE === 'observe' ? 'would-allow' : 'allow';

  // External use with no lease held: the gateway seam must surface the typed
  // deny instead of trusting TTL.
  const ext = createGatewayGovernor(adapters(tmpDir('a3-extwire-'), externalUseLiveness));
  await ext.governor.reconcileProfile('test-profile');
  const verdict = await checkGatewayExternalUse({ governor: ext.governor, profileAlias: 'test-profile' });
  assert.equal(verdict.checked, true, 'gateway external-use probe must run against the real Governor');
  assert.equal(verdict.decision, expectDeny, `external use must deny via the gateway seam in ${A3_FENCE_MODE} mode (got ${verdict.decision})`);
  assert.equal(verdict.reason, 'PROFILE_EXTERNAL_USE', `external use must carry PROFILE_EXTERNAL_USE (actual ${verdict.reason})`);
  ext.governor.close();

  // Healthy profile with no external use: no deny.
  const ok = createGatewayGovernor(adapters(tmpDir('a3-extwire-ok-'), healthyLiveness));
  await ok.governor.reconcileProfile('test-profile');
  const clear = await checkGatewayExternalUse({ governor: ok.governor, profileAlias: 'test-profile' });
  assert.equal(clear.reason, null, `healthy profile must not be denied (actual ${clear.reason})`);
  assert.equal(clear.decision, expectAllow, `healthy profile must allow via the gateway seam (got ${clear.decision})`);
  ok.governor.close();
});

test('A3 external use guard: no-lease external use yields external_use and contender hits PROFILE_EXTERNAL_USE', async () => {
  const dir = tmpDir('a3-external-use-');
  let externalUse = false;
  const { governor } = makeGovernor({
    dir,
    liveness: async () => (externalUse
      ? { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: false }
      : { governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }),
  });
  await governor.reconcileProfile('test-profile');

  // External SingletonLock appears while no lease is held.
  externalUse = true;
  const after = await governor.detectExternalUse('test-profile');
  assert.equal(
    after.state, 'external_use',
    `detectExternalUse with no current lease and externalUse liveness must yield external_use in ${A3_FENCE_MODE} mode (actual state=${after.state})`,
  );
  assert.equal(after.stateReasonCode, 'PROFILE_EXTERNAL_USE', `reason must be PROFILE_EXTERNAL_USE (actual ${after.stateReasonCode})`);

  // A contender must still hit the external-use fence, not succeed.
  const contenderError = await governor.acquire(
    leaseRequest({ requestId: 'plr_a3ext-0002', runId: 'run_a3test22', idempotencyKey: 'a3-ext-key-22' }),
  ).then(() => null, (error) => error);
  assert.ok(contenderError, 'contender acquire during external use must be denied');
  assert.ok(
    ['PROFILE_EXTERNAL_USE', 'PROFILE_QUARANTINED'].includes(contenderError?.code),
    `contender must get PROFILE_EXTERNAL_USE/PROFILE_QUARANTINED, not ${contenderError?.code} (mode=${A3_FENCE_MODE})`,
  );
});
