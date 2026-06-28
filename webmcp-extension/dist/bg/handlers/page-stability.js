// ============================================================
// WebMCP — Page Stability Detection
//
// Inspired by Browser-MCP's page stability waiting mechanism.
// Ensures the page has settled (DOM stable, no pending navigations)
// before proceeding with the next action.
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
 * @param {number} [options.minStableMs=800]   — minimum quiet period
 * @param {number} [options.maxWaitMs=5000]    — maximum time to wait
 * @param {number} [options.maxMutations=2]    — mutation threshold per poll
 */
export async function waitForPageStable(tabId, options = {}) {
  const {
    minStableMs = DEFAULT_MIN_STABLE_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    maxMutations = DEFAULT_MAX_MUTATIONS,
  } = options;

  const startTime = Date.now();
  const deadline = startTime + maxWaitMs;

  try {
    // Install a MutationObserver and poll for stability
    const setupResult = await evaluateInTab(tabId, `
      (() => {
        // Clean up any previous observer
        if (window.__webmcp_stability_observer) {
          window.__webmcp_stability_observer.disconnect();
        }

        window.__webmcp_mutation_count = 0;
        window.__webmcp_last_mutation_time = Date.now();

        const observer = new MutationObserver((mutations) => {
          // Only count meaningful mutations (ignore attribute-only changes on scripts/styles)
          const meaningful = mutations.filter(m => {
            if (m.type === 'childList') return true;
            if (m.type === 'characterData') return true;
            if (m.type === 'attributes') {
              const tag = m.target.tagName?.toLowerCase();
              return tag !== 'script' && tag !== 'style' && tag !== 'link';
            }
            return false;
          });
          if (meaningful.length > 0) {
            window.__webmcp_mutation_count += meaningful.length;
            window.__webmcp_last_mutation_time = Date.now();
          }
        });

        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
          attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled', 'value', 'src', 'href'],
        });

        window.__webmcp_stability_observer = observer;
        return { installed: true };
      })()
    `);

    if (!setupResult?.installed) {
      // Could not install observer (e.g., chrome:// page), just do a short wait
      await new Promise(r => setTimeout(r, Math.min(500, maxWaitMs)));
      return { stable: true, waited: Date.now() - startTime, reason: 'fallback' };
    }

    // Poll for stability
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const status = await evaluateInTab(tabId, `
        (() => {
          const count = window.__webmcp_mutation_count || 0;
          const lastMutation = window.__webmcp_last_mutation_time || 0;
          const isLoading = document.readyState === 'loading';
          // Reset counter for next poll
          window.__webmcp_mutation_count = 0;
          return { count, lastMutation, isLoading, now: Date.now() };
        })()
      `);

      if (!status) break; // Tab may have navigated away

      const isStable = status.count <= maxMutations && !status.isLoading;

      if (isStable) {
        const quietTime = Date.now() - stableSince;
        if (quietTime >= minStableMs) {
          // Clean up observer
          try {
            await evaluateInTab(tabId, `
              (() => {
                if (window.__webmcp_stability_observer) {
                  window.__webmcp_stability_observer.disconnect();
                  delete window.__webmcp_stability_observer;
                  delete window.__webmcp_mutation_count;
                  delete window.__webmcp_last_mutation_time;
                }
              })()
            `);
          } catch { /* ignore */ }

          return { stable: true, waited: Date.now() - startTime };
        }
      } else {
        stableSince = Date.now();
      }
    }

    // Timeout — clean up and return
    try {
      await evaluateInTab(tabId, `
        (() => {
          if (window.__webmcp_stability_observer) {
            window.__webmcp_stability_observer.disconnect();
            delete window.__webmcp_stability_observer;
            delete window.__webmcp_mutation_count;
            delete window.__webmcp_last_mutation_time;
          }
        })()
      `);
    } catch { /* ignore */ }

    return { stable: false, waited: Date.now() - startTime, reason: 'timeout' };
  } catch (err) {
    // If tab navigated or was closed, just return
    return { stable: true, waited: Date.now() - startTime, reason: 'error' };
  }
}

/**
 * Exported handler for explicit use as an MCP tool.
 */
export const pageStabilityHandlers = {
  async waitForStable(params) {
    const tabId = await resolveTabId(params);
    const { minStableMs, maxWaitMs, maxMutations } = params;
    return await waitForPageStable(tabId, { minStableMs, maxWaitMs, maxMutations });
  },
};
