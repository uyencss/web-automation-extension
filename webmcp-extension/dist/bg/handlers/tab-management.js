import { detachDebugger } from '../cdp-bridge.js';
import { resolveTabId } from '../utils.js';

export const tabHandlers = {
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

  async activateTab(params) {
    const tabId = await resolveTabId(params);
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.id) throw new Error(`No tab found for tabId=${tabId}`);

    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    const updatedTab = await chrome.tabs.update(tabId, { active: true });

    return {
      tabId: updatedTab.id,
      url: updatedTab.url,
      title: updatedTab.title,
      active: updatedTab.active,
      windowId: updatedTab.windowId,
    };
  },

  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');
    return { tabId: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId };
  }
};
