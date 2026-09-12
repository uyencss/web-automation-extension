import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { GovernorRepository } from '../../profile-governor/repository.mjs';
import { ProfileGovernor } from '../../profile-governor/lease-service.mjs';
import { canonicalJson, digestCanonical, SCHEMAS } from '../../server/gateway/trusted-context-schema.mjs';
import { PermitStore } from '../../server/gateway/permit-store.mjs';
import { GatewayVerifier } from '../../server/gateway/verifier.mjs';

export const A3_FENCE_MODE = process.env.A3_FENCE_MODE ?? 'enforce';

export const DIGEST_A = 'sha256:' + 'a'.repeat(64);
export const CLAIM_A = 'sha256:' + 'b'.repeat(64);
export const CLAIM_B = 'sha256:' + 'c'.repeat(64);

export function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function leaseRequest(overrides = {}) {
  return {
    schema: 'webmcp-profile-lease-request/1',
    requestId: 'plr_a3-0001',
    ownerType: 'automation',
    nodeId: 'node-test-1',
    runId: 'run_a3test11',
    runnerClaimDigest: CLAIM_A,
    bindingId: 'pb_test-profile',
    bindingRevision: 1,
    bindingDigest: DIGEST_A,
    profileAlias: 'test-profile',
    leaseMode: 'single-context',
    requestedActions: ['browser-read', 'browser-write'],
    heartbeatIntervalMs: 1000,
    leaseTtlMs: 5000,
    idempotencyKey: 'a3-key-1111',
    ...overrides,
  };
}

export function makeGovernor({ dir, liveness, registryPhysicalId = 'prsc_a3-shared', allowedActions = ['browser-read', 'browser-write'] } = {}) {
  const statePath = path.join(dir, 'governor-state.json');
  const repository = new GovernorRepository({ statePath });
  const governor = new ProfileGovernor({
    repository,
    registry: {
      resolve: async (alias) => ({
        physicalResourceId: registryPhysicalId,
        bindingId: 'pb_test-profile',
        bindingRevision: 1,
        bindingDigest: DIGEST_A,
        allowedActions: [...allowedActions],
      }),
    },
    claims: {
      validate: async (req) => ({ valid: true, active: true, allowedActions: [...allowedActions], ...req }),
    },
    liveness: liveness ?? (async () => ({
      governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true,
    })),
    revokeGrants: async () => true,
  });
  return { governor, repository, statePath };
}

export const healthyLiveness = async () => ({
  governor: 'healthy', registry: 'healthy', runnerClaim: 'active', browserAlive: true, extensionConnected: true,
});

// --- S2b: GatewayVerifier RED seam helpers ---------------------------------
// S3 seam contract (frozen write-set: server/gateway/verifier.mjs): an action
// must carry its physical fence tuple in params (fenceProof, mirroring the
// broker convention fenceProof/fenceId/fence). The verifier compares
// params.fenceProof.fenceEpoch against the live tuple (context.fenceEpoch):
// absent -> PROFILE_FENCE_REQUIRED, stale -> PROFILE_FENCE_STALE. The verifier
// has no such check today, so fully-permitted fenceless/stale requests ALLOW
// (the RED). Builders below mirror tests/unit/gateway-permit.test.mjs so the
// permit/context pair is valid and only the fence is missing/stale.

export const A3_VERIFY_MODE = A3_FENCE_MODE === 'observe' ? 'observe' : 'enforce';
export const expectDeny = () => (A3_VERIFY_MODE === 'observe' ? 'would-deny' : 'deny');
export const expectAllow = () => (A3_VERIFY_MODE === 'observe' ? 'would-allow' : 'allow');

export const A3_DIGEST = (ch) => `sha256:${ch.repeat(64)}`;

export function makeA3KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { publicKey, privateKey, rawPublicKeyHex, keyId: 'ed25519-test-key-01' };
}

let a3NonceCounter = 0;

export function buildA3Context(keys, { fenceEpoch = 2, runId = 'run_a3test22' } = {}) {
  const base = {
    schema: SCHEMAS.TRUSTED_CONTEXT, messageId: `ctxmsg_a3s2b${String(a3NonceCounter).padStart(4, '0')}`, seq: 1, runId,
    claimGeneration: fenceEpoch, claimDigest: A3_DIGEST('0'), projectId: 'project_test_123',
    profileAlias: 'interactive-profile', profileId: 'interactive-profile', bindingId: 'pb_test_123',
    bindingRevision: 2, bindingDigest: A3_DIGEST('1'), automationStoreRevision: 3, automationStoreDigest: A3_DIGEST('2'),
    siteStoreRevision: 4, siteStoreDigest: A3_DIGEST('3'), fenceEpoch, phaseId: 'interactive-action', stateVersion: 1,
    planRevision: 1, planDigest: A3_DIGEST('4'), instructionDigest: A3_DIGEST('5'), policyRevision: A3_DIGEST('6'),
    ttlMs: 60000, keyId: keys.keyId, publicKey: keys.rawPublicKeyHex, issuedAt: new Date().toISOString(),
    notBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revocations: [],
  };
  const canonical = canonicalJson(base);
  const contextDigest = digestCanonical('webmcp-digest-v1:trusted-context', base);
  const signature = sign(null, Buffer.from(`webmcp-digest-v1:trusted-context\n${canonical}`, 'utf8'), keys.privateKey).toString('hex');
  return { ...base, signature, contextDigest };
}

export function buildA3Permit(keys, { fenceEpoch = 2, runId = 'run_a3test22' } = {}) {
  const nonce = `nonce_a3s2b_${a3NonceCounter++}`;
  const base = {
    schema: SCHEMAS.PERMIT, permitId: `permit_a3s2b_${nonce}`, runId,
    claimGeneration: fenceEpoch, claimDigest: A3_DIGEST('0'), projectId: 'project_test_123',
    profileAlias: 'interactive-profile', profileId: 'interactive-profile', bindingId: 'pb_test_123',
    bindingRevision: 2, bindingDigest: A3_DIGEST('1'), automationStoreRevision: 3, automationStoreDigest: A3_DIGEST('2'),
    siteStoreRevision: 4, siteStoreDigest: A3_DIGEST('3'), phaseId: 'interactive-action',
    origins: ['https://example.test'], actionClasses: ['browser.navigate'], budget: { maxCalls: 5 }, stateVersion: 1,
    planRevision: 1, planDigest: A3_DIGEST('4'), instructionDigest: A3_DIGEST('5'), policyRevision: A3_DIGEST('6'),
    keyId: keys.keyId, nonce, issuedAt: new Date().toISOString(),
    notBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString(),
    ttlMs: 30000, revocationId: 'rev_001',
  };
  const canonical = canonicalJson(base);
  const signature = sign(null, Buffer.from(`webmcp-digest-v1:permit\n${canonical}`, 'utf8'), keys.privateKey).toString('hex');
  return { ...base, signature, permitDigest: digestCanonical('webmcp-digest-v1:permit', base) };
}

export function makeA3Verifier(keys) {
  return new GatewayVerifier({ publicKey: keys.publicKey, permitStore: new PermitStore(), mode: A3_VERIFY_MODE });
}
