// ============================================================
// WebMCP Tools Provider — Background Service Worker
//
// Refactored into ES Modules
// ============================================================

import { connectWebSocket, sendNotification, ws } from './bg/ws-client.js';
import './bg/events.js';

chrome.runtime.onInstalled.addListener((details) => {
  console.log(
    `[WebMCP] Extension installed (reason: ${details.reason}, v${chrome.runtime.getManifest().version})`
  );
});

// Connect to WebSocket server immediately
connectWebSocket();

// Also try to reconnect when the service worker wakes up
chrome.runtime.onStartup.addListener(() => {
  connectWebSocket();
});

// ── Keep-alive via chrome.alarms (reliable in MV3) ──────────
// setInterval is NOT reliable in Manifest V3 service workers because
// the worker can be terminated after ~30s of inactivity. chrome.alarms
// persists across worker restarts and will wake the worker on fire.
const KEEPALIVE_ALARM = 'webmcp-keepalive';

chrome.alarms.create(KEEPALIVE_ALARM, {
  // Fire every 20 seconds (minimum is ~1 min in practice, but Chrome
  // allows sub-minute alarms for packed extensions)
  periodInMinutes: 0.33,
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    sendNotification('heartbeat', { timestamp: Date.now() });
  } else {
    // Attempt reconnect on each alarm tick if disconnected
    connectWebSocket();
  }
});

console.log('[WebMCP] Background service worker started (modular version).');

