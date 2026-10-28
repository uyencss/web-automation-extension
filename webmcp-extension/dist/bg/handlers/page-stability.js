// ============================================================
// WebMCP — Page Stability Detection (Self-contained Promise IIFE)
//
// Inspired by Browser-MCP's page stability waiting mechanism.
// Ensures the page has settled (DOM stable, no pending navigations)
// before proceeding with the next action without polluting window globals.
// ============================================================

import { resolveTabId } from '../utils.js';
import { evaluateInTab } from '../cdp-bridge.js';

const DEFAULT_MIN_STABLE_MS = 800;
const DEFAULT_MAX_WAIT_MS = 5000;
const DEFAULT_MAX_MUTATIONS = 2;
const POLL_INTERVAL_MS = 150;

/**
 * Wait for the page to stabilize.
 *
 * "Stable" means: no significant DOM mutations for `minStableMs`,
 * and the page is not in a loading state.
 *
 * @param {number} tabId
 * @param {object} [options]
 * @param {number}   [options.minStableMs=800]        — minimum quiet period
 * @param {number}   [options.maxWaitMs=5000]         — maximum time to wait
 * @param {number}   [options.maxMutations=2]         — mutation threshold per poll
 * @param {string}   [options.watchSelector=null]     — only observe this subtree (CSS selector)
 * @param {string[]} [options.ignoreSelectors=[]]     — exclude these subtrees from mutation count
 * @param {boolean}  [options.ignoreCharacterData=false] — ignore text-node mutations
 */
export async function waitForPageStable(tabId, options = {}) {
  const {
    minStableMs = DEFAULT_MIN_STABLE_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    maxMutations = DEFAULT_MAX_MUTATIONS,
    watchSelector = null,
    ignoreSelectors = [],
    ignoreCharacterData = false,
  } = options;

  const startTime = Date.now();
  const rawMaxWait = Number(maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const effectiveMaxWaitMs = Math.max(50, Math.min(Number.isFinite(rawMaxWait) && rawMaxWait > 0 ? rawMaxWait : DEFAULT_MAX_WAIT_MS, 25000));
  const rawMinStable = Number(minStableMs ?? DEFAULT_MIN_STABLE_MS);
  const effectiveMinStableMs = Math.max(0, Math.min(Number.isFinite(rawMinStable) ? rawMinStable : DEFAULT_MIN_STABLE_MS, effectiveMaxWaitMs));

  const runStabilityCheck = async (timeLimitMs) => {
    const expr = `
      (() => {
        return new Promise((resolve) => {
          let mutationCount = 0;
          let stableSince = Date.now();
          const startedAt = Date.now();

          const watchSelector = ${JSON.stringify(watchSelector)};
          const root = watchSelector
            ? (document.querySelector(watchSelector) || document.documentElement)
            : document.documentElement;

          if (!root) {
            resolve({ stable: true, waited: 0, reason: 'no-root' });
            return;
          }

          const ignoreSelectors = ${JSON.stringify(ignoreSelectors)};
          const ignoredRoots = ignoreSelectors && ignoreSelectors.length
            ? Array.from(document.querySelectorAll(ignoreSelectors.join(',')))
            : [];
          const ignoreCharacterData = ${JSON.stringify(ignoreCharacterData)};

          function isIgnored(node) {
            if (!ignoredRoots.length) return false;
            return ignoredRoots.some((r) => r.contains(node));
          }

          let observer = null;
          let pollTimer = null;
          let timeoutTimer = null;

          function finish(result) {
            if (observer) {
              observer.disconnect();
              observer = null;
            }
            if (pollTimer) {
              clearInterval(pollTimer);
              pollTimer = null;
            }
            if (timeoutTimer) {
              clearTimeout(timeoutTimer);
              timeoutTimer = null;
            }
            resolve(result);
          }

          try {
            observer = new MutationObserver((mutations) => {
              const meaningful = mutations.filter((m) => {
                if (m.type === 'characterData') return !ignoreCharacterData;
                if (m.type === 'childList') {
                  if (isIgnored(m.target)) return false;
                  return true;
                }
                if (m.type === 'attributes') {
                  if (isIgnored(m.target)) return false;
                  const tag = m.target.tagName?.toLowerCase();
                  return tag !== 'script' && tag !== 'style' && tag !== 'link';
                }
                return false;
              });
              if (meaningful.length > 0) {
                mutationCount += meaningful.length;
              }
            });

            observer.observe(root, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: !ignoreCharacterData,
              attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled', 'value', 'src', 'href'],
            });
          } catch (e) {
            finish({ stable: true, waited: Date.now() - startedAt, reason: 'observer-failed' });
            return;
          }

          pollTimer = setInterval(() => {
            const now = Date.now();
            const isLoading = document.readyState === 'loading';
            const isStable = mutationCount <= ${Number(maxMutations)} && !isLoading;
            mutationCount = 0;

            if (isStable) {
              if (now - stableSince >= ${Number(effectiveMinStableMs)}) {
                finish({ stable: true, waited: now - startedAt });
              }
            } else {
              stableSince = now;
            }
          }, ${POLL_INTERVAL_MS});

          timeoutTimer = setTimeout(() => {
            finish({ stable: false, waited: Date.now() - startedAt, reason: 'timeout' });
          }, ${Number(timeLimitMs)});
        });
      })()
    `;

    let swTimer = null;
    try {
      return await Promise.race([
        evaluateInTab(tabId, expr, true),
        new Promise((resolve) => {
          swTimer = setTimeout(() => {
            resolve({ stable: false, waited: Date.now() - startTime, reason: 'timeout' });
          }, Number(timeLimitMs) + 250);
          if (typeof swTimer?.unref === 'function') swTimer.unref();
        }),
      ]);
    } finally {
      if (swTimer) clearTimeout(swTimer);
    }
  };

  try {
    const res = await runStabilityCheck(effectiveMaxWaitMs);
    if (res && typeof res.stable === 'boolean') {
      return res;
    }
    return { stable: true, waited: Date.now() - startTime, reason: 'fallback' };
  } catch (err) {
    const isNavigation = /Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(
      String(err?.message || err)
    );
    if (isNavigation) {
      await new Promise((r) => setTimeout(r, 150));
      const remainingMs = Math.max(200, effectiveMaxWaitMs - (Date.now() - startTime));
      try {
        const retryRes = await runStabilityCheck(remainingMs);
        if (retryRes && typeof retryRes.stable === 'boolean') {
          return retryRes;
        }
        return { stable: true, waited: Date.now() - startTime, reason: 'fallback' };
      } catch {
        return { stable: true, waited: Date.now() - startTime, reason: 'error' };
      }
    }
    return { stable: true, waited: Date.now() - startTime, reason: 'error' };
  }
}

/**
 * Exported handler for explicit use as an MCP tool.
 */
export const pageStabilityHandlers = {
  async waitForStable(params) {
    const tabId = await resolveTabId(params);
    const { minStableMs, maxWaitMs, maxMutations, watchSelector, ignoreSelectors, ignoreCharacterData } = params;
    return await waitForPageStable(tabId, { minStableMs, maxWaitMs, maxMutations, watchSelector, ignoreSelectors, ignoreCharacterData });
  },
};
