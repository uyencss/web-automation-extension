import { handleIncomingMessage } from './router.js';
import { getProfileInfo } from './profile-id.js';
import { attachedTabs } from './state.js';
import { onTabAttached, onTabDetached } from './cdp-bridge.js';

export const DEFAULT_WS_URL = 'ws://localhost:7865';
export const DEFAULT_VAULT_URL = 'http://127.0.0.1:7876';

let currentGatewayUrl = DEFAULT_WS_URL;
let currentVaultUrl = DEFAULT_VAULT_URL;
let activeSocketUrl = null;

export function normalizeGatewayUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return DEFAULT_WS_URL;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Gateway URL không hợp lệ (ví dụ: ws://localhost:7865)');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('Gateway URL phải bắt đầu bằng ws:// hoặc wss://');
  }
  return parsed.href.replace(/\/+$/, '');
}

export function normalizeVaultUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return DEFAULT_VAULT_URL;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Vault URL không hợp lệ (ví dụ: http://127.0.0.1:7876)');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Vault URL phải bắt đầu bằng http:// hoặc https://');
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + cleanPath;
}

export function getCurrentGatewayUrl() {
  return currentGatewayUrl;
}

export async function getServiceUrls() {
  try {
    if (globalThis.chrome?.storage?.local?.get) {
      const data = await chrome.storage.local.get(['webmcp_gateway_url', 'webmcp_vault_url']);
      currentGatewayUrl = data?.webmcp_gateway_url
        ? normalizeGatewayUrl(data.webmcp_gateway_url)
        : DEFAULT_WS_URL;
      currentVaultUrl = data?.webmcp_vault_url
        ? normalizeVaultUrl(data.webmcp_vault_url)
        : DEFAULT_VAULT_URL;
    }
  } catch {}
  return {
    gatewayUrl: currentGatewayUrl,
    vaultUrl: currentVaultUrl,
    defaultGatewayUrl: DEFAULT_WS_URL,
    defaultVaultUrl: DEFAULT_VAULT_URL,
  };
}

export async function saveServiceUrls({ gatewayUrl, vaultUrl } = {}) {
  const nextGateway = gatewayUrl !== undefined ? normalizeGatewayUrl(gatewayUrl) : currentGatewayUrl;
  const nextVault = vaultUrl !== undefined ? normalizeVaultUrl(vaultUrl) : currentVaultUrl;
  const gatewayChanged = nextGateway !== currentGatewayUrl || (activeSocketUrl && nextGateway !== activeSocketUrl);
  currentGatewayUrl = nextGateway;
  currentVaultUrl = nextVault;

  if (globalThis.chrome?.storage?.local) {
    if (nextGateway === DEFAULT_WS_URL) {
      await chrome.storage.local.remove('webmcp_gateway_url');
    } else {
      await chrome.storage.local.set({ webmcp_gateway_url: nextGateway });
    }
    if (nextVault === DEFAULT_VAULT_URL) {
      await chrome.storage.local.remove('webmcp_vault_url');
    } else {
      await chrome.storage.local.set({ webmcp_vault_url: nextVault });
    }
  }

  if (gatewayChanged) {
    const t = setTimeout(() => reconnectNow(), 50);
    if (typeof t?.unref === 'function') t.unref();
  }

  return {
    gatewayUrl: currentGatewayUrl,
    vaultUrl: currentVaultUrl,
    defaultGatewayUrl: DEFAULT_WS_URL,
    defaultVaultUrl: DEFAULT_VAULT_URL,
  };
}

if (globalThis.chrome?.storage?.local?.get) {
  chrome.storage.local
    .get(['webmcp_gateway_url', 'webmcp_vault_url'])
    .then((data) => {
      if (data?.webmcp_vault_url) {
        try { currentVaultUrl = normalizeVaultUrl(data.webmcp_vault_url); } catch {}
      }
      if (data?.webmcp_gateway_url) {
        try {
          const storedGw = normalizeGatewayUrl(data.webmcp_gateway_url);
          currentGatewayUrl = storedGw;
          if (activeSocketUrl && storedGw !== activeSocketUrl) {
            reconnectNow();
          }
        } catch {}
      }
    })
    .catch(() => {});
}

const RECONNECT_INTERVAL_MS = 3000;

export let ws = null;
let reconnectTimer = null;
let isConnecting = false;
let reconnectAttempt = 0;

export function updateActionBadge() {
  if (!globalThis.chrome?.action?.setBadgeText) return;
  try {
    const isOpen = Boolean(ws && ws.readyState === WebSocket.OPEN);
    if (!isOpen) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor?.({ color: '#ef4444' });
    } else if (attachedTabs.size > 0) {
      chrome.action.setBadgeText({ text: String(attachedTabs.size) });
      chrome.action.setBadgeBackgroundColor?.({ color: '#22c55e' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {}
}

onTabAttached(() => updateActionBadge());
onTabDetached(() => updateActionBadge());

export function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (isConnecting) return;
  isConnecting = true;

  try {
    activeSocketUrl = currentGatewayUrl;
    ws = new WebSocket(currentGatewayUrl);
  } catch (err) {
    console.warn('[WS] Failed to create WebSocket:', err.message);
    isConnecting = false;
    updateActionBadge();
    scheduleReconnect();
    return;
  }

  const socket = ws;

  ws.onopen = async () => {
    if (ws !== socket) return;
    isConnecting = false;
    reconnectAttempt = 0;
    clearReconnectTimer();
    updateActionBadge();
    console.log('[WS] ✓ Connected to', currentGatewayUrl);

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
        // Vault & Passkey Companion Delegation
        'vault.autofill', 'passkey.authenticateWithVirtualAuthenticator',
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
    updateActionBadge();
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
  const delay = Math.min(RECONNECT_INTERVAL_MS * Math.pow(1.5, reconnectAttempt), 30000) + Math.floor(Math.random() * 250);
  reconnectAttempt++;

  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, delay);
  if (typeof reconnectTimer?.unref === 'function') {
    reconnectTimer.unref();
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

export function closeWebSocket() {
  clearReconnectTimer();
  isConnecting = false;
  reconnectAttempt = 0;
  if (ws) {
    const old = ws;
    ws = null;
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    try { old.close(); } catch {}
  }
  updateActionBadge();
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
