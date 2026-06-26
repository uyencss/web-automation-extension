import { sendNotification } from './ws-client.js';
import { attachedTabs } from './state.js';

// ────────────────────────────────────────────────────────────
// CDP Event Forwarding
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
// Tab Events Forwarding
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
// Download Events Forwarding
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
// Bridge Messages Forwarding (From register-tools.js)
// ────────────────────────────────────────────────────────────
import { startNetworkCapture, stopNetworkCapture, waitForNetworkResponse } from './handlers/network-intercept.js';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'WEBMCP_BG_REQUEST') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab context' });
      return true;
    }
    
    (async () => {
      try {
        let result;
        switch (request.method) {
          case 'start_network_capture':
            result = await startNetworkCapture(tabId, request.params);
            break;
          case 'stop_network_capture':
            result = await stopNetworkCapture(tabId);
            break;
          case 'wait_for_network_response':
            result = await waitForNetworkResponse(tabId, request.params);
            break;
          default:
            result = { error: 'Unknown bg request method: ' + request.method };
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    
    return true; // Keep channel open for async response
  }
});
