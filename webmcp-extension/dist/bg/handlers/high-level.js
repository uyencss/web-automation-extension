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
  },

  // P2 — Read a named window variable (e.g. ytInitialData, __NEXT_DATA__).
  // Supports dot-notation path and pagination so large objects can be chunked.
  // This is the primary extraction strategy for SSR/hydrated SPAs — data is
  // already rendered client-side and far more stable than DOM selectors.
  async getWindowVariable(params) {
    const { path } = params;
    if (!path) throw new Error('Missing required param: path');
    const tabId = await resolveTabId(params);
    const { maxLength = 50000, offset = 0 } = params;

    const result = await evaluateInTab(tabId, `
      (() => {
        // Walk dot-notation path safely (e.g. "ytInitialData.contents.twoColumn...")
        const parts = ${JSON.stringify(path)}.split('.');
        let value = window;
        for (const part of parts) {
          if (value == null || typeof value !== 'object') {
            return { found: false, reason: 'Path "' + parts.slice(0, parts.indexOf(part) + 1).join('.') + '" is ' + typeof value };
          }
          if (!(part in value)) {
            return { found: false, reason: 'Key "' + part + '" not found at path "' + parts.slice(0, parts.indexOf(part)).join('.') + '"' };
          }
          value = value[part];
        }

        if (value === undefined) return { found: false, reason: 'Value is undefined' };

        // Serialize and paginate
        let serialized;
        try {
          serialized = JSON.stringify(value);
        } catch (e) {
          return { found: true, error: 'Value is not JSON-serializable: ' + e.message };
        }

        const total = serialized.length;
        const offset = ${Number(offset)};
        const maxLength = ${Number(maxLength)};
        const chunk = serialized.slice(offset, offset + maxLength);
        const truncated = offset + chunk.length < total;

        // If the full value fits, parse it back so callers get an object, not a string
        let parsedValue = undefined;
        if (!truncated && offset === 0) {
          try { parsedValue = JSON.parse(chunk); } catch {}
        }

        return {
          found: true,
          totalLength: total,
          offset,
          returnedLength: chunk.length,
          truncated,
          nextOffset: truncated ? offset + chunk.length : null,
          // Prefer parsed object; fall back to raw string chunk for large paginated responses
          value: parsedValue !== undefined ? parsedValue : chunk,
          isString: parsedValue === undefined,
        };
      })()
    `);
    return { tabId, path, ...result };
  },

  // P3 — Find elements by visible text using TreeWalker (no CSS class dependency).
  // Returns same bounds schema as getInteractiveElements so results can be used
  // directly with dispatchClick { x: bounds.centerX, y: bounds.centerY }.
  async findByText(params) {
    const { text } = params;
    if (!text) throw new Error('Missing required param: text');
    const tabId = await resolveTabId(params);
    const {
      exact = false,
      selector = '*',
      maxResults = 10,
    } = params;

    const result = await evaluateInTab(tabId, `
      (() => {
        const needle = ${JSON.stringify(text)};
        const exact = ${JSON.stringify(exact)};
        const selector = ${JSON.stringify(selector)};
        const maxResults = ${Number(maxResults)};

        const matches = [];
        // Use TreeWalker to find text nodes, then walk up to a visible element
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        const seen = new Set();

        let node;
        while ((node = walker.nextNode()) && matches.length < maxResults) {
          const raw = node.textContent || '';
          const textContent = raw.trim();
          if (!textContent) continue;

          const hit = exact
            ? textContent === needle
            : textContent.toLowerCase().includes(needle.toLowerCase());
          if (!hit) continue;

          // Walk up to a real element that matches the optional filter selector
          let el = node.parentElement;
          while (el && el !== document.body) {
            if (el.matches && el.matches(selector)) break;
            el = el.parentElement;
          }
          if (!el || seen.has(el)) continue;
          seen.add(el);

          const rect = el.getBoundingClientRect();
          // Skip off-screen elements
          if (rect.width === 0 && rect.height === 0) continue;

          matches.push({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 300),
            matchedText: textContent.slice(0, 200),
            bounds: {
              x: Math.round(rect.left + window.scrollX),
              y: Math.round(rect.top + window.scrollY),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              centerX: Math.round(rect.left + window.scrollX + rect.width / 2),
              centerY: Math.round(rect.top + window.scrollY + rect.height / 2),
            },
            visible: rect.top >= 0 && rect.top < window.innerHeight,
          });
        }

        return { total: matches.length, exact, needle, elements: matches };
      })()
    `);
    return { tabId, ...result };
  }
};
