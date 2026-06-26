// ============================================================
// WebMCP Tools Provider — Background Service Worker
//
// This is the core communication bridge between your AI program
// and the Chrome browser. It:
//
//   1. Connects to your WebSocket server (ws://localhost:7865)
//   2. Receives JSON-RPC 2.0 commands from your AI program
//   3. Executes them via chrome.debugger (CDP), chrome.tabs,
//      chrome.scripting, or page JS evaluation
//   4. Returns results back over WebSocket
//
// Protocol: JSON-RPC 2.0 (same as Codex extension)
// ============================================================

const WS_URL = 'ws://localhost:7865';
const RECONNECT_INTERVAL_MS = 3000;
const CDP_TIMEOUT_MS = 30000;

// ────────────────────────────────────────────────────────────
// §1 — State
// ────────────────────────────────────────────────────────────

let ws = null;
let reconnectTimer = null;
let isConnecting = false;

/** Set of tabIds where chrome.debugger is attached */
const attachedTabs = new Set();

// ────────────────────────────────────────────────────────────
// §2 — WebSocket Client (connects TO your server)
// ────────────────────────────────────────────────────────────

function connectWebSocket() {
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

function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function sendNotification(method, params) {
  sendMessage({ jsonrpc: '2.0', method, params });
}

// ────────────────────────────────────────────────────────────
// §3 — JSON-RPC Command Router
// ────────────────────────────────────────────────────────────

async function handleIncomingMessage(msg) {
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

// ────────────────────────────────────────────────────────────
// §4 — CDP (Chrome DevTools Protocol) Bridge
// ────────────────────────────────────────────────────────────

async function ensureDebuggerAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  } catch (err) {
    // Already attached (by another extension like Codex?)
    if (err.message?.includes('Another debugger is already attached')) {
      throw new Error(
        `Tab ${tabId} already has a debugger attached (likely Codex). ` +
        'Detach it first or use a different tab.'
      );
    }
    // Already attached by us
    if (err.message?.includes('already attached')) {
      attachedTabs.add(tabId);
      return;
    }
    throw err;
  }
}

async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignore
  }
  attachedTabs.delete(tabId);
}

