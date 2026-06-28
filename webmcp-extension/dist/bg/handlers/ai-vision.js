import { resolveTabId } from '../utils.js';
import { sendCDPCommand, evaluateInTab } from '../cdp-bridge.js';
import { DOM_DEEP_HELPERS } from './dom-helpers.js';

export const aiVisionHandlers = {
  async getAccessibilityTree(params) {
    const tabId = await resolveTabId(params);
    const { depth = -1, interestingOnly = true } = params;

    // Enable accessibility domain
    await sendCDPCommand(tabId, 'Accessibility.enable', {});

    const tree = await sendCDPCommand(tabId, 'Accessibility.getFullAXTree', { depth });

    if (!interestingOnly) return { tabId, nodes: tree.nodes };

    // Filter to only interactive/meaningful nodes
    const interestingRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
      'menuitem', 'tab', 'heading', 'img', 'listitem', 'option',
      'searchbox', 'switch', 'slider', 'spinbutton', 'table',
      'row', 'cell', 'dialog', 'alert', 'navigation', 'main',
      'form', 'list', 'tree', 'treeitem', 'banner', 'complementary',
    ]);

    const filtered = tree.nodes.filter((n) => {
      const role = n.role?.value?.toLowerCase();
      if (interestingRoles.has(role)) return true;
      if (n.name?.value?.trim()) return true;
      return false;
    });

    const simplified = filtered.map((n) => ({
      nodeId: n.nodeId,
      role: n.role?.value,
      name: n.name?.value,
      description: n.description?.value,
      value: n.value?.value,
      disabled: n.properties?.find(p => p.name === 'disabled')?.value?.value,
      focused: n.properties?.find(p => p.name === 'focused')?.value?.value,
      checked: n.properties?.find(p => p.name === 'checked')?.value?.value,
      backendDOMNodeId: n.backendDOMNodeId,
      childIds: n.childIds,
    }));

    return { tabId, nodeCount: simplified.length, nodes: simplified };
  },

  async getDOMSnapshot(params) {
    const tabId = await resolveTabId(params);
    const { computedStyles = ['display', 'visibility', 'opacity', 'color', 'font-size'] } = params;

    const result = await sendCDPCommand(tabId, 'DOMSnapshot.captureSnapshot', {
      computedStyles,
      includeDOMRects: true,
      includePaintOrder: true,
      includeBlendedBackgroundColors: true,
    });

    return { tabId, ...result };
  },

  async getElementBounds(params) {
    const { selector } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);
    const { pierceShadow = true } = params;

    const result = await evaluateInTab(tabId, `
      (() => {
        ${pierceShadow ? DOM_DEEP_HELPERS : ''}
        const els = ${pierceShadow
          ? `__webmcpQueryDeep(${JSON.stringify(selector)})`
          : `document.querySelectorAll(${JSON.stringify(selector)})`};
        return Array.from(els).slice(0, 50).map((el, i) => {
          const rect = el.getBoundingClientRect();
          return {
            index: i,
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            text: (el.textContent || '').trim().slice(0, 100),
            role: el.getAttribute('role') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              centerX: Math.round(rect.x + rect.width / 2),
              centerY: Math.round(rect.y + rect.height / 2),
            },
            visible: rect.width > 0 && rect.height > 0 &&
              getComputedStyle(el).display !== 'none' &&
              getComputedStyle(el).visibility !== 'hidden',
          };
        });
      })()
    `);
    return { tabId, elements: result };
  },

  async getInteractiveElements(params) {
    const tabId = await resolveTabId(params);
    const { pierceShadow = true } = params;

    const result = await evaluateInTab(tabId, `
      (() => {
        ${pierceShadow ? DOM_DEEP_HELPERS : ''}
        const selectors = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="searchbox"],[contenteditable="true"]';
        const els = ${pierceShadow
          ? `__webmcpQueryDeep(selectors)`
          : `document.querySelectorAll(selectors)`};
        return Array.from(els).slice(0, 200).map((el, i) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return null;
          return {
            index: i,
            tag: el.tagName.toLowerCase(),
            type: el.type || undefined,
            id: el.id || undefined,
            name: el.name || undefined,
            role: el.getAttribute('role') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            text: (el.textContent || '').trim().slice(0, 100),
            placeholder: el.placeholder || undefined,
            href: el.href || undefined,
            value: el.value || undefined,
            checked: el.checked ?? undefined,
            disabled: el.disabled || undefined,
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              centerX: Math.round(rect.x + rect.width / 2),
              centerY: Math.round(rect.y + rect.height / 2),
            },
          };
        }).filter(Boolean);
      })()
    `);
    return { tabId, elements: result };
  }
};
