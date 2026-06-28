import { resolveTabId } from '../utils.js';
import {
  evaluateInFrameMainWorld,
  evaluateInTab,
  formatFrameTarget,
  resolveFrameTarget,
} from '../cdp-bridge.js';
import { waitForPageStable } from './page-stability.js';
import { DOM_DEEP_HELPERS } from './dom-helpers.js';

async function getEvaluator(tabId, frameSpec) {
  if (!frameSpec) {
    return { evaluate: (expr) => evaluateInTab(tabId, expr), frameTarget: null };
  }
  const frameTarget = await resolveFrameTarget(tabId, frameSpec);
  return {
    evaluate: (expr) => evaluateInFrameMainWorld(tabId, frameTarget, expr),
    frameTarget,
  };
}

function framePayload(frameTarget) {
  return frameTarget ? { frame: formatFrameTarget(frameTarget) } : {};
}

export const highLevelHandlers = {
  async click(params) {
    const { selector } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);
    const { evaluate, frameTarget } = await getEvaluator(tabId, params.frame);

    const result = await evaluate(`
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
    return { tabId, ...framePayload(frameTarget), ...result };
  },

  async type(params) {
    const { selector, text } = params;
    if (!selector) throw new Error('Missing required param: selector');
    if (text === undefined) throw new Error('Missing required param: text');
    const tabId = await resolveTabId(params);
    const { evaluate, frameTarget } = await getEvaluator(tabId, params.frame);

    const result = await evaluate(`
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
    return { tabId, ...framePayload(frameTarget), ...result };
  },

  async waitForSelector(params) {
    const { selector, timeout = 10000 } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);
    const { evaluate, frameTarget } = await getEvaluator(tabId, params.frame);

    const result = await evaluate(`
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
    return { tabId, ...framePayload(frameTarget), ...result };
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
    const { evaluate, frameTarget } = await getEvaluator(tabId, params.frame);

    const result = await evaluate(`
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
    return { tabId, ...framePayload(frameTarget), ...result };
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
      pierceShadow = true,
    } = params;
    const { evaluate, frameTarget } = await getEvaluator(tabId, params.frame);

    const result = await evaluate(`
      (() => {
        ${pierceShadow ? DOM_DEEP_HELPERS : ''}
        const els = ${pierceShadow
          ? `__webmcpQueryDeep(${JSON.stringify(selector)})`
          : `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`};
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
          pierceShadow: ${pierceShadow},
          elements: page,
        };
      })()
    `);
    return { tabId, selector, ...framePayload(frameTarget), ...result };
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
    const { evaluate, frameTarget } = await getEvaluator(tabId, params.frame);

    const result = await evaluate(`
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
    return { tabId, path, ...framePayload(frameTarget), ...result };
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
      pierceShadow = true,
    } = params;
    const { evaluate, frameTarget } = await getEvaluator(tabId, params.frame);

    const result = await evaluate(`
      (() => {
        ${pierceShadow ? DOM_DEEP_HELPERS : ''}
        const needle = ${JSON.stringify(text)};
        const exact = ${JSON.stringify(exact)};
        const selector = ${JSON.stringify(selector)};
        const maxResults = ${Number(maxResults)};
        const pierceShadow = ${pierceShadow};

        const matches = [];
        const seen = new Set();

        // Walk up to a real element matching the filter selector, crossing
        // shadow boundaries (parentElement is null at a shadow root edge).
        function ancestorMatch(node) {
          let el = node.parentElement;
          if (!el) {
            const root = node.parentNode;
            el = root && root.host ? root.host : null;
          }
          while (el) {
            if (el.matches && el.matches(selector)) return el;
            let next = el.parentElement;
            if (!next) {
              const root = el.getRootNode && el.getRootNode();
              next = root && root.host ? root.host : null;
            }
            el = next;
          }
          return null;
        }

        function visit(node) {
          if (matches.length >= maxResults) return;
          const textContent = (node.textContent || '').trim();
          if (!textContent) return;
          const hit = exact
            ? textContent === needle
            : textContent.toLowerCase().includes(needle.toLowerCase());
          if (!hit) return;

          const el = ancestorMatch(node);
          if (!el || seen.has(el)) return;
          seen.add(el);

          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;

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

        if (pierceShadow) {
          __webmcpWalkTextDeep(document.body, visit);
        } else {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          let node;
          while ((node = walker.nextNode()) && matches.length < maxResults) visit(node);
        }

        return { total: matches.length, exact, needle, pierceShadow, elements: matches };
      })()
    `);
    return { tabId, ...framePayload(frameTarget), ...result };
  },

  // pageFetch — run fetch() inside the page (MAIN world) so it inherits the
  // page's cookies, origin, and credentials. Returns a structured, size-bounded
  // result. Replaces hand-written evaluateJS + fetch boilerplate. The win is
  // same-origin in-page APIs with the real session (CORS still applies as usual).
  async pageFetch(params) {
    const { url } = params;
    if (!url) throw new Error('Missing required param: url');
    const tabId = await resolveTabId(params);
    const {
      method = 'GET',
      headers = {},
      body = null,
      responseType = 'auto', // 'text' | 'json' | 'base64' | 'auto'
      credentials = 'include',
      maxLength = 100000,
      offset = 0,
    } = params;
    const { evaluate, frameTarget } = await getEvaluator(tabId, params.frame);

    const result = await evaluate(`
      (async () => {
        try {
          const res = await fetch(${JSON.stringify(url)}, {
            method: ${JSON.stringify(method)},
            headers: ${JSON.stringify(headers)},
            ${body != null ? `body: ${JSON.stringify(body)},` : ''}
            credentials: ${JSON.stringify(credentials)},
          });

          const respHeaders = {};
          res.headers.forEach((v, k) => { respHeaders[k] = v; });
          const ct = res.headers.get('content-type') || '';

          let rt = ${JSON.stringify(responseType)};
          if (rt === 'auto') {
            if (ct.includes('json')) rt = 'json';
            else if (ct.startsWith('text/') || ct.includes('xml') || ct.includes('javascript')) rt = 'text';
            else rt = 'base64';
          }

          const offset = ${Number(offset)};
          const maxLength = ${Number(maxLength)};
          let payload, total, truncated = false, parsed;

          if (rt === 'base64') {
            const buf = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            total = bytes.length;
            const slice = bytes.subarray(offset, offset + maxLength);
            let bin = '';
            for (let i = 0; i < slice.length; i++) bin += String.fromCharCode(slice[i]);
            payload = btoa(bin);
            truncated = offset + slice.length < total;
          } else {
            const textBody = await res.text();
            total = textBody.length;
            payload = textBody.slice(offset, offset + maxLength);
            truncated = offset + payload.length < total;
            if (rt === 'json' && !truncated && offset === 0) {
              try { parsed = JSON.parse(payload); } catch (e) {}
            }
          }

          return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            responseType: rt,
            contentType: ct,
            headers: respHeaders,
            totalLength: total,
            offset,
            returnedLength: payload.length,
            truncated,
            nextOffset: truncated ? offset + payload.length : null,
            json: parsed,
            body: parsed !== undefined ? undefined : payload,
          };
        } catch (e) {
          return { error: true, message: String((e && e.message) || e) };
        }
      })()
    `);
    return { tabId, url, ...framePayload(frameTarget), ...result };
  }
};