async function sendCDPCommand(tabId, method, commandParams = {}) {
  await ensureDebuggerAttached(tabId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CDP command "${method}" timed out after ${CDP_TIMEOUT_MS}ms`));
    }, CDP_TIMEOUT_MS);

    chrome.debugger.sendCommand({ tabId }, method, commandParams, (result) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// Clean up when debugger detaches
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

// ────────────────────────────────────────────────────────────
// §5 — Helper: Evaluate JavaScript in a Tab
// ────────────────────────────────────────────────────────────

async function evaluateInTab(tabId, expression, awaitPromise = true) {
  const result = await sendCDPCommand(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.text ||
      result.exceptionDetails.exception?.description ||
      'JS evaluation error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

// ────────────────────────────────────────────────────────────
// §6 — Helper: Resolve Tab ID
// ────────────────────────────────────────────────────────────

async function resolveTabId(params) {
  if (params.tabId) return params.tabId;
  // Default to the active tab in the current window
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
}

// ────────────────────────────────────────────────────────────
// §7 — Command Handlers
// ────────────────────────────────────────────────────────────

const commandHandlers = {

  // ── Tab Management ──────────────────────────────────────

  async listTabs() {
    const tabs = await chrome.tabs.query({});
    return {
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
      })),
    };
  },

  async navigate(params) {
    const { url } = params;
    if (!url) throw new Error('Missing required param: url');
    const tabId = await resolveTabId(params);
    await chrome.tabs.update(tabId, { url });

    // Wait for page to finish loading
    await new Promise((resolve) => {
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Timeout after 30s
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 30000);
    });

    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url, title: tab.title };
  },

  async newTab(params) {
    const tab = await chrome.tabs.create({ url: params.url || 'about:blank', active: true });
    if (params.url && params.url !== 'about:blank') {
      // Wait for load
      await new Promise((resolve) => {
        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 30000);
      });
    }
    const updatedTab = await chrome.tabs.get(tab.id);
    return { tabId: updatedTab.id, url: updatedTab.url, title: updatedTab.title };
  },

  async closeTab(params) {
    const tabId = await resolveTabId(params);
    await detachDebugger(tabId);
    await chrome.tabs.remove(tabId);
    return { closed: true, tabId };
  },

  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');
    return { tabId: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId };
  },

  // ── Page Interaction (CDP) ──────────────────────────────

  async evaluateJS(params) {
    const { code } = params;
    if (!code) throw new Error('Missing required param: code');
    const tabId = await resolveTabId(params);

    // Wrap in an async IIFE so users can use `return` and `await`
    const wrapped = `(async () => { ${code} })()`;
    const result = await evaluateInTab(tabId, wrapped);
    return { tabId, result };
  },

  async executeCDP(params) {
    const { method } = params;
    if (!method) throw new Error('Missing required param: method');
    const tabId = await resolveTabId(params);
    const result = await sendCDPCommand(tabId, method, params.params || {});
    return { tabId, result };
  },

  async screenshot(params) {
    const tabId = await resolveTabId(params);
    const result = await sendCDPCommand(tabId, 'Page.captureScreenshot', {
      format: 'png',
      quality: 80,
      ...(params.fullPage ? { captureBeyondViewport: true } : {}),
    });
    return { tabId, base64: result.data, format: 'png' };
  },

  // ── High-Level Actions ──────────────────────────────────

  async click(params) {
    const { selector } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);

    const result = await evaluateInTab(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { success: false, error: 'Element not found: ${selector}' };
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.click();
        return {
          success: true,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 200),
        };
      })()
    `);
    return { tabId, ...result };
  },

  async type(params) {
    const { selector, text } = params;
    if (!selector) throw new Error('Missing required param: selector');
    if (text === undefined) throw new Error('Missing required param: text');
    const tabId = await resolveTabId(params);

    const result = await evaluateInTab(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { success: false, error: 'Element not found: ${selector}' };
        el.focus();
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, tag: el.tagName.toLowerCase(), name: el.name || el.id };
      })()
    `);
    return { tabId, ...result };
  },

  async waitForSelector(params) {
    const { selector, timeout = 10000 } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);

    const result = await evaluateInTab(tabId, `
      new Promise((resolve) => {
        const existing = document.querySelector(${JSON.stringify(selector)});
        if (existing) {
          return resolve({
            found: true,
            tag: existing.tagName.toLowerCase(),
            text: (existing.textContent || '').trim().slice(0, 200),
          });
        }
        const observer = new MutationObserver(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) {
            observer.disconnect();
            resolve({
              found: true,
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || '').trim().slice(0, 200),
            });
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve({ found: false, error: 'Timeout waiting for: ${selector}' });
        }, ${timeout});
      })
    `);
    return { tabId, ...result };
  },

  async getPageContent(params) {
    const tabId = await resolveTabId(params);
    const result = await evaluateInTab(tabId, `
      (() => ({
        title: document.title,
        url: location.href,
        text: document.body?.innerText?.slice(0, 50000) || '',
        html: document.documentElement.outerHTML.slice(0, 100000),
      }))()
    `);
    return { tabId, ...result };
  },

  // ── WebMCP Bridge ───────────────────────────────────────

  async 'webmcp.listTools'(params) {
    const tabId = await resolveTabId(params);
    const tools = await evaluateInTab(tabId, `
      (() => {
        if (!navigator.modelContext) return { error: 'navigator.modelContext not found' };
        return navigator.modelContext.tools;
      })()
    `);
    return { tabId, tools };
  },

  async 'webmcp.invokeTool'(params) {
    const { toolName, input = {} } = params;
    if (!toolName) throw new Error('Missing required param: toolName');
    const tabId = await resolveTabId(params);

    const result = await evaluateInTab(tabId, `
      (async () => {
        if (!navigator.modelContext) throw new Error('navigator.modelContext not found');
        return await navigator.modelContext.invokeTool(
          ${JSON.stringify(toolName)},
          ${JSON.stringify(input)}
        );
      })()
    `);
    return { tabId, result };
  },

  // ── Phase 1: AI "Vision" — Page Structure ───────────────

  async getAccessibilityTree(params) {
    const tabId = await resolveTabId(params);
    const { depth = -1, interestingOnly = true } = params;

    // Enable accessibility domain
    await sendCDPCommand(tabId, 'Accessibility.enable', {});

    const tree = await sendCDPCommand(tabId, 'Accessibility.getFullAXTree', {
      depth,
    });

    if (!interestingOnly) return { tabId, nodes: tree.nodes };

    // Filter to only interactive/meaningful nodes
    const interestingRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
      'menuitem', 'tab', 'heading', 'img', 'listitem', 'option',
      'searchbox', 'switch', 'slider', 'spinbutton', 'table',
      'row', 'cell', 'dialog', 'alert', 'navigation', 'main',
      'form', 'list', 'tree', 'treeitem', 'banner', 'complementary',
    ]);

    const filtered = tree.nodes.filter((n) => {
      const role = n.role?.value?.toLowerCase();
      if (interestingRoles.has(role)) return true;
      // Include nodes with names (visible text)
      if (n.name?.value?.trim()) return true;
      return false;
    });

    // Simplify each node for AI consumption
    const simplified = filtered.map((n) => ({
      nodeId: n.nodeId,
      role: n.role?.value,
      name: n.name?.value,
      description: n.description?.value,
      value: n.value?.value,
      disabled: n.properties?.find(p => p.name === 'disabled')?.value?.value,
      focused: n.properties?.find(p => p.name === 'focused')?.value?.value,
      checked: n.properties?.find(p => p.name === 'checked')?.value?.value,
      backendDOMNodeId: n.backendDOMNodeId,
      childIds: n.childIds,
    }));

    return { tabId, nodeCount: simplified.length, nodes: simplified };
  },

  async getDOMSnapshot(params) {
    const tabId = await resolveTabId(params);
    const { computedStyles = ['display', 'visibility', 'opacity', 'color', 'font-size'] } = params;

    const result = await sendCDPCommand(tabId, 'DOMSnapshot.captureSnapshot', {
      computedStyles,
      includeDOMRects: true,
      includePaintOrder: true,
      includeBlendedBackgroundColors: true,
    });

    return { tabId, ...result };
  },

  async getElementBounds(params) {
    const { selector } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);

    const result = await evaluateInTab(tabId, `
      (() => {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        return Array.from(els).slice(0, 50).map((el, i) => {
          const rect = el.getBoundingClientRect();
          return {
            index: i,
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            text: (el.textContent || '').trim().slice(0, 100),
            role: el.getAttribute('role') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              centerX: Math.round(rect.x + rect.width / 2),
              centerY: Math.round(rect.y + rect.height / 2),
            },
            visible: rect.width > 0 && rect.height > 0 &&
              getComputedStyle(el).display !== 'none' &&
              getComputedStyle(el).visibility !== 'hidden',
          };
        });
      })()
    `);
    return { tabId, elements: result };
  },

  async getInteractiveElements(params) {
    const tabId = await resolveTabId(params);

    const result = await evaluateInTab(tabId, `
      (() => {
        const selectors = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="searchbox"],[contenteditable="true"]';
        const els = document.querySelectorAll(selectors);
        return Array.from(els).slice(0, 200).map((el, i) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return null;
          return {
            index: i,
            tag: el.tagName.toLowerCase(),
            type: el.type || undefined,
            id: el.id || undefined,
            name: el.name || undefined,
            role: el.getAttribute('role') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            text: (el.textContent || '').trim().slice(0, 100),
            placeholder: el.placeholder || undefined,
            href: el.href || undefined,
            value: el.value || undefined,
            checked: el.checked ?? undefined,
            disabled: el.disabled || undefined,
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              centerX: Math.round(rect.x + rect.width / 2),
              centerY: Math.round(rect.y + rect.height / 2),
            },
          };
        }).filter(Boolean);
      })()
    `);
    return { tabId, elements: result };
  },

  // ── Phase 2: AI "Actions" — CDP Input Dispatch ──────────

  async dispatchClick(params) {
    const { x, y, button = 'left', clickCount = 1 } = params;
    if (x === undefined || y === undefined) throw new Error('Missing required params: x, y');
    const tabId = await resolveTabId(params);

    // Move mouse to position first
    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    // Small delay for hover effects
    await new Promise(r => setTimeout(r, 50));
    // Press
    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, clickCount,
    });
    // Release
    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, clickCount,
    });

    return { tabId, clicked: true, x, y, button };
  },

  async moveMouse(params) {
    const { x, y, steps = 1 } = params;
    if (x === undefined || y === undefined) throw new Error('Missing required params: x, y');
    const tabId = await resolveTabId(params);

    // Get current mouse position (or default)
    const startX = params.fromX ?? 0;
    const startY = params.fromY ?? 0;

    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const currentX = startX + (x - startX) * progress;
      const currentY = startY + (y - startY) * progress;
      await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(currentX),
        y: Math.round(currentY),
      });
    }

    return { tabId, x, y };
  },

  async pressKey(params) {
    const { key, text, modifiers = [] } = params;
    if (!key) throw new Error('Missing required param: key');
    const tabId = await resolveTabId(params);

    // Modifier flags: Alt=1, Ctrl=2, Meta=4, Shift=8
    let modifierFlags = 0;
    if (modifiers.includes('alt')) modifierFlags |= 1;
    if (modifiers.includes('ctrl')) modifierFlags |= 2;
    if (modifiers.includes('meta')) modifierFlags |= 4;
    if (modifiers.includes('shift')) modifierFlags |= 8;

    // Special key mapping
    const specialKeys = {
      Enter: { keyCode: 13, code: 'Enter' },
      Tab: { keyCode: 9, code: 'Tab' },
      Escape: { keyCode: 27, code: 'Escape' },
      Backspace: { keyCode: 8, code: 'Backspace' },
      Delete: { keyCode: 46, code: 'Delete' },
      ArrowUp: { keyCode: 38, code: 'ArrowUp' },
      ArrowDown: { keyCode: 40, code: 'ArrowDown' },
      ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
      ArrowRight: { keyCode: 39, code: 'ArrowRight' },
      Home: { keyCode: 36, code: 'Home' },
      End: { keyCode: 35, code: 'End' },
      PageUp: { keyCode: 33, code: 'PageUp' },
      PageDown: { keyCode: 34, code: 'PageDown' },
      Space: { keyCode: 32, code: 'Space', text: ' ' },
    };

    const special = specialKeys[key];
    const keyCode = special?.keyCode || key.charCodeAt(0);
    const code = special?.code || `Key${key.toUpperCase()}`;
    const keyText = text || special?.text || (key.length === 1 ? key : '');

    // Key down
    await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers: modifierFlags,
      ...(keyText ? { text: keyText, unmodifiedText: keyText } : {}),
    });

    // Char event (for text input)
    if (keyText) {
      await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'char',
        key: keyText,
        code,
        text: keyText,
        unmodifiedText: keyText,
        windowsVirtualKeyCode: keyCode,
        modifiers: modifierFlags,
      });
    }

    // Key up
    await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers: modifierFlags,
    });

    return { tabId, key, modifiers };
  },

  async typeText(params) {
    const { text } = params;
    if (!text) throw new Error('Missing required param: text');
    const tabId = await resolveTabId(params);

    // Use Input.insertText for fast, reliable text insertion
    await sendCDPCommand(tabId, 'Input.insertText', { text });
    return { tabId, typed: text.length };
  },

  async scroll(params) {
    const { x = 0, y = 0, deltaX = 0, deltaY = 0 } = params;
    const tabId = await resolveTabId(params);

    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x, y,
      deltaX, deltaY,
    });

    return { tabId, deltaX, deltaY };
  },

  async hover(params) {
    const { selector } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);

    // Get element center coordinates
    const bounds = await evaluateInTab(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        };
      })()
    `);

    if (!bounds) throw new Error(`Element not found: ${selector}`);

    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: bounds.x, y: bounds.y,
    });

    return { tabId, ...bounds, selector };
  },

  async selectOption(params) {
    const { selector, value, index, text: optionText } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);

    const result = await evaluateInTab(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || el.tagName !== 'SELECT') return { success: false, error: 'SELECT not found' };
        const opts = Array.from(el.options);
        let option;
        if (${JSON.stringify(value)} !== null) option = opts.find(o => o.value === ${JSON.stringify(value)});
        else if (${JSON.stringify(index)} !== null) option = opts[${JSON.stringify(index)}];
        else if (${JSON.stringify(optionText)} !== null) option = opts.find(o => o.text === ${JSON.stringify(optionText)});
        if (!option) return { success: false, error: 'Option not found' };
        el.value = option.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, value: option.value, text: option.text };
      })()
    `);
    return { tabId, ...result };
  },

  // ── Phase 3: Full Control ───────────────────────────────

  async getCookies(params) {
    const tabId = await resolveTabId(params);
    const tab = await chrome.tabs.get(tabId);
    const result = await sendCDPCommand(tabId, 'Network.getCookies', {
      urls: [tab.url],
    });
    return { tabId, cookies: result.cookies };
  },

  async setCookie(params) {
    const { name, value, domain, path = '/' } = params;
    if (!name || value === undefined) throw new Error('Missing required params: name, value');
    const tabId = await resolveTabId(params);

    const result = await sendCDPCommand(tabId, 'Network.setCookie', {
      name, value, domain, path,
    });
    return { tabId, success: result.success };
  },

  async deleteCookies(params) {
    const { name, domain, url } = params;
    if (!name) throw new Error('Missing required param: name');
    const tabId = await resolveTabId(params);

    await sendCDPCommand(tabId, 'Network.deleteCookies', {
      name, ...(domain ? { domain } : {}), ...(url ? { url } : {}),
    });
    return { tabId, deleted: true };
  },

  async getLocalStorage(params) {
    const tabId = await resolveTabId(params);
    const result = await evaluateInTab(tabId, `
      (() => {
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          data[key] = localStorage.getItem(key);
        }
        return data;
      })()
    `);
    return { tabId, data: result };
  },

  async setLocalStorage(params) {
    const { key, value } = params;
    if (!key) throw new Error('Missing required param: key');
    const tabId = await resolveTabId(params);
    await evaluateInTab(tabId, `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
    return { tabId, key, set: true };
  },

  async listWindows() {
    const windows = await chrome.windows.getAll({ populate: true });
    return {
      windows: windows.map((w) => ({
        id: w.id,
        focused: w.focused,
        state: w.state,
        width: w.width,
        height: w.height,
        top: w.top,
        left: w.left,
        tabCount: w.tabs?.length || 0,
      })),
    };
  },

  async createWindow(params) {
    const { url, width, height, type = 'normal' } = params;
    const win = await chrome.windows.create({
      url, width, height, type, focused: true,
    });
    return { windowId: win.id, tabId: win.tabs?.[0]?.id };
  },

  async setViewport(params) {
    const { width, height, deviceScaleFactor = 1, mobile = false } = params;
    if (!width || !height) throw new Error('Missing required params: width, height');
    const tabId = await resolveTabId(params);

    await sendCDPCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor, mobile,
    });
    return { tabId, width, height };
  },

  async resetViewport(params) {
    const tabId = await resolveTabId(params);
    await sendCDPCommand(tabId, 'Emulation.clearDeviceMetricsOverride', {});
    return { tabId, reset: true };
  },

  // ── Utility ─────────────────────────────────────────────

  async ping() {
    return { pong: true, timestamp: Date.now() };
  },

  async getExtensionInfo() {
    const manifest = chrome.runtime.getManifest();
    return {
      name: manifest.name,
      version: manifest.version,
      debuggerAttached: [...attachedTabs],
    };
  },
};

