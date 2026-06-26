import { attachedTabs } from '../state.js';
import { ensureDebuggerAttached, sendCDPCommand } from '../cdp-bridge.js';

// Map: tabId -> { urlPattern, requests: Map(requestId -> { url, status, body }) }
const captureSessions = new Map();

export async function startNetworkCapture(tabId, { url_pattern }) {
  await ensureDebuggerAttached(tabId);
  await sendCDPCommand(tabId, 'Network.enable', {});
  captureSessions.set(tabId, {
    urlPattern: url_pattern,
    requests: new Map()
  });
  return { success: true };
}

export async function stopNetworkCapture(tabId) {
  captureSessions.delete(tabId);
  try {
    await sendCDPCommand(tabId, 'Network.disable', {});
  } catch (e) {
    // ignore
  }
  return { success: true };
}

export async function waitForNetworkResponse(tabId, { url_pattern, timeout_ms = 10000 }) {
  const session = captureSessions.get(tabId);
  if (!session) throw new Error('Network capture not started. Call start_network_capture first.');

  const startTime = Date.now();
  
  return new Promise((resolve) => {
    const checkInterval = setInterval(async () => {
      // Find a request matching the pattern that has completed
      for (const [reqId, data] of session.requests.entries()) {
        if (data.url.includes(url_pattern) && data.status === 'finished') {
          clearInterval(checkInterval);
          
          try {
            const bodyResult = await sendCDPCommand(tabId, 'Network.getResponseBody', { requestId: reqId });
            resolve({
              url: data.url,
              body: bodyResult.body
            });
          } catch (err) {
            resolve({
              url: data.url,
              error: err.message
            });
          }
          return;
        }
      }
      
      if (Date.now() - startTime > timeout_ms) {
        clearInterval(checkInterval);
        resolve({ error: `Timeout waiting for network response matching: ${url_pattern}` });
      }
    }, 500);
  });
}

// Hook into debugger events
chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = captureSessions.get(source.tabId);
  if (!session) return;
  
  if (method === 'Network.requestWillBeSent') {
    if (params.request.url.includes(session.urlPattern)) {
      session.requests.set(params.requestId, {
        url: params.request.url,
        status: 'pending'
      });
    }
  }
  
  if (method === 'Network.loadingFinished') {
    if (session.requests.has(params.requestId)) {
      session.requests.get(params.requestId).status = 'finished';
    }
  }
  
  if (method === 'Network.loadingFailed') {
    if (session.requests.has(params.requestId)) {
      session.requests.get(params.requestId).status = 'failed';
    }
  }
});
