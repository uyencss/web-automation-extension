// A3 RED #6 — mutating-entry invariant: every mutating entry routes through the
// verifier fence guard; no caller bypass.
// Pins: browser-kit 3d58328, vault-kit e71c764.
// Mode: A3_FENCE_MODE=observe|enforce (default enforce). RED in enforce.
// Baseline RED because: no fence guard exists yet in the entry files. Each
// mutating entry below must route through authorizeFence / PROFILE_FENCE_REQUIRED
// before any browser side effect.
// Seed verified already (R7): evaluateJS, dispatchClick, webmcp.invokeTool,
// waitForStable (broker-fill path). Enumerated from catalog/command-catalog.js,
// server/mcp_server.mjs, server/gateway/* (files with side effects).
// All state is static file reads under the candidate; no browser/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const A3_FENCE_MODE = process.env.A3_FENCE_MODE ?? 'enforce';

// entry, file (relative to package root), mutate/read-only. Guard = file routes
// through the verifier fence guard (authorizeFence or PROFILE_FENCE_REQUIRED).
const INVENTORY = [
  // Seed (R7 broker-fill path)
  { entry: 'evaluateJS', file: '../../catalog/command-catalog.js', mutate: 'mutate' },
  { entry: 'dispatchClick', file: '../../catalog/command-catalog.js', mutate: 'mutate' },
  { entry: 'webmcp.invokeTool', file: '../../catalog/command-catalog.js', mutate: 'mutate' },
  { entry: 'waitForStable', file: '../../catalog/command-catalog.js', mutate: 'mutate' },
  // Catalog mutating surface
  { entry: 'navigate', file: '../../catalog/command-catalog.js', mutate: 'mutate' },
  { entry: 'click', file: '../../catalog/command-catalog.js', mutate: 'mutate' },
  { entry: 'type', file: '../../catalog/command-catalog.js', mutate: 'mutate' },
  { entry: 'executeCDP', file: '../../catalog/command-catalog.js', mutate: 'mutate' },
  { entry: 'typeText', file: '../../catalog/command-catalog.js', mutate: 'mutate' },
  { entry: 'pressKey', file: '../../catalog/command-catalog.js', mutate: 'mutate' },
  // MCP entry: dispatches every tool call to the gateway without a fence guard
  { entry: 'mcp.callTool (dispatch)', file: '../../server/mcp_server.mjs', mutate: 'mutate' },
  // Gateway entries with side effects
  { entry: 'gateway.call (coordinator dispatch)', file: '../../server/gateway/coordinator-dispatcher.mjs', mutate: 'mutate' },
  { entry: 'gateway.call (http server)', file: '../../server/gateway_server.js', mutate: 'mutate' },
  { entry: 'broker.fillLoginFormWithLease', file: '../../../webmcp-vault-kit/lib/broker.js', mutate: 'mutate' },
  // Read-only controls (guard not required; documents the boundary)
  { entry: 'getPageText', file: '../../catalog/command-catalog.js', mutate: 'read-only' },
  { entry: 'getAriaSnapshot', file: '../../catalog/command-catalog.js', mutate: 'read-only' },
  { entry: 'listTabs', file: '../../catalog/command-catalog.js', mutate: 'read-only' },
];

function fileHasFenceGuard(text) {
  return text.includes('authorizeFence') || text.includes('PROFILE_FENCE_REQUIRED');
}

test('A3 inventory: table covers the required seed and bounded sources', () => {
  const names = INVENTORY.map((row) => row.entry);
  for (const seed of ['evaluateJS', 'dispatchClick', 'webmcp.invokeTool', 'waitForStable']) {
    assert.ok(names.includes(seed), `inventory must include seed entry ${seed}`);
  }
  const files = new Set(INVENTORY.map((row) => row.file));
  assert.ok(files.has('../../catalog/command-catalog.js'), 'inventory must enumerate catalog/command-catalog.js');
  assert.ok(files.has('../../server/mcp_server.mjs'), 'inventory must enumerate server/mcp_server.mjs');
  assert.ok([...files].some((f) => f.startsWith('../../server/gateway')), 'inventory must enumerate server/gateway/*');
  assert.ok(files.has('../../../webmcp-vault-kit/lib/broker.js'), 'inventory must enumerate the vault broker fill path');
});

test(`A3 invariant: every mutating entry routes through the verifier fence guard (mode=${A3_FENCE_MODE})`, () => {
  const missing = [];
  for (const row of INVENTORY.filter((r) => r.mutate === 'mutate')) {
    const url = new URL(row.file, import.meta.url);
    let text;
    try {
      text = fs.readFileSync(url, 'utf8');
    } catch (error) {
      missing.push(`${row.entry} (${row.file}): unreadable (${error?.code ?? error})`);
      continue;
    }
    if (!fileHasFenceGuard(text)) missing.push(`${row.entry} (${row.file})`);
  }
  assert.deepEqual(missing, [], `mutating entries must route through the verifier fence guard (authorizeFence / PROFILE_FENCE_REQUIRED) with no caller bypass in ${A3_FENCE_MODE} mode. Missing guard for: ${missing.join('; ')}`);
});
