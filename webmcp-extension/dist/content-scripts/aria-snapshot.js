// ============================================================
// WebMCP Tools Provider — Fast ARIA Snapshot Content Script
//
// Runs in the ISOLATED world. Produces a lightweight ARIA-like
// snapshot without CDP Accessibility round-trips and keeps stable
// per-document refs with WeakRef.
// ============================================================

(() => {
  if (window.__WEBMCP_FAST_ARIA_SNAPSHOT__) return;
  window.__WEBMCP_FAST_ARIA_SNAPSHOT__ = true;

  const REF_TTL_MS = 10 * 60 * 1000;
  const MAX_STORED_REFS = 1000;
  const MAX_VISITED_ELEMENTS = 10000;
  const DEFAULT_MAX_DEPTH = 8;
  const DEFAULT_MAX_NODES = 250;
  const DEFAULT_VIEWPORT_MARGIN = 32;
  const documentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  const elementToRef = new WeakMap();
  const refToElement = new Map();
  const refMetadata = new Map();
  let nextRefId = 1;

  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'menuitem', 'tab', 'option', 'searchbox', 'switch', 'slider',
    'spinbutton', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
  ]);

  const landmarkRoles = new Set([
    'navigation', 'main', 'banner', 'complementary', 'contentinfo',
    'form', 'search', 'region', 'dialog', 'alert', 'alertdialog',
  ]);

  const structuralRoles = new Set([
    'heading', 'list', 'listitem', 'table', 'row', 'cell',
    'columnheader', 'rowheader', 'group', 'toolbar', 'tablist',
    'tabpanel', 'tree', 'menu', 'menubar', 'grid', 'img',
  ]);

  const sensitivePattern = [
    'password', 'passcode', 'passwd', 'pwd', 'secret', 'token',
    'access_token', 'refresh_token', 'api_key', 'apikey', 'otp',
    'one-time-code', 'one time code', 'verification code', '2fa',
    'mfa', 'cvv', 'cvc', 'security code', 'card number',
    'credit card', 'cc-number', 'cc-csc', 'ssn',
  ].join('|');
  const sensitiveRegex = new RegExp(sensitivePattern, 'i');

  function collapseText(value, maxLength = 120) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function getOwnText(element, maxLength = 120) {
    const chunks = [];
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = collapseText(node.textContent, maxLength);
        if (text) chunks.push(text);
      }
    }
    return collapseText(chunks.join(' '), maxLength);
  }

  function getLabelText(element) {
    if (element.id) {
      const label = document.querySelector(`label[for="${cssEscape(element.id)}"]`);
      if (label) return collapseText(label.textContent, 120);
    }
    const wrappingLabel = element.closest('label');
    if (wrappingLabel) return collapseText(wrappingLabel.textContent, 120);
    return '';
  }

  function getLabelledByText(element) {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (!labelledBy) return '';
    return collapseText(labelledBy.split(/\s+/).map((id) => {
      const label = document.getElementById(id);
      return label ? label.textContent : '';
    }).join(' '), 120);
  }

  function getImplicitRole(element) {
    const tag = element.localName;
    if (!tag) return '';

    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'aside') return 'complementary';
    if (tag === 'form') return 'form';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return 'columnheader';
    if (tag === 'img' || tag === 'svg') return 'img';
    if (tag === 'iframe') return 'iframe';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'header') return element.closest('article,section,main') ? 'group' : 'banner';
    if (tag === 'footer') return element.closest('article,section,main') ? 'group' : 'contentinfo';
    if (tag === 'section' && (element.getAttribute('aria-label') || element.getAttribute('aria-labelledby'))) return 'region';
    if (tag === 'summary') return 'button';
    if (element.isContentEditable) return 'textbox';

    if (tag === 'input') {
      const type = String(element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return '';
      return 'textbox';
    }

    return '';
  }

  function getRole(element) {
    const explicitRole = collapseText(element.getAttribute('role'), 60).toLowerCase();
    if (explicitRole && explicitRole !== 'none' && explicitRole !== 'presentation') {
      return explicitRole.split(/\s+/)[0];
    }
    return getImplicitRole(element);
  }

  function getAccessibleName(element, role) {
    const ariaLabel = collapseText(element.getAttribute('aria-label'), 120);
    if (ariaLabel) return ariaLabel;

    const labelledBy = getLabelledByText(element);
    if (labelledBy) return labelledBy;

    const tag = element.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return getLabelText(element) ||
        collapseText(element.getAttribute('placeholder'), 120) ||
        collapseText(element.getAttribute('name'), 120);
    }

    if (tag === 'img' || tag === 'svg') {
      return collapseText(element.getAttribute('alt') || element.getAttribute('title'), 120);
    }

    if (role === 'button' || role === 'link' || role === 'heading' || role === 'option' ||
        role === 'tab' || role === 'menuitem' || role === 'checkbox' || role === 'radio' ||
        role === 'switch' || role === 'listitem') {
      return getOwnText(element, 120) ||
        collapseText(element.textContent, 120) ||
        collapseText(element.getAttribute('title'), 120);
    }

    return collapseText(element.getAttribute('title'), 120);
  }

  function isSensitiveField(element, name) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const type = String(element.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    const hints = [
      element.getAttribute('autocomplete'),
      element.getAttribute('name'),
      element.id,
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      name,
    ].filter(Boolean).join(' ');
    return sensitiveRegex.test(hints);
  }

  function getValue(element, role, name) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (isSensitiveField(element, name)) return '[value redacted]';
      if (element.type === 'checkbox' || element.type === 'radio') return '';
      return collapseText(element.value, 80);
    }
    if (element instanceof HTMLSelectElement) {
      return collapseText(Array.from(element.selectedOptions).map((option) => option.textContent).join(', '), 80);
    }
    if (role === 'slider' || role === 'spinbutton') {
      return collapseText(element.getAttribute('aria-valuetext') || element.getAttribute('aria-valuenow'), 80);
    }
    return '';
  }

  function isVisible(element) {
    if (element === document.documentElement || element === document.body) return true;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isInViewport(element, margin) {
    if (element === document.documentElement || element === document.body) return true;
    const rect = element.getBoundingClientRect();
    return rect.bottom >= -margin &&
      rect.right >= -margin &&
      rect.top <= window.innerHeight + margin &&
      rect.left <= window.innerWidth + margin;
  }

  function getBounds(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centerX: Math.round(rect.x + rect.width / 2),
      centerY: Math.round(rect.y + rect.height / 2),
    };
  }

  function stateParts(element, role) {
    const parts = [];
    if (element.matches(':disabled,[aria-disabled="true"]')) parts.push('[disabled]');
    if (element.matches('[required],[aria-required="true"]')) parts.push('[required]');

    const expanded = element.getAttribute('aria-expanded');
    if (expanded !== null) parts.push(`[expanded=${expanded}]`);

    const pressed = element.getAttribute('aria-pressed');
    if (pressed !== null) parts.push(`[pressed=${pressed}]`);

    const selected = element.getAttribute('aria-selected');
    if (selected === 'true') parts.push('[selected]');

    const checked = element.getAttribute('aria-checked') ||
      (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')
        ? String(element.checked)
        : '');
    if (checked === 'true' || checked === 'mixed') parts.push(`[checked=${checked}]`);

    if (role === 'heading') {
      const tagLevel = /^h([1-6])$/.exec(element.localName || '');
      const level = element.getAttribute('aria-level') || tagLevel?.[1];
      if (level) parts.push(`(h${level})`);
    }

    return parts;
  }

  function makeLine(element, role, name, value, ref) {
    const parts = [];
    if (ref) parts.push(`ref=${ref}`);
    parts.push(role);
    if (name) parts.push(`"${name.replace(/"/g, '\\"')}"`);
    if (value) parts.push(`value="${value.replace(/"/g, '\\"')}"`);
    parts.push(...stateParts(element, role));
    return `- ${parts.join(' ')}`;
  }

  function getChildElements(element) {
    const children = Array.from(element.children || []);
    if (element.shadowRoot) {
      children.push(...Array.from(element.shadowRoot.children || []));
    }
    return children;
  }

  function pruneRefs() {
    const now = Date.now();
    for (const [ref, weakElement] of refToElement) {
      const meta = refMetadata.get(ref);
      const element = weakElement.deref();
      if (!element || !element.isConnected || (meta && now - meta.lastSeen > REF_TTL_MS)) {
        refToElement.delete(ref);
        refMetadata.delete(ref);
      }
    }

    if (refToElement.size <= MAX_STORED_REFS) return;
    const staleFirst = Array.from(refMetadata.entries()).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [ref] of staleFirst.slice(0, refToElement.size - MAX_STORED_REFS)) {
      refToElement.delete(ref);
      refMetadata.delete(ref);
    }
  }

  function ensureRef(element, metadata) {
    let ref = elementToRef.get(element);
    if (!ref) {
      ref = `R${nextRefId++}`;
      elementToRef.set(element, ref);
      refToElement.set(ref, new WeakRef(element));
    }
    refMetadata.set(ref, { ...metadata, lastSeen: Date.now() });
    return ref;
  }

  function buildSnapshot(params = {}) {
    pruneRefs();

    const maxDepth = Number.isFinite(params.maxDepth) ? params.maxDepth : DEFAULT_MAX_DEPTH;
    const maxNodes = Number.isFinite(params.maxNodes) ? params.maxNodes : DEFAULT_MAX_NODES;
    const viewportMargin = Number.isFinite(params.viewportMargin) ? params.viewportMargin : DEFAULT_VIEWPORT_MARGIN;
    const requestedScope = params.scope || 'auto';
    const scope = requestedScope === 'full' ? 'full' : 'viewport';
    const root = document.body || document.documentElement;

    let visited = 0;
    let truncated = false;

    function walk(element, depth) {
      if (!element || visited >= MAX_VISITED_ELEMENTS) {
        truncated = true;
        return [];
      }
      visited++;

      const childEntries = [];
      if (depth < maxDepth) {
        for (const child of getChildElements(element)) {
          if (childEntries.length > maxNodes * 4) {
            truncated = true;
            break;
          }
          childEntries.push(...walk(child, depth + 1));
        }
      }

      const role = getRole(element);
      const isInteractive = interactiveRoles.has(role);
      const isLandmark = landmarkRoles.has(role);
      const isStructural = structuralRoles.has(role);
      const name = role ? getAccessibleName(element, role) : '';
      const value = role ? getValue(element, role, name) : '';
      const meaningful = Boolean(role && (isInteractive || isLandmark || isStructural || name || value));
      const visible = meaningful && isVisible(element);
      const inScope = scope === 'full' || isInViewport(element, viewportMargin);
      const includeSelf = meaningful && visible && (inScope || childEntries.length > 0);

      if (!includeSelf) return childEntries;

      const bounds = getBounds(element);
      const ref = isInteractive ? ensureRef(element, { role, name, bounds, documentId }) : null;
      const line = makeLine(element, role, name, value, ref);
      return [
        { indent: 0, line },
        ...childEntries.map((entry) => ({ indent: entry.indent + 1, line: entry.line })),
      ];
    }

    const entries = root ? walk(root, 0) : [];
    if (entries.length > maxNodes) truncated = true;

    const visibleEntries = entries.slice(0, maxNodes);
    const rootLine = `- document "${collapseText(document.title || location.href, 120)}"`;
    const snapshot = [
      rootLine,
      ...visibleEntries.map((entry) => `${'  '.repeat(entry.indent + 1)}${entry.line}`),
    ].join('\n');

    return {
      source: 'content-script',
      documentId,
      url: location.href,
      title: document.title,
      scope,
      snapshot,
      refCount: refToElement.size,
      nodeCount: visibleEntries.length + 1,
      totalCandidates: entries.length + 1,
      visited,
      truncated,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      },
    };
  }

  function resolveRef(ref) {
    const weakElement = refToElement.get(ref);
    const element = weakElement?.deref();
    if (!element || !element.isConnected) {
      refToElement.delete(ref);
      refMetadata.delete(ref);
      return null;
    }
    return element;
  }

  function assertActionable(element) {
    if (!isVisible(element)) return { ok: false, error: 'Element is not visible.' };
    if (element.matches(':disabled,[aria-disabled="true"]')) return { ok: false, error: 'Element is disabled.' };
    return { ok: true };
  }

  function scrollToElement(element) {
    element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    return getBounds(element);
  }

  function dispatchMouseEvent(element, type, bounds) {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: bounds.centerX,
      clientY: bounds.centerY,
      button: 0,
    }));
  }

  function setNativeValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  function runRefAction(params = {}) {
    const { action, ref } = params;
    if (!ref) return { success: false, error: 'Missing ref.' };

    const element = resolveRef(ref);
    if (!element) {
      return { success: false, stale: true, error: `Ref "${ref}" is stale. Run getAriaSnapshot again.` };
    }

    const actionability = assertActionable(element);
    if (!actionability.ok) return { success: false, error: actionability.error };

    const bounds = scrollToElement(element);

    if (action === 'click') {
      dispatchMouseEvent(element, 'mouseover', bounds);
      dispatchMouseEvent(element, 'mousemove', bounds);
      dispatchMouseEvent(element, 'mousedown', bounds);
      dispatchMouseEvent(element, 'mouseup', bounds);
      element.click();
      return { success: true, clicked: true, ref, coordinates: { x: bounds.centerX, y: bounds.centerY } };
    }

    if (action === 'hover') {
      dispatchMouseEvent(element, 'mouseover', bounds);
      dispatchMouseEvent(element, 'mousemove', bounds);
      return { success: true, hovered: true, ref, coordinates: { x: bounds.centerX, y: bounds.centerY } };
    }

    if (action === 'type') {
      const text = params.text === undefined ? '' : String(params.text);
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) {
        return { success: false, error: 'Element is not text-editable.' };
      }
      element.focus();
      if (element.isContentEditable) {
        element.textContent = text;
      } else {
        setNativeValue(element, text);
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      if (params.submit) {
        element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
        element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
      }
      return { success: true, typed: text.length, submitted: Boolean(params.submit), ref };
    }

    if (action === 'select') {
      if (!(element instanceof HTMLSelectElement)) {
        return { success: false, error: 'Element is not a <select>.' };
      }
      const values = Array.isArray(params.values) ? params.values.map(String) : [];
      const matched = [];
      for (const option of element.options) {
        const shouldSelect = values.includes(option.value) || values.includes(collapseText(option.textContent, 200));
        if (shouldSelect) {
          option.selected = true;
          matched.push(option.value);
        } else if (!element.multiple) {
          option.selected = false;
        }
      }
      if (matched.length === 0) {
        return {
          success: false,
          error: 'No matching options found.',
          available: Array.from(element.options).slice(0, 20).map((option) => ({
            value: option.value,
            text: collapseText(option.textContent, 120),
          })),
        };
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, selected: matched, ref };
    }

    return { success: false, error: `Unknown ref action: ${action}` };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'WEBMCP_FAST_ARIA') return false;

    try {
      if (message.method === 'snapshot') {
        sendResponse({ ok: true, result: buildSnapshot(message.params || {}) });
        return false;
      }

      if (message.method === 'action') {
        sendResponse({ ok: true, result: runRefAction(message.params || {}) });
        return false;
      }

      sendResponse({ ok: false, error: `Unknown WEBMCP_FAST_ARIA method: ${message.method}` });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }

    return false;
  });
})();
