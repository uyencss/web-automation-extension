// bg/handlers/batch.js
// Pure orchestration helper: runs a sequence of gateway commands in-process.
// Injected with the resolved `commandHandlers` map by router.js (no circular import).

const MAX_ACTIONS = 50;
const MAX_DELAY_MS = 10_000;
const DEFAULT_ACTION_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`batch action timed out after ${ms}ms: ${label}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {Object} params
 * @param {Array<{method:string, params?:object}>} params.actions
 * @param {'continue'|'stop-on-error'} [params.onError='continue']
 * @param {boolean} [params.screenshotAfter=false]  capture a screenshot after EACH action
 * @param {number}  [params.tabId]                  default tab for every action
 * @param {number}  [params.actionTimeoutMs=60000]  per-action timeout
 * @param {Object}  handlers  the resolved commandHandlers map (injected)
 * @returns {{total,executed,success,errors,results:Array}}
 */
export async function runBatch(params, handlers) {
  const {
    actions,
    onError = 'continue',
    screenshotAfter = false,
    tabId: batchTabId,
    actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
  } = params || {};

  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('batch: "actions" must be a non-empty array');
  }
  if (actions.length > MAX_ACTIONS) {
    throw new Error(`batch: too many actions (${actions.length} > ${MAX_ACTIONS})`);
  }

  const results = [];
  let success = 0;
  let errors = 0;
  let carryTabId = batchTabId; // last known tab, threaded across actions (D3)

  const fail = (i, method, error) => {
    results.push({ index: i, method, ok: false, error, duration: 0 });
    errors++;
  };

  for (let i = 0; i < actions.length; i++) {
    const { method, params: p = {} } = actions[i] || {};

    // Guard: no nested batch (D4)
    if (method === 'batch') {
      fail(i, method, 'nested batch is not allowed');
      if (onError === 'stop-on-error') break;
      continue;
    }

    // delay / wait pseudo-actions — extension has no such handler; mirror the
    // runner's `wait`/`delay` (command-catalog.js group "runner").
    if (method === 'delay' || method === 'wait') {
      const ms = Math.min(Number(p.ms ?? p.timeout ?? 500) || 0, MAX_DELAY_MS);
      await new Promise((r) => setTimeout(r, ms));
      results.push({ index: i, method, ok: true, result: { waited: ms }, duration: ms });
      success++;
      continue;
    }

    const handler = handlers[method];
    if (typeof handler !== 'function') {
      fail(i, method, `unknown method: "${method}"`);
      if (onError === 'stop-on-error') break;
      continue;
    }

    // Thread tabId: inject carried tab when the action didn't name one (D3).
    const actionParams =
      carryTabId != null && p.tabId === undefined ? { ...p, tabId: carryTabId } : p;

    const t0 = Date.now();
    try {
      const result = await withTimeout(
        Promise.resolve(handler(actionParams)),
        actionTimeoutMs,
        method,
      );
      const entry = { index: i, method, ok: true, result, duration: Date.now() - t0 };

      // Carry forward whatever tab this action resolved/created.
      if (result && typeof result.tabId === 'number') carryTabId = result.tabId;

      // Inline screenshot: from the action itself, or captured on request.
      if (result && typeof result.base64 === 'string') {
        entry.screenshot = { base64: result.base64, format: result.format || 'png' };
      } else if (screenshotAfter && typeof handlers.screenshot === 'function') {
        try {
          const snap = await handlers.screenshot(carryTabId != null ? { tabId: carryTabId } : {});
          entry.screenshot = { base64: snap.base64, format: snap.format || 'png' };
        } catch {
          /* best-effort — a failed screenshot must not fail the action */
        }
      }

      results.push(entry);
      success++;
    } catch (err) {
      results.push({
        index: i,
        method,
        ok: false,
        error: err?.message || String(err),
        duration: Date.now() - t0,
      });
      errors++;
      if (onError === 'stop-on-error') break;
    }
  }

  return { total: actions.length, executed: results.length, success, errors, results };
}
