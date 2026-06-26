import { resolveTabId } from '../utils.js';
import { sendCDPCommand, evaluateInTab } from '../cdp-bridge.js';

export const cdpInputHandlers = {
  async dispatchClick(params) {
    const { x, y, button = 'left', clickCount = 1 } = params;
    if (x === undefined || y === undefined) throw new Error('Missing required params: x, y');
    const tabId = await resolveTabId(params);

    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await new Promise(r => setTimeout(r, 50));
    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });

    return { tabId, clicked: true, x, y, button };
  },

  async moveMouse(params) {
    const { x, y, steps = 1 } = params;
    if (x === undefined || y === undefined) throw new Error('Missing required params: x, y');
    const tabId = await resolveTabId(params);

    const startX = params.fromX ?? 0;
    const startY = params.fromY ?? 0;

    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const currentX = startX + (x - startX) * progress;
      const currentY = startY + (y - startY) * progress;
      await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(currentX),
        y: Math.round(currentY),
      });
    }

    return { tabId, x, y };
  },

  async pressKey(params) {
    const { key, text, modifiers = [] } = params;
    if (!key) throw new Error('Missing required param: key');
    const tabId = await resolveTabId(params);

    let modifierFlags = 0;
    if (modifiers.includes('alt')) modifierFlags |= 1;
    if (modifiers.includes('ctrl')) modifierFlags |= 2;
    if (modifiers.includes('meta')) modifierFlags |= 4;
    if (modifiers.includes('shift')) modifierFlags |= 8;

    const specialKeys = {
      Enter: { keyCode: 13, code: 'Enter' },
      Tab: { keyCode: 9, code: 'Tab' },
      Escape: { keyCode: 27, code: 'Escape' },
      Backspace: { keyCode: 8, code: 'Backspace' },
      Delete: { keyCode: 46, code: 'Delete' },
      ArrowUp: { keyCode: 38, code: 'ArrowUp' },
      ArrowDown: { keyCode: 40, code: 'ArrowDown' },
      ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
      ArrowRight: { keyCode: 39, code: 'ArrowRight' },
      Home: { keyCode: 36, code: 'Home' },
      End: { keyCode: 35, code: 'End' },
      PageUp: { keyCode: 33, code: 'PageUp' },
      PageDown: { keyCode: 34, code: 'PageDown' },
      Space: { keyCode: 32, code: 'Space', text: ' ' },
    };

    const special = specialKeys[key];
    const keyCode = special?.keyCode || key.charCodeAt(0);
    const code = special?.code || `Key${key.toUpperCase()}`;
    const keyText = text || special?.text || (key.length === 1 ? key : '');

    await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      modifiers: modifierFlags, ...(keyText ? { text: keyText, unmodifiedText: keyText } : {}),
    });

    if (keyText) {
      await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'char', key: keyText, code, text: keyText, unmodifiedText: keyText,
        windowsVirtualKeyCode: keyCode, modifiers: modifierFlags,
      });
    }

    await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      modifiers: modifierFlags,
    });

    return { tabId, key, modifiers };
  },

  async typeText(params) {
    const { text } = params;
    if (!text) throw new Error('Missing required param: text');
    const tabId = await resolveTabId(params);

    await sendCDPCommand(tabId, 'Input.insertText', { text });
    return { tabId, typed: text.length };
  },

  async scroll(params) {
    const { x = 0, y = 0, deltaX = 0, deltaY = 0 } = params;
    const tabId = await resolveTabId(params);

    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX, deltaY,
    });

    return { tabId, deltaX, deltaY };
  },

  async hover(params) {
    const { selector } = params;
    if (!selector) throw new Error('Missing required param: selector');
    const tabId = await resolveTabId(params);

    const bounds = await evaluateInTab(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        };
      })()
    `);

    if (!bounds) throw new Error(`Element not found: ${selector}`);

    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: bounds.x, y: bounds.y,
    });

    return { tabId, selector };
  },

  async selectOption(params) {
    const { selector, value, index, text } = params;
    if (!selector) throw new Error('Missing required param: selector');
    if (value === undefined && index === undefined && text === undefined) {
      throw new Error('Missing one of required params: value, index, text');
    }
    const tabId = await resolveTabId(params);
    const payload = { selector, value, index, text };

    const result = await evaluateInTab(tabId, `
      (() => {
        const input = ${JSON.stringify(payload)};
        const el = document.querySelector(input.selector);
        if (!el) return { success: false, error: 'Element not found: ' + input.selector };
        if (!(el instanceof HTMLSelectElement)) {
          return { success: false, error: 'Element is not a <select>: ' + input.selector };
        }

        const options = Array.from(el.options);
        let option = null;

        if (input.value !== undefined) {
          option = options.find((item) => item.value === String(input.value));
        }
        if (!option && input.text !== undefined) {
          const wantedText = String(input.text).trim();
          option = options.find((item) => item.text.trim() === wantedText);
        }
        if (!option && input.index !== undefined) {
          option = options[Number(input.index)] || null;
        }
        if (!option) {
          return {
            success: false,
            error: 'No matching option found',
            availableOptions: options.slice(0, 25).map((item, optionIndex) => ({
              index: optionIndex,
              value: item.value,
              text: item.text.trim(),
            })),
          };
        }

        el.value = option.value;
        option.selected = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        return {
          success: true,
          value: el.value,
          text: option.text.trim(),
          index: option.index,
          selector: input.selector,
        };
      })()
    `);

    return { tabId, ...result };
  }
};
