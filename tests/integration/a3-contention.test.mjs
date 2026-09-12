// A3 S2b #1 — contention (reshaped v2).
// Pins: browser-kit 3d58328, vault-kit e71c764.
// Mode: A3_FENCE_MODE=observe|enforce (default enforce).
// GUARD (governor race, GREEN today): 2 contenders race for one physical
// resource -> exactly 1 winner; loser code is PROFILE_LEASE_CONFLICT. That code
// is the governor's accepted contract (unit governor-lease-race.test.mjs); the
// gateway translation to a fence code is S3 work, not asserted here.
// RED (GatewayVerifier.verifyRequest, flips at S3 via verifier.mjs): with a
// fully-permitted request, the current fence tuple allows; an absent physical
// fence must deny PROFILE_FENCE_REQUIRED and a stale tuple must deny
// PROFILE_FENCE_STALE. Today the verifier has no fence check, so both ALLOW.
// All state under fs.mkdtemp(os.tmpdir()); no real browser/network/profiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A3_FENCE_MODE, CLAIM_A, CLAIM_B, DIGEST_A, tmpDir, leaseRequest, makeGovernor,
  makeA3KeyPair, buildA3Context, buildA3Permit, makeA3Verifier, expectDeny, expectAllow,
} from './a3-helpers.mjs';

function contenderRequest(alias, runId, keyId, claim) {
  return leaseRequest({
    requestId: `plr_race-${keyId}`,
    profileAlias: alias,
    runId,
    runnerClaimDigest: claim,
    bindingId: 'pb_test-profile',
    bindingRevision: 1,
    bindingDigest: DIGEST_A,
    requestedActions: ['browser-read'],
    idempotencyKey: `race-key-${keyId}`,
  });
}

test('A3 contention guard: sub-50ms race yields exactly 1 winner, loser PROFILE_LEASE_CONFLICT (governor contract)', async () => {
  const dir = tmpDir('a3-contention-');
  const { governor } = makeGovernor({
    dir,
    registryPhysicalId: 'prsc_shared_resource',
    allowedActions: ['browser-read'],
    liveness: async () => ({ governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true }),
  });
  await governor.reconcileProfile('alpha');
  const [a, b] = await Promise.allSettled([
    governor.acquire(contenderRequest('alpha', 'run_race111x', 'win-a001', CLAIM_A)),
    governor.acquire(contenderRequest('beta', 'run_race222x', 'win-b001', CLAIM_B)),
  ]);
  const winners = [a, b].filter((r) => r.status === 'fulfilled');
  const losers = [a, b].filter((r) => r.status === 'rejected');
  assert.equal(winners.length, 1, `exactly 1 winner expected, got ${winners.length}`);
  assert.equal(losers.length, 1, `exactly 1 loser expected, got ${losers.length}`);
  assert.equal(
    losers[0].reason?.code, 'PROFILE_LEASE_CONFLICT',
    `governor race loser owns PROFILE_LEASE_CONFLICT per governor contract (actual ${losers[0].reason?.code}, mode=${A3_FENCE_MODE})`,
  );
});

test('A3 contention RED: verifier allows the current fence tuple but denies absent/stale physical fence', () => {
  const keys = makeA3KeyPair();
  const liveEpoch = 2;
  const context = buildA3Context(keys, { fenceEpoch: liveEpoch });

  const current = makeA3Verifier(keys).verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page', fenceProof: { fenceEpoch: liveEpoch, scope: { actions: ['browser-write'] } } },
    permit: buildA3Permit(keys, { fenceEpoch: liveEpoch }),
    context,
  });
  assert.equal(current.decision, expectAllow(), `current fence tuple must allow (got ${current.decision}/${current.reason})`);

  const absent = makeA3Verifier(keys).verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page' },
    permit: buildA3Permit(keys, { fenceEpoch: liveEpoch }),
    context,
  });
  assert.equal(absent.decision, expectDeny(), `absent physical fence must deny in ${A3_FENCE_MODE} mode (got ${absent.decision})`);
  assert.equal(
    absent.reason, 'PROFILE_FENCE_REQUIRED',
    `absent physical fence must deny PROFILE_FENCE_REQUIRED (actual ${absent.reason})`,
  );

  const stale = makeA3Verifier(keys).verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page', fenceProof: { fenceEpoch: liveEpoch - 1 } },
    permit: buildA3Permit(keys, { fenceEpoch: liveEpoch }),
    context,
  });
  assert.equal(stale.decision, expectDeny(), `stale physical fence must deny in ${A3_FENCE_MODE} mode (got ${stale.decision})`);
  assert.equal(
    stale.reason, 'PROFILE_FENCE_STALE',
    `stale physical fence must deny PROFILE_FENCE_STALE (actual ${stale.reason})`,
  );
});
