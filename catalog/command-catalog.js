const COMMAND_GROUPS = [
  { id: 'tabs', label: 'Tab management' },
  { id: 'page', label: 'Page interaction' },
  { id: 'cdp', label: 'Chrome DevTools Protocol' },
  { id: 'webmcp', label: 'Page WebMCP tools' },
  { id: 'vision', label: 'AI observation' },
  { id: 'observability', label: 'Runtime observability' },
  { id: 'aria', label: 'ARIA snapshot interaction' },
  { id: 'input', label: 'CDP input' },
  { id: 'control', label: 'Full browser control' },
  { id: 'runner', label: 'Runner pseudo commands' },
];

const COMMAND_DEFINITIONS = [
  ['listTabs', { group: 'tabs' }],
  ['navigate', { group: 'tabs', requiredParams: ['url'] }],
  ['newTab', { group: 'tabs', optionalParams: ['url'] }],
  ['closeTab', { group: 'tabs', optionalParams: ['tabId'] }],
  ['getActiveTab', { group: 'tabs' }],
  ['listFrames', { group: 'page', description: 'List the frame tree for a tab, returning CDP frame IDs, Chrome frame IDs when available, URLs, names, and parent relationships. Use this before targeting iframe commands.', optionalParams: ['flat', 'force'] }],

  ['click', { group: 'page', requiredParams: ['selector'], optionalParams: ['frame'] }],
  ['type', { group: 'page', requiredParams: ['selector', 'text'], optionalParams: ['frame'] }],
  ['waitForSelector', { group: 'page', requiredParams: ['selector'], optionalParams: ['timeout', 'frame'] }],
  ['getPageContent', { group: 'page', description: 'Get page title/url plus text and/or HTML. Supports pagination for large pages and optional iframe targeting via frame.', optionalParams: ['format', 'maxLength', 'offset', 'frame'] }],
  ['querySelectorAll', { group: 'page', description: 'Extract all elements matching a CSS selector as structured records, with limit/offset pagination. Pierces open Shadow DOM by default (pierceShadow). Supports optional iframe targeting via frame.', requiredParams: ['selector'], optionalParams: ['limit', 'offset', 'fields', 'textMaxLength', 'pierceShadow', 'frame'] }],
  ['getWindowVariable', { group: 'page', description: 'Read a named window variable by dot-notation path (e.g. ytInitialData, __NEXT_DATA__, __NUXT__). Supports pagination and optional iframe targeting via frame.', requiredParams: ['path'], optionalParams: ['maxLength', 'offset', 'frame'] }],
  ['findByText', { group: 'page', description: 'Find elements by visible text content using TreeWalker — no CSS class dependency. Pierces open Shadow DOM by default (pierceShadow). Supports optional iframe targeting via frame.', requiredParams: ['text'], optionalParams: ['exact', 'selector', 'maxResults', 'pierceShadow', 'frame'] }],
  ['pageFetch', { group: 'page', description: 'Run fetch() inside the page or target iframe so it inherits the cookies/origin/session for that frame. Returns a structured, size-bounded result.', requiredParams: ['url'], optionalParams: ['method', 'headers', 'body', 'responseType', 'credentials', 'maxLength', 'offset', 'frame'] }],
  ['evaluateJS', { group: 'cdp', requiredParams: ['code'], optionalParams: ['frame'] }],

  ['executeCDP', { group: 'cdp', requiredParams: ['method'], optionalParams: ['params'] }],
  ['screenshot', { group: 'cdp', optionalParams: ['fullPage'] }],

  ['webmcp.listTools', { group: 'webmcp', optionalParams: ['frame'] }],
  ['webmcp.invokeTool', { group: 'webmcp', requiredParams: ['toolName'], optionalParams: ['input', 'frame'] }],

  ['getAccessibilityTree', { group: 'vision', optionalParams: ['depth', 'interestingOnly'] }],
  ['getDOMSnapshot', { group: 'vision', optionalParams: ['computedStyles'] }],
  ['getElementBounds', { group: 'vision', requiredParams: ['selector'], optionalParams: ['pierceShadow', 'frame'] }],
  ['getInteractiveElements', { group: 'vision', optionalParams: ['pierceShadow', 'frame'] }],

  ['getAriaSnapshot', { group: 'aria', description: 'Capture an accessibility snapshot with ref IDs. Defaults to a fast content-script, viewport-first snapshot with compact persistent refs like ref=r1 or ref=f3r1; use mode="native" for the CDP Accessibility fallback with refs like ref=S1.', optionalParams: ['maxDepth', 'mode', 'scope', 'maxNodes', 'maxChars', 'includeOptions', 'maxOptions', 'refFormat', 'viewportMargin', 'frameId'] }],
  ['clickByRef', { group: 'aria', description: 'Click an element using an ARIA snapshot ref (e.g. ref=r1, ref=f3r1, legacy ref=F0:R1, or native ref=S1). Run getAriaSnapshot first to get refs.', requiredParams: ['ref'], optionalParams: ['element', 'frameId'] }],
  ['typeByRef', { group: 'aria', description: 'Type text into an element using an ARIA snapshot ref. Run getAriaSnapshot first. Supports optional submit (press Enter after typing).', requiredParams: ['ref', 'text'], optionalParams: ['submit', 'frameId'] }],
  ['hoverByRef', { group: 'aria', description: 'Hover over an element using its ARIA snapshot ref.', requiredParams: ['ref'], optionalParams: ['frameId'] }],
  ['selectByRef', { group: 'aria', description: 'Select option(s) in a dropdown using its ARIA snapshot ref.', requiredParams: ['ref', 'values'], optionalParams: ['frameId'] }],

  ['waitForStable', { group: 'control', description: 'Wait for the page to stabilize (no DOM mutations for a quiet period). Useful after navigation or clicking dynamic elements. Use watchSelector to scope to a subtree, ignoreSelectors to exclude noisy elements (e.g. video player), and ignoreCharacterData to suppress text-node tick mutations on video/live pages.', optionalParams: ['minStableMs', 'maxWaitMs', 'maxMutations', 'watchSelector', 'ignoreSelectors', 'ignoreCharacterData'] }],

  ['startConsoleCapture', { group: 'observability', description: 'Start capturing Runtime console API calls and uncaught exceptions for a tab. Uses CDP Runtime events and a bounded per-tab buffer.', optionalParams: ['tabId'] }],
  ['stopConsoleCapture', { group: 'observability', description: 'Stop console capture for a tab and clear its buffered messages.', optionalParams: ['tabId'] }],
  ['readConsoleMessages', { group: 'observability', description: 'Read captured console messages with optional level, substring pattern, timestamp, limit, and consume-on-read filtering.', optionalParams: ['level', 'pattern', 'limit', 'since', 'clear', 'tabId'] }],
  ['clearConsoleMessages', { group: 'observability', description: 'Clear the captured console message buffer while keeping capture active.', optionalParams: ['tabId'] }],

  ['dispatchClick', { group: 'input', requiredParams: ['x', 'y'], optionalParams: ['button', 'clickCount', 'frame'] }],
  ['moveMouse', { group: 'input', requiredParams: ['x', 'y'], optionalParams: ['fromX', 'fromY', 'steps', 'frame'] }],
  ['pressKey', { group: 'input', requiredParams: ['key'], optionalParams: ['text', 'modifiers'] }],
  ['typeText', { group: 'input', requiredParams: ['text'] }],
  ['scroll', { group: 'input', optionalParams: ['x', 'y', 'deltaX', 'deltaY'] }],
  ['hover', { group: 'input', requiredParams: ['selector'], optionalParams: ['frame'] }],
  ['selectOption', { group: 'input', requiredParams: ['selector'], optionalParams: ['value', 'index', 'text', 'frame'] }],

  ['getCookies', { group: 'control' }],
  ['setCookie', { group: 'control', requiredParams: ['name', 'value'], optionalParams: ['domain', 'path'] }],
  ['deleteCookies', { group: 'control', requiredParams: ['name'], optionalParams: ['domain', 'url'] }],
  ['getLocalStorage', { group: 'control' }],
  ['setLocalStorage', { group: 'control', requiredParams: ['key'], optionalParams: ['value'] }],
  ['listWindows', { group: 'control' }],
  ['createWindow', { group: 'control', optionalParams: ['url', 'width', 'height', 'type'] }],
  ['setViewport', { group: 'control', requiredParams: ['width', 'height'], optionalParams: ['deviceScaleFactor', 'mobile'] }],
  ['resetViewport', { group: 'control' }],
  ['ping', { group: 'control' }],
  ['getExtensionInfo', { group: 'control', description: 'Return extension manifest version, attached debugger tabs, and gateway WebSocket URL.' }],

  ['wait', { group: 'runner', optionalParams: ['ms', 'timeout'] }],
  ['delay', { group: 'runner', optionalParams: ['ms', 'timeout'] }],
];

