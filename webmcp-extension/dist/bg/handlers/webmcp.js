import { resolveTabId } from '../utils.js';
import {
  evaluateInFrameMainWorld,
  evaluateInTab,
  formatFrameTarget,
  resolveFrameTarget,
} from '../cdp-bridge.js';

async function getEvaluator(tabId, frameSpec) {
  if (!frameSpec) {
    return { evaluate: (expr) => evaluateInTab(tabId, expr), frameTarget: null };
  }
  const frameTarget = await resolveFrameTarget(tabId, frameSpec);
  return {
    evaluate: (expr) => evaluateInFrameMainWorld(tabId, frameTarget, expr),
    frameTarget,
  };
}

export const webmcpHandlers = {
  async 'webmcp.listTools'(params) {
    const tabId = await resolveTabId(params);
    const { evaluate, frameTarget } = await getEvaluator(tabId, params.frame);
    const tools = await evaluate(`
      (() => {
        if (!navigator.modelContext) return { error: 'navigator.modelContext not found' };
        return navigator.modelContext.tools;
      })()
    `);
    return {
      tabId,
      ...(frameTarget ? { frame: formatFrameTarget(frameTarget) } : {}),
      tools,
    };
  },

  async 'webmcp.invokeTool'(params) {
    const { toolName, input = {} } = params;
    if (!toolName) throw new Error('Missing required param: toolName');
    const tabId = await resolveTabId(params);
    const { evaluate, frameTarget } = await getEvaluator(tabId, params.frame);

    const result = await evaluate(`
      (async () => {
        if (!navigator.modelContext) throw new Error('navigator.modelContext not found');
        return await navigator.modelContext.invokeTool(
          ${JSON.stringify(toolName)},
          ${JSON.stringify(input)}
        );
      })()
    `);
    return {
      tabId,
      ...(frameTarget ? { frame: formatFrameTarget(frameTarget) } : {}),
      result,
    };
  }
};
