// A3 S2b #3 — host restart (reshaped v2).
// Pins: browser-kit 3d58328, vault-kit e71c764.
// Mode: A3_FENCE_MODE=observe|enforce (default enforce).
// GUARD (governor, GREEN today): crash = close + reopen on the SAME durable
// state file (no manual deletion) with failed liveness probes (registry failed,
// runner terminal, browser down — what a dead holder looks like to the
// governor). Failed-liveness reconcile quarantines the orphan, advances the
// fence epoch, records a readable recovery receipt, and the pre-crash fence
// denies PROFILE_FENCE_STALE. The governor supports all of this today.
// Gateway-startup reconcile wiring is not reachable via any existing seam, so
// it is an explicit test.todo (S3 acceptance debt), not a faked assertion.
// Uses no child processes and no real browser/network/profiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';
import { A3_FENCE_MODE, DIGEST_A, tmpDir, leaseRequest, healthyLiveness } from './a3-helpers.mjs';

function makeGovernorOn(statePath, liveness) {
  const repository = new GovernorRepository({ statePath });
  const governor = new ProfileGovernor({
    repository,
    registry: {
      resolve: async () => ({
        physicalResourceId: 'prsc_a3-restart',
        bindingId: 'pb_test-profile',
        bindingRevision: 1,
        bindingDigest: DIGEST_A,
        allowedActions: ['browser-read', 'browser-write'],
      }),
    },
    claims: { validate: async (req) => ({ valid: true, active: true, allowedActions: ['browser-read', 'browser-write'], ...req }) },
    liveness: liveness ?? healthyLiveness,
    revokeGrants: async () => true,
  });
  return { governor, repository };
}

// What a dead lease holder looks like to the governor: registry failed,
// runner claim terminal, browser down -> liveness summary 'failed'.
const failedLiveness = async () => ({
  governor: 'healthy', registry: 'failed', runnerClaim: 'terminal', browserAlive: false, extensionConnected: false,
});

test('A3 host restart guard: reopen on the same state file with failed liveness quarantines the orphan with receipt, stale old fence, new epoch', async () => {
  const dir = tmpDir('a3-host-restart-');
  const statePath = path.join(dir, 'governor-state.json');
  const receiptPath = path.join(dir, 'recovery-receipt.json');

  const { governor: gov1 } = makeGovernorOn(statePath, healthyLiveness);
  await gov1.reconcileProfile('test-profile');
  const L1 = await gov1.acquire(leaseRequest({ requestId: 'plr_a3rst-0001', idempotencyKey: 'a3-rst-key-11' }));
  const oldEpoch = L1.fenceEpoch;
  const oldProof = await gov1.createFence({
    leaseId: L1.leaseId, fenceEpoch: L1.fenceEpoch, leaseBindingDigest: L1.leaseBindingDigest,
    bindingId: L1.bindingId, runId: L1.runId, runnerClaimDigest: L1.runnerClaimDigest,
    action: 'browser-write', actionKind: 'click',
  });
  gov1.close(); // host crash: no clean shutdown, durable state file survives.

  // Restart on the SAME state file: no manual file deletion.
  assert.ok(fs.existsSync(statePath), 'restart must reuse the durable state file (no manual deletion)');
  const { governor: gov2 } = makeGovernorOn(statePath, failedLiveness);
  const reconciled = await gov2.reconcileProfile('test-profile');
  assert.equal(reconciled.state, 'quarantined', `orphaned lease after crash must be quarantined in ${A3_FENCE_MODE} mode (actual ${reconciled.state})`);
  assert.ok(reconciled.fenceEpoch > oldEpoch, `recovery must advance to a new epoch > ${oldEpoch} (got ${reconciled.fenceEpoch})`);

  const receipts = gov2.listRecoveryReceipts();
  assert.ok(receipts.length > 0, 'a recovery receipt must exist after host-restart quarantine');
  fs.writeFileSync(receiptPath, JSON.stringify(receipts[0], null, 2), 'utf8');
  const reread = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.ok(reread.receiptId && reread.receiptDigest, 'recovery receipt must be readable with receiptId and receiptDigest');

  let oldError = null;
  try {
    await gov2.authorizeFence(oldProof);
  } catch (error) {
    oldError = error;
  }
  assert.ok(oldError, 'old fence receipt must be invalid after restart quarantine');
  assert.equal(oldError?.code, 'PROFILE_FENCE_STALE', `old receipt must be invalid with PROFILE_FENCE_STALE (actual ${oldError?.code})`);
  gov2.close();
});

test('S3: gateway bootstrap reconcile wires orphan quarantine', async () => {
  const { createGatewayGovernor, reconcileGatewayProfiles, makeGovernorActiveFenceReader } =
    await import('../../server/gateway_server.js');
  const dir = tmpDir('a3-gw-reconcile-');
  const statePath = path.join(dir, 'governor-state.json');
  const adapters = (liveness) => ({
    statePath,
    registry: {
      resolve: async () => ({
        physicalResourceId: 'prsc_a3-restart',
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

  // Pre-crash holder through the gateway bootstrap seam (not a bare Governor).
  const pre = createGatewayGovernor(adapters(healthyLiveness));
  await pre.governor.reconcileProfile('test-profile');
  const L1 = await pre.governor.acquire(leaseRequest({ requestId: 'plr_a3gwr-0001', idempotencyKey: 'a3-gwr-key-11' }));
  const oldEpoch = L1.fenceEpoch;
  const oldProof = await pre.governor.createFence({
    leaseId: L1.leaseId, fenceEpoch: L1.fenceEpoch, leaseBindingDigest: L1.leaseBindingDigest,
    bindingId: L1.bindingId, runId: L1.runId, runnerClaimDigest: L1.runnerClaimDigest,
    action: 'browser-write', actionKind: 'click',
  });
  pre.governor.close(); // host crash: durable state file survives.

  // Gateway bootstrap reconcile on the SAME state file with failed liveness.
  const post = createGatewayGovernor(adapters(failedLiveness));
  const results = await reconcileGatewayProfiles({ governor: post.governor, aliases: ['test-profile'] });
  assert.equal(results.length, 1, 'bootstrap reconcile must report one profile');
  assert.equal(results[0].ok, true, `bootstrap reconcile must succeed (got ${JSON.stringify(results[0])})`);
  assert.equal(results[0].state, 'quarantined', `crash orphan must be quarantined via the gateway seam in ${A3_FENCE_MODE} mode (actual ${results[0].state})`);
  assert.ok(results[0].fenceEpoch > oldEpoch, `recovery must advance past pre-crash epoch ${oldEpoch} (got ${results[0].fenceEpoch})`);

  // S6b Fix 3: the gateway live-tuple reader is fail-closed — a quarantined
  // resource must NOT supply a live epoch (it previously returned the
  // post-recovery epoch, letting the weak verifier treat it as live). The
  // safety property is preserved below: the pre-crash fence authorizes STALE.
  const live = makeGovernorActiveFenceReader(post.governor)('test-profile');
  assert.equal(live, null, 'gateway live-tuple reader must not supply an epoch for a quarantined resource');

  assert.ok(post.governor.listRecoveryReceipts().length > 0, 'a recovery receipt must exist after bootstrap quarantine');

  let oldError = null;
  try {
    await post.governor.authorizeFence(oldProof);
  } catch (error) {
    oldError = error;
  }
  assert.equal(oldError?.code, 'PROFILE_FENCE_STALE', `pre-crash fence must be stale after bootstrap quarantine (actual ${oldError?.code})`);
  post.governor.close();
});
