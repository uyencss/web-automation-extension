import { detachDebugger } from '../cdp-bridge.js';
import { resolveTabId } from '../utils.js';

export const tabHandlers = {
  async listTabs() {
    const tabs = await chrome.tabs.query({});
    let sessionData = {};
    try {
      if (chrome.storage?.session) {
        sessionData = (await chrome.storage.session.get(null)) || {};
      }
    } catch {
      sessionData = {};
    }
    return {
      tabs: tabs.map((t) => {
        const item = {
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          windowId: t.windowId,
        };
        const custom = sessionData['title:' + t.id];
        if (custom !== undefined && custom !== null) {
          item.customTitle = custom;
        }
        return item;
      }),
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
    let tab;
    try {
      tab = await chrome.tabs.create({ url: params.url || 'about:blank', active: true });
    } catch (err) {
      if (err?.message?.includes('No current window') || err?.message?.includes('No window')) {
        const win = await chrome.windows.create({ url: params.url || 'about:blank', focused: true });
        tab = win.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id, active: true }))[0];
      } else {
        throw err;
      }
    }
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
  },

  async renameTab(params = {}) {
    const tabId = await resolveTabId(params);
    const customTitle = typeof params.title === 'string' ? params.title.trim().slice(0, 256) : '';
    const key = 'title:' + tabId;
    try {
      if (chrome.storage?.session) {
        if (customTitle) {
          await chrome.storage.session.set({ [key]: customTitle });
        } else {
          await chrome.storage.session.remove(key);
        }
      }
    } catch {
      // ignore session storage error in stub environments
    }

    let applied = false;
    let currentTitle = customTitle;
    let pageTitle = null;
    try {
      const res = await chrome.tabs.sendMessage(
        tabId,
        { type: 'WEBMCP_TAB_TITLE', title: customTitle || null },
        { frameId: 0 }
      );
      applied = Boolean(res?.ok);
      if (res?.title !== undefined) currentTitle = res.title;
      if (res?.pageTitle) pageTitle = res.pageTitle;
    } catch {
      applied = false;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return {
      tabId,
      title: currentTitle || tab?.title || '',
      customTitle: customTitle || null,
      applied,
      ...(applied ? {} : { reason: 'reload-required' }),
      ...(pageTitle ? { pageTitle } : {}),
    };
  }
};
