import { resolveTabId } from '../utils.js';
import {
  evaluateInFrameMainWorld,
  evaluateInTab,
  formatFrameTarget,
  getFrameViewportOffset,
  onTabDetached,
  resolveFrameTarget,
  sendCDPCommand,
} from '../cdp-bridge.js';

export const lastMousePos = new Map();

onTabDetached((tabId) => lastMousePos.delete(tabId));
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId) => lastMousePos.delete(tabId));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => min + Math.random() * (max - min);
const KEY_ASCII = /^[A-Za-z0-9 ]$/;
const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('vi', { granularity: 'grapheme' })
  : null;

function splitGraphemes(str) {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(str), (s) => s.segment);
  }
  return Array.from(str);
}

export async function moveTo(tabId, x, y, options = {}) {
  const { human = true, steps } = options;
  const targetX = Math.round(Number(x));
  const targetY = Math.round(Number(y));
  const from = options.fromX !== undefined && options.fromY !== undefined
    ? { x: Math.round(Number(options.fromX)), y: Math.round(Number(options.fromY)) }
    : lastMousePos.get(tabId);

  if (human && from && Math.hypot(targetX - from.x, targetY - from.y) > 4) {
    const dx = targetX - from.x, dy = targetY - from.y, dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist, ny = dx / dist;
    const k1 = rnd(-0.25, 0.25) * dist, k2 = rnd(-0.25, 0.25) * dist;
    const p1x = from.x + dx * 0.3 + nx * k1, p1y = from.y + dy * 0.3 + ny * k1;
    const p2x = from.x + dx * 0.7 + nx * k2, p2y = from.y + dy * 0.7 + ny * k2;
    const numSteps = steps || Math.max(4, Math.min(12, Math.round(dist / 45)));

    for (let i = 1; i < numSteps; i++) {
      const t = (1 - Math.cos(Math.PI * i / numSteps)) / 2, u = 1 - t;
      const bx = Math.round(u * u * u * from.x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * targetX);
      const by = Math.round(u * u * u * from.y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * targetY);
      await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by, buttons: 0 });
      await sleep(rnd(8, 16));
    }
  } else if (!human && steps && steps > 1 && from) {
    for (let i = 1; i < steps; i++) {
      const progress = i / steps;
      const currentX = Math.round(from.x + (targetX - from.x) * progress);
      const currentY = Math.round(from.y + (targetY - from.y) * progress);
      await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: currentX,
        y: currentY,
        buttons: 0,
      });
    }
  }

  await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: targetY, buttons: 0 });
  lastMousePos.set(tabId, { x: targetX, y: targetY });
  return { x: targetX, y: targetY };
}

export async function clickAt(tabId, target, options = {}) {
  const { button = 'left', clickCount = 1, human = true } = options;
  let x, y;

  if (target.pointX !== undefined && target.pointY !== undefined) {
    x = Math.round(Number(target.pointX));
    y = Math.round(Number(target.pointY));
  } else if (target.width > 0 && target.height > 0) {
    const fx = human ? rnd(0.35, 0.65) : 0.5;
    const fy = human ? rnd(0.35, 0.65) : 0.5;
    x = Math.round(Number(target.x) + Number(target.width) * fx);
    y = Math.round(Number(target.y) + Number(target.height) * fy);
  } else {
    x = Math.round(Number(target.x));
    y = Math.round(Number(target.y));
  }

  await moveTo(tabId, x, y, { human });
  if (human) await sleep(rnd(35, 110));

  const buttons = { left: 1, right: 2, middle: 4 }[button] ?? 1;
  for (let c = 1; c <= clickCount; c++) {
    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons,
      clickCount: c,
    });
    if (human) await sleep(rnd(45, 115));
    await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: c,
    });
    if (human && c < clickCount) await sleep(rnd(60, 120));
  }

  return { x, y, button, clickCount };
}

export async function typeInto(tabId, text, options = {}) {
  const { human = true, clearEmptyWithBackspace = false } = options;
  const str = String(text ?? '');

  if (str === '') {
    if (clearEmptyWithBackspace) {
      await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
      await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
    }
    return { typed: 0, cleared: Boolean(clearEmptyWithBackspace) };
  }

  if (!human || str.length > 120) {
    await sendCDPCommand(tabId, 'Input.insertText', { text: str });
    return { typed: str.length, mode: 'insertText' };
  }

  const graphemes = splitGraphemes(str);
  for (const ch of graphemes) {
    if (KEY_ASCII.test(ch)) {
      const up = ch.toUpperCase();
      const code = ch === ' ' ? 'Space' : /\d/.test(ch) ? 'Digit' + ch : 'Key' + up;
      const keyCode = up.charCodeAt(0);
      const modifiers = /[A-Z]/.test(ch) ? 8 : 0;
      await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: ch,
        code,
        text: ch,
        unmodifiedText: ch.toLowerCase(),
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers,
      });
      await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: ch,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers,
      });
    } else {
      await sendCDPCommand(tabId, 'Input.insertText', { text: ch });
    }
    await sleep(/[\s.,!?;:]/.test(ch) ? rnd(110, 210) : rnd(35, 95));
  }

  return { typed: str.length, mode: 'humanKeystroke' };
}

