import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACTIONS,
  computeFenceDigest,
  computeLeaseBindingDigest,
  isRfc3339DateTime,
  redactResource,
  STATES,
  validateActionFence,
} from '../../../profile-governor/contracts.mjs';
import { STATE_SCHEMA } from '../../../profile-governor/repository.mjs';
import { validateEventIntegrity, validateRedactedEvent, EVENT_REASONS } from '../../../profile-governor/events.mjs';
import { computeRecoveryPlanDigest, validateRecoveryReceipt } from '../../../profile-governor/recovery.mjs';
import { createProfileGovernor } from '../../../profile-governor/lease-service.mjs';
import { createLocalGovernorServer } from '../../../profile-governor/ipc-server.mjs';
import { GovernorClient } from '../../../profile-governor/client.mjs';

const SUBCOMMANDS = ['status', 'inspect', 'receipts', 'events', 'reconcile', 'recover', 'release'];
const AUTH_GATED = new Set(['inspect', 'receipts', 'events', 'reconcile', 'recover', 'release']);
// Per-subcommand closed flag sets (F5). `help`/`h` are handled before dispatch
// and are never accepted as operation flags (keeps --json envelopes exact).
const FLAG_SETS = {
  status: new Set(['json']),
  inspect: new Set(['approve', 'json']),
  receipts: new Set(['approve', 'json']),
  events: new Set(['approve', 'json']),
  reconcile: new Set(['approve', 'json']),
  recover: new Set(['approve', 'json']),
  release: new Set(['approve', 'json', 'lease-id']),
};
const LEASE_ID = /^lease_[0-9a-f]{16}$/;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FENCE_ID = /^fence_[0-9a-f]{16}$/;
const TAB_ID = /^tab_[a-z0-9-]{4,128}$/;
const ALIAS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BINDING_ID = /^pb_[a-z0-9-]+$/;
const RUN_ID = /^run_[a-z0-9-]{8,96}$/;
const PHYSICAL_ID = /^prsc_[a-zA-Z0-9._-]{2,512}$/;
const ACTION_ID = /^[a-z0-9_-]{4,80}$/;
const OUTCOMES = new Set(['prepared', 'dispatched', 'confirmed', 'failed-known', 'indeterminate']);
const ACTION_KINDS = new Set(['click', 'type', 'scroll', 'waitForStable', 'batch', 'read', 'queryIndexedDB']);

const RESOURCE_KEYS = new Set([
  'physicalResourceId', 'profileAlias', 'aliases', 'state', 'stateReasonCode',
  'stateChangedAt', 'fenceEpoch', 'currentLeaseId', 'needsReconciliation',
  'livenessSummary', 'cooldownUntil', 'recoveryPlanDigest', 'recoverySubjectKind',
  'recoveryBindingId', 'recoveryBindingRevision', 'recoveryBindingDigest',
  'lastRecoveryEvidenceDigest', 'lastRecoveredAt',
]);

const LEASE_KEYS = new Set([
  'leaseId', 'physicalResourceId', 'profileAlias', 'bindingId', 'bindingRevision',
  'bindingDigest', 'runId', 'runnerClaimDigest', 'leaseMode', 'fenceEpoch',
  'leaseBindingDigest', 'state', 'stateReasonCode', 'stateChangedAt', 'issuedAt',
  'expiresAt', 'heartbeatIntervalMs', 'leaseTtlMs', 'nodeId', 'ownerType',
  'idempotencyKey', 'fingerprint', 'requestedActions', 'allowedActions', 'tabs',
  'maxTabs', 'actionUses', 'actionJournal', 'fences', 'heartbeatCount',
  'releasedAt', 'recoveryPlanDigest',
]);

const STATE_KEYS = new Set([
  'schema', 'serviceGeneration', 'writerGeneration', 'writerId',
  'resources', 'leases', 'events', 'eventIntegrityDigests', 'receipts',
]);

const RECEIPT_ALLOWLIST_KEYS = Object.freeze([
  'schema', 'receiptId', 'leaseId', 'profileAlias', 'bindingId',
  'bindingRevision', 'bindingDigest', 'runId', 'priorState', 'newState',
  'priorFenceEpoch', 'newFenceEpoch', 'reasonCode', 'probeOutcomes',
  'lastActionOutcome', 'dependentGrantRevokeStatus', 'authorityKind',
  'createdAt', 'receiptDigest', 'eventId',
]);

const PROBE_ALLOWLIST_KEYS = Object.freeze([
  'governorHealth', 'runnerClaim', 'browserAlive', 'extensionConnected',
  'dependentGrantsRevoked', 'registryCurrent',
]);

function projectReceipt(receipt) {
  const result = {};
  for (const key of RECEIPT_ALLOWLIST_KEYS) {
    if (receipt[key] === undefined) continue;
    if (key === 'probeOutcomes' && receipt[key] && typeof receipt[key] === 'object') {
      const probe = {};
      for (const pk of PROBE_ALLOWLIST_KEYS) {
        if (receipt[key][pk] !== undefined) probe[pk] = receipt[key][pk];
      }
      result[key] = probe;
    } else {
      result[key] = receipt[key];
    }
  }
  return result;
}

const EVENT_ALLOWLIST_KEYS = Object.freeze([
  'schema', 'eventId', 'leaseId', 'profileAlias', 'state', 'stateReasonCode',
  'fenceEpoch', 'bindingDigest', 'bindingId', 'runId', 'timestamp',
  'leaseBindingDigest', 'counts', 'livenessSummary', 'grantRevokeStatus',
]);

const COUNT_ALLOWLIST_KEYS = Object.freeze(['heartbeats', 'actions', 'pages']);

function projectEvent(event) {
  const result = {};
  for (const key of EVENT_ALLOWLIST_KEYS) {
    if (event[key] === undefined) continue;
    if (key === 'counts' && event[key] && typeof event[key] === 'object') {
      const counts = {};
      for (const ck of COUNT_ALLOWLIST_KEYS) {
        if (event[key][ck] !== undefined) counts[ck] = event[key][ck];
      }
      result[key] = counts;
    } else {
      result[key] = event[key];
    }
  }
  return result;
}
// Boolean flags (F5): bare `--json` / `--approve` mean true and NEVER consume
// the following token as a value; only `--flag=value` carries a value. This
// keeps `--json status` as `status` in JSON mode instead of swallowing the
// subcommand as the flag value.
const BOOLEAN_FLAGS = new Set(['json', 'approve', 'help', 'h']);

function resolveStatePath() {
  const explicit = process.env.WEBMCP_GOVERNOR_STATE;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return path.join(os.homedir(), '.webmcp', 'governor-state.json');
}

function resolveGatewayBaseUrl() {
  const raw = process.env.WEBMCP_GATEWAY_URL || 'http://127.0.0.1:7865';
  const trimmed = String(raw).replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
}

