import { resolveTabId } from '../utils.js';
import {
  evaluateInFrameMainWorld,
  evaluateInTab,
  formatFrameTarget,
  resolveFrameTarget,
  sendCDPCommand,
} from '../cdp-bridge.js';

export const cdpActionHandlers = {
  async evaluateJS(params) {
    const { code } = params;
    if (!code) throw new Error('Missing required param: code');
    const tabId = await resolveTabId(params);
    const frameTarget = params.frame ? await resolveFrameTarget(tabId, params.frame) : null;

    // Wrap in an async IIFE so users can use `return` and `await`
    const wrapped = `(async () => { ${code} })()`;
    const result = frameTarget
      ? await evaluateInFrameMainWorld(tabId, frameTarget, wrapped)
      : await evaluateInTab(tabId, wrapped);
    return {
      tabId,
      ...(frameTarget ? { frame: formatFrameTarget(frameTarget) } : {}),
      result,
    };
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
  }
};
