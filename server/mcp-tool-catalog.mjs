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
  'maxDepth',
  'maxMutations',
  'maxWaitMs',
  'minStableMs',
  'ms',
  'limit',
  'since',
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
  'clear',
  'submit',
]);

const OBJECT_PARAMS = new Set([
  'input',
  'params',
]);

const ARRAY_PARAMS = new Set([
  'computedStyles',
  'modifiers',
  'values',
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

  if (!seen.has('profileId')) {
    properties.profileId = {
      type: 'string',
      description: 'Optional Chrome profile ID to route this command to when multiple profiles are connected.',
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

// Methods hidden from the default ("core") MCP surface. They stay fully
// reachable through browser_raw_command, so trimming them is lossless — it only
// shrinks the first-class tool list to cut per-request token cost and reduce
// tool-selection ambiguity between overlapping tools.
//
//   Group A — a strictly better / more specific tool already exists:
//     getPageContent       -> getPageText (text); raw_command for raw HTML
//     getAccessibilityTree -> getAriaSnapshot (faster, ref-based)
//     getDOMSnapshot, getInteractiveElements -> niche, token-heavy whole-page
//       dumps. getElementBounds stays exposed (cheap, targeted) so the
//       coordinate-click fallback getElementBounds -> dispatchClick is complete
//       even on the minimal surface.
//   Group B — CSS-selector variants of the preferred *ByRef actions:
//     click -> clickByRef, type -> typeByRef, hover -> hoverByRef,
//     selectOption -> selectByRef
export const CORE_HIDDEN_METHODS = new Set([
  // Group A
  'getPageContent',
  'getAccessibilityTree',
  'getDOMSnapshot',
  'getInteractiveElements',
  // Group B
  'click',
  'type',
  'hover',
  'selectOption',
]);

// Methods hidden from the default ("minimal") MCP surface. A strict superset of
// CORE_HIDDEN_METHODS: minimal keeps only the ~25 tools that cover the common
// navigate -> read -> ARIA-interact loop (plus getElementBounds for the
// coordinate-click fallback), and pushes lower-frequency commands
// (cookies/storage, windows/viewport, low-level input, console capture, frame
// tree, diagnostics, raw CDP, page-side fetch) out of the first-class list.
// Everything here stays fully callable through browser_raw_command, so trimming
// is lossless — it only cuts per-request token cost and tool-selection ambiguity.
export const MINIMAL_HIDDEN_METHODS = new Set([
  ...CORE_HIDDEN_METHODS,
  // Iframe / power-user / page-side fetch
  'listFrames',
  'pageFetch',
  'executeCDP',
  // Low-level input (covered by dispatchClick / *ByRef in minimal)
  'moveMouse',
  'typeText',
  // Console capture (reach via raw_command when debugging)
  'startConsoleCapture',
  'stopConsoleCapture',
  'readConsoleMessages',
  'clearConsoleMessages',
  // Cookies / storage
  'getCookies',
  'setCookie',
  'deleteCookies',
  'getLocalStorage',
  'setLocalStorage',
  // Windows / viewport
  'listWindows',
  'createWindow',
  'setViewport',
  'resetViewport',
  // Diagnostics
  'ping',
  'getExtensionInfo',
]);

// Resolve which gateway methods are exposed as first-class MCP tools based on
// the WEBMCP_TOOLS env var:
//   unset | 'minimal' -> full minus MINIMAL_HIDDEN_METHODS (default, leanest)
//   'core'            -> full minus CORE_HIDDEN_METHODS (broader lean set)
//   'full'            -> every supported command
//   'a,b,c'           -> explicit allowlist of gateway methods or snake_case
//                        tool names (space/comma separated)
// browser_raw_command is always added afterwards as the escape hatch.
export function resolveToolFilter(rawValue) {
  const value = (rawValue || '').trim();
  const mode = value.toLowerCase();
  if (mode === 'full') return () => true;
  if (mode === 'core') return (method) => !CORE_HIDDEN_METHODS.has(method);
  if (value === '' || mode === 'minimal') {
    return (method) => !MINIMAL_HIDDEN_METHODS.has(method);
  }
  const allow = new Set(value.split(/[,\s]+/).filter(Boolean));
  return (method) => allow.has(method) || allow.has(toolNameForMethod(method));
}

function buildTool(method, definition) {
  const requiredParams = definition.requiredParams || [];
  const optionalParams = definition.optionalParams || [];
  const group = definition.group || 'control';

  // batch has a nested action schema that the generic builder can't express.
  if (method === 'batch') {
    return {
      name: 'batch',
      method: 'batch',
      group,
      description: definition.description,
      inputSchema: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            description: 'Ordered commands to run sequentially.',
            items: {
              type: 'object',
              properties: {
                method: {
                  type: 'string',
                  description:
                    'Gateway command name (navigate, clickByRef, typeByRef, ' +
                    'getPageText, screenshot, waitForStable, delay, ...).',
                },
                params: { type: 'object', additionalProperties: true },
              },
              required: ['method'],
              additionalProperties: false,
            },
          },
          onError: { type: 'string', enum: ['continue', 'stop-on-error'] },
          screenshotAfter: { type: 'boolean' },
          tabId: { type: 'number', description: 'Default tab for every action.' },
          actionTimeoutMs: { type: 'number' },
          profileId: {
            type: 'string',
            description: 'Route to this Chrome profile when several are connected.',
          },
        },
        required: ['actions'],
        additionalProperties: false,
      },
    };
  }

  return {
    name: toolNameForMethod(method),
    method,
    group,
    description: TOOL_DESCRIPTIONS[method] ||
      `${definition.description || method} gateway command (${group}).`,
    inputSchema: buildInputSchema(requiredParams, optionalParams),
  };
}

export function buildMcpTools({ toolsEnv = process.env.WEBMCP_TOOLS } = {}) {
  const unsupportedMethods = new Set(Object.keys(UNSUPPORTED_COMMANDS));
  const allow = resolveToolFilter(toolsEnv);
  const catalogTools = COMMAND_DEFINITIONS
    .filter(([method, definition]) =>
      definition.group !== 'runner' &&
      !unsupportedMethods.has(method) &&
      (method === 'browser_raw_command' || allow(method)))
    .map(([method, definition]) => buildTool(method, definition));

  return catalogTools;
}