// ────────────────────────────────────────────────────────────
// §8 — CDP Event Forwarding
// ────────────────────────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  // Forward CDP events to the WebSocket server
  sendNotification('cdpEvent', {
    tabId: source.tabId,
    method,
    params,
  });
});

// ────────────────────────────────────────────────────────────
// §9 — Tab Events Forwarding
// ────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    sendNotification('tabUpdated', {
      tabId,
      url: tab.url,
      title: tab.title,
      status: 'complete',
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  sendNotification('tabClosed', { tabId });
});

chrome.tabs.onCreated.addListener((tab) => {
  sendNotification('tabCreated', {
    tabId: tab.id,
    url: tab.url || tab.pendingUrl,
    windowId: tab.windowId,
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  sendNotification('tabActivated', {
    tabId: activeInfo.tabId,
    windowId: activeInfo.windowId,
  });
});

// ────────────────────────────────────────────────────────────
// §10 — Download Events Forwarding
// ────────────────────────────────────────────────────────────

chrome.downloads.onCreated.addListener((item) => {
  sendNotification('downloadStarted', {
    id: item.id,
    url: item.url,
    filename: item.filename,
    mime: item.mime,
    fileSize: item.fileSize,
    state: item.state,
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  sendNotification('downloadChanged', {
    id: delta.id,
    state: delta.state?.current,
    filename: delta.filename?.current,
    error: delta.error?.current,
  });
});

// ────────────────────────────────────────────────────────────
// §10 — Startup
// ────────────────────────────────────────────────────────────

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

console.log('[WebMCP] Background service worker started. Connecting to', WS_URL);
