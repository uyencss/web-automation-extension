// Unit tests for the `batch` orchestration handler (runBatch pure function).
//
// Run with: node tests/unit/batch.test.mjs

import { runBatch } from '../../webmcp-extension/dist/bg/handlers/batch.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.log('FAIL:', msg); } else console.log('PASS:', msg);
}

// ── carry-over tabId (D3) ────────────────────────────────────
{
  const seen = [];
  const handlers = {
    openTab: async () => ({ tabId: 99 }),
    read: async (p) => { seen.push(p.tabId); return { ok: true }; },
  };
  const out = await runBatch({
    actions: [
      { method: 'openTab' },
      { method: 'read', params: {} },
    ],
  }, handlers);
  assert(seen[0] === 99, 'carry-over: action 2 inherits tabId=99 from action 1 result');
  assert(out.success === 2 && out.errors === 0, 'carry-over: both actions succeed');
}

// ── explicit tabId overrides carry-over ──────────────────────
{
  const seen = [];
  const handlers = {
    openTab: async () => ({ tabId: 99 }),
    read: async (p) => { seen.push(p.tabId); return {}; },
  };
  await runBatch({
    actions: [
      { method: 'openTab' },
      { method: 'read', params: { tabId: 7 } },
    ],
  }, handlers);
  assert(seen[0] === 7, 'explicit action tabId overrides carry-over');
}

// ── batch-level tabId default ────────────────────────────────
{
  const seen = [];
  const handlers = { read: async (p) => { seen.push(p.tabId); return {}; } };
  await runBatch({ tabId: 42, actions: [{ method: 'read', params: {} }] }, handlers);
  assert(seen[0] === 42, 'batch-level tabId applied to actions without one');
}

// ── onError: continue vs stop-on-error ───────────────────────
{
  const handlers = { ok: async () => ({}) };
  const cont = await runBatch({
    actions: [{ method: 'ok' }, { method: 'nope' }, { method: 'ok' }],
  }, handlers);
  assert(cont.executed === 3 && cont.errors === 1, 'continue: runs all actions past a failure');

  const stop = await runBatch({
    onError: 'stop-on-error',
    actions: [{ method: 'ok' }, { method: 'nope' }, { method: 'ok' }],
  }, handlers);
  assert(stop.executed === 2 && stop.errors === 1, 'stop-on-error: halts after first failure');
  assert(stop.results.at(-1).method === 'nope', 'stop-on-error: last result is the failing action (partial)');
}

// ── per-action timeout isolates a hung action (D4) ───────────
{
  const handlers = {
    hang: () => new Promise(() => {}), // never resolves
    ok: async () => ({}),
  };
  const out = await runBatch({
    actionTimeoutMs: 50,
    actions: [{ method: 'hang' }, { method: 'ok' }],
  }, handlers);
  assert(out.results[0].ok === false && /timed out/.test(out.results[0].error), 'timeout: hung action fails');
  assert(out.results[1].ok === true, 'timeout: batch continues past a hung action (continue mode)');
}

// ── delay pseudo-action capped at 10s ────────────────────────
{
  const out = await runBatch({ actions: [{ method: 'delay', params: { ms: 999999 } }] }, {});
  assert(out.results[0].ok === true && out.results[0].result.waited === 10000, 'delay capped at 10s (MAX_DELAY_MS)');
}

// ── nested batch rejected (D4) ───────────────────────────────
{
  const out = await runBatch({ actions: [{ method: 'batch', params: { actions: [] } }] }, {});
  assert(out.results[0].ok === false && /nested batch/.test(out.results[0].error), 'nested batch is rejected');
}

// ── screenshotAfter captures per-action ──────────────────────
{
  const handlers = {
    read: async () => ({ text: 'hi' }),
    screenshot: async () => ({ base64: 'AAAA', format: 'png' }),
  };
  const out = await runBatch({
    screenshotAfter: true,
    actions: [{ method: 'read' }],
  }, handlers);
  assert(out.results[0].screenshot?.base64 === 'AAAA', 'screenshotAfter attaches a screenshot to each action');
}

// ── inline screenshot from the action itself ─────────────────
{
  const handlers = { screenshot: async () => ({ tabId: 1, base64: 'BBBB', format: 'png' }) };
  const out = await runBatch({ actions: [{ method: 'screenshot' }] }, handlers);
  assert(out.results[0].screenshot?.base64 === 'BBBB', 'action returning base64 surfaces as a screenshot entry');
}

// ── input validation ─────────────────────────────────────────
{
  let threw = false;
  try { await runBatch({ actions: [] }, {}); } catch { threw = true; }
  assert(threw, 'empty actions array throws');

  threw = false;
  try {
    await runBatch({ actions: Array.from({ length: 51 }, () => ({ method: 'x' })) }, {});
  } catch { threw = true; }
  assert(threw, 'more than 50 actions throws');
}

console.log(failed === 0 ? '\nAll batch tests passed.' : `\n${failed} batch test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
