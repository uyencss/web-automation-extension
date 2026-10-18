import { sendNotification, ws, reconnectNow, applyProfileName, getServiceUrls, saveServiceUrls } from './ws-client.js';
import { attachedTabs } from './state.js';
import { detachDebugger, cleanupDetachedTab } from './cdp-bridge.js';
import { getProfileInfo } from './profile-id.js';
import { tabHandlers } from './handlers/tab-management.js';
import { startNetworkCapture, stopNetworkCapture, waitForNetworkResponse, getCapturedRequests } from './handlers/network-intercept.js';

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
  cleanupDetachedTab(tabId);
  if (chrome.storage?.session) {
    chrome.storage.session.remove('title:' + tabId).catch(() => {});
  }
  sendNotification('tabClosed', { tabId });
});

chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  if (!chrome.storage?.session) return;
  const oldKey = 'title:' + removedTabId;
  const newKey = 'title:' + addedTabId;
  chrome.storage.session.get(oldKey).then(async (data) => {
    const existing = data?.[oldKey];
    if (existing) {
      await chrome.storage.session.set({ [newKey]: existing });
      await chrome.storage.session.remove(oldKey);
    }
  }).catch(() => {});
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
// Bridge & Popup Messages Forwarding
// ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === 'WEBMCP_TAB_TITLE_INIT') {
    if (!sender.tab?.id || sender.frameId !== 0) {
      sendResponse({ customTitle: null });
      return false;
    }
    const key = 'title:' + sender.tab.id;
    if (chrome.storage?.session) {
      chrome.storage.session.get(key).then((data) => {
        sendResponse({ customTitle: data?.[key] || null });
      }).catch(() => sendResponse({ customTitle: null }));
      return true;
    } else {
      sendResponse({ customTitle: null });
      return false;
    }
  }

  if (request?.type === 'WEBMCP_POPUP') {
    if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ ok: false, error: 'Unauthorized popup sender' });
      return false;
    }

    (async () => {
      try {
        switch (request.method) {
          case 'status': {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const profile = await getProfileInfo();
            const urls = await getServiceUrls();
            let customTitle = null;
            if (activeTab?.id && chrome.storage?.session) {
              try {
                const data = await chrome.storage.session.get('title:' + activeTab.id);
                customTitle = data?.['title:' + activeTab.id] || null;
              } catch {}
            }
            let pageTitle = activeTab?.title || '';
            if (activeTab?.id && chrome.tabs?.sendMessage) {
              try {
                const titleRes = await chrome.tabs.sendMessage(
                  activeTab.id,
                  { type: 'WEBMCP_GET_TAB_TITLE' },
                  { frameId: 0 }
                );
                if (titleRes?.pageTitle) pageTitle = titleRes.pageTitle;
              } catch {}
            }
            const wsState = !ws
              ? 'closed'
              : ws.readyState === WebSocket.OPEN
              ? 'open'
              : ws.readyState === WebSocket.CONNECTING
              ? 'connecting'
              : 'closed';

            sendResponse({
              ok: true,
              wsState,
              profile,
              gatewayUrl: urls.gatewayUrl,
              defaultGatewayUrl: urls.defaultGatewayUrl,
              tab: activeTab
                ? {
                    id: activeTab.id,
                    url: activeTab.url,
                    title: activeTab.title,
                    customTitle,
                    pageTitle,
                    cdpAttached: attachedTabs.has(activeTab.id),
                  }
                : null,
              attachedCount: attachedTabs.size,
            });
            break;
          }

          case 'saveSettings': {
            const urls = await saveServiceUrls(request.params || {});
            sendResponse({ ok: true, ...urls });
            break;
          }

          case 'renameTab': {
            const result = await tabHandlers.renameTab(request.params || {});
            sendResponse({ ok: true, result });
            break;
          }

          case 'reconnect': {
            reconnectNow();
            sendResponse({ ok: true });
            break;
          }

          case 'setProfileName': {
            const res = await applyProfileName(request.params?.name);
            const profile = await getProfileInfo();
            sendResponse({ ok: true, ...res, profile });
            break;
          }

          case 'detach': {
            if (request.params?.all) {
              const tabIds = [...attachedTabs];
              for (const id of tabIds) {
                await detachDebugger(id);
              }
            } else if (request.params?.tabId) {
              await detachDebugger(request.params.tabId);
            }
            sendResponse({ ok: true, attachedCount: attachedTabs.size });
            break;
          }

          default:
            sendResponse({ ok: false, error: 'Unknown popup method: ' + request.method });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();

    return true;
  }

  if (request?.type === 'WEBMCP_BG_REQUEST') {
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
            result = await stopNetworkCapture(tabId, request.params);
            break;
          case 'wait_for_network_response':
            result = await waitForNetworkResponse(tabId, request.params);
            break;
          case 'get_captured_requests':
            result = await getCapturedRequests(tabId, request.params);
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
