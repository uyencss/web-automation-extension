import { digestLf, isRfc3339DateTime, opaqueId, SCHEMAS, STATES } from './contracts.mjs';
import { profileError } from './errors.mjs';

const EVENT_KEYS = new Set(['schema', 'eventId', 'leaseId', 'profileAlias', 'state', 'stateReasonCode', 'fenceEpoch', 'bindingDigest', 'bindingId', 'runId', 'timestamp', 'leaseBindingDigest', 'counts', 'livenessSummary', 'grantRevokeStatus']);
const EVENT_REASONS = new Set(['PROFILE_LEASE_CONFLICT', 'PROFILE_GOVERNOR_NOT_READY', 'PROFILE_EXTERNAL_USE', 'PROFILE_AUTH_REQUIRED', 'PROFILE_CHALLENGE_REQUIRED', 'PROFILE_RATE_LIMITED', 'PROFILE_LEASE_EXPIRED', 'PROFILE_LEASE_REVOKED', 'PROFILE_QUARANTINED', 'PROFILE_RELEASE', 'PROFILE_RECLAIM_UNSAFE', 'PROFILE_OUTWARD_EFFECT_INDETERMINATE', 'HEARTBEAT_OK', 'LIVENESS_UNKNOWN', 'RECOVERY_APPLIED']);
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function invalid(message) { throw profileError('PROFILE_GOVERNOR_STATE_INVALID', message); }

export function validateRedactedEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('event record is invalid');
  const unknown = Object.keys(input).find((key) => !EVENT_KEYS.has(key));
  if (unknown) invalid('event record contains an unknown field');
  if (input.schema !== SCHEMAS.event || !/^pse_[0-9a-f]{16}$/.test(input.eventId || '') || !/^lease_[0-9a-f]{16}$/.test(input.leaseId || '') || typeof input.profileAlias !== 'string' || input.profileAlias.length < 2 || input.profileAlias.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.profileAlias) || !STATES.includes(input.state) || !EVENT_REASONS.has(input.stateReasonCode) || !Number.isInteger(input.fenceEpoch) || input.fenceEpoch < 1 || !DIGEST.test(input.bindingDigest || '') || !isRfc3339DateTime(input.timestamp)) invalid('event record is invalid');
  if (input.stateReasonCode === 'HEARTBEAT_OK' && (!input.counts || !Number.isInteger(input.counts.heartbeats) || input.counts.heartbeats < 1)) invalid('HEARTBEAT_OK is invalid when no heartbeat occurred');
  if (input.bindingId !== undefined && !/^pb_[a-z0-9-]+$/.test(input.bindingId)) invalid('event bindingId is invalid');
  if (input.runId !== undefined && !/^run_[a-z0-9-]{8,}$/.test(input.runId)) invalid('event runId is invalid');
  if (input.leaseBindingDigest !== undefined && !DIGEST.test(input.leaseBindingDigest)) invalid('event lease binding digest is invalid');
  if (input.livenessSummary !== undefined && !['healthy', 'degraded', 'unknown', 'failed'].includes(input.livenessSummary)) invalid('event liveness summary is invalid');
  if (input.grantRevokeStatus !== undefined && !['none', 'revoked', 'pending', 'failed'].includes(input.grantRevokeStatus)) invalid('event grant revoke status is invalid');
  if (input.counts !== undefined && (!input.counts || typeof input.counts !== 'object' || Array.isArray(input.counts) || Object.keys(input.counts).some((key) => !['heartbeats', 'actions', 'pages'].includes(key)) || Object.values(input.counts).some((count) => !Number.isInteger(count) || count < 0))) invalid('event counts are invalid');
  return input;
}

function projectEvent(input) {
  const event = {};
  for (const key of EVENT_KEYS) if (input[key] !== undefined) event[key] = key === 'counts' ? { ...input[key] } : input[key];
  return event;
}

export function redactedEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('event input is invalid');
  const unknown = Object.keys(input).find((key) => !EVENT_KEYS.has(key));
  if (unknown) invalid('event input contains an unknown field');
  const event = projectEvent({ ...input, schema: SCHEMAS.event, eventId: input.eventId || opaqueId('pse') });
  validateRedactedEvent(event);
  return event;
}

export function computeEventIntegrityDigest(event) {
  validateRedactedEvent(event);
  return digestLf('webmcp-digest-v1:governor-event', projectEvent(event));
}

export function validateEventIntegrity(state) {
  if (!state || !Array.isArray(state.events) || !Array.isArray(state.eventIntegrityDigests) || state.events.length !== state.eventIntegrityDigests.length) invalid('event integrity journal is invalid');
  const seenIds = new Set();
  const seenDigests = new Set();
  for (let index = 0; index < state.events.length; index += 1) {
    const event = state.events[index];
    if (seenIds.has(event.eventId)) invalid('duplicate event id is invalid');
    seenIds.add(event.eventId);
    const digest = state.eventIntegrityDigests[index];
    if (!DIGEST.test(digest || '') || digest !== computeEventIntegrityDigest(event)) invalid('event integrity digest is invalid');
    const pairKey = `${event.eventId}:${digest}`;
    if (seenDigests.has(pairKey)) invalid('duplicate event digest pair is invalid');
    seenDigests.add(pairKey);
    if (seenDigests.size !== new Set(state.eventIntegrityDigests).size) {
      const uniq = new Set(state.eventIntegrityDigests);
      if (uniq.size !== state.eventIntegrityDigests.length) invalid('duplicate event digest is invalid');
    }
  }
  // duplicate digest across different eventIds is also invalid (replay)
  if (new Set(state.eventIntegrityDigests).size !== state.eventIntegrityDigests.length) invalid('duplicate event digest is invalid');
  return state;
}

export function appendEvent(state, input) {
  if (!state || !Array.isArray(state.events) || !Array.isArray(state.eventIntegrityDigests) || state.events.length !== state.eventIntegrityDigests.length) invalid('event integrity journal is invalid');
  const event = redactedEvent(input);
  // reject duplicate eventId or duplicate event/digest pair (replay)
  if (state.events.some((e) => e.eventId === event.eventId)) invalid('duplicate event id is invalid');
  const digest = computeEventIntegrityDigest(event);
  if (state.eventIntegrityDigests.includes(digest)) invalid('duplicate event digest is invalid');
  if (state.events.some((e, i) => e.eventId === event.eventId && state.eventIntegrityDigests[i] === digest)) invalid('duplicate event digest pair is invalid');
  state.events.push(event);
  state.eventIntegrityDigests.push(digest);
  if (state.events.length > 256) {
    const trimCount = state.events.length - 256;
    state.events.splice(0, trimCount);
    state.eventIntegrityDigests.splice(0, trimCount);
  }
  return event;
}

export function listRedactedEvents(state) {
  validateEventIntegrity(state);
  return state.events.map((event) => {
    validateRedactedEvent(event);
    return projectEvent(event);
  });
}

export { EVENT_REASONS };