async function getFrameContext(tabId, frameSpec) {
  if (!frameSpec) {
    return {
      evaluate: (expr) => evaluateInTab(tabId, expr),
      frameTarget: null,
      offset: { x: 0, y: 0 },
    };
  }
  const frameTarget = await resolveFrameTarget(tabId, frameSpec);
  return {
    evaluate: (expr) => evaluateInFrameMainWorld(tabId, frameTarget, expr),
    frameTarget,
    offset: await getFrameViewportOffset(tabId, frameTarget),
  };
}

function addOffset(value, offset) {
  return Math.round(Number(value) + Number(offset || 0));
}

export const cdpInputHandlers = {
  async dispatchClick(params) {
    const { x, y, button = 'left', clickCount = 1 } = params;
    if (x === undefined || y === undefined) throw new Error('Missing required params: x, y');
    const tabId = await resolveTabId(params);
    const { frameTarget, offset } = await getFrameContext(tabId, params.frame);
    const targetX = addOffset(x, offset.x);
    const targetY = addOffset(y, offset.y);

    await clickAt(tabId, { x: targetX, y: targetY, width: 0, height: 0 }, {
      button,
      clickCount,
      human: params.human !== false,
    });

    return {
      tabId,
      ...(frameTarget ? { frame: formatFrameTarget(frameTarget), local: { x, y }, offset } : {}),
      clicked: true,
      x: targetX,
      y: targetY,
      button,
    };
  },

  async moveMouse(params) {
    const { x, y } = params;
    if (x === undefined || y === undefined) throw new Error('Missing required params: x, y');
    const tabId = await resolveTabId(params);
    const { frameTarget, offset } = await getFrameContext(tabId, params.frame);
    const targetX = addOffset(x, offset.x);
    const targetY = addOffset(y, offset.y);

    await moveTo(tabId, targetX, targetY, {
      human: params.human !== false,
      steps: params.steps,
      fromX: params.fromX !== undefined ? addOffset(params.fromX, offset.x) : undefined,
      fromY: params.fromY !== undefined ? addOffset(params.fromY, offset.y) : undefined,
    });

    return {
      tabId,
      ...(frameTarget ? { frame: formatFrameTarget(frameTarget), local: { x, y }, offset } : {}),
      x: targetX,
      y: targetY,
    };
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
      Enter: { keyCode: 13, code: 'Enter', text: '\r' },
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

    await sendCDPCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      modifiers: modifierFlags,
    });

    return { tabId, key, modifiers };
  },

  async typeText(params) {
    const { text } = params;
    if (!text && text !== '') throw new Error('Missing required param: text');
    const tabId = await resolveTabId(params);

    await typeInto(tabId, text, { human: params.human !== false });
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
    const { evaluate, frameTarget, offset } = await getFrameContext(tabId, params.frame);

    const bounds = await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = el.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      })()
    `);

    if (!bounds) throw new Error(`Element not found: ${selector}`);
    const isHuman = params.human !== false;
    const fx = isHuman && bounds.width > 0 ? rnd(0.35, 0.65) : 0.5;
    const fy = isHuman && bounds.height > 0 ? rnd(0.35, 0.65) : 0.5;
    const localX = Math.round(bounds.x + bounds.width * fx);
    const localY = Math.round(bounds.y + bounds.height * fy);
    const x = addOffset(localX, offset.x);
    const y = addOffset(localY, offset.y);

    await moveTo(tabId, x, y, { human: isHuman });

    return {
      tabId,
      selector,
      ...(frameTarget ? { frame: formatFrameTarget(frameTarget), local: { x: localX, y: localY }, offset } : {}),
      x,
      y,
    };
  },

  async selectOption(params) {
    const { selector, value, index, text } = params;
    if (!selector) throw new Error('Missing required param: selector');
    if (value === undefined && index === undefined && text === undefined) {
      throw new Error('Missing one of required params: value, index, text');
    }
    const tabId = await resolveTabId(params);
    const payload = { selector, value, index, text };
    const { evaluate, frameTarget } = await getFrameContext(tabId, params.frame);

    const result = await evaluate(`
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

    return {
      tabId,
      ...(frameTarget ? { frame: formatFrameTarget(frameTarget) } : {}),
      ...result,
    };
  }
};
