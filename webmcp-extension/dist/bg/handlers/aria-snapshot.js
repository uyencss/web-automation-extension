// ============================================================
// WebMCP — ARIA Snapshot Handler
//
// Inspired by Browser-MCP's ref-based interaction model.
// Provides an accessibility-tree snapshot with unique ref IDs
// so AI can interact with elements using stable refs instead of
// fragile CSS selectors.
// ============================================================

import { resolveTabId } from '../utils.js';
import { sendCDPCommand, evaluateInTab } from '../cdp-bridge.js';
import { waitForPageStable } from './page-stability.js';

// ── In-memory ref map per tab ──────────────────────────────
// Maps ref string → { backendNodeId, tabId } for resolving refs to elements.
const refMaps = new Map();

function getRefMap(tabId) {
  if (!refMaps.has(tabId)) {
    refMaps.set(tabId, new Map());
  }
  return refMaps.get(tabId);
}

// Clean up ref maps when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  refMaps.delete(tabId);
});

export const ariaSnapshotHandlers = {
  /**
   * Capture an ARIA snapshot of the current page.
   *
   * Returns a readable text representation of the accessibility tree
   * with ref IDs (e.g., "ref=S1") that can be used with clickByRef,
   * typeByRef, etc.
   */
  async getAriaSnapshot(params) {
    const tabId = await resolveTabId(params);
    const { maxDepth = 8 } = params;

    // Enable accessibility domain
    await sendCDPCommand(tabId, 'Accessibility.enable', {});

    const tree = await sendCDPCommand(tabId, 'Accessibility.getFullAXTree', { depth: maxDepth });

    // Clear previous ref map for this tab
    const refMap = getRefMap(tabId);
    refMap.clear();

    // Build a simplified, readable snapshot
    let refCounter = 0;
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
      'tabpanel', 'tree', 'menu', 'menubar', 'grid',
    ]);

    // Build node lookup by nodeId
    const nodeById = new Map();
    for (const node of tree.nodes) {
      nodeById.set(node.nodeId, node);
    }

    const lines = [];
    const visited = new Set();

    function formatNode(node, indent = 0) {
      if (visited.has(node.nodeId)) return;
      visited.add(node.nodeId);

      const role = (node.role?.value || '').toLowerCase();
      const name = (node.name?.value || '').trim();
      const value = (node.value?.value || '').trim();
      const description = (node.description?.value || '').trim();

      // Skip ignored/none nodes
      if (role === 'none' || role === 'presentation' || role === 'generic') {
        // Still recurse into children
        if (node.childIds) {
          for (const childId of node.childIds) {
            const child = nodeById.get(childId);
            if (child) formatNode(child, indent);
          }
        }
        return;
      }

      // Skip empty non-interactive non-landmark nodes
      const isInteractive = interactiveRoles.has(role);
      const isLandmark = landmarkRoles.has(role);
      const isStructural = structuralRoles.has(role);
      const hasContent = name || value || description;

      if (!isInteractive && !isLandmark && !isStructural && !hasContent) {
        if (node.childIds) {
          for (const childId of node.childIds) {
            const child = nodeById.get(childId);
            if (child) formatNode(child, indent);
          }
        }
        return;
      }

      // Assign a ref ID to interactive elements
      let ref = null;
      if (isInteractive && node.backendDOMNodeId) {
        refCounter++;
        ref = `S${refCounter}`;
        refMap.set(ref, {
          backendNodeId: node.backendDOMNodeId,
          tabId,
          role,
          name,
        });
      }

      // Build the line
      const prefix = '  '.repeat(indent);
      const parts = [];
      if (ref) parts.push(`ref=${ref}`);
      parts.push(role);
      if (name) parts.push(`"${name.slice(0, 120)}"`);
      if (value) parts.push(`value="${value.slice(0, 80)}"`);

      // Add state attributes for interactive elements
      if (isInteractive) {
        const props = node.properties || [];
        const disabled = props.find(p => p.name === 'disabled')?.value?.value;
        const checked = props.find(p => p.name === 'checked')?.value?.value;
        const selected = props.find(p => p.name === 'selected')?.value?.value;
        const expanded = props.find(p => p.name === 'expanded')?.value?.value;
        const required = props.find(p => p.name === 'required')?.value?.value;
        if (disabled) parts.push('[disabled]');
        if (checked === 'true' || checked === 'mixed') parts.push(`[checked=${checked}]`);
        if (selected) parts.push('[selected]');
        if (expanded !== undefined) parts.push(`[expanded=${expanded}]`);
        if (required) parts.push('[required]');
      }

      // Heading level
      if (role === 'heading') {
        const level = (node.properties || []).find(p => p.name === 'level')?.value?.value;
        if (level) parts.push(`(h${level})`);
      }

      lines.push(`${prefix}- ${parts.join(' ')}`);

      // Recurse into children
      if (node.childIds && indent < maxDepth) {
        for (const childId of node.childIds) {
          const child = nodeById.get(childId);
          if (child) formatNode(child, indent + 1);
        }
      }
    }

    // Find root node and start building
    const rootNode = tree.nodes.find(n =>
      n.role?.value === 'RootWebArea' || n.role?.value === 'rootWebArea' || !n.parentId
    );
    if (rootNode) {
      formatNode(rootNode, 0);
    } else {
      // Fallback: format all root-level nodes
      for (const node of tree.nodes) {
        if (!node.parentId) formatNode(node, 0);
      }
    }

    const snapshot = lines.join('\n');

    return {
      tabId,
      snapshot,
      refCount: refMap.size,
      totalNodes: tree.nodes.length,
      usage: 'Use ref values (e.g. ref=S1) with clickByRef, typeByRef, hoverByRef, or selectByRef to interact with elements.',
    };
  },

  /**
   * Click an element by its ARIA snapshot ref.
   */
  async clickByRef(params) {
    const { ref, element } = params;
    if (!ref) throw new Error('Missing required param: ref');
    const tabId = await resolveTabId(params);
    const refMap = getRefMap(tabId);
    const refEntry = refMap.get(ref);

    if (!refEntry) {
      throw new Error(
        `Ref "${ref}" not found. Run getAriaSnapshot first to get fresh refs.`
      );
    }

    // Resolve backendNodeId to a RemoteObject
    const { object } = await sendCDPCommand(tabId, 'DOM.resolveNode', {
      backendNodeId: refEntry.backendNodeId,
    });

    if (!object || !object.objectId) {
      throw new Error(`Could not resolve ref "${ref}" to a DOM element. The element may have been removed.`);
    }

    // Scroll into view, get coordinates, and click
    const coords = await evaluateInTab(tabId, `
      (() => {
        const el = document.querySelector('[data-webmcp-ref="${ref}"]') ||
          (() => {
            // Find element by backendNodeId via CDP resolved object
            return null;
          })();
        return null; // Will use CDP approach below
      })()
    `);

    // Use CDP to scroll into view and get box model
    try {
      await sendCDPCommand(tabId, 'DOM.scrollIntoViewIfNeeded', {
        backendNodeId: refEntry.backendNodeId,
      });
    } catch {
      // Fallback: use JS scrollIntoView via the resolved object
      await sendCDPCommand(tabId, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { this.scrollIntoView({ behavior: "instant", block: "center" }); }',
      });
    }

    // Get the element's bounding box
    const { model } = await sendCDPCommand(tabId, 'DOM.getBoxModel', {
      backendNodeId: refEntry.backendNodeId,
    });

    if (!model) {
      throw new Error(`Could not get box model for ref "${ref}".`);
    }

    // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
    const quad = model.content;
    const centerX = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
    const centerY = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);

    // Dispatch click via CDP Input
    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: centerX, y: centerY });
    await new Promise(r => setTimeout(r, 30));
    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: centerX, y: centerY, button: 'left', clickCount: 1 });
    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: centerX, y: centerY, button: 'left', clickCount: 1 });

    // Wait for page to stabilize
    await waitForPageStable(tabId);

    // Release the object
    try {
      await sendCDPCommand(tabId, 'Runtime.releaseObject', { objectId: object.objectId });
    } catch { /* ignore */ }

    return {
      tabId,
      ref,
      element: element || refEntry.name || refEntry.role,
      clicked: true,
      coordinates: { x: centerX, y: centerY },
    };
  },

  /**
   * Type text into an element identified by ARIA ref.
   */
  async typeByRef(params) {
    const { ref, text, submit = false } = params;
    if (!ref) throw new Error('Missing required param: ref');
    if (text === undefined) throw new Error('Missing required param: text');
    const tabId = await resolveTabId(params);
    const refMap = getRefMap(tabId);
    const refEntry = refMap.get(ref);

    if (!refEntry) {
      throw new Error(
        `Ref "${ref}" not found. Run getAriaSnapshot first to get fresh refs.`
      );
    }

    // Resolve the node
    const { object } = await sendCDPCommand(tabId, 'DOM.resolveNode', {
      backendNodeId: refEntry.backendNodeId,
    });

    if (!object || !object.objectId) {
      throw new Error(`Could not resolve ref "${ref}" to a DOM element.`);
    }

    // Focus the element
    try {
      await sendCDPCommand(tabId, 'DOM.focus', {
        backendNodeId: refEntry.backendNodeId,
      });
    } catch {
      await sendCDPCommand(tabId, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { this.focus(); }',
      });
    }

    // Clear existing value and type new text
    await sendCDPCommand(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        if ('value' in this) {
          const proto = this instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(this, '');
          else this.value = '';
        }
      }`,
    });

    // Use Input.insertText for reliable typing
    await sendCDPCommand(tabId, 'Input.insertText', { text });

    // Fire events
    await sendCDPCommand(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
    });

    // Submit if requested (press Enter)
    if (submit) {
      await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
      await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
    }

    // Wait for page to stabilize
    await waitForPageStable(tabId);

    // Release the object
    try {
      await sendCDPCommand(tabId, 'Runtime.releaseObject', { objectId: object.objectId });
    } catch { /* ignore */ }

    return {
      tabId,
      ref,
      typed: text.length,
      submitted: submit,
    };
  },

  /**
   * Hover over an element by its ARIA ref.
   */
  async hoverByRef(params) {
    const { ref } = params;
    if (!ref) throw new Error('Missing required param: ref');
    const tabId = await resolveTabId(params);
    const refMap = getRefMap(tabId);
    const refEntry = refMap.get(ref);

    if (!refEntry) {
      throw new Error(
        `Ref "${ref}" not found. Run getAriaSnapshot first to get fresh refs.`
      );
    }

    // Scroll into view
    try {
      await sendCDPCommand(tabId, 'DOM.scrollIntoViewIfNeeded', {
        backendNodeId: refEntry.backendNodeId,
      });
    } catch { /* ignore */ }

    // Get bounding box
    const { model } = await sendCDPCommand(tabId, 'DOM.getBoxModel', {
      backendNodeId: refEntry.backendNodeId,
    });

    if (!model) throw new Error(`Could not get box model for ref "${ref}".`);

    const quad = model.content;
    const centerX = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
    const centerY = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);

    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: centerX, y: centerY,
    });

    return { tabId, ref, coordinates: { x: centerX, y: centerY } };
  },

  /**
   * Select option(s) in a dropdown by ARIA ref.
   */
  async selectByRef(params) {
    const { ref, values } = params;
    if (!ref) throw new Error('Missing required param: ref');
    if (!values || !Array.isArray(values)) throw new Error('Missing required param: values (array)');
    const tabId = await resolveTabId(params);
    const refMap = getRefMap(tabId);
    const refEntry = refMap.get(ref);

    if (!refEntry) {
      throw new Error(
        `Ref "${ref}" not found. Run getAriaSnapshot first to get fresh refs.`
      );
    }

    const { object } = await sendCDPCommand(tabId, 'DOM.resolveNode', {
      backendNodeId: refEntry.backendNodeId,
    });

    if (!object || !object.objectId) {
      throw new Error(`Could not resolve ref "${ref}" to a DOM element.`);
    }

    const result = await sendCDPCommand(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(vals) {
        if (!(this instanceof HTMLSelectElement)) {
          return { success: false, error: 'Element is not a <select>' };
        }
        const options = Array.from(this.options);
        let matched = [];
        for (const val of vals) {
          const opt = options.find(o => o.value === val || o.text.trim() === val);
          if (opt) { opt.selected = true; matched.push(opt.value); }
        }
        if (matched.length === 0) {
          return {
            success: false,
            error: 'No matching options found',
            available: options.slice(0, 20).map(o => ({ value: o.value, text: o.text.trim() })),
          };
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, selected: matched };
      }`,
      arguments: [{ value: values }],
      returnByValue: true,
    });

    // Wait for page to stabilize
    await waitForPageStable(tabId);

    try {
      await sendCDPCommand(tabId, 'Runtime.releaseObject', { objectId: object.objectId });
    } catch { /* ignore */ }

    return { tabId, ref, ...result.result?.value };
  },
};
