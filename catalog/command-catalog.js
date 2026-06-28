const COMMAND_GROUPS = [
  { id: 'tabs', label: 'Tab management' },
  { id: 'page', label: 'Page interaction' },
  { id: 'cdp', label: 'Chrome DevTools Protocol' },
  { id: 'webmcp', label: 'Page WebMCP tools' },
  { id: 'vision', label: 'AI observation' },
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

  ['click', { group: 'page', requiredParams: ['selector'] }],
  ['type', { group: 'page', requiredParams: ['selector', 'text'] }],
  ['waitForSelector', { group: 'page', requiredParams: ['selector'], optionalParams: ['timeout'] }],
  ['getPageContent', { group: 'page', description: 'Get page title/url plus text and/or HTML. Supports pagination for large pages.', optionalParams: ['format', 'maxLength', 'offset'] }],
  ['querySelectorAll', { group: 'page', description: 'Extract all elements matching a CSS selector as structured records, with limit/offset pagination. Pierces open Shadow DOM by default (pierceShadow). Use instead of stuffing data into HTML attributes when results exceed a single payload.', requiredParams: ['selector'], optionalParams: ['limit', 'offset', 'fields', 'textMaxLength', 'pierceShadow'] }],
  ['getWindowVariable', { group: 'page', description: 'Read a named window variable by dot-notation path (e.g. ytInitialData, __NEXT_DATA__, __NUXT__). Primary extraction strategy for SSR/hydrated SPAs — data is already rendered client-side and more stable than DOM selectors. Supports maxLength/offset pagination for large objects.', requiredParams: ['path'], optionalParams: ['maxLength', 'offset'] }],
  ['findByText', { group: 'page', description: 'Find elements by visible text content using TreeWalker — no CSS class dependency. Pierces open Shadow DOM by default (pierceShadow). Returns bounds with centerX/Y for direct use with dispatchClick. More stable than class-based selectors on SPAs where class names change per build.', requiredParams: ['text'], optionalParams: ['exact', 'selector', 'maxResults', 'pierceShadow'] }],
  ['pageFetch', { group: 'page', description: 'Run fetch() inside the page (MAIN world) so it inherits the page cookies/origin/session. Returns a structured, size-bounded result (text/json/base64) with offset pagination. Use to call same-origin in-page APIs with the real logged-in session instead of hand-writing evaluateJS + fetch.', requiredParams: ['url'], optionalParams: ['method', 'headers', 'body', 'responseType', 'credentials', 'maxLength', 'offset'] }],
  ['evaluateJS', { group: 'cdp', requiredParams: ['code'] }],

  ['executeCDP', { group: 'cdp', requiredParams: ['method'], optionalParams: ['params'] }],
  ['screenshot', { group: 'cdp', optionalParams: ['fullPage'] }],

  ['webmcp.listTools', { group: 'webmcp' }],
  ['webmcp.invokeTool', { group: 'webmcp', requiredParams: ['toolName'], optionalParams: ['input'] }],

  ['getAccessibilityTree', { group: 'vision', optionalParams: ['depth', 'interestingOnly'] }],
  ['getDOMSnapshot', { group: 'vision', optionalParams: ['computedStyles'] }],
  ['getElementBounds', { group: 'vision', requiredParams: ['selector'], optionalParams: ['pierceShadow'] }],
  ['getInteractiveElements', { group: 'vision', optionalParams: ['pierceShadow'] }],

  ['getAriaSnapshot', { group: 'aria', description: 'Capture an accessibility snapshot of the page with ref IDs. Returns a readable tree with refs like ref=S1 that can be used with clickByRef, typeByRef, etc. More robust than CSS selectors for interacting with dynamic pages.', optionalParams: ['maxDepth'] }],
  ['clickByRef', { group: 'aria', description: 'Click an element using its ARIA snapshot ref (e.g. ref=S1). Run getAriaSnapshot first to get refs. More reliable than CSS selector click on SPAs.', requiredParams: ['ref'], optionalParams: ['element'] }],
  ['typeByRef', { group: 'aria', description: 'Type text into an element using its ARIA snapshot ref. Run getAriaSnapshot first. Supports optional submit (press Enter after typing).', requiredParams: ['ref', 'text'], optionalParams: ['submit'] }],
  ['hoverByRef', { group: 'aria', description: 'Hover over an element using its ARIA snapshot ref.', requiredParams: ['ref'] }],
  ['selectByRef', { group: 'aria', description: 'Select option(s) in a dropdown using its ARIA snapshot ref.', requiredParams: ['ref', 'values'] }],

  ['waitForStable', { group: 'control', description: 'Wait for the page to stabilize (no DOM mutations for a quiet period). Useful after navigation or clicking dynamic elements. Use watchSelector to scope to a subtree, ignoreSelectors to exclude noisy elements (e.g. video player), and ignoreCharacterData to suppress text-node tick mutations on video/live pages.', optionalParams: ['minStableMs', 'maxWaitMs', 'maxMutations', 'watchSelector', 'ignoreSelectors', 'ignoreCharacterData'] }],

  ['dispatchClick', { group: 'input', requiredParams: ['x', 'y'], optionalParams: ['button', 'clickCount'] }],
  ['moveMouse', { group: 'input', requiredParams: ['x', 'y'], optionalParams: ['fromX', 'fromY', 'steps'] }],
  ['pressKey', { group: 'input', requiredParams: ['key'], optionalParams: ['text', 'modifiers'] }],
  ['typeText', { group: 'input', requiredParams: ['text'] }],
  ['scroll', { group: 'input', optionalParams: ['x', 'y', 'deltaX', 'deltaY'] }],
  ['hover', { group: 'input', requiredParams: ['selector'] }],

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

  ['wait', { group: 'runner', optionalParams: ['ms', 'timeout'] }],
  ['delay', { group: 'runner', optionalParams: ['ms', 'timeout'] }],
];

const UNSUPPORTED_COMMANDS = {
  selectOption: 'ws-client.js advertises selectOption, but commandHandlers does not register a selectOption handler.',
};

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
