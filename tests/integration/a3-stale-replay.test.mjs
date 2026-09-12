// A3 S2b #2 — stale replay (reshaped v2 onto GatewayVerifier.verifyRequest).
// Pins: browser-kit 3d58328, vault-kit e71c764.
// Mode: A3_FENCE_MODE=observe|enforce (default enforce).
// Setup (governor, GREEN today): L1 (epoch e1) -> release -> reacquire as e2.
// RED (verifier, flips at S3 via verifier.mjs): an action carrying the e1 fence
// while the live tuple is e2 must deny PROFILE_FENCE_STALE. Today the verifier
// has no fence check, so it ALLOWs (or denies with an unrelated EXECUTION_*
// code if the permit/context pair is malformed — hence the fully-valid pair and
// the current-epoch positive control below).
// "Before side effect" needs no side-effect log: verifyRequest is a pure
// decision function and the first gate (deny-before-forward, cf the gateway
// HTTP test in tests/unit/gateway-permit.test.mjs where a deny never
// forwards), so a deny guarantees no browser effect is ever dispatched.
// All state under fs.mkdtemp(os.tmpdir()); no real browser/network/profiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A3_FENCE_MODE, tmpDir, leaseRequest, makeGovernor, healthyLiveness,
  makeA3KeyPair, buildA3Context, buildA3Permit, makeA3Verifier, expectDeny, expectAllow,
} from './a3-helpers.mjs';

test('A3 stale replay RED: e1 fence replay against live e2 denies PROFILE_FENCE_STALE at the verifier', async () => {
  const dir = tmpDir('a3-stale-replay-');
  const { governor } = makeGovernor({ dir, liveness: healthyLiveness });

  await governor.reconcileProfile('test-profile');
  const L1 = await governor.acquire(leaseRequest({ requestId: 'plr_a3e1-0001', idempotencyKey: 'a3-e1-key-11' }));
  const e1 = L1.fenceEpoch;
  const F1 = await governor.createFence({
    leaseId: L1.leaseId, fenceEpoch: L1.fenceEpoch, leaseBindingDigest: L1.leaseBindingDigest,
    bindingId: L1.bindingId, runId: L1.runId, runnerClaimDigest: L1.runnerClaimDigest,
    action: 'browser-write', actionKind: 'click',
  });
  assert.equal(F1.fenceEpoch, e1, 'replay proof must carry the e1 fence epoch');
  const released = await governor.release({
    leaseId: L1.leaseId, fenceEpoch: L1.fenceEpoch, leaseBindingDigest: L1.leaseBindingDigest,
    bindingId: L1.bindingId, bindingDigest: L1.bindingDigest, runId: L1.runId, runnerClaimDigest: L1.runnerClaimDigest,
  });
  assert.equal(released.released, true, 'L1 must release cleanly for the e2 reacquire setup');
  await governor.reconcileProfile('test-profile');
  const L2 = await governor.acquire(leaseRequest({ requestId: 'plr_a3e1-0002', runId: 'run_a3test22', idempotencyKey: 'a3-e2-key-22' }));
  const e2 = L2.fenceEpoch;
  assert.equal(e2, e1 + 1, `reacquire must advance fence epoch e1=${e1} -> e2=${e1 + 1} (got ${e2})`);

  // Live tuple is e2; the replayed action carries the e1 fence.
  const keys = makeA3KeyPair();
  const context = buildA3Context(keys, { fenceEpoch: e2 });

  const replay = makeA3Verifier(keys).verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page', fenceProof: { fenceId: F1.fenceId, fenceEpoch: F1.fenceEpoch } },
    permit: buildA3Permit(keys, { fenceEpoch: e2 }),
    context,
  });
  assert.equal(replay.decision, expectDeny(), `stale e1 replay against live e2 must deny in ${A3_FENCE_MODE} mode (got ${replay.decision})`);
  assert.equal(
    replay.reason, 'PROFILE_FENCE_STALE',
    `stale replay of e1=${e1} after e2=${e2} must fail with PROFILE_FENCE_STALE (actual ${replay.reason})`,
  );

  const current = makeA3Verifier(keys).verifyRequest({
    tool: 'browser_navigate',
    params: { url: 'https://example.test/page', fenceProof: { fenceEpoch: e2, scope: { actions: ['browser-write'] } } },
    permit: buildA3Permit(keys, { fenceEpoch: e2 }),
    context,
  });
  assert.equal(current.decision, expectAllow(), `current e2 fence tuple must allow (got ${current.decision}/${current.reason})`);
});
