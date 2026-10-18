// ============================================================
// WebMCP Tools Provider — Polyfill & Frame Bridge (MAIN world)
//
// Implements W3C 2026 navigator.modelContext / document.modelContext polyfill
// and iframe / background bridge utilities.
// ============================================================

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // §1 — Polyfill navigator.modelContext & document.modelContext
  // ────────────────────────────────────────────────────────────

  const _registry = new Map();

  function registerToolInRegistry(def) {
    if (!def || typeof def.name !== 'string' || !def.name.trim()) {
      throw new TypeError('registerTool: tool must have a non-empty "name"');
    }
    if (typeof def.execute !== 'function') {
      throw new TypeError(`registerTool: tool "${def.name}" must have an "execute" function`);
    }
    _registry.set(def.name, def);
  }

  function unregisterToolInRegistry(name) {
    _registry.delete(name);
  }

  function listRegistryTools() {
    return Array.from(_registry.values()).map((t) => ({
      name: t.name,
      ...(t.title != null ? { title: t.title } : {}),
      ...(t.description != null ? { description: t.description } : {}),
      input_schema: t.inputSchema || t.input_schema || {},
      ...(t.annotations != null ? { annotations: t.annotations } : {}),
      origin: location.origin,
      pageUrl: location.href,
    }));
  }

  async function invokeRegistryTool(name, input) {
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
  }

  if (!('modelContext' in navigator)) {
    const modelContextObj = Object.freeze({
      registerTool: registerToolInRegistry,
      unregisterTool: unregisterToolInRegistry,
      get tools() {
        return listRegistryTools();
      },
      async getTools() {
        return listRegistryTools();
      },
      invokeTool: invokeRegistryTool,
      async executeTool(name, input) {
        return invokeRegistryTool(name, input);
      },
    });

    Object.defineProperty(navigator, 'modelContext', {
      value: modelContextObj,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  } else {
    // If native navigator.modelContext exists (e.g. Chrome 150+)
    const ctx = navigator.modelContext;
    if (ctx) {
      const origRegister = ctx.registerTool;
      const origUnregister = ctx.unregisterTool;
      const origGetTools = typeof ctx.getTools === 'function' ? ctx.getTools : null;

      const wrappedRegister = function (...args) {
        if (args[0]) registerToolInRegistry(args[0]);
        if (typeof origRegister === 'function') {
          try { return origRegister.apply(ctx, args); } catch {}
        }
      };

      const wrappedUnregister = function (...args) {
        if (args[0]) unregisterToolInRegistry(args[0]);
        if (typeof origUnregister === 'function') {
          try { return origUnregister.apply(ctx, args); } catch {}
        }
      };

      try {
        ctx.registerTool = wrappedRegister;
      } catch {
        try {
          Object.defineProperty(ctx, 'registerTool', {
            value: wrappedRegister,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        } catch {}
      }

      try {
        ctx.unregisterTool = wrappedUnregister;
      } catch {
        try {
          Object.defineProperty(ctx, 'unregisterTool', {
            value: wrappedUnregister,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        } catch {}
      }

      if (!('tools' in ctx)) {
        try {
          Object.defineProperty(ctx, 'tools', {
            get: listRegistryTools,
            enumerable: true,
            configurable: true,
          });
        } catch {}
      }

      const wrappedGetTools = async function () {
        const regTools = listRegistryTools();
        if (origGetTools) {
          try {
            const nativeTools = await origGetTools.call(ctx);
            if (Array.isArray(nativeTools)) {
              const seen = new Set(regTools.map((t) => t.name));
              for (const nt of nativeTools) {
                if (nt?.name && !seen.has(nt.name)) {
                  seen.add(nt.name);
                  regTools.push(nt);
                }
              }
            }
          } catch {}
        }
        return regTools;
      };

      try {
        ctx.getTools = wrappedGetTools;
      } catch {
        try {
          Object.defineProperty(ctx, 'getTools', {
            value: wrappedGetTools,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        } catch {}
      }

      if (typeof ctx.invokeTool !== 'function') {
        try {
          ctx.invokeTool = invokeRegistryTool;
        } catch {
          try {
            Object.defineProperty(ctx, 'invokeTool', {
              value: invokeRegistryTool,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          } catch {}
        }
      }

      if (typeof ctx.executeTool !== 'function') {
        try {
          ctx.executeTool = invokeRegistryTool;
        } catch {
          try {
            Object.defineProperty(ctx, 'executeTool', {
              value: invokeRegistryTool,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          } catch {}
        }
      }
    }
  }

  // W3C 2026 Dual-Alias: document.modelContext
  if (!('modelContext' in document)) {
    try {
      Object.defineProperty(document, 'modelContext', {
        value: navigator.modelContext,
        writable: false,
        enumerable: true,
        configurable: true,
      });
    } catch {}
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

  const FRAME_SELECTOR_SCHEMA = {
    oneOf: [
      { type: 'string', description: 'CSS selector for an iframe.' },
      {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for an iframe.' },
          name: { type: 'string', description: 'iframe name attribute.' },
          index: { type: 'number', description: 'Zero-based iframe index.' },
          url: { type: 'string', description: 'Substring of iframe src URL.' },
        },
      },
    ],
    description: 'Optional iframe target. String form is treated as a CSS selector.',
  };

  const FRAME_PATH_SCHEMA = {
    type: 'array',
    items: FRAME_SELECTOR_SCHEMA,
    description: 'Nested iframe path, from outer frame to inner frame.',
  };

  const FRAME_TIMEOUT_SCHEMA = {
    type: 'number',
    description: 'Maximum iframe bridge wait in milliseconds. Default 5000.',
  };

  function describeFrameSpec(frameSpec) {
    if (typeof frameSpec === 'string') return frameSpec;
    if (!frameSpec || typeof frameSpec !== 'object') return String(frameSpec);
    return JSON.stringify(frameSpec);
  }

  function resolveFrame(frameSpec) {
    if (typeof frameSpec === 'string') {
      return document.querySelector(frameSpec);
    }

    if (!frameSpec || typeof frameSpec !== 'object') return null;

    if (frameSpec.selector) {
      return document.querySelector(frameSpec.selector);
    }

    const frames = Array.from(document.querySelectorAll('iframe, frame'));

    if (frameSpec.name) {
      return frames.find((frame) => frame.getAttribute('name') === frameSpec.name) || null;
    }

    if (typeof frameSpec.index === 'number') {
      return frames[frameSpec.index] || null;
    }

    if (frameSpec.url) {
      return frames.find((frame) => {
        const src = frame.getAttribute('src') || frame.src || '';
        return src.includes(frameSpec.url);
      }) || null;
    }

    return null;
  }

  function getFrameOrigin(frame) {
    const rawSrc = frame.getAttribute('src') || frame.src || '';
    if (!rawSrc || rawSrc === 'about:blank' || frame.hasAttribute('srcdoc')) {
      return '*';
    }
    try {
      return new URL(rawSrc, location.href).origin;
    } catch {
      return '*';
    }
  }

  function cleanFrameParams(input) {
    const {
      frame_selector,
      frame_path,
      frame_timeout_ms,
      ...rest
    } = input || {};
    return rest;
  }

  function shouldInvokeFrame(input) {
    return Boolean(
      input?.frame_selector ||
      (Array.isArray(input?.frame_path) && input.frame_path.length > 0)
    );
  }

  async function invokeFrameForTool(input, cmd) {
    const path = Array.isArray(input?.frame_path) && input.frame_path.length > 0
      ? input.frame_path
      : [input.frame_selector];
    return invokeIframe(path, cmd, cleanFrameParams(input), input?.frame_timeout_ms);
  }

  async function invokeIframe(frameTarget, cmd, params, timeoutMs = 5000) {
    const path = Array.isArray(frameTarget) ? frameTarget.filter(Boolean) : [frameTarget];
    const [frameSpec, ...remainingPath] = path;
    const frame = resolveFrame(frameSpec);
    const targetDescription = describeFrameSpec(frameSpec);
    if (!frame || !frame.contentWindow) {
      return mcpError(`Iframe not found: ${targetDescription}`);
    }

    const id = ++_reqId;
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const done = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(result);
      };
      const handler = (event) => {
        if (event.source !== frame.contentWindow) return;
        if (event.data?.type !== 'WEBMCP_IFRAME_RES' || event.data.id !== id) return;
        done(event.data.result);
      };
      window.addEventListener('message', handler);
      const targetOrigin = getFrameOrigin(frame);
      frame.contentWindow.postMessage({
        type: 'WEBMCP_IFRAME_CMD',
        cmd,
        params,
        framePath: remainingPath,
        timeoutMs,
        id,
      }, targetOrigin);
      timer = setTimeout(() => {
        done(mcpError(`Timeout communicating with iframe: ${targetDescription}. Note: cross-origin iframes must have register-tools.js injected via all_frames: true.`));
      }, Number(timeoutMs) || 5000);
    });
  }

  // Iframe command receiver (runs inside the iframe)
  if (window !== window.top) {
    window.addEventListener('message', async (event) => {
      if (event.data?.type === 'WEBMCP_IFRAME_CMD') {
        if (event.source !== window.parent) return;
        const { cmd, params, id } = event.data;
        if (cmd === 'execute_javascript' && event.origin !== location.origin && location.origin !== 'null') {
          event.source.postMessage({
            type: 'WEBMCP_IFRAME_RES',
            id,
            result: mcpError('Cross-origin iframe execute_javascript is blocked for security'),
          }, event.origin || '*');
          return;
        }
        let result;
        try {
          if (Array.isArray(event.data.framePath) && event.data.framePath.length > 0) {
            result = await invokeIframe(event.data.framePath, cmd, params, event.data.timeoutMs);
          } else {
            const ctx = document.modelContext || navigator.modelContext;
            if (ctx) {
              const fn = typeof ctx.invokeTool === 'function' ? ctx.invokeTool : ctx.executeTool;
              if (typeof fn === 'function') {
                result = await fn.call(ctx, cmd, params);
              } else {
                result = mcpError('modelContext.invokeTool not available in iframe');
              }
            } else {
              result = mcpError('navigator.modelContext not available in iframe');
            }
          }
        } catch (err) {
          result = mcpError(err.message);
        }
        event.source.postMessage({ type: 'WEBMCP_IFRAME_RES', id, result }, event.origin || '*');
      }
    });
  }

  window.__webmcp_internal__ = Object.freeze({
    mcpResult,
    mcpError,
    invokeBackground,
    FRAME_SELECTOR_SCHEMA,
    FRAME_PATH_SCHEMA,
    FRAME_TIMEOUT_SCHEMA,
    cleanFrameParams,
    shouldInvokeFrame,
    invokeFrameForTool,
    invokeIframe,
  });
})();
