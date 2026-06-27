// ============================================================
// WebMCP Tools Provider — Content Script (MAIN world)
//
// This script runs in the page's own JavaScript context so that
// navigator.modelContext is visible to the Codex extension when
// it evaluates webmcp_list_tools / webmcp_invoke_tool.
//
// Architecture:
//   1. Polyfill navigator.modelContext if the browser doesn't
//      natively support WebMCP yet.
//   2. Register each tool with { name, description, inputSchema,
//      execute }.
//   3. Codex discovers tools via navigator.modelContext.tools
//      and invokes them via navigator.modelContext.invokeTool().
//   4. Each execute() must return MCP-format:
//      { content: [{ type: "text", text: "..." }] }
// ============================================================

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // §1 — Polyfill navigator.modelContext
  // ────────────────────────────────────────────────────────────

  if (!('modelContext' in navigator)) {
    const _registry = new Map();

    Object.defineProperty(navigator, 'modelContext', {
      value: Object.freeze({
        /**
         * Register a tool that AI agents can discover and invoke.
         *
         * @param {object} def
         * @param {string} def.name         — unique identifier (snake_case)
         * @param {string} def.description  — what the tool does (shown to AI)
         * @param {object} def.inputSchema  — JSON Schema for the input
         * @param {function} def.execute    — async (input) => MCP result
         * @param {string} [def.title]      — human-readable title
         * @param {object} [def.annotations]— MCP annotation hints
         */
        registerTool(def) {
          if (!def || typeof def.name !== 'string' || !def.name.trim()) {
            throw new TypeError('registerTool: tool must have a non-empty "name"');
          }
          if (typeof def.execute !== 'function') {
            throw new TypeError(`registerTool: tool "${def.name}" must have an "execute" function`);
          }
          _registry.set(def.name, def);
          console.debug(`[WebMCP] ✓ registered tool: ${def.name}`);
        },

        /** Remove a previously registered tool. */
        unregisterTool(name) {
          if (_registry.delete(name)) {
            console.debug(`[WebMCP] ✗ unregistered tool: ${name}`);
          }
        },

        /** List all registered tool descriptors (used by Codex webmcp_list_tools). */
        get tools() {
          return Array.from(_registry.values()).map((t) => ({
            name: t.name,
            ...(t.title != null ? { title: t.title } : {}),
            ...(t.description != null ? { description: t.description } : {}),
            input_schema: t.inputSchema || t.input_schema || {},
            ...(t.annotations != null ? { annotations: t.annotations } : {}),
            origin: location.origin,
            pageUrl: location.href,
          }));
        },

        /** Invoke a tool by name (used by Codex webmcp_invoke_tool). */
        async invokeTool(name, input) {
          const tool = _registry.get(name);
          if (!tool) {
            throw new Error(`[WebMCP] Tool "${name}" is not registered`);
          }
          try {
            return await tool.execute(input || {});
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: true,
                    message: err?.message || String(err),
                  }),
                },
              ],
            };
          }
        },
      }),
      writable: false,
      enumerable: true,
      configurable: false,
    });

    console.debug('[WebMCP] polyfill installed on navigator.modelContext');
  }

  // ────────────────────────────────────────────────────────────
  // §2 — Helper: wrap a return value in MCP response format
  // ────────────────────────────────────────────────────────────

  /**
   * Convenience wrapper — takes any JS value and wraps it in
   * the MCP content format that Codex expects.
   */
  function mcpResult(data) {
    return {
      content: [
        {
          type: 'text',
          text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  /**
   * Convenience wrapper for error responses.
   */
  function mcpError(message) {
    return mcpResult({ error: true, message });
  }

  // ────────────────────────────────────────────────────────────
  // §2.5 — Bridge Communication (Background & Iframe)
  // ────────────────────────────────────────────────────────────

  let _reqId = 0;
  async function invokeBackground(method, params) {
    const id = ++_reqId;
    return new Promise((resolve) => {
      const handler = (event) => {
        if (event.source !== window || event.data?.type !== 'WEBMCP_BG_RESPONSE' || event.data?.id !== id) return;
        window.removeEventListener('message', handler);
        resolve(event.data.response);
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'WEBMCP_BG_REQUEST', payload: { type: 'WEBMCP_BG_REQUEST', method, params }, id }, '*');
    });
  }

  async function invokeIframe(frameSelector, cmd, params) {
    const frame = document.querySelector(frameSelector);
    if (!frame) return mcpError(`Iframe not found: ${frameSelector}`);
    const id = ++_reqId;
    return new Promise((resolve) => {
      const handler = (event) => {
        if (event.data?.type === 'WEBMCP_IFRAME_RES' && event.data.id === id) {
          window.removeEventListener('message', handler);
          resolve(event.data.result);
        }
      };
      window.addEventListener('message', handler);
      frame.contentWindow.postMessage({ type: 'WEBMCP_IFRAME_CMD', cmd, params, id }, '*');
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(mcpError(`Timeout communicating with iframe: ${frameSelector}. Note: cross-origin iframes must have register-tools.js injected via all_frames: true.`));
      }, 5000);
    });
  }

  // Iframe command receiver (runs inside the iframe)
  if (window !== window.top) {
    window.addEventListener('message', async (event) => {
      if (event.data?.type === 'WEBMCP_IFRAME_CMD') {
        const { cmd, params, id } = event.data;
        let result;
        try {
          // We can reuse the tools registry to execute inside iframe!
          if (navigator.modelContext && navigator.modelContext.tools) {
            result = await navigator.modelContext.invokeTool(cmd, params);
          } else {
            result = mcpError('navigator.modelContext not available in iframe');
          }
        } catch (err) {
          result = mcpError(err.message);
        }
        event.source.postMessage({ type: 'WEBMCP_IFRAME_RES', id, result }, event.origin);
      }
    });
  }

  // ────────────────────────────────────────────────────────────
  // §3 — Tool definitions
  // ────────────────────────────────────────────────────────────

  // ─── Tool 1: get_page_metadata ────────────────────────────
  navigator.modelContext.registerTool({
    name: 'get_page_metadata',
    title: 'Get Page Metadata',
    description:
      'Extract structured metadata from the current page: title, meta tags, ' +
      'Open Graph data, canonical URL, and optionally all headings.',
    inputSchema: {
      type: 'object',
      properties: {
        include_headings: {
          type: 'boolean',
          description: 'Include all h1–h6 headings in the result.',
        },
        include_links: {
          type: 'boolean',
          description: 'Include all anchor links in the result.',
        },
      },
    },
    async execute(input) {
      const meta = (name) =>
        document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)
          ?.content || null;

      const result = {
        title: document.title,
        url: location.href,
        canonical: document.querySelector('link[rel="canonical"]')?.href || null,
        description: meta('description'),
        og: {
          title: meta('og:title'),
          description: meta('og:description'),
          image: meta('og:image'),
          type: meta('og:type'),
          siteName: meta('og:site_name'),
        },
        lang: document.documentElement.lang || null,
      };

      if (input?.include_headings) {
        result.headings = Array.from(
          document.querySelectorAll('h1, h2, h3, h4, h5, h6')
        ).map((h) => ({
          level: parseInt(h.tagName[1], 10),
          text: h.textContent.trim(),
        }));
      }

      if (input?.include_links) {
        result.links = Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 200)
          .map((a) => ({
            text: a.textContent.trim().slice(0, 100),
            href: a.href,
          }));
      }

      return mcpResult(result);
    },
  });

  // ─── Tool 2: query_selector_all ───────────────────────────
  navigator.modelContext.registerTool({
    name: 'query_selector_all',
    title: 'Query Selector All',
    description:
      'Find all elements matching a CSS selector and return their tag, text, ' +
      'attributes, and bounding-box position. Useful for understanding page layout.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to query.',
        },
        frame_selector: {
          type: 'string',
          description: 'Optional CSS selector for an iframe containing the element.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of elements to return. Default 50.',
        },
        attributes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of attribute names to extract (e.g. ["id", "class", "href"]). ' +
            'Defaults to id, class, href, src, type, role, aria-label.',
        },
      },
      required: ['selector'],
    },
    async execute(input) {
      if (input.frame_selector) {
        return invokeIframe(input.frame_selector, 'query_selector_all', { ...input, frame_selector: undefined });
      }
      const defaultAttrs = ['id', 'class', 'href', 'src', 'type', 'role', 'aria-label', 'name', 'value', 'placeholder'];
      const attrList = input.attributes || defaultAttrs;
      const max = input.max_results || 50;

      const els = Array.from(document.querySelectorAll(input.selector)).slice(0, max);
      if (els.length === 0) {
        return mcpError(`No elements found for selector: ${input.selector}`);
      }

      const results = els.map((el, index) => {
        const rect = el.getBoundingClientRect();
        const attrs = {};
        for (const a of attrList) {
          const v = el.getAttribute(a);
          if (v != null) attrs[a] = v;
        }
        return {
          index,
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().slice(0, 200) || '',
          attributes: attrs,
          visible: rect.width > 0 && rect.height > 0,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      });

      return mcpResult({ count: results.length, elements: results });
    },
  });

  // ─── Tool 3: click_element ────────────────────────────────
  navigator.modelContext.registerTool({
    name: 'click_element',
    title: 'Click Element',
    description:
      'Click an element matching a CSS selector. Optionally scroll it into view first. ' +
      'Returns the element text and tag for confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element to click.',
        },
        frame_selector: {
          type: 'string',
          description: 'Optional CSS selector for an iframe containing the element.',
        },
        scroll_into_view: {
          type: 'boolean',
          description: 'Whether to scroll the element into view before clicking. Default true.',
        },
      },
      required: ['selector'],
    },
    async execute(input) {
      if (input.frame_selector) {
        return invokeIframe(input.frame_selector, 'click_element', { ...input, frame_selector: undefined });
      }
      const el = document.querySelector(input.selector);
      if (!el) return mcpError(`No element found for selector: ${input.selector}`);

      if (input.scroll_into_view !== false) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise((r) => setTimeout(r, 300));
      }

      el.click();

      return mcpResult({
        success: true,
        tag: el.tagName.toLowerCase(),
        text: el.textContent?.trim().slice(0, 200),
      });
    },
  });

  // ─── Tool 4: fill_form_field ──────────────────────────────
  navigator.modelContext.registerTool({
    name: 'fill_form_field',
    title: 'Fill Form Field',
    description:
      'Set the value of an input, textarea, or select element. Dispatches ' +
      'input/change events so React, Vue, Angular, and vanilla forms detect the change.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the form field.',
        },
        frame_selector: {
          type: 'string',
          description: 'Optional CSS selector for an iframe containing the element.',
        },
        value: {
          type: 'string',
          description: 'The value to set.',
        },
      },
      required: ['selector', 'value'],
    },
    async execute(input) {
      const el = document.querySelector(input.selector);
      if (!el) return mcpError(`No element found: ${input.selector}`);

      // Focus the element first
      el.focus();

      if (el.tagName === 'SELECT') {
        // For <select>, set .value and dispatch change
        el.value = input.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        // For contenteditable elements
        el.textContent = input.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // For <input>/<textarea>, use the native setter to bypass
        // React/Vue controlled component wrappers
        const proto =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

        if (nativeSetter) {
          nativeSetter.call(el, input.value);
        } else {
          el.value = input.value;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      return mcpResult({
        success: true,
        tag: el.tagName.toLowerCase(),
        fieldName: el.name || el.id || input.selector,
      });
    },
  });

  // ─── Tool 5: extract_table_data ───────────────────────────
  navigator.modelContext.registerTool({
    name: 'extract_table_data',
    title: 'Extract Table Data',
    description:
      'Extract data from an HTML <table> as structured JSON. Returns an array ' +
      'of row objects keyed by the column header text.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the <table>. Defaults to the first table on the page.',
        },
        frame_selector: {
          type: 'string',
          description: 'Optional CSS selector for an iframe containing the element.',
        },
        max_rows: {
          type: 'number',
          description: 'Maximum rows to extract. Default 100.',
        },
      },
    },
    async execute(input) {
      if (input.frame_selector) {
        return invokeIframe(input.frame_selector, 'extract_table_data', { ...input, frame_selector: undefined });
      }
      const table = document.querySelector(input?.selector || 'table');
      if (!table) return mcpError('No table found on the page.');

      const headers = Array.from(
        table.querySelectorAll('thead th, thead td, tr:first-child th')
      ).map((th) => th.textContent.trim());

      const bodyRows = table.querySelector('tbody')
        ? table.querySelectorAll('tbody tr')
        : table.querySelectorAll('tr:not(:first-child)');

      const rows = Array.from(bodyRows)
        .slice(0, input?.max_rows || 100)
        .map((tr) => {
          const cells = Array.from(tr.querySelectorAll('td, th'));
          const row = {};
          cells.forEach((td, i) => {
            row[headers[i] || `col_${i}`] = td.textContent.trim();
          });
          return row;
        });

      return mcpResult({ rowCount: rows.length, headers, data: rows });
    },
  });

  // ─── Tool 6: wait_for_element ─────────────────────────────
  navigator.modelContext.registerTool({
    name: 'wait_for_element',
    title: 'Wait For Element',
    description:
      'Wait until an element matching a CSS selector appears in the DOM. ' +
      'Returns when found or after the timeout. Useful for SPAs and dynamic content.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to wait for.',
        },
        frame_selector: {
          type: 'string',
          description: 'Optional CSS selector for an iframe containing the element.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Maximum wait time in milliseconds. Default 10000.',
        },
      },
      required: ['selector'],
    },
    async execute(input) {
      if (input.frame_selector) {
        return invokeIframe(input.frame_selector, 'wait_for_element', { ...input, frame_selector: undefined });
      }
      const timeout = input.timeout_ms || 10000;
      const start = Date.now();

      // Check immediately
      const existing = document.querySelector(input.selector);
      if (existing) {
        return mcpResult({
          found: true,
          elapsed_ms: Date.now() - start,
          tag: existing.tagName.toLowerCase(),
          text: existing.textContent?.trim().slice(0, 200),
        });
      }

      // Watch DOM mutations
      return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          const el = document.querySelector(input.selector);
          if (el) {
            observer.disconnect();
            resolve(
              mcpResult({
                found: true,
                elapsed_ms: Date.now() - start,
                tag: el.tagName.toLowerCase(),
                text: el.textContent?.trim().slice(0, 200),
              })
            );
          }
        });

        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });

        setTimeout(() => {
          observer.disconnect();
          resolve(
            mcpError(`Timeout (${timeout}ms) waiting for: ${input.selector}`)
          );
        }, timeout);
      });
    },
  });

  // ─── Tool 7: get_computed_styles ──────────────────────────
  navigator.modelContext.registerTool({
    name: 'get_computed_styles',
    title: 'Get Computed Styles',
    description:
      'Get the computed CSS styles for an element. Useful for debugging layout, ' +
      'colors, fonts, and visibility.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element.',
        },
        frame_selector: {
          type: 'string',
          description: 'Optional CSS selector for an iframe containing the element.',
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of CSS property names to read. If omitted, returns a common set: ' +
            'display, visibility, opacity, color, background-color, font-size, ' +
            'width, height, position, z-index.',
        },
      },
      required: ['selector'],
    },
    async execute(input) {
      if (input.frame_selector) {
        return invokeIframe(input.frame_selector, 'get_computed_styles', { ...input, frame_selector: undefined });
      }
      const el = document.querySelector(input.selector);
      if (!el) return mcpError(`No element found: ${input.selector}`);

      const defaultProps = [
        'display', 'visibility', 'opacity', 'color', 'background-color',
        'font-family', 'font-size', 'font-weight', 'width', 'height',
        'margin', 'padding', 'position', 'z-index', 'overflow',
        'border', 'box-sizing',
      ];
      const props = input.properties || defaultProps;
      const computed = getComputedStyle(el);
      const styles = {};
      for (const p of props) {
        styles[p] = computed.getPropertyValue(p);
      }

      const rect = el.getBoundingClientRect();

      return mcpResult({
        tag: el.tagName.toLowerCase(),
        selector: input.selector,
        styles,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    },
  });

  // ─── Tool 8: scroll_page ──────────────────────────────────
  navigator.modelContext.registerTool({
    name: 'scroll_page',
    title: 'Scroll Page',
    description:
      'Scroll the page or a specific container. Can scroll to a position, ' +
      'by a delta, or to a specific element.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Where to scroll: "top", "bottom", or a CSS selector of an element to scroll into view.',
        },
        delta_y: {
          type: 'number',
          description: 'Pixels to scroll vertically (positive = down, negative = up). Overrides target.',
        },
        container_selector: {
          type: 'string',
          description: 'CSS selector for a scrollable container. Defaults to the document.',
        },
        behavior: {
          type: 'string',
          enum: ['smooth', 'instant'],
          description: 'Scroll behavior. Default "smooth".',
        },
      },
    },
    async execute(input) {
      const behavior = input.behavior || 'smooth';

      // Scroll by delta
      if (input.delta_y != null) {
        const container = input.container_selector
          ? document.querySelector(input.container_selector)
          : window;
        if (!container) return mcpError(`Container not found: ${input.container_selector}`);
        container.scrollBy({ top: input.delta_y, behavior });
        await new Promise((r) => setTimeout(r, 400));
        return mcpResult({
          success: true,
          scrollY: window.scrollY,
          pageHeight: document.documentElement.scrollHeight,
        });
      }

      // Scroll to target
      const target = input.target || 'top';
      if (target === 'top') {
        window.scrollTo({ top: 0, behavior });
      } else if (target === 'bottom') {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
      } else {
        const el = document.querySelector(target);
        if (!el) return mcpError(`Element not found: ${target}`);
        el.scrollIntoView({ behavior, block: 'center' });
      }

      await new Promise((r) => setTimeout(r, 400));
      return mcpResult({
        success: true,
        scrollY: Math.round(window.scrollY),
        pageHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
      });
    },
  });

  // ─── Tool 9: submit_form ──────────────────────────────────
  navigator.modelContext.registerTool({
    name: 'submit_form',
    title: 'Submit Form',
    description:
      'Submit a form element. Optionally fill multiple fields before submitting. ' +
      'Can submit by clicking a submit button or calling form.submit().',
    inputSchema: {
      type: 'object',
      properties: {
        form_selector: {
          type: 'string',
          description: 'CSS selector for the <form>. Default: first form on page.',
        },
        fields: {
          type: 'object',
          description:
            'Key-value pairs where key is the field name or CSS selector and value is the text to fill.',
        },
        submit_button_selector: {
          type: 'string',
          description:
            'CSS selector for the submit button. If omitted, calls form.submit() directly.',
        },
      },
    },
    annotations: {
      untrustedContentHint: true,
    },
    async execute(input) {
      const form = document.querySelector(input.form_selector || 'form');
      if (!form) return mcpError('No form found.');

      // Fill fields if provided
      if (input.fields && typeof input.fields === 'object') {
        for (const [key, value] of Object.entries(input.fields)) {
          // Try by name first, then by selector
          let field = form.querySelector(`[name="${key}"]`) || form.querySelector(key);
          if (!field) continue;

          const proto =
            field instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) {
            setter.call(field, value);
          } else {
            field.value = value;
          }
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Submit
      if (input.submit_button_selector) {
        const btn = form.querySelector(input.submit_button_selector) ||
                    document.querySelector(input.submit_button_selector);
        if (!btn) return mcpError(`Submit button not found: ${input.submit_button_selector}`);
        btn.click();
      } else {
        // Try to find a submit button, otherwise call submit()
        const submitBtn = form.querySelector('[type="submit"], button:not([type])');
        if (submitBtn) {
          submitBtn.click();
        } else {
          form.submit();
        }
      }

      return mcpResult({
        success: true,
        action: form.action || location.href,
        method: form.method || 'GET',
      });
    },
  });

  // ─── Tool 10: execute_javascript ──────────────────────────
  navigator.modelContext.registerTool({
    name: 'execute_javascript',
    title: 'Execute JavaScript',
    description:
      'Execute arbitrary JavaScript code in the page context and return the result. ' +
      'The code has full access to the page DOM and all page APIs. ' +
      'Use this as a fallback when no other tool fits.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript code to evaluate. Can be an expression or statements.',
        },
      },
      required: ['code'],
    },
    annotations: {
      untrustedContentHint: true,
    },
    async execute(input) {
      try {
        // Use indirect eval to run in global scope
        const evalFn = new Function(`return (async () => { ${input.code} })()`);
        const result = await evalFn();
        return mcpResult({
          success: true,
          result: result === undefined ? 'undefined' : result,
        });
      } catch (err) {
        return mcpError(`Execution error: ${err.message}`);
      }
    },
  });

  // ─── Tool 11: start_network_capture ───────────────────────
  navigator.modelContext.registerTool({
    name: 'start_network_capture',
    title: 'Start Network Capture',
    description: 'Start capturing network requests whose URL contains a pattern. Call multiple times to capture several patterns at once on the same tab. Captures method, status, headers, timing, and response bodies for ALL matching requests. Must be called before wait_for_network_response or get_captured_requests.',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string', description: 'Substring to match in request URLs (e.g. "api/graphql" or "/complete/search").' },
      },
      required: ['url_pattern'],
    },
    async execute(input) {
      try {
        const res = await invokeBackground('start_network_capture', input);
        return mcpResult(res);
      } catch (err) {
        return mcpError(err.message);
      }
    }
  });

  // ─── Tool 12: wait_for_network_response ───────────────────
  navigator.modelContext.registerTool({
    name: 'wait_for_network_response',
    title: 'Wait For Network Response',
    description: 'Wait (event-driven, no polling) for the next captured response matching a pattern and return its metadata + body. Each call consumes the oldest unconsumed match, so calling repeatedly walks through successive responses. Use get_captured_requests to see everything captured so far without consuming.',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string', description: 'URL substring to wait for.' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 10000).' },
        include_body: { type: 'boolean', description: 'Include the response body (default true).' },
      },
      required: ['url_pattern'],
    },
    async execute(input) {
      try {
        const res = await invokeBackground('wait_for_network_response', input);
        return mcpResult(res);
      } catch (err) {
        return mcpError(err.message);
      }
    }
  });

  // ─── Tool 13: get_captured_requests ───────────────────────
  navigator.modelContext.registerTool({
    name: 'get_captured_requests',
    title: 'Get Captured Requests',
    description: 'List all network requests captured so far (across all active patterns), without consuming them. Returns metadata for each; optionally response bodies and headers. Ideal when a page fires many requests matching the same pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string', description: 'Optional: only return requests whose URL contains this substring.' },
        include_bodies: { type: 'boolean', description: 'Include response bodies (default false; can be large).' },
        include_headers: { type: 'boolean', description: 'Include request/response headers (default false).' },
        limit: { type: 'number', description: 'Max requests to return (default 100).' },
      },
    },
    async execute(input) {
      try {
        const res = await invokeBackground('get_captured_requests', input);
        return mcpResult(res);
      } catch (err) {
        return mcpError(err.message);
      }
    }
  });

  // ─── Tool 14: stop_network_capture ────────────────────────
  navigator.modelContext.registerTool({
    name: 'stop_network_capture',
    title: 'Stop Network Capture',
    description: 'Stop capturing and clean up. Pass a url_pattern to remove only that one pattern (if others remain active); omit it to stop all capture on the tab.',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string', description: 'Optional: remove only this pattern instead of stopping everything.' },
      },
    },
    async execute(input) {
      try {
        const res = await invokeBackground('stop_network_capture', input);
        return mcpResult(res);
      } catch (err) {
        return mcpError(err.message);
      }
    }
  });

  // ────────────────────────────────────────────────────────────
  // §4 — Startup log
  // ────────────────────────────────────────────────────────────

  const toolCount = navigator.modelContext.tools.length;
  console.log(
    `%c[WebMCP Tools Provider]%c ${toolCount} tools registered and ready for AI agent discovery.`,
    'color: #22c55e; font-weight: bold;',
    'color: inherit;'
  );
})();
