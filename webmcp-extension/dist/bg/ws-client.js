import { handleIncomingMessage } from './router.js';

const WS_URL = 'ws://localhost:7865';
const RECONNECT_INTERVAL_MS = 3000;

export let ws = null;
let reconnectTimer = null;
let isConnecting = false;

export function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (isConnecting) return;
  isConnecting = true;

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.warn('[WS] Failed to create WebSocket:', err.message);
    isConnecting = false;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    isConnecting = false;
    clearReconnectTimer();
    console.log('[WS] ✓ Connected to', WS_URL);

    // Send a handshake notification so the server knows the extension is ready
    sendNotification('extensionReady', {
      name: 'WebMCP Tools Provider',
      version: chrome.runtime.getManifest().version,
      capabilities: [
        // Tab management
        'listTabs', 'navigate', 'newTab', 'closeTab', 'getActiveTab',
        // Page interaction (JS-based)
        'evaluateJS', 'executeCDP', 'screenshot',
        'click', 'type', 'waitForSelector', 'getPageContent',
        // WebMCP
        'webmcp.listTools', 'webmcp.invokeTool',
        // Phase 1: AI Vision
        'getAccessibilityTree', 'getDOMSnapshot', 'getElementBounds', 'getInteractiveElements',
        // Phase 2: CDP Input
        'dispatchClick', 'moveMouse', 'pressKey', 'typeText', 'scroll', 'hover', 'selectOption',
        // Phase 3: Full Control
        'getCookies', 'setCookie', 'deleteCookies',
        'getLocalStorage', 'setLocalStorage',
        'listWindows', 'createWindow', 'setViewport', 'resetViewport',
      ],
    });
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.error('[WS] Invalid JSON received:', event.data);
      return;
    }
    handleIncomingMessage(msg);
  };

  ws.onclose = (event) => {
    isConnecting = false;
    ws = null;
    console.log(`[WS] ✗ Disconnected (code=${event.code}). Reconnecting in ${RECONNECT_INTERVAL_MS}ms...`);
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    isConnecting = false;
    // onclose will fire after this, which handles reconnect
  };
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, RECONNECT_INTERVAL_MS);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

export function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

export function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

export function sendNotification(method, params) {
  sendMessage({ jsonrpc: '2.0', method, params });
}