function parseArgs(args) {
  const flags = {};
  const seen = new Set();
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h') {
      if (seen.has('help')) throw typedError('PROFILE_REQUEST_INVALID', 'duplicate flag --help');
      seen.add('help');
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    let key;
    let value;
    let hasEq = false;
    if (eq !== -1) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
      hasEq = true;
    } else {
      key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        value = true;
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
    }
    if (!key) throw typedError('PROFILE_REQUEST_INVALID', 'malformed flag');
    if (key === 'h') key = 'help';
    if (seen.has(key)) throw typedError('PROFILE_REQUEST_INVALID', `duplicate flag --${key}`);
    seen.add(key);
    if (hasEq && (value === undefined || value === '')) {
      throw typedError('PROFILE_REQUEST_INVALID', `flag --${key} requires a value`);
    }
    flags[key] = value;
  }
  return { flags, positional };
}

function printGovernorHelp() {
  console.log(`webmcp-browser governor — operator recovery CLI

Usage:
  webmcp-browser governor --help
  webmcp-browser governor status [--json]
  webmcp-browser governor inspect <alias> --approve [--json]
  webmcp-browser governor receipts --approve [--json]
  webmcp-browser governor events --approve [--json]
  webmcp-browser governor reconcile <alias> --approve [--json]
  webmcp-browser governor recover <alias> --approve [--json]
  webmcp-browser governor release --lease-id <id> --approve [--json]

Options:
  --approve            operator capability ({kind:'operator'}), required for inspect, receipts, events, reconcile, recover, release
  --json               machine-readable JSON output
  --lease-id <id>      lease id for release
`);
}

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Exact JSON-mode detection (F5): scan the RAW args for any token equal to
// `--json` or starting with `--json=` (except `--json=false`, which is an
// explicit non-JSON opt-out). When present, failure paths (parse errors
// included: duplicate flags, invalid values, unknown flags, ordering) emit
// exactly ONE JSON document {ok:false,error:{code,message}} on stdout, exit 2
// — no help text mixed in. Explicit `--json=false` preserves typed stderr and
// empty stdout on failure.
function rawArgsWantJson(args) {
  return Array.isArray(args) && args.some((token) => token === '--json' || (typeof token === 'string' && token.startsWith('--json=') && token !== '--json=false'));
}

function failEnvelope(error) {
  const code = error?.code || 'UNKNOWN';
  const message = error?.message || String(error);
  return { ok: false, error: { code, message } };
}

