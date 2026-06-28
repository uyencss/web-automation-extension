import { resolveTabId } from '../utils.js';
import { evaluateInTab } from '../cdp-bridge.js';
import { waitForPageStable } from './page-stability.js';

export const highLevelHandlers = {
  async click(params) {
    const { selector } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);

    const result = await evaluateInTab(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { success: false, error: 'Element not found: ${selector}' };
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.click();
        return {
          success: true,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 200),
        };
      })()
    `);
    // Auto-wait for page stability after click
    await waitForPageStable(tabId, { minStableMs: 500, maxWaitMs: 3000 });
    return { tabId, ...result };
  },

  async type(params) {
    const { selector, text } = params;
    if (!selector) throw new Error('Missing required param: selector');
    if (text === undefined) throw new Error('Missing required param: text');
    const tabId = await resolveTabId(params);

    const result = await evaluateInTab(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { success: false, error: 'Element not found: ${selector}' };
        el.focus();
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, tag: el.tagName.toLowerCase(), name: el.name || el.id };
      })()
    `);
    // Auto-wait for page stability after type
    await waitForPageStable(tabId, { minStableMs: 300, maxWaitMs: 2000 });
    return { tabId, ...result };
  },

  async waitForSelector(params) {
    const { selector, timeout = 10000 } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);

    const result = await evaluateInTab(tabId, `
      new Promise((resolve) => {
        const existing = document.querySelector(${JSON.stringify(selector)});
        if (existing) {
          return resolve({
            found: true,
            tag: existing.tagName.toLowerCase(),
            text: (existing.textContent || '').trim().slice(0, 200),
          });
        }
        const observer = new MutationObserver(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) {
            observer.disconnect();
            resolve({
              found: true,
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || '').trim().slice(0, 200),
            });
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve({ found: false, error: 'Timeout waiting for: ${selector}' });
        }, ${timeout});
      })
    `);
    return { tabId, ...result };
  },

  async getPageContent(params) {
    const tabId = await resolveTabId(params);
    const result = await evaluateInTab(tabId, `
      (() => ({
        title: document.title,
        url: location.href,
        text: document.body?.innerText?.slice(0, 50000) || '',
        html: document.documentElement.outerHTML.slice(0, 100000),
      }))()
    `);
    return { tabId, ...result };
  }
};
