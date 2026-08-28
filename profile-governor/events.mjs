import { opaqueId, SCHEMAS } from './contracts.mjs';

const EVENT_KEYS = new Set(['eventId', 'leaseId', 'profileAlias', 'state', 'stateReasonCode', 'fenceEpoch', 'bindingDigest', 'bindingId', 'runId', 'timestamp', 'leaseBindingDigest', 'counts', 'livenessSummary', 'grantRevokeStatus']);

export function redactedEvent(input) {
  const event = { schema: SCHEMAS.event, eventId: input.eventId || opaqueId('pse') };
  for (const key of EVENT_KEYS) if (input[key] !== undefined) event[key] = key === 'counts' ? { ...input[key] } : input[key];
  return event;
}

export function appendEvent(state, input) {
  const event = redactedEvent(input);
  state.events.push(event);
  if (state.events.length > 256) state.events.splice(0, state.events.length - 256);
  return event;
}

export function listRedactedEvents(state) {
  return state.events.map((event) => redactedEvent(event));
}
