import { resolveTabId } from '../utils.js';
import { evaluateInTab, sendCDPCommand } from '../cdp-bridge.js';
import { attachedTabs } from '../state.js';

export const fullControlHandlers = {
  async getCookies(params) {
    const tabId = await resolveTabId(params);
    const cdpParams = {};
    if (params?.urls && Array.isArray(params.urls)) {
      cdpParams.urls = params.urls;
    } else if (params?.url) {
      cdpParams.urls = [params.url];
    } else {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url) cdpParams.urls = [tab.url];
    }
    const result = await sendCDPCommand(tabId, 'Network.getCookies', cdpParams);
    return { tabId, cookies: result.cookies, supportsCdpCookieAttributes: true };
  },

  async setCookie(params) {
    const {
      name,
      value,
      url,
      domain,
      path = '/',
      secure,
      httpOnly,
      sameSite,
      expires,
      priority,
      sameParty,
      sourceScheme,
      sourcePort,
      partitionKey,
    } = params;
    if (!name || value === undefined) throw new Error('Missing required params: name, value');
    const tabId = await resolveTabId(params);

    const cdpParams = {
      name,
      value,
      path,
    };
    if (url) cdpParams.url = url;
    if (domain) cdpParams.domain = domain;
    if (secure !== undefined) cdpParams.secure = Boolean(secure);
    if (httpOnly !== undefined) cdpParams.httpOnly = Boolean(httpOnly);
    if (sameSite) cdpParams.sameSite = sameSite;
    if (expires !== undefined && expires !== null) cdpParams.expires = Number(expires);
    if (priority) cdpParams.priority = priority;
    if (sameParty !== undefined) cdpParams.sameParty = Boolean(sameParty);
    if (sourceScheme) cdpParams.sourceScheme = sourceScheme;
    if (sourcePort !== undefined) cdpParams.sourcePort = Number(sourcePort);
    if (partitionKey) cdpParams.partitionKey = partitionKey;

    const result = await sendCDPCommand(tabId, 'Network.setCookie', cdpParams);
    return { tabId, success: Boolean(result?.success), supportsCdpCookieAttributes: true };
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

  async ping() {
    return { pong: true, timestamp: Date.now() };
  },

  async getExtensionInfo() {
    const manifest = chrome.runtime.getManifest();
    return {
      name: manifest.name,
      version: manifest.version,
      manifestVersion: manifest.manifest_version,
      attachedDebuggerTabs: Array.from(attachedTabs),
      websocketUrl: 'ws://localhost:7865',
    };
  }
};
