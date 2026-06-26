const COMMAND_GROUPS = [
  { id: 'tabs', label: 'Tab management' },
  { id: 'page', label: 'Page interaction' },
  { id: 'cdp', label: 'Chrome DevTools Protocol' },
  { id: 'webmcp', label: 'Page WebMCP tools' },
  { id: 'vision', label: 'AI observation' },
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
  ['getPageContent', { group: 'page' }],
  ['evaluateJS', { group: 'cdp', requiredParams: ['code'] }],

  ['executeCDP', { group: 'cdp', requiredParams: ['method'], optionalParams: ['params'] }],
  ['screenshot', { group: 'cdp', optionalParams: ['fullPage'] }],

  ['webmcp.listTools', { group: 'webmcp' }],
  ['webmcp.invokeTool', { group: 'webmcp', requiredParams: ['toolName'], optionalParams: ['input'] }],

  ['getAccessibilityTree', { group: 'vision', optionalParams: ['depth', 'interestingOnly'] }],
  ['getDOMSnapshot', { group: 'vision', optionalParams: ['computedStyles'] }],
  ['getElementBounds', { group: 'vision', requiredParams: ['selector'] }],
  ['getInteractiveElements', { group: 'vision' }],

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