const UNSUPPORTED_COMMANDS = {};

const COMMANDS = new Map(
  COMMAND_DEFINITIONS.map(([name, definition]) => [
    name,
    {
      name,
      group: definition.group,
      requiredParams: definition.requiredParams || [],
      optionalParams: definition.optionalParams || [],
      description: definition.description || '',
    },
  ]),
);

function getCommand(name) {
  return COMMANDS.get(name);
}

function hasCommand(name) {
  return COMMANDS.has(name);
}

function isUnsupportedCommand(name) {
  return Object.prototype.hasOwnProperty.call(UNSUPPORTED_COMMANDS, name);
}

function getUnsupportedReason(name) {
  return UNSUPPORTED_COMMANDS[name];
}

function listCommands() {
  return Array.from(COMMANDS.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function getCommandGroups() {
  return COMMAND_GROUPS.map((group) => ({
    ...group,
    commands: listCommands().filter((command) => command.group === group.id),
  })).filter((group) => group.commands.length > 0);
}

function hasParam(params, key) {
  return (
    params &&
    Object.prototype.hasOwnProperty.call(params, key) &&
    params[key] !== undefined &&
    params[key] !== null &&
    params[key] !== ''
  );
}

function validateCommandParams(commandName, params = {}) {
  const command = getCommand(commandName);
  if (!command) return [];

  const errors = [];
  for (const paramName of command.requiredParams) {
    if (!hasParam(params, paramName)) {
      errors.push(`Command "${commandName}" is missing required param "${paramName}"`);
    }
  }
  return errors;
}

module.exports = {
  COMMAND_DEFINITIONS,
  COMMAND_GROUPS,
  UNSUPPORTED_COMMANDS,
  getCommand,
  hasCommand,
  isUnsupportedCommand,
  getUnsupportedReason,
  listCommands,
  getCommandGroups,
  validateCommandParams,
};
