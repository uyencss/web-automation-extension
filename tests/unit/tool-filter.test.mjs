// Unit tests for the WEBMCP_TOOLS exposure preset (full | core | custom).
//
// Run with: node tests/unit/tool-filter.test.mjs

import { buildMcpTools, CORE_HIDDEN_METHODS } from '../../server/mcp-tool-catalog.mjs';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.log('FAIL:', msg); } else console.log('PASS:', msg);
}

const methods = (env) => buildMcpTools({ toolsEnv: env }).map((t) => t.method || t.name);

const full = methods('full');
const core = methods('core');
const unset = methods(undefined);
const custom = methods('getAriaSnapshot, clickByRef evaluateJS');

assert(full.length > core.length, 'full exposes more tools than core');
assert(JSON.stringify(unset) === JSON.stringify(core), 'unset WEBMCP_TOOLS defaults to core');
assert(full.length - core.length === CORE_HIDDEN_METHODS.size, 'core hides exactly CORE_HIDDEN_METHODS');

for (const m of CORE_HIDDEN_METHODS) {
  assert(full.includes(m) && !core.includes(m), `core hides ${m} (still in full)`);
}

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
