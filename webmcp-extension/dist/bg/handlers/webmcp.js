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
      (async () => {
        const ctx = document.modelContext || navigator.modelContext;
        if (!ctx) return { error: 'navigator.modelContext not found' };
        if (Array.isArray(ctx.tools)) return ctx.tools;
        if (typeof ctx.getTools === 'function') return await ctx.getTools();
        return [];
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
        const ctx = document.modelContext || navigator.modelContext;
        if (!ctx) throw new Error('navigator.modelContext not found');
        const fn = typeof ctx.invokeTool === 'function' ? ctx.invokeTool : ctx.executeTool;
        if (typeof fn !== 'function') throw new Error('modelContext.invokeTool not found');
        return await fn.call(
          ctx,
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
