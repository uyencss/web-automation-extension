// Unit tests for the WEBMCP_TOOLS exposure preset (minimal | core | full | custom).
//
// Run with: node tests/unit/tool-filter.test.mjs

import {
  buildMcpTools,
  CORE_HIDDEN_METHODS,
  MINIMAL_HIDDEN_METHODS,
} from '../../server/mcp-tool-catalog.mjs';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.log('FAIL:', msg); } else console.log('PASS:', msg);
}

const methods = (env) => buildMcpTools({ toolsEnv: env }).map((t) => t.method || t.name);

const full = methods('full');
const core = methods('core');
const minimal = methods('minimal');
const unset = methods(undefined);
const custom = methods('getAriaSnapshot, clickByRef evaluateJS');

assert(full.length > core.length, 'full exposes more tools than core');
assert(core.length > minimal.length, 'core exposes more tools than minimal');
assert(JSON.stringify(unset) === JSON.stringify(minimal), 'unset WEBMCP_TOOLS defaults to minimal');
assert(full.length - core.length === CORE_HIDDEN_METHODS.size, 'core hides exactly CORE_HIDDEN_METHODS');
assert(full.length - minimal.length === MINIMAL_HIDDEN_METHODS.size, 'minimal hides exactly MINIMAL_HIDDEN_METHODS');

for (const m of CORE_HIDDEN_METHODS) {
  assert(full.includes(m) && !core.includes(m), `core hides ${m} (still in full)`);
  assert(MINIMAL_HIDDEN_METHODS.has(m), `minimal hidden set is a superset of core (${m})`);
}

for (const m of MINIMAL_HIDDEN_METHODS) {
  assert(full.includes(m) && !minimal.includes(m), `minimal hides ${m} (still in full)`);
}

// The minimal surface must still cover the core navigate -> read -> interact loop.
for (const m of ['navigate', 'getPageText', 'getAriaSnapshot', 'clickByRef', 'typeByRef', 'evaluateJS', 'screenshot', 'dispatchClick', 'getElementBounds']) {
  assert(minimal.includes(m), `minimal keeps essential tool ${m}`);
}

assert(minimal.includes('browser_raw_command'), 'minimal keeps browser_raw_command escape hatch');
assert(minimal.includes('webmcp.invokeTool'), 'minimal keeps webmcp.invokeTool (page tools depend on it)');
assert(core.includes('browser_raw_command'), 'core keeps browser_raw_command escape hatch');
assert(core.includes('webmcp.invokeTool'), 'core keeps webmcp.invokeTool (page tools depend on it)');

// Custom allowlist: only the named methods + the always-present escape hatch.
assert(custom.includes('getAriaSnapshot') && custom.includes('clickByRef') && custom.includes('evaluateJS'),
  'custom allowlist exposes the listed methods');
assert(custom.includes('browser_raw_command'), 'custom mode still includes browser_raw_command');
assert(!custom.includes('navigate'), 'custom allowlist excludes unlisted methods');

// Custom allowlist also accepts snake_case tool names.
const customByToolName = methods('webmcp_invoke_tool');
assert(customByToolName.includes('webmcp.invokeTool'), 'custom allowlist accepts snake_case tool names');

if (failed === 0) {
  console.log('\nALL PASS');
  process.exit(0);
} else {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
