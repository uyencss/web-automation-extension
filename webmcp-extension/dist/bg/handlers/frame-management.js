import { resolveTabId } from '../utils.js';
import { listFrameContexts } from '../cdp-bridge.js';

export const frameManagementHandlers = {
  async listFrames(params) {
    const tabId = await resolveTabId(params);
    const flat = params.flat === true;
    const result = await listFrameContexts(tabId, { flat: false, force: params.force === true });

    if (flat) {
      return {
        tabId,
        frameCount: result.frameCount,
        flat: true,
        frames: result.flatFrames,
        warnings: result.warnings,
      };
    }

    return {
      tabId,
      frameCount: result.frameCount,
      flat: false,
      frames: result.frames,
      warnings: result.warnings,
    };
  },
};
