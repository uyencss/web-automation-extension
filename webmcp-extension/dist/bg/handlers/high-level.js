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
    // Pagination / size controls (all optional, backward compatible):
    //   format:    'text' (default) | 'html' | 'both'
    //   maxLength: max chars of the chosen field(s) to return (default 50000)
    //   offset:    char offset to start from, for fetching the next chunk
    const {
      format = 'text',
      maxLength = 50000,
      offset = 0,
    } = params;

    const result = await evaluateInTab(tabId, `
      (() => {
        const fmt = ${JSON.stringify(format)};
        const offset = ${Number(offset)};
        const maxLength = ${Number(maxLength)};
        const out = { title: document.title, url: location.href };

        const slice = (full) => {
          const total = full.length;
          const chunk = full.slice(offset, offset + maxLength);
          return {
            value: chunk,
            totalLength: total,
            offset,
            returnedLength: chunk.length,
            truncated: offset + chunk.length < total,
            nextOffset: offset + chunk.length < total ? offset + chunk.length : null,
          };
        };

        if (fmt === 'text' || fmt === 'both') {
          const t = slice(document.body?.innerText || '');
          out.text = t.value;
          out.textMeta = { totalLength: t.totalLength, offset: t.offset, returnedLength: t.returnedLength, truncated: t.truncated, nextOffset: t.nextOffset };
        }
        if (fmt === 'html' || fmt === 'both') {
          const h = slice(document.documentElement.outerHTML || '');
          out.html = h.value;
          out.htmlMeta = { totalLength: h.totalLength, offset: h.offset, returnedLength: h.returnedLength, truncated: h.truncated, nextOffset: h.nextOffset };
        }
        return out;
      })()
    `);
    return { tabId, ...result };
  },

  // Paginated DOM extraction — replaces the "stuff data into HTML attributes"
  // workaround. Returns matched elements as structured records with explicit
  // limit/offset so large result sets can be fetched in chunks.
  async querySelectorAll(params) {
    const { selector } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);
    const {
      limit = 100,
      offset = 0,
      fields = ['text', 'href', 'src', 'value'],
      textMaxLength = 2000,
    } = params;

    const result = await evaluateInTab(tabId, `
      (() => {
        const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const total = els.length;
        const offset = ${Number(offset)};
        const limit = ${Number(limit)};
        const fields = ${JSON.stringify(fields)};
        const textMax = ${Number(textMaxLength)};
        const page = els.slice(offset, offset + limit).map((el, i) => {
          const rec = { index: offset + i, tag: el.tagName.toLowerCase() };
          if (fields.includes('text')) rec.text = (el.textContent || '').trim().slice(0, textMax);
          if (fields.includes('html')) rec.html = (el.innerHTML || '').slice(0, textMax);
          if (fields.includes('href') && el.href) rec.href = el.href;
          if (fields.includes('src') && el.src) rec.src = el.src;
          if (fields.includes('value') && 'value' in el && el.value) rec.value = String(el.value).slice(0, textMax);
          if (fields.includes('id') && el.id) rec.id = el.id;
          if (fields.includes('class') && el.className) rec.class = String(el.className);
          return rec;
        });
        return {
          total,
          offset,
          returned: page.length,
          truncated: offset + page.length < total,
          nextOffset: offset + page.length < total ? offset + page.length : null,
          elements: page,
        };
      })()
    `);
    return { tabId, selector, ...result };
  }
};
