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

// Keep service worker alive while WebSocket is connected
// (Manifest V3 service workers can be killed after 30s of inactivity)
const keepAlive = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Send a ping to keep the connection alive
    sendNotification('heartbeat', { timestamp: Date.now() });
  }
};

// Ping every 20 seconds to prevent service worker termination
setInterval(keepAlive, 20000);

console.log('[WebMCP] Background service worker started (modular version).');
