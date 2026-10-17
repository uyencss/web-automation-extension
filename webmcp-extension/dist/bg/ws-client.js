import { handleIncomingMessage } from './router.js';
import { getProfileInfo } from './profile-id.js';

const WS_URL = 'ws://localhost:7865';
const RECONNECT_INTERVAL_MS = 3000;

export let ws = null;
let reconnectTimer = null;
let isConnecting = false;
let reconnectAttempt = 0;

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

  const socket = ws;

  ws.onopen = async () => {
    if (ws !== socket) return;
    isConnecting = false;
    reconnectAttempt = 0;
    clearReconnectTimer();
    console.log('[WS] ✓ Connected to', WS_URL);

    // Stable per-Chrome-profile id so the gateway can route commands to this
    // specific browser when several profiles share one gateway.
    const profile = await getProfileInfo();

    // Send a handshake notification so the server knows the extension is ready
    sendNotification('extensionReady', {
      name: 'WebMCP Tools Provider',
      version: chrome.runtime.getManifest().version,
      profileId: profile.id,
      profileEmail: profile.email,
      profileName: profile.name,
      capabilities: [
        // Tab management
        'listTabs', 'navigate', 'newTab', 'closeTab', 'activateTab', 'getActiveTab', 'renameTab',
        // Page interaction (JS-based)
        'listFrames',
        'evaluateJS', 'executeCDP', 'screenshot',
        'click', 'type', 'waitForSelector', 'getPageContent', 'getPageText', 'readPage', 'querySelectorAll',
        'getWindowVariable', 'findByText', 'pageFetch',
        // WebMCP
        'webmcp.listTools', 'webmcp.invokeTool',
        // Phase 1: AI Vision
        'getAccessibilityTree', 'getDOMSnapshot', 'getElementBounds', 'getInteractiveElements',
        // ARIA Snapshot Interaction (ref-based, robust alternative to CSS selectors)
        'getAriaSnapshot', 'clickByRef', 'typeByRef', 'hoverByRef', 'selectByRef',
        // Page Stability
        'waitForStable',
        // Console observability
        'startConsoleCapture', 'stopConsoleCapture',
        'readConsoleMessages', 'clearConsoleMessages',
        // Phase 2: CDP Input
        'dispatchClick', 'moveMouse', 'pressKey', 'typeText', 'scroll', 'hover', 'selectOption',
        // Phase 3: Full Control
        'getCookies', 'setCookie', 'deleteCookies',
        'getLocalStorage', 'setLocalStorage',
        'listWindows', 'createWindow', 'setViewport', 'resetViewport',
        // Utility
        'ping', 'getExtensionInfo',
      ],
    });
  };

  ws.onmessage = async (event) => {
    if (ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.error('[WS] Invalid JSON received:', event.data);
      return;
    }

    if (msg && msg.method === 'setProfileName') {
      const name = msg.params?.name;
      if (!name) {
        sendError(msg.id, -32602, 'Missing required param: name');
        return;
      }
      try {
        await chrome.storage.local.set({ webmcp_profile_name: name });
        sendResult(msg.id, { success: true });
        // Trigger a reconnect so the gateway receives the new profile name in the handshake
        setTimeout(() => reconnectNow(), 500);
      } catch (err) {
        sendError(msg.id, -32603, err.message);
      }
      return;
    }

    handleIncomingMessage(msg);
  };

  ws.onclose = (event) => {
    if (ws !== socket) return;
    isConnecting = false;
    ws = null;
    console.log(`[WS] ✗ Disconnected (code=${event.code}). Reconnecting in ${RECONNECT_INTERVAL_MS}ms...`);
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    if (ws !== socket) return;
    isConnecting = false;
    // onclose will fire after this, which handles reconnect
  };
}

function scheduleReconnect() {
  clearReconnectTimer();

  // Use chrome.alarms as a fallback in case the service worker is killed
  // before the setTimeout fires. Alarm-based reconnect is handled by
  // background.js onAlarm listener (which calls connectWebSocket).
  // Here we do an immediate fast retry via setTimeout.
  const delay = Math.min(RECONNECT_INTERVAL_MS * Math.pow(1.5, reconnectAttempt), 30000);
  reconnectAttempt++;

  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, delay);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

export function reconnectNow() {
  clearReconnectTimer();
  reconnectAttempt = 0;
  isConnecting = false;
  if (ws) {
    const old = ws;
    ws = null;
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    try { old.close(); } catch {}
  }
  connectWebSocket();
}

export async function applyProfileName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed) {
    await chrome.storage.local.set({ webmcp_profile_name: trimmed });
  } else {
    await chrome.storage.local.remove('webmcp_profile_name');
  }
  setTimeout(() => reconnectNow(), 100);
  return { success: true, profileName: trimmed || null };
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
