import { sendResult, sendError, sendNotification } from './ws-client.js';
import { commandHandlers } from './handlers/index.js';
import { runBatch } from './handlers/batch.js';

export async function handleIncomingMessage(msg) {
  // It's a response to something we sent (not used currently)
  if (!('method' in msg)) return;

  // It's a notification (no id)
  if (msg.id === undefined) {
    // Gateway keep-alive ping: reply with pong so traffic flows both ways.
    // Receiving this message already reset the MV3 service-worker idle timer.
    if (msg.method === 'ping') {
      sendNotification('pong', { ts: Date.now() });
      return;
    }
    console.log('[WS] Notification:', msg.method, msg.params);
    return;
  }

  if (msg.method === 'closeBrowser') {
    try {
      const windows = await chrome.windows.getAll();
      for (const win of windows) {
        await chrome.windows.remove(win.id);
      }
      sendResult(msg.id, { success: true });
    } catch (err) {
      sendError(msg.id, -1, err.message || String(err));
    }
    return;
  }

  // Orchestration primitive: run several commands in-process, one round-trip.
  // Handled before the generic dispatch so it never needs to live in
  // commandHandlers (avoids circular import + nested-batch recursion).
  if (msg.method === 'batch') {
    try {
      const result = await runBatch(msg.params || {}, commandHandlers);
      sendResult(msg.id, result);
    } catch (err) {
      sendError(msg.id, -1, err.message || String(err));
    }
    return;
  }

  // It's a request — dispatch to handler
  const handler = commandHandlers[msg.method];
  if (!handler) {
    sendError(msg.id, -32601, await methodNotFoundHint(msg.method));
    return;
  }

  try {
    const result = await handler(msg.params || {});
    sendResult(msg.id, result);
  } catch (err) {
    sendError(msg.id, -1, err.message || String(err));
  }
}

// Build a helpful "method not found" message. If the unknown method matches a
// page-registered WebMCP tool (navigator.modelContext), tell the caller to use
// the `webmcp.invokeTool` layer instead of calling it as an extension command.
async function methodNotFoundHint(method) {
  let pageTools = [];
  try {
    const r = await commandHandlers['webmcp.listTools']({});
    const tools = r?.tools;
    if (Array.isArray(tools)) pageTools = tools.map((t) => t?.name).filter(Boolean);
    else if (tools && typeof tools === 'object') pageTools = Object.keys(tools);
  } catch {
    // ignore — no active tab / no modelContext
  }

  if (pageTools.includes(method)) {
    return `Method not found: "${method}". This is a PAGE tool (registered via ` +
      `navigator.modelContext), not an extension command. Call it through the ` +
      `WebMCP layer instead: webmcp.invokeTool { toolName: "${method}", input: {...} }.`;
  }

  let hint = `Method not found: "${method}".`;
  if (pageTools.length > 0) {
    hint += ` Available page tools (call via webmcp.invokeTool): ${pageTools.join(', ')}.`;
  }
  hint += ` Use extension commands directly (e.g. click, type, navigate, evaluateJS), ` +
    `or webmcp.listTools / webmcp.invokeTool for page-registered tools.`;
  return hint;
}