// Honest liveness (F2): probe the local gateway health endpoint and read only
// the fields the gateway actually exposes (see server/gateway_server.js
// GET /health: { ok, schema, extensionConnected, profiles, ... }).
// - reachable + extension connected -> browserAlive/extensionConnected true;
// - reachable without connection -> false/false;
// - unreachable/timeout/parse error -> UNKNOWN probes (omit fields so the
//   composite summary becomes `unknown`).
// NEVER asserts runnerClaim:'active' or a healthy browser without evidence.
async function probeGatewayLiveness() {
  const url = `${resolveGatewayBaseUrl()}/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return {};
    let payload;
    try {
      payload = await response.json();
    } catch {
      return {};
    }
    if (!payload || typeof payload !== 'object') return {};
    if (payload.extensionConnected === true) return { browserAlive: true, extensionConnected: true };
    if (payload.extensionConnected === false) return { browserAlive: false, extensionConnected: false };
    // Gateway reachable but without a recognizable connection field:
    // conservatively report disconnected rather than inventing health.
    return { browserAlive: false, extensionConnected: false };
  } catch {
    return {};
  }
}

async function buildRegistryOrThrow() {
  let adapter;
  try {
    const { createGovernorRegistryAdapter } = await import('../../../server/gateway/governor-registry-adapter.mjs');
    adapter = createGovernorRegistryAdapter({});
  } catch (error) {
    throw typedError('PROFILE_REGISTRY_UNAVAILABLE', `governor registry is unavailable (${error?.message || 'import failed'})`);
  }
  const st = typeof adapter?.status === 'function' ? adapter.status() : null;
  if (!st?.ok) throw typedError('PROFILE_REGISTRY_UNAVAILABLE', `governor registry is unavailable (${st?.reason || 'no dispatcher config'})`);
  return adapter;
}

async function buildClient({ withApprove, registry }) {
  const statePath = resolveStatePath();
  const { GovernorRepository } = await import('../../../profile-governor/repository.mjs');
  const repository = new GovernorRepository({ statePath });
  // Offline operator CLI honesty (F2):
  // - claims always reject PROFILE_CLAIM_REQUIRED (no fabricated acceptance);
  // - revokeGrants always false (this CLI cannot revoke grants);
  // - liveness is only the gateway /health probe above (unknown when offline);
  // - recoveryAuthorizer always refuses (never returns `evidence`): the
  //   offline CLI cannot observe authoritative recovery facts, so recovery
  //   fails closed at the authorizer-result/authorization check with no
  //   fabricated evidence; the indeterminate-crash case still returns
  //   PROFILE_RECLAIM_UNSAFE (no reclaim) because the core rejects
  //   unresolved indeterminate journals before the authorizer.
  const service = createProfileGovernor({
    repository,
    registry,
    claims: {
      validate: async () => {
        throw typedError('PROFILE_CLAIM_REQUIRED', 'operator CLI has no authoritative Runner claim (acquire is claim-gated)');
      },
    },
    liveness: probeGatewayLiveness,
    revokeGrants: async () => false,
    recoveryAuthorizer: async (context) => {
      // Offline fail-closed honesty (F2): the offline CLI has no authoritative
      // recovery context (no live Runner claim, no live browser/extension
      // observation, no grant-revocation path, no live registry freshness), so
      // it must NEVER fabricate an `evidence` object — the core treats that
      // object as trusted recovery evidence. Both branches refuse; operator
      // recovery is served by the live service context (deferred integration).
      // Fail-closed behavior is preserved by the core: the indeterminate-journal
      // rejection runs BEFORE the authorizer (crash case keeps
      // PROFILE_RECLAIM_UNSAFE), and every other case fails closed at the
      // authorizer-result/authorization check with no fabricated evidence.
      // No path mints recovery from this CLI.
      if (context?.capability?.kind !== 'operator') return { authorized: false };
      return { authorized: false };
    },
  });
  const server = createLocalGovernorServer({ service, authenticate: (cap) => cap?.kind === 'operator' });
  const client = new GovernorClient({ server, capability: withApprove ? { kind: 'operator' } : undefined });
  return { repository, service, client };
}

function parseJsonRejectingDuplicateKeys(text, { maxDepth = 128 } = {}) {
  if (typeof text !== 'string') throw new SyntaxError('JSON text is required');
  let index = 0;
  const fail = () => { throw new SyntaxError('Invalid or duplicate-key JSON'); };
  const whitespace = () => { while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1; };
  const string = () => {
    if (text[index] !== '"') fail();
    const start = index++;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (code <= 0x1f) fail();
      if (text[index] === '\\') {
        index += 1;
        if (index >= text.length || !/["\\/bfnrtu]/.test(text[index])) fail();
        if (text[index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) fail();
          index += 4;
        }
      }
      index += 1;
    }
    fail();
  };
  const value = (depth) => {
    if (depth > maxDepth) fail();
    whitespace();
    if (text[index] === '{') {
      index += 1;
      whitespace();
      const keys = new Set();
      if (text[index] === '}') { index += 1; return; }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (text[index++] !== ':') fail();
        value(depth + 1);
        whitespace();
        const separator = text[index++];
        if (separator === '}') return;
        if (separator !== ',') fail();
      }
    }
    if (text[index] === '[') {
      index += 1;
      whitespace();
      if (text[index] === ']') { index += 1; return; }
      for (;;) {
        value(depth + 1);
        whitespace();
        const separator = text[index++];
        if (separator === ']') return;
        if (separator !== ',') fail();
      }
    }
    if (text[index] === '"') { string(); return; }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) { index += literal.length; return; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (!number) fail();
    index += number[0].length;
  };
  value(0);
  whitespace();
  if (index !== text.length) fail();
  return JSON.parse(text);
}

function invalidState(message) {
  throw typedError('PROFILE_GOVERNOR_STATE_INVALID', message);
}

function assertString(value, pattern, label, max = 512) {
  if (typeof value !== 'string' || value.length > max || (pattern && !pattern.test(value))) {
    invalidState(`${label} is invalid`);
  }
}

function assertDigest(value, label) {
  assertString(value, DIGEST, label, 71);
}

function assertInteger(value, label, min, max = 2 ** 31 - 1) {
  if (!Number.isInteger(value) || value < min || value > max) {
    invalidState(`${label} is invalid`);
  }
}

function assertActions(value, label) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8 ||
    new Set(value).size !== value.length ||
    value.some((action) => !ACTIONS.includes(action))
  ) {
    invalidState(`${label} is invalid`);
  }
}

function assertClosed(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalidState(`${label} contains an unknown field`);
}

function findHistoricalLease(resource, leases) {
  if (resource.currentLeaseId) {
    return leases[resource.currentLeaseId] || null;
  }
  if (!leases || typeof leases !== 'object') return null;
  const matching = Object.values(leases).filter(
    (lease) =>
      lease &&
      lease.physicalResourceId === resource.physicalResourceId &&
      lease.state === 'cooldown' &&
      lease.recoveryPlanDigest !== undefined &&
      resource.recoveryPlanDigest !== undefined &&
      lease.recoveryPlanDigest === resource.recoveryPlanDigest
  );
  return matching[0] || null;
}

// Semantic reason binding (Sol S15 finding 1): mirrors the core
// `eventReason()` mapping in profile-governor/lease-service.mjs, which stores
// a mapped public reason on the event while the recovery-plan digest binds the
// raw barrier reason (e.g. digest `PROFILE_BINDING_STALE` with event
// `PROFILE_LEASE_REVOKED`). A digest is proven only when it equals
// computeRecoveryPlanDigest() for a raw reason that is itself durable
// (resource/lease/receipt reason) or a raw pre-image semantically bound to a
// durable current-epoch quarantine event. The `PROFILE_QUARANTINED` event
// compat covers the reconcile-path barrier (lease-service reconcileProfile:
// digest `PROFILE_RECLAIM_UNSAFE` with event `PROFILE_QUARANTINED`).
function eventReasonForDigest(reasonCode) {
  if (EVENT_REASONS.has(reasonCode)) return reasonCode;
  if (reasonCode === 'PROFILE_CLAIM_INVALID' || reasonCode === 'PROFILE_BINDING_STALE') return 'PROFILE_LEASE_REVOKED';
  if (reasonCode === 'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED') return 'PROFILE_RECLAIM_UNSAFE';
  return 'LIVENESS_UNKNOWN';
}

// Raw digest reasons the core actually mints recovery-plan digests with:
// every EVENT_REASONS member (direct barriers) plus the non-event raw codes
// that map to a public event reason.
const KNOWN_DIGEST_REASONS = Object.freeze([
  ...EVENT_REASONS,
  'PROFILE_CLAIM_INVALID',
  'PROFILE_BINDING_STALE',
  'PROFILE_DEPENDENT_GRANT_REVOKE_FAILED',
  'PROFILE_LIVENESS_UNKNOWN',
  'PROFILE_GOVERNOR_UNAVAILABLE',
]);

function rawReasonsBoundToEvent(eventReason) {
  const bound = new Set([eventReason]);
  for (const raw of KNOWN_DIGEST_REASONS) {
    if (raw !== eventReason && eventReasonForDigest(raw) === eventReason) bound.add(raw);
  }
  // Reconcile-path barrier compat: event PROFILE_QUARANTINED is stored while
  // the digest binds PROFILE_RECLAIM_UNSAFE (see reconcileProfile).
  if (eventReason === 'PROFILE_QUARANTINED') bound.add('PROFILE_RECLAIM_UNSAFE');
  return bound;
}

function validateRecoveryPlanBinding(resource, lease, events = [], receipts = []) {
  if (!resource || resource.recoveryPlanDigest === undefined) {
    invalidState('recovery-state record carries only one side');
  }
  assertDigest(resource.recoveryPlanDigest, 'resource.recoveryPlanDigest');
  if (!lease || lease.recoveryPlanDigest === undefined) {
    invalidState('recovery-state record carries only one side');
  }
  assertDigest(lease.recoveryPlanDigest, 'lease.recoveryPlanDigest');
  if (resource.recoveryPlanDigest !== lease.recoveryPlanDigest) {
    invalidState('resource and lease recovery plan digests must match');
  }
  if (resource.currentLeaseId === lease.leaseId) {
    if (!lease.bindingDigest) {
      invalidState('recovery plan lacks facts needed to prove the digest');
    }
    const candidateReasons = new Set();
    if (typeof resource.stateReasonCode === 'string' && resource.stateReasonCode) {
      candidateReasons.add(resource.stateReasonCode);
    }
    if (typeof lease.stateReasonCode === 'string' && lease.stateReasonCode) {
      candidateReasons.add(lease.stateReasonCode);
    }
    const currentEpochQuarantineEvents = Array.isArray(events)
      ? events.filter(
          (e) =>
            e &&
            e.leaseId === lease.leaseId &&
            e.profileAlias === lease.profileAlias &&
            e.bindingDigest === lease.bindingDigest &&
            (e.bindingId === undefined || e.bindingId === lease.bindingId) &&
            e.fenceEpoch === resource.fenceEpoch &&
            e.state === 'quarantined'
        )
      : [];
    // Durable event reasons prove their raw pre-images as well: the core
    // stores the mapped public reason while the digest binds the raw barrier
    // reason, so each current-epoch quarantine event contributes the full
    // semantically bound raw set.
    for (const event of currentEpochQuarantineEvents) {
      if (typeof event.stateReasonCode === 'string' && event.stateReasonCode) {
        for (const raw of rawReasonsBoundToEvent(event.stateReasonCode)) {
          candidateReasons.add(raw);
        }
      }
    }
    const matchingReceipts = Array.isArray(receipts)
      ? receipts.filter(
          (r) =>
            r &&
            r.leaseId === lease.leaseId &&
            r.profileAlias === lease.profileAlias &&
            r.bindingDigest === lease.bindingDigest &&
            (r.bindingId === undefined || r.bindingId === lease.bindingId) &&
            r.newFenceEpoch === resource.fenceEpoch &&
            typeof r.reasonCode === 'string' &&
            r.reasonCode
        )
      : [];
    for (const receipt of matchingReceipts) {
      candidateReasons.add(receipt.reasonCode);
    }

    const matches = Array.from(candidateReasons).some((candidateReason) => {
      return (
        resource.recoveryPlanDigest ===
        computeRecoveryPlanDigest({
          leaseId: lease.leaseId,
          bindingDigest: lease.bindingDigest,
          fenceEpoch: resource.fenceEpoch,
          reasonCode: candidateReason,
        })
      );
    });

    if (matches) {
      return;
    }

    // Sol S15 finding 1: no fail-open compatibility. A current-lease
    // recovery-plan digest that is not cryptographically derivable from a
    // durable, semantically bound reason/fact is rejected, even when earlier
    // plus current-epoch quarantine events are both present. Legitimate
    // re-barriers remain accepted above because their digest is proven via
    // the semantically bound raw pre-image of the durable event.
    invalidState('recovery plan digest does not match durable recovery facts');
    return;
  }

  if (resource.currentLeaseId === null) {
    if (!lease.bindingDigest) {
      invalidState('recovery plan lacks facts needed to prove the digest');
    }
    const priorQuarantineEvents = Array.isArray(events)
      ? events.filter(
          (e) =>
            e &&
            e.leaseId === lease.leaseId &&
            e.profileAlias === lease.profileAlias &&
            e.bindingDigest === lease.bindingDigest &&
            (e.bindingId === undefined || e.bindingId === lease.bindingId) &&
            e.state === 'quarantined' &&
            Number.isInteger(e.fenceEpoch) &&
            typeof e.stateReasonCode === 'string' &&
            e.stateReasonCode
        )
      : [];

    const candidateReceipts = Array.isArray(receipts)
      ? receipts.filter(
          (r) =>
            r &&
            r.leaseId === lease.leaseId &&
            r.profileAlias === lease.profileAlias &&
            r.bindingDigest === lease.bindingDigest &&
            (r.bindingId === undefined || r.bindingId === lease.bindingId) &&
            typeof r.reasonCode === 'string' &&
            r.reasonCode
        )
      : [];

    let matches = false;
    for (const event of priorQuarantineEvents) {
      // The core stores the mapped public reason on the durable event while
      // the recovery-plan digest binds the raw barrier reason (e.g. digest
      // `PROFILE_BINDING_STALE` with event `PROFILE_LEASE_REVOKED`), so each
      // historical event contributes the full bounded semantically bound raw
      // set — the same mapping the current-lease branch applies above.
      for (const raw of rawReasonsBoundToEvent(event.stateReasonCode)) {
        if (
          resource.recoveryPlanDigest ===
          computeRecoveryPlanDigest({
            leaseId: lease.leaseId,
            bindingDigest: lease.bindingDigest,
            fenceEpoch: event.fenceEpoch,
            reasonCode: raw,
          })
        ) {
          matches = true;
          break;
        }
      }
      if (matches) break;
    }
    if (!matches) {
      for (const receipt of candidateReceipts) {
        const candidateEpochs = [];
        if (Number.isInteger(receipt.newFenceEpoch)) candidateEpochs.push(receipt.newFenceEpoch);
        if (Number.isInteger(receipt.priorFenceEpoch)) candidateEpochs.push(receipt.priorFenceEpoch);
        for (const epoch of candidateEpochs) {
          if (
            resource.recoveryPlanDigest ===
            computeRecoveryPlanDigest({
              leaseId: lease.leaseId,
              bindingDigest: lease.bindingDigest,
              fenceEpoch: epoch,
              reasonCode: receipt.reasonCode,
            })
          ) {
            matches = true;
            break;
          }
        }
        if (matches) break;
      }
    }

    if (matches) {
      return;
    }

    const hasProofRecords =
      priorQuarantineEvents.length > 0 ||
      candidateReceipts.some((r) => r.newState === 'quarantined');

    if (hasProofRecords) {
      invalidState('recovery plan digest does not match durable recovery facts');
    }

    // When those bounded historical proof records have been trimmed, accept the
    // paired/equal historical digest as explicitly UNVERIFIED read-only history
    // (Sol S15 finding 1): this path is reachable only through
    // readStateFileDirect, which serves the offline read-only subcommands
    // (status/inspect/receipts/events) and never authorizes reclaim/retry —
  // writer subcommands (reconcile/recover/release) go through the live
  // service construction instead. Existing trimmed-history read regressions
  // and the writer-path tests keep this compatibility explicitly read-only.
    return;
  }

  invalidState('active lease is not the current resource owner');
}

function validateResource(resource, physicalResourceId, leases, events = [], receipts = []) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) invalidState('resource record is invalid');
  assertClosed(resource, RESOURCE_KEYS, 'resource record');
  assertString(physicalResourceId, PHYSICAL_ID, 'resource key');
  assertString(resource.physicalResourceId, PHYSICAL_ID, 'resource.physicalResourceId');
  if (resource.physicalResourceId !== physicalResourceId) invalidState('resource physical identity is inconsistent');
  assertString(resource.profileAlias, ALIAS, 'resource.profileAlias', 64);
  if (!Array.isArray(resource.aliases) || resource.aliases.length < 1 || resource.aliases.length > 16 || new Set(resource.aliases).size !== resource.aliases.length || resource.aliases.some((alias) => typeof alias !== 'string' || !ALIAS.test(alias))) {
    invalidState('resource aliases are invalid');
  }
  if (!resource.aliases.includes(resource.profileAlias)) invalidState('resource aliases must bind the lease profile alias');
  if (!STATES.includes(resource.state)) invalidState('resource state is invalid');
  assertInteger(resource.fenceEpoch, 'resource.fenceEpoch', 0);
  if (resource.currentLeaseId !== null && !LEASE_ID.test(resource.currentLeaseId)) invalidState('resource currentLeaseId is invalid');
  if (typeof resource.needsReconciliation !== 'boolean') invalidState('resource reconciliation flag is invalid');
  if (!['healthy', 'failed', 'unknown'].includes(resource.livenessSummary)) invalidState('resource liveness summary is invalid');
  if (resource.cooldownUntil !== null && !isRfc3339DateTime(resource.cooldownUntil)) invalidState('resource cooldownUntil is invalid');
  if (resource.recoveryPlanDigest !== undefined) assertDigest(resource.recoveryPlanDigest, 'resource.recoveryPlanDigest');
  if (resource.stateReasonCode !== undefined) assertString(resource.stateReasonCode, /^[A-Z][A-Z0-9_]{2,63}$/, 'resource.stateReasonCode', 64);
  if (resource.stateChangedAt !== undefined && !isRfc3339DateTime(resource.stateChangedAt)) invalidState('resource.stateChangedAt is invalid');
  const hasSubjectKind = resource.recoverySubjectKind !== undefined;
  const hasBindingId = resource.recoveryBindingId !== undefined;
  const hasBindingRev = resource.recoveryBindingRevision !== undefined;
  const hasBindingDigest = resource.recoveryBindingDigest !== undefined;
  const tupleCount = (hasSubjectKind ? 1 : 0) + (hasBindingId ? 1 : 0) + (hasBindingRev ? 1 : 0) + (hasBindingDigest ? 1 : 0);
  if (tupleCount !== 0 && tupleCount !== 4) invalidState('resource recovery binding tuple must be all-or-nothing');
  if (hasSubjectKind) {
    if (resource.recoverySubjectKind !== 'unregistered-external' && resource.recoverySubjectKind !== 'registered-external') invalidState('resource recovery subject is invalid');
    assertString(resource.recoveryBindingId, BINDING_ID, 'resource.recoveryBindingId', 96);
    assertInteger(resource.recoveryBindingRevision, 'resource.recoveryBindingRevision', 1);
    assertDigest(resource.recoveryBindingDigest, 'resource.recoveryBindingDigest');
  }
  if (resource.lastRecoveryEvidenceDigest !== undefined) assertDigest(resource.lastRecoveryEvidenceDigest, 'resource.lastRecoveryEvidenceDigest');
  if (resource.lastRecoveredAt !== undefined && !isRfc3339DateTime(resource.lastRecoveredAt)) invalidState('resource.lastRecoveredAt is invalid');
  if (resource.currentLeaseId) {
    const lease = leases[resource.currentLeaseId];
    if (!lease || lease.physicalResourceId !== physicalResourceId || lease.fenceEpoch !== resource.fenceEpoch) invalidState('resource current lease reference is inconsistent');
    if (hasSubjectKind) {
      if (resource.recoveryBindingId !== lease.bindingId || resource.recoveryBindingRevision !== lease.bindingRevision || resource.recoveryBindingDigest !== lease.bindingDigest) invalidState('resource recovery binding tuple does not match current lease');
      if (resource.recoverySubjectKind === 'registered-external' && lease.ownerType !== 'external') invalidState('registered-external subject kind requires external lease ownerType');
      if (resource.recoverySubjectKind === 'unregistered-external' && lease.ownerType !== 'external') invalidState('unregistered-external subject kind requires external lease ownerType');
    } else {
      if (lease.ownerType === 'external') invalidState('external lease requires recovery binding tuple');
    }
  }
  if (['leased', 'active'].includes(resource.state) && !resource.currentLeaseId) invalidState('leased resource has no current lease');
  if (['ready', 'cooldown'].includes(resource.state) && resource.currentLeaseId) invalidState('reusable resource still has a current lease');
  if (resource.state === 'quarantined' && !resource.currentLeaseId) invalidState('quarantined resource has no durable owner barrier');
  if (resource.currentLeaseId) {
    if (resource.recoveryPlanDigest !== undefined || leases[resource.currentLeaseId]?.recoveryPlanDigest !== undefined) {
      const lease = leases[resource.currentLeaseId] || null;
      validateRecoveryPlanBinding(resource, lease, events, receipts);
    }
  } else if (resource.recoveryPlanDigest !== undefined) {
    const lease = findHistoricalLease(resource, leases);
    validateRecoveryPlanBinding(resource, lease, events, receipts);
  }
}

function validateLease(lease, leaseId, resources, events = [], receipts = []) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) invalidState('lease record is invalid');
  assertClosed(lease, LEASE_KEYS, 'lease record');
  if (!LEASE_ID.test(leaseId) || lease.leaseId !== leaseId) invalidState('lease identity is inconsistent');
  assertString(lease.physicalResourceId, PHYSICAL_ID, 'lease.physicalResourceId');
  const resource = resources[lease.physicalResourceId];
  if (!resource) invalidState('lease physical resource is missing');
  assertString(lease.profileAlias, ALIAS, 'lease.profileAlias', 64);
  assertString(lease.bindingId, BINDING_ID, 'lease.bindingId', 96);
  assertInteger(lease.bindingRevision, 'lease.bindingRevision', 1);
  assertDigest(lease.bindingDigest, 'lease.bindingDigest');
  assertString(lease.runId, RUN_ID, 'lease.runId', 96);
  assertDigest(lease.runnerClaimDigest, 'lease.runnerClaimDigest');
  if (!['single-context', 'shared-trust-domain'].includes(lease.leaseMode)) invalidState('lease mode is invalid');
  assertInteger(lease.fenceEpoch, 'lease.fenceEpoch', 1);
  assertDigest(lease.leaseBindingDigest, 'lease.leaseBindingDigest');
  if (lease.leaseBindingDigest !== computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: lease.physicalResourceId, fenceEpoch: lease.fenceEpoch, profileAlias: lease.profileAlias })) invalidState('lease binding digest is inconsistent');
  if (!STATES.includes(lease.state)) invalidState('lease state is invalid');
  if (!isRfc3339DateTime(lease.issuedAt) || !isRfc3339DateTime(lease.expiresAt)) invalidState('lease timestamps are invalid');
  assertInteger(lease.heartbeatIntervalMs, 'lease.heartbeatIntervalMs', 1000, 120000);
  assertInteger(lease.leaseTtlMs, 'lease.leaseTtlMs', 5000, 600000);
  assertString(lease.nodeId, /^node-[a-z0-9-]+$/, 'lease.nodeId', 96);
  if (!['automation', 'external'].includes(lease.ownerType)) invalidState('lease ownerType is invalid');
  assertString(lease.idempotencyKey, /^[\x21-\x7e]{4,128}$/, 'lease.idempotencyKey', 128);
  assertString(lease.fingerprint, null, 'lease.fingerprint', 20000);
  assertActions(lease.requestedActions, 'lease.requestedActions');
  assertActions(lease.allowedActions, 'lease.allowedActions');
  if (!lease.tabs || typeof lease.tabs !== 'object' || Array.isArray(lease.tabs) || Object.keys(lease.tabs).length > 8) invalidState('lease tabs are invalid');
  assertInteger(lease.maxTabs, 'lease.maxTabs', 1, 8);
  for (const [tabHandle, tab] of Object.entries(lease.tabs)) {
    if (!TAB_ID.test(tabHandle) || !tab || typeof tab !== 'object' || Array.isArray(tab) || Object.keys(tab).some((key) => !['runId', 'createdAt'].includes(key)) || tab.runId !== lease.runId || !isRfc3339DateTime(tab.createdAt)) invalidState('lease tab ownership is invalid');
  }
  assertInteger(lease.actionUses, 'lease.actionUses', 0, 1000000);
  if (!Array.isArray(lease.actionJournal) || lease.actionJournal.length > 64) invalidState('lease action journal is invalid');
  for (const entry of lease.actionJournal) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => !['actionId', 'fenceId', 'outcome', 'at', 'actionKind'].includes(key)) || !ACTION_ID.test(entry.actionId) || !OUTCOMES.has(entry.outcome) || !isRfc3339DateTime(entry.at)) invalidState('lease action journal entry is invalid');
    if (entry.fenceId !== undefined && !FENCE_ID.test(entry.fenceId)) invalidState('lease action journal fence is invalid');
    if (entry.actionKind !== undefined && !ACTION_KINDS.has(entry.actionKind)) invalidState('lease action journal action kind is invalid');
  }
  if (!lease.fences || typeof lease.fences !== 'object' || Array.isArray(lease.fences)) invalidState('lease fences are invalid');
  for (const [fenceId, issued] of Object.entries(lease.fences)) {
    if (!FENCE_ID.test(fenceId) || !issued || typeof issued !== 'object' || Array.isArray(issued) || Object.keys(issued).some((key) => !['proof', 'uses'].includes(key)) || !Number.isInteger(issued.uses) || issued.uses < 0 || !issued.proof) invalidState('lease issued fence is invalid');
    try { validateActionFence(issued.proof); } catch { invalidState('lease issued fence proof is invalid'); }
    if (issued.proof.fenceId !== fenceId || issued.proof.leaseId !== leaseId || issued.proof.fenceEpoch !== lease.fenceEpoch || issued.proof.leaseBindingDigest !== lease.leaseBindingDigest || issued.proof.runId !== lease.runId || issued.proof.bindingId !== lease.bindingId || issued.proof.fenceDigest !== computeFenceDigest(issued.proof) || issued.uses > issued.proof.maxUses) invalidState('lease issued fence binding is inconsistent');
  }
  if (!resource.aliases.includes(lease.profileAlias)) invalidState('lease profile alias must be bound by resource aliases');
  if (resource.profileAlias !== lease.profileAlias && !resource.aliases.includes(lease.profileAlias)) invalidState('lease identity does not bind resource profile identity');
  if (lease.stateReasonCode !== undefined) assertString(lease.stateReasonCode, /^[A-Z][A-Z0-9_]{2,63}$/, 'lease.stateReasonCode', 64);
  if (lease.stateChangedAt !== undefined && !isRfc3339DateTime(lease.stateChangedAt)) invalidState('lease.stateChangedAt is invalid');
  if (lease.heartbeatCount !== undefined) assertInteger(lease.heartbeatCount, 'lease.heartbeatCount', 0, 1000000);
  if (lease.releasedAt !== undefined && !isRfc3339DateTime(lease.releasedAt)) invalidState('lease.releasedAt is invalid');
  if (lease.recoveryPlanDigest !== undefined) {
    assertDigest(lease.recoveryPlanDigest, 'lease.recoveryPlanDigest');
    if (!resource) invalidState('lease physical resource is missing');
    if (resource.currentLeaseId === leaseId) {
      if (resource.recoveryPlanDigest === undefined) {
        invalidState('recovery-state record carries only one side');
      }
      validateRecoveryPlanBinding(resource, lease, events, receipts);
    } else if (resource.currentLeaseId === null) {
      if (resource.recoveryPlanDigest !== undefined && lease.recoveryPlanDigest === resource.recoveryPlanDigest) {
        validateRecoveryPlanBinding(resource, lease, events, receipts);
      }
    }
  }
  if (!['cooldown'].includes(lease.state) && resource.currentLeaseId !== leaseId) invalidState('active lease is not the current resource owner');
}

// Sol S15 finding 2: shared current-pair invariant at the durable-state
// validation boundary. When resource.currentLeaseId points at the current
// lease, the two records must agree on identity/epoch, state, ownership and
// recovery posture per the existing core state contract (acquire sets both to
// leased/external_use; fence activation sets both to active; every barrier
// sets both to quarantined; release/recovery clear the pointer). `unknown`
// resource state is the post-restart normalization (markStartupUnknown keeps
// the held lease) and is compatible with any held lease state. This rejects
// impossible combinations such as resource `active` with current lease
// `quarantined` without duplicating core transition logic.
function assertCurrentPairConsistent(resource, lease) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    invalidState('current lease reference is invalid');
  }
  if (lease.physicalResourceId !== resource.physicalResourceId) {
    invalidState('current lease reference is invalid');
  }
  if (lease.fenceEpoch !== resource.fenceEpoch) {
    invalidState('resource current lease reference is inconsistent');
  }
  if (!resource.aliases.includes(lease.profileAlias)) {
    invalidState('lease profile alias must be bound by resource aliases');
  }
  if (lease.state === 'cooldown' || lease.state === 'ready') {
    invalidState('current lease state is inconsistent');
  }
  if (resource.state !== 'unknown' && resource.state !== lease.state) {
    invalidState('resource and current lease states must agree');
  }
  const external = resource.state === 'external_use' || lease.state === 'external_use' || lease.ownerType === 'external';
  if (external) {
    if (resource.state !== 'external_use' || lease.state !== 'external_use' || lease.ownerType !== 'external') {
      invalidState('external lease ownership is inconsistent');
    }
    if (resource.recoveryPlanDigest === undefined || lease.recoveryPlanDigest === undefined || resource.recoveryPlanDigest !== lease.recoveryPlanDigest) {
      invalidState('recovery-state record carries only one side');
    }
  }
  if (resource.state === 'quarantined' || lease.state === 'quarantined') {
    if (resource.recoveryPlanDigest === undefined || lease.recoveryPlanDigest === undefined || resource.recoveryPlanDigest !== lease.recoveryPlanDigest) {
      invalidState('recovery-state record carries only one side');
    }
  }
  if ((resource.state === 'leased' || resource.state === 'active') && lease.ownerType === 'automation') {
    if (resource.recoveryPlanDigest !== undefined || lease.recoveryPlanDigest !== undefined) {
      invalidState('active lease must not carry a recovery plan');
    }
  }
}

function validateDurableState(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.schema === STATE_SCHEMA && (!Array.isArray(value.eventIntegrityDigests) || !Array.isArray(value.events))) {
    invalidState('legacy governor state without integrity digests is not trusted and requires migration');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || [...STATE_KEYS].some((key) => !Object.hasOwn(value, key)) || value.schema !== STATE_SCHEMA || !Number.isInteger(value.serviceGeneration) || value.serviceGeneration < 0 || !Number.isInteger(value.writerGeneration) || value.writerGeneration < 0 || (value.writerId !== null && (typeof value.writerId !== 'string' || !/^[a-z0-9_-]{4,128}$/.test(value.writerId)))) {
    invalidState('Governor state schema is invalid');
  }
  assertClosed(value, STATE_KEYS, 'Governor state');
  for (const key of ['resources', 'leases']) {
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) {
      invalidState('Governor state collections are invalid');
    }
  }
  if (!Array.isArray(value.events) || !Array.isArray(value.eventIntegrityDigests) || !Array.isArray(value.receipts)) {
    invalidState('Governor state journals are invalid');
  }
  if (value.events.length > 256 || value.receipts.length > 128) invalidState('Governor state journal bounds are invalid');
  try {
    validateEventIntegrity(value);
  } catch (err) {
    invalidState(err?.message || 'event integrity journal is invalid');
  }
  for (const [physicalResourceId, resource] of Object.entries(value.resources)) {
    validateResource(resource, physicalResourceId, value.leases, value.events, value.receipts);
  }
  for (const [leaseId, lease] of Object.entries(value.leases)) {
    validateLease(lease, leaseId, value.resources, value.events, value.receipts);
  }
  for (const resource of Object.values(value.resources)) {
    if (resource.currentLeaseId) {
      const lease = value.leases[resource.currentLeaseId];
      assertCurrentPairConsistent(resource, lease);
    }
  }
  for (const event of value.events) {
    try {
      validateRedactedEvent(event);
    } catch (err) {
      invalidState(err?.message || 'event record is invalid');
    }
    const lease = value.leases[event.leaseId];
    if (!lease || event.profileAlias !== lease.profileAlias || event.bindingDigest !== lease.bindingDigest || (event.bindingId !== undefined && event.bindingId !== lease.bindingId) || (event.runId !== undefined && event.runId !== lease.runId) || event.fenceEpoch > lease.fenceEpoch) {
      invalidState('event identity does not match its durable lease');
    }
    if (event.leaseBindingDigest !== undefined && event.leaseBindingDigest !== computeLeaseBindingDigest({ claimDigest: lease.runnerClaimDigest, bindingDigest: lease.bindingDigest, physicalResourceId: lease.physicalResourceId, fenceEpoch: event.fenceEpoch, profileAlias: lease.profileAlias })) {
      invalidState('event lease binding digest is invalid');
    }
  }
  for (const receipt of value.receipts) {
    try {
      validateRecoveryReceipt(receipt, { requireOperationalFields: true });
    } catch (err) {
      invalidState(err?.message || 'recovery receipt is invalid');
    }
    const lease = value.leases[receipt.leaseId];
    if (!lease || receipt.profileAlias !== lease.profileAlias || (receipt.bindingId !== undefined && receipt.bindingId !== lease.bindingId) || (receipt.bindingRevision !== undefined && receipt.bindingRevision !== lease.bindingRevision) || (receipt.bindingDigest !== undefined && receipt.bindingDigest !== lease.bindingDigest) || (receipt.runId !== undefined && receipt.runId !== lease.runId) || receipt.newFenceEpoch > lease.fenceEpoch) {
      invalidState('recovery receipt identity does not match its durable lease');
    }
    if (receipt.eventId !== undefined) {
      const event = value.events.find((entry) => entry.eventId === receipt.eventId);
      if (
        event &&
        (event.leaseId !== receipt.leaseId ||
          event.profileAlias !== receipt.profileAlias ||
          event.fenceEpoch !== receipt.newFenceEpoch ||
          (receipt.bindingDigest !== undefined && event.bindingDigest !== receipt.bindingDigest) ||
          event.state !== receipt.newState)
      ) {
        invalidState('recovery receipt referenced event is invalid');
      }
    }
  }
  return value;
}

// Read-only durable inspection (F3): never constructs GovernorRepository or
// ProfileGovernor (no dir creation, no writer lock, no markStartupUnknown).
// Fails closed on malformed state: validates closed schema, resources, leases,
// event integrity, and recovery receipts.
function readStateFileDirect(statePath) {
  // O_NONBLOCK keeps the fd-first open from blocking on FIFOs: the fstat
  // private-regular-file guard below then rejects the non-regular descriptor
  // fail-closed with the typed state error instead of hanging.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd;
  try {
    fd = fs.openSync(statePath, flags);
  } catch (error) {
    if (error?.code === 'ENOENT') throw typedError('PROFILE_GOVERNOR_UNAVAILABLE', 'governor state is unavailable');
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK' || error?.code === 'EISDIR' || error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw typedError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state must be a private regular file');
    }
    throw typedError('PROFILE_GOVERNOR_UNAVAILABLE', `governor state cannot be inspected (${error?.code || 'UNKNOWN'})`);
  }

  try {
    let stat;
    try {
      stat = fs.fstatSync(fd);
    } catch (error) {
      throw typedError('PROFILE_GOVERNOR_STATE_INVALID', `Governor state cannot be inspected (${error?.code || 'UNKNOWN'})`);
    }

    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw typedError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state must be a private regular file');
    }
    if (stat.size > MAX_STATE_BYTES) {
      throw typedError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state exceeds the bounded size');
    }

    // Bounded fd-first read: stream from the open descriptor in fixed chunks
    // and reject a payload beyond MAX_STATE_BYTES before parsing, so a
    // racing/growing descriptor cannot bypass the stat size guard above and a
    // FIFO/pipe descriptor cannot block indefinitely in readFileSync.
    // O_NONBLOCK makes an empty-FIFO read fail fast (EAGAIN) instead of
    // hanging; any read failure stays the typed state error below.
    let text;
    try {
      const chunks = [];
      let total = 0;
      const buf = Buffer.alloc(64 * 1024);
      for (;;) {
        let read;
        try {
          read = fs.readSync(fd, buf, 0, buf.length, null);
        } catch (error) {
          throw typedError('PROFILE_GOVERNOR_STATE_INVALID', `governor state cannot be read (${error?.code || 'UNKNOWN'})`);
        }
        if (read === 0) break;
        total += read;
        if (total > MAX_STATE_BYTES) {
          throw typedError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state exceeds the bounded size');
        }
        chunks.push(Buffer.from(buf.subarray(0, read)));
      }
      text = Buffer.concat(chunks, total).toString('utf8');
    } catch (error) {
      if (error?.code === 'PROFILE_GOVERNOR_STATE_INVALID') throw error;
      throw typedError('PROFILE_GOVERNOR_STATE_INVALID', `governor state cannot be read (${error?.code || 'UNKNOWN'})`);
    }

    if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) {
      throw typedError('PROFILE_GOVERNOR_STATE_INVALID', 'Governor state exceeds the bounded size');
    }

    let parsed;
    try {
      parsed = parseJsonRejectingDuplicateKeys(text);
    } catch {
      throw typedError('PROFILE_GOVERNOR_STATE_INVALID', 'governor state is not valid JSON');
    }

    return validateDurableState(parsed);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

export async function runGovernor(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    // Parse errors pre-empt flag parsing; detect JSON mode from the RAW args
    // (bare `--json` or any `--json=*` token except `--json=false`) so
    // duplicate/invalid/unknown flag failures still emit a single JSON envelope,
    // while explicit `--json=false` preserves typed non-JSON stderr.
    if (rawArgsWantJson(args)) {
      console.log(JSON.stringify(failEnvelope(error), null, 2));
      return 2;
    }
    console.error(`${error?.code || 'UNKNOWN'}: ${error?.message || String(error)}`);
    return 2;
  }
  const { flags, positional } = parsed;
  const wantsJson = flags.json === true || flags.json === 'true';
  const withApprove = flags.approve === true || flags.approve === 'true';
  const fail = (error, exitCode = 2) => {
    if (wantsJson) console.log(JSON.stringify(failEnvelope(error), null, 2));
    else console.error(`${error?.code || 'UNKNOWN'}: ${error?.message || String(error)}`);
    return exitCode;
  };
  const ok = (data) => {
    if (wantsJson) console.log(JSON.stringify({ ok: true, data }, null, 2));
    else if (typeof data === 'string') console.log(data);
    else console.log(JSON.stringify(data, null, 2));
    return 0;
  };

  // Strict --json value (F5): only bare --json / --json=true|false are accepted.
  // An invalid --json value (e.g. --json=wat) emits exactly ONE JSON document
  // on stdout, exit 2 (bare `--json`, `--json=true`, or invalid `--json=<value>`
  // selects JSON error output; `--json=false` is an explicit non-JSON opt-out).
  // Validated before early help/subcommand branches so --json=wat cannot bypass JSON mode.
  if (flags.json !== undefined && !(flags.json === true || flags.json === 'true' || flags.json === 'false' || flags.json === false)) {
    const error = typedError('PROFILE_REQUEST_INVALID', 'flag --json takes no value');
    console.log(JSON.stringify(failEnvelope(error), null, 2));
    return 2;
  }
  // Strict --approve value: only bare --approve / --approve=true|false.
  if (flags.approve !== undefined && !(flags.approve === true || flags.approve === 'true' || flags.approve === 'false' || flags.approve === false)) {
    return fail(typedError('PROFILE_REQUEST_INVALID', 'flag --approve takes no value'));
  }

  // Help (never mixed into --json stdout; bare `governor --json` is a single
  // JSON error envelope per F5).
  if (!wantsJson && (flags.help === true || flags.h === true || positional[0] === 'help')) {
    printGovernorHelp();
    return 0;
  }
  // In --json mode a help flag is not part of any closed flag set: reject it
  // as an unknown flag so stdout stays exactly one JSON document.
  if (wantsJson && (flags.help !== undefined || flags.h !== undefined)) {
    return fail(typedError('PROFILE_REQUEST_INVALID', 'unknown flag --help for governor --json (help text is never mixed into JSON output)'));
  }
  if (positional[0] === 'help') {
    return fail(typedError('PROFILE_REQUEST_INVALID', 'governor help takes no JSON envelope (use --help without --json)'));
  }
  if (positional.length === 0) {
    if (flags.json === undefined) printGovernorHelp();
    return fail(typedError('PROFILE_REQUEST_INVALID', 'governor requires a subcommand (status|inspect|receipts|events|reconcile|recover|release)'));
  }

  const sub = positional[0];
  if (!SUBCOMMANDS.includes(sub)) {
    return fail(typedError('PROFILE_REQUEST_INVALID', `Unknown governor subcommand: ${sub} (expected status|inspect|receipts|events|reconcile|recover|release)`));
  }

  // Strict per-subcommand closed flag sets (F5): unknown flags fail closed.
  const allowed = FLAG_SETS[sub];
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) return fail(typedError('PROFILE_REQUEST_INVALID', `unknown flag --${key} for governor ${sub}`));
  }

  // Strict arity (F5): no extra positionals, no missing alias.
  const expectedPositionals = sub === 'status' || sub === 'receipts' || sub === 'events' || sub === 'release' ? 1 : 2;
  if (positional.length !== expectedPositionals) {
    if (positional.length < expectedPositionals) {
      const missing = sub === 'release' ? 'release requires --lease-id <id>' : `${sub} requires a profile alias`;
      return fail(typedError('PROFILE_REQUEST_INVALID', missing));
    }
    return fail(typedError('PROFILE_REQUEST_INVALID', `too many arguments for governor ${sub}`));
  }

  if (AUTH_GATED.has(sub) && !withApprove) {
    return fail(typedError('PROFILE_IPC_AUTH', 'Authenticated local capability is required (pass --approve)'));
  }

  // Read paths (F3): direct file read only, auth already gated above.
  if (sub === 'status' || sub === 'inspect' || sub === 'receipts' || sub === 'events') {
    let state;
    try {
      state = readStateFileDirect(resolveStatePath());
    } catch (error) {
      return fail(error);
    }
    try {
      if (sub === 'status') {
        const data = {
          profiles: Object.keys(state.resources || {}).length,
          leases: Object.keys(state.leases || {}).length,
          receipts: (state.receipts || []).length,
          events: (state.events || []).length,
        };
        return ok(data);
      }
      if (sub === 'inspect') {
        const alias = positional[1];
        const resources = Object.values(state.resources || {});
        const resource = resources.find((r) => r?.profileAlias === alias || (Array.isArray(r?.aliases) && r.aliases.includes(alias)));
        if (!resource) throw typedError('PROFILE_GOVERNOR_NOT_READY', `profile resource '${alias}' has not been reconciled`);
        return ok(redactResource(resource));
      }
      if (sub === 'receipts') return ok(state.receipts.map(projectReceipt));
      return ok(state.events.map(projectEvent));
    } catch (error) {
      return fail(error);
    }
  }

  // Writer paths: validate every writer operand with the durable grammar
  // BEFORE any registry/client construction or other mutation-capable call
  // (Sol S15 finding 3). GovernorRepository construction creates the state
  // directory, takes the writer lock, and runs markStartupUnknown (a state
  // mutation), so malformed operands must fail closed first. Typed
  // fail-closed errors and the existing --approve gate above are preserved.
  if (sub === 'release') {
    const rawLeaseId = flags['lease-id'];
    if (typeof rawLeaseId !== 'string' || !rawLeaseId) {
      return fail(typedError('PROFILE_REQUEST_INVALID', 'release requires --lease-id <id>'));
    }
    if (!LEASE_ID.test(rawLeaseId)) {
      return fail(typedError('PROFILE_REQUEST_INVALID', `flag --lease-id is invalid (${rawLeaseId})`));
    }
  }
  if (sub === 'reconcile' || sub === 'recover') {
    const alias = positional[1];
    if (typeof alias !== 'string' || alias.length < 2 || alias.length > 64 || !ALIAS.test(alias)) {
      return fail(typedError('PROFILE_REQUEST_INVALID', `profile alias is invalid (${alias})`));
    }
  }

  let registry;
  try {
    registry = await buildRegistryOrThrow();
  } catch (error) {
    return fail(error);
  }

  let built = null;
  try {
    built = await buildClient({ withApprove, registry });
    const { repository, client } = built;
    try {
      if (sub === 'reconcile' || sub === 'recover') {
        const alias = positional[1];
        if (sub === 'reconcile') {
          const projection = await client.reconcileProfile(alias);
          return ok(projection);
        }
        const receipt = await client.recover(alias);
        return ok(receipt);
      }
      if (sub === 'release') {
        const leaseId = flags['lease-id'];
        const state = repository.read();
        const lease = state.leases?.[leaseId];
        if (!lease) throw typedError('PROFILE_LEASE_NOT_FOUND', `Governor lease is not current (${leaseId})`);
        // Frozen S1 contract: release flows through externalRelease.
        const result = await client.externalRelease({ leaseId: lease.leaseId, fenceEpoch: lease.fenceEpoch, leaseBindingDigest: lease.leaseBindingDigest });
        return ok(result);
      }
      throw typedError('PROFILE_REQUEST_INVALID', `Unknown governor subcommand: ${sub}`);
    } finally {
      try { repository?.close?.(); } catch {}
    }
  } catch (error) {
    try { built?.repository?.close?.(); } catch {}
    return fail(error);
  }
}
