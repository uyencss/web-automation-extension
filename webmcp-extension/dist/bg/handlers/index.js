import { tabHandlers } from './tab-management.js';
import { cdpActionHandlers } from './cdp-actions.js';
import { highLevelHandlers } from './high-level.js';
import { webmcpHandlers } from './webmcp.js';
import { aiVisionHandlers } from './ai-vision.js';
import { cdpInputHandlers } from './cdp-input.js';
import { fullControlHandlers } from './full-control.js';
import { ariaSnapshotHandlers } from './aria-snapshot.js';
import { pageStabilityHandlers } from './page-stability.js';
import { frameManagementHandlers } from './frame-management.js';

export const commandHandlers = {
  ...tabHandlers,
  ...frameManagementHandlers,
  ...cdpActionHandlers,
  ...highLevelHandlers,
  ...webmcpHandlers,
  ...aiVisionHandlers,
  ...cdpInputHandlers,
  ...fullControlHandlers,
  ...ariaSnapshotHandlers,
  ...pageStabilityHandlers,
};
