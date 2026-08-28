import { profileError } from './errors.mjs';

const transitions = new Map([
  ['unknown', new Set(['ready', 'external_use', 'quarantined'])],
  ['ready', new Set(['leased', 'external_use', 'quarantined', 'unknown'])],
  ['leased', new Set(['active', 'auth_required', 'challenge', 'rate_limited', 'cooldown', 'external_use', 'quarantined', 'unknown'])],
  ['active', new Set(['auth_required', 'challenge', 'rate_limited', 'cooldown', 'external_use', 'quarantined', 'unknown'])],
  ['cooldown', new Set(['ready', 'quarantined', 'unknown'])],
  ['external_use', new Set(['ready', 'quarantined', 'unknown'])],
  ['auth_required', new Set(['quarantined', 'unknown', 'cooldown'])],
  ['challenge', new Set(['quarantined', 'unknown', 'cooldown'])],
  ['rate_limited', new Set(['quarantined', 'unknown', 'cooldown'])],
  ['quarantined', new Set(['ready', 'unknown'])],
]);

export function canTransition(from, to) {
  return from === to || Boolean(transitions.get(from)?.has(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw profileError('PROFILE_TRANSITION_INVALID', `Governor transition ${from} -> ${to} is not allowed`);
}

export function transition(record, to, reasonCode, now = new Date().toISOString()) {
  assertTransition(record.state, to);
  record.state = to;
  record.stateReasonCode = reasonCode;
  record.stateChangedAt = now;
  return record;
}

export function allowedTransitions(from) {
  return [...(transitions.get(from) || [])];
}
