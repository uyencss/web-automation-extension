import { tabHandlers } from './tab-management.js';
import { cdpActionHandlers } from './cdp-actions.js';
import { highLevelHandlers } from './high-level.js';
import { webmcpHandlers } from './webmcp.js';
import { aiVisionHandlers } from './ai-vision.js';
import { cdpInputHandlers } from './cdp-input.js';
import { fullControlHandlers } from './full-control.js';

export const commandHandlers = {
  ...tabHandlers,
  ...cdpActionHandlers,
  ...highLevelHandlers,
  ...webmcpHandlers,
  ...aiVisionHandlers,
  ...cdpInputHandlers,
  ...fullControlHandlers
};
