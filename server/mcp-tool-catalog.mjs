import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  COMMAND_DEFINITIONS,
  UNSUPPORTED_COMMANDS,
} = require('../catalog/command-catalog.js');

const NUMERIC_PARAMS = new Set([
  'clickCount',
  'deltaX',
  'deltaY',
  'depth',
  'deviceScaleFactor',
  'fromX',
  'fromY',
  'height',
  'ms',
  'steps',
  'tabId',
  'timeout',
  'width',
  'x',
  'y',
]);

const BOOLEAN_PARAMS = new Set([
  'fullPage',
  'interestingOnly',
  'mobile',
]);

const OBJECT_PARAMS = new Set([
  'input',
  'params',
]);

const ARRAY_PARAMS = new Set([
  'computedStyles',
  'modifiers',
]);

const TOOL_DESCRIPTIONS = {
  'webmcp.invokeTool': 'Invoke a page-registered WebMCP tool. Gateway HTTP results are nested; the page tool text is usually under result.result.content[0].text.',
  'webmcp.listTools': 'List page-registered WebMCP tools for the target tab.',
};

function schemaForParam(paramName) {
  if (NUMERIC_PARAMS.has(paramName)) return { type: 'number' };
  if (BOOLEAN_PARAMS.has(paramName)) return { type: 'boolean' };
  if (OBJECT_PARAMS.has(paramName)) return { type: 'object', additionalProperties: true };
  if (ARRAY_PARAMS.has(paramName)) return { type: 'array' };
  return { type: 'string' };
}

function buildInputSchema(requiredParams, optionalParams) {
  const properties = {};
  const seen = new Set();

  for (const paramName of [...requiredParams, ...optionalParams]) {
    properties[paramName] = schemaForParam(paramName);
    seen.add(paramName);
  }

  if (!seen.has('tabId')) {
    properties.tabId = {
      type: 'number',
      description: 'Optional Chrome tab id. Defaults to the active tab when supported by the gateway command.',
    };
  }

  return {
    type: 'object',
    properties,
    required: requiredParams,
    additionalProperties: false,
  };
}

function toolNameForMethod(method) {
  if (method === 'webmcp.listTools') return 'webmcp_list_tools';
  if (method === 'webmcp.invokeTool') return 'webmcp_invoke_tool';
  return method.replaceAll('.', '_');
}

function buildTool(method, definition) {
  const requiredParams = definition.requiredParams || [];
  const optionalParams = definition.optionalParams || [];
  const group = definition.group || 'control';

  return {
    name: toolNameForMethod(method),
    method,
    group,
    description: TOOL_DESCRIPTIONS[method] ||
      `${definition.description || method} gateway command (${group}).`,
    inputSchema: buildInputSchema(requiredParams, optionalParams),
  };
}

export function buildMcpTools() {
  const unsupportedMethods = new Set(Object.keys(UNSUPPORTED_COMMANDS));
  const catalogTools = COMMAND_DEFINITIONS
    .filter(([method, definition]) => definition.group !== 'runner' && !unsupportedMethods.has(method))
    .map(([method, definition]) => buildTool(method, definition));

  catalogTools.push({
    name: 'browser_raw_command',
    method: null,
    group: 'control',
    description: 'Send any raw gateway command. Use this when a command is not exposed as its own MCP tool.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          description: 'Gateway command name, for example "getActiveTab" or "webmcp.invokeTool".',
        },
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'Gateway command params object.',
        },
      },
      required: ['method'],
      additionalProperties: false,
    },
  });

  return catalogTools;
}
