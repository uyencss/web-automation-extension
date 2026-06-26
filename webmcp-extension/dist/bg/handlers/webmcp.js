import { resolveTabId } from '../utils.js';
import { evaluateInTab } from '../cdp-bridge.js';

export const webmcpHandlers = {
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
  }
};
