import { sendResult, sendError } from './ws-client.js';
import { commandHandlers } from './handlers/index.js';

export async function handleIncomingMessage(msg) {
  // It's a response to something we sent (not used currently)
  if (!('method' in msg)) return;

  // It's a notification (no id) — just log
  if (msg.id === undefined) {
    console.log('[WS] Notification:', msg.method, msg.params);
    return;
  }

  // It's a request — dispatch to handler
  const handler = commandHandlers[msg.method];
  if (!handler) {
    sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    return;
  }

  try {
    const result = await handler(msg.params || {});
    sendResult(msg.id, result);
  } catch (err) {
    sendError(msg.id, -1, err.message || String(err));
  }
}
