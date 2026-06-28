import { attachedTabs } from './state.js';

const CDP_TIMEOUT_MS = 30000;
const WEBMCP_WORLD_NAME = 'WebMCP';

const pageEnabledTabs = new Set();
const frameTreeCache = new Map();
const isolatedWorldCache = new Map();

export async function ensureDebuggerAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  } catch (err) {
    // Already attached (by another extension like Codex?)
    if (err.message?.includes('Another debugger is already attached')) {
      throw new Error(
        `Tab ${tabId} already has a debugger attached (likely Codex). ` +
        'Detach it first or use a different tab.'
      );
    }
    // Already attached by us
    if (err.message?.includes('already attached')) {
      attachedTabs.add(tabId);
      return;
    }
    throw err;
  }
}

export async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignore
  }
  attachedTabs.delete(tabId);
  invalidateFrameCaches(tabId);
}

export async function sendCDPCommand(tabId, method, commandParams = {}) {
  await ensureDebuggerAttached(tabId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CDP command "${method}" timed out after ${CDP_TIMEOUT_MS}ms`));
    }, CDP_TIMEOUT_MS);

    chrome.debugger.sendCommand({ tabId }, method, commandParams, (result) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// Clean up when debugger detaches
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    pageEnabledTabs.delete(source.tabId);
    invalidateFrameCaches(source.tabId);
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  if (
    method === 'Page.frameNavigated' ||
    method === 'Page.frameDetached' ||
    method === 'Page.frameStartedNavigating'
  ) {
    invalidateFrameCaches(source.tabId, params?.frame?.id || params?.frameId);
  }
});

export async function evaluateInTab(tabId, expression, awaitPromise = true) {
  const result = await sendCDPCommand(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.text ||
      result.exceptionDetails.exception?.description ||
      'JS evaluation error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

export function formatFrameTarget(frameTarget) {
  if (!frameTarget) return null;
  return {
    cdpFrameId: frameTarget.cdpFrameId || null,
    frameId: frameTarget.frameId ?? null,
    documentId: frameTarget.documentId || null,
    url: frameTarget.url || '',
    name: frameTarget.name || '',
    parentCdpFrameId: frameTarget.parentCdpFrameId || null,
    parentFrameId: frameTarget.parentFrameId ?? null,
    childIndex: frameTarget.childIndex ?? 0,
    path: frameTarget.path || [],
    mappingConfidence: frameTarget.mappingConfidence || 'unknown',
  };
}

export function withFrameResult(result, frameTarget) {
  if (!frameTarget) return result;
  return {
    frame: formatFrameTarget(frameTarget),
    ...result,
  };
}

export async function ensurePageEnabled(tabId) {
  if (pageEnabledTabs.has(tabId)) return;
  await sendCDPCommand(tabId, 'Page.enable', {});
  pageEnabledTabs.add(tabId);
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function flattenCdpFrameTree(node, parent = null, path = [], out = []) {
  const siblings = parent?.childFrames || [node];
  const childIndex = siblings.indexOf(node);
  const frame = node.frame || {};
  const context = {
    cdpFrameId: frame.id,
    frameId: null,
    documentId: null,
    url: frame.url || '',
    origin: getOrigin(frame.url || ''),
    name: frame.name || '',
    parentCdpFrameId: parent?.frame?.id || null,
    parentFrameId: null,
    childIndex: Math.max(childIndex, 0),
    path,
    mappingConfidence: parent ? 'cdp-only' : 'exact-main',
    _node: node,
  };
  out.push(context);
  const children = node.childFrames || [];
  children.forEach((child, index) => {
    flattenCdpFrameTree(child, node, [...path, index], out);
  });
  return out;
}

function buildTreeFromFlat(flat) {
  const byCdpFrameId = new Map(flat.map((frame) => [frame.cdpFrameId, { ...frame, children: [] }]));
  const roots = [];

  for (const frame of byCdpFrameId.values()) {
    delete frame._node;
    if (frame.parentCdpFrameId && byCdpFrameId.has(frame.parentCdpFrameId)) {
      byCdpFrameId.get(frame.parentCdpFrameId).children.push(frame);
    } else {
      roots.push(frame);
    }
  }

  return roots;
}

function getAllNavigationFrames(tabId) {
  return new Promise((resolve) => {
    if (!chrome.webNavigation?.getAllFrames) {
      resolve({ frames: [], warning: 'chrome.webNavigation.getAllFrames is unavailable.' });
      return;
    }

    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      if (chrome.runtime.lastError) {
        resolve({ frames: [], warning: chrome.runtime.lastError.message });
        return;
      }
      resolve({ frames: frames || [], warning: null });
    });
  });
}

function mergeNavigationFrames(flat, navigationFrames) {
  const warnings = [];
  const usedNavigationIds = new Set();
  const root = flat.find((frame) => !frame.parentCdpFrameId);
  const rootNav = navigationFrames.find((frame) => frame.frameId === 0);

  if (root && rootNav) {
    root.frameId = rootNav.frameId;
    root.documentId = rootNav.documentId || null;
    root.parentFrameId = rootNav.parentFrameId ?? -1;
    root.mappingConfidence = 'exact-main';
    usedNavigationIds.add(rootNav.frameId);
  }

  for (const frame of flat) {
    if (!frame.parentCdpFrameId || frame.frameId !== null) continue;
    const parent = flat.find((item) => item.cdpFrameId === frame.parentCdpFrameId);
    const candidates = navigationFrames.filter((item) => (
      !usedNavigationIds.has(item.frameId) &&
      item.url === frame.url &&
      (parent?.frameId == null || item.parentFrameId === parent.frameId)
    ));

    if (candidates.length === 1) {
      const nav = candidates[0];
      frame.frameId = nav.frameId;
      frame.documentId = nav.documentId || null;
      frame.parentFrameId = nav.parentFrameId ?? null;
      frame.mappingConfidence = 'url-parent';
      usedNavigationIds.add(nav.frameId);
    } else if (candidates.length > 1) {
      frame.mappingConfidence = 'ambiguous';
      warnings.push(`Ambiguous webNavigation mapping for CDP frame ${frame.cdpFrameId} (${frame.url}).`);
    }
  }

  return warnings;
}

export function invalidateFrameCaches(tabId, cdpFrameId = null) {
  frameTreeCache.delete(tabId);
  if (!cdpFrameId) {
    for (const key of Array.from(isolatedWorldCache.keys())) {
      if (key.startsWith(`${tabId}:`)) isolatedWorldCache.delete(key);
    }
    return;
  }
  isolatedWorldCache.delete(`${tabId}:${cdpFrameId}`);
}

export async function listFrameContexts(tabId, { flat = true, force = false } = {}) {
  if (!force && frameTreeCache.has(tabId)) {
    const cached = frameTreeCache.get(tabId);
    return flat ? cached.flatFrames : cached;
  }

  await ensurePageEnabled(tabId);
  const [{ frameTree }, navigationResult] = await Promise.all([
    sendCDPCommand(tabId, 'Page.getFrameTree', {}),
    getAllNavigationFrames(tabId),
  ]);

  const contexts = flattenCdpFrameTree(frameTree);
  const warnings = mergeNavigationFrames(contexts, navigationResult.frames);
  if (navigationResult.warning) warnings.push(navigationResult.warning);

  const flatContexts = contexts.map((context) => {
    const { _node, children, ...serializable } = context;
    return { ...serializable };
  });
  const tree = buildTreeFromFlat(contexts);
  const payload = {
    tabId,
    frameCount: flatContexts.length,
    flat: false,
    frames: tree,
    warnings,
    flatFrames: flatContexts,
  };
  frameTreeCache.set(tabId, payload);
  return flat ? flatContexts : payload;
}

function frameCandidateSummary(frame) {
  return {
    cdpFrameId: frame.cdpFrameId,
    frameId: frame.frameId,
    documentId: frame.documentId,
    url: frame.url,
    name: frame.name,
    childIndex: frame.childIndex,
    path: frame.path,
  };
}

function requireSingleFrame(candidates, reason) {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error(`FRAME_NOT_FOUND: No frame matched ${reason}. Run listFrames and retry with an exact frame ID.`);
  }
  throw new Error(
    `FRAME_AMBIGUOUS: ${candidates.length} frames matched ${reason}. ` +
    `Use listFrames and retry with cdpFrameId or frameId. Candidates: ${JSON.stringify(candidates.map(frameCandidateSummary))}`
  );
}

function normalizeFrameSpec(frameSpec) {
  if (frameSpec == null) return {};
  if (typeof frameSpec === 'string') return { frameSelector: frameSpec };
  if (typeof frameSpec === 'number') return { frameId: frameSpec };
  return frameSpec;
}

async function resolveFrameElementInParent(tabId, parentFrame, segment) {
  const spec = normalizeFrameSpec(segment);
  const result = await evaluateInFrame(tabId, parentFrame, `
    (() => {
      const spec = ${JSON.stringify(spec)};
      const frames = Array.from(document.querySelectorAll('iframe, frame'));
      let el = null;
      if (spec.frameSelector || spec.selector) {
        el = document.querySelector(spec.frameSelector || spec.selector);
      } else if (spec.frameName || spec.name) {
        const name = spec.frameName || spec.name;
        el = frames.find((frame) => frame.getAttribute('name') === name) || null;
      } else if (typeof spec.frameIndex === 'number' || typeof spec.index === 'number') {
        el = frames[typeof spec.frameIndex === 'number' ? spec.frameIndex : spec.index] || null;
      } else if (spec.frameUrl || spec.url) {
        const needle = spec.frameUrl || spec.url;
        el = frames.find((frame) => String(frame.getAttribute('src') || frame.src || '').includes(needle)) || null;
      }
      if (!el) return null;
      const index = frames.indexOf(el);
      const rect = el.getBoundingClientRect();
      return {
        index,
        name: el.getAttribute('name') || '',
        src: el.src || el.getAttribute('src') || '',
        id: el.id || '',
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
      };
    })()
  `);

  if (!result) {
    throw new Error(`FRAME_NOT_FOUND: No child iframe matched ${JSON.stringify(spec)} in frame ${parentFrame.cdpFrameId}.`);
  }
  return result;
}

async function resolveChildFrameFromParent(tabId, parentFrame, segment, allFrames) {
  const info = await resolveFrameElementInParent(tabId, parentFrame, segment);
  const children = allFrames.filter((frame) => frame.parentCdpFrameId === parentFrame.cdpFrameId);
  const byIndex = children.filter((frame) => frame.childIndex === info.index);
  if (byIndex.length === 1) return byIndex[0];

  const byName = info.name
    ? children.filter((frame) => frame.name === info.name)
    : [];
  if (byName.length === 1) return byName[0];

  const byUrl = info.src
    ? children.filter((frame) => frame.url === info.src || frame.url.includes(info.src))
    : [];
  return requireSingleFrame([...new Set([...byIndex, ...byName, ...byUrl])], `child frame ${JSON.stringify(segment)}`);
}

export async function resolveFrameTarget(tabId, frameSpec = {}) {
  const spec = normalizeFrameSpec(frameSpec);
  const frames = await listFrameContexts(tabId, { flat: true });
  const root = frames.find((frame) => !frame.parentCdpFrameId);

  if (!spec || Object.keys(spec).length === 0) {
    return root;
  }

  if (spec.cdpFrameId) {
    return requireSingleFrame(frames.filter((frame) => frame.cdpFrameId === spec.cdpFrameId), `cdpFrameId ${spec.cdpFrameId}`);
  }

  if (typeof spec.frameId === 'number') {
    return requireSingleFrame(frames.filter((frame) => frame.frameId === spec.frameId), `frameId ${spec.frameId}`);
  }

  if (spec.documentId) {
    return requireSingleFrame(frames.filter((frame) => frame.documentId === spec.documentId), `documentId ${spec.documentId}`);
  }

  if (Array.isArray(spec.framePath) && spec.framePath.length > 0) {
    let current = root;
    for (const segment of spec.framePath) {
      current = await resolveChildFrameFromParent(tabId, current, segment, frames);
    }
    return current;
  }

  if (spec.frameSelector || spec.selector) {
    return resolveChildFrameFromParent(tabId, root, { selector: spec.frameSelector || spec.selector }, frames);
  }

  if (spec.frameName || spec.name) {
    const name = spec.frameName || spec.name;
    return requireSingleFrame(frames.filter((frame) => frame.name === name), `frameName ${name}`);
  }

  if (spec.frameUrl || spec.url) {
    const url = spec.frameUrl || spec.url;
    return requireSingleFrame(frames.filter((frame) => frame.url.includes(url)), `frameUrl ${url}`);
  }

  if (typeof spec.frameIndex === 'number' || typeof spec.index === 'number') {
    const index = typeof spec.frameIndex === 'number' ? spec.frameIndex : spec.index;
    return requireSingleFrame(
      frames.filter((frame) => frame.parentCdpFrameId === root.cdpFrameId && frame.childIndex === index),
      `frameIndex ${index}`
    );
  }

  return root;
}

export async function getOrCreateIsolatedWorld(tabId, cdpFrameId) {
  const key = `${tabId}:${cdpFrameId}`;
  if (isolatedWorldCache.has(key)) return isolatedWorldCache.get(key);

  await ensurePageEnabled(tabId);
  const result = await sendCDPCommand(tabId, 'Page.createIsolatedWorld', {
    frameId: cdpFrameId,
    worldName: WEBMCP_WORLD_NAME,
    grantUniveralAccess: false,
  });
  isolatedWorldCache.set(key, result.executionContextId);
  return result.executionContextId;
}

export async function evaluateInFrame(tabId, frameSpec, expression, awaitPromise = true) {
  const frameTarget = frameSpec?.cdpFrameId ? frameSpec : await resolveFrameTarget(tabId, frameSpec);
  if (!frameTarget?.cdpFrameId) {
    throw new Error('FRAME_UNSUPPORTED_FOR_HANDLER: CDP frame ID is required for Runtime.evaluate.');
  }

  const contextId = await getOrCreateIsolatedWorld(tabId, frameTarget.cdpFrameId);
  const result = await sendCDPCommand(tabId, 'Runtime.evaluate', {
    expression,
    contextId,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.text ||
      result.exceptionDetails.exception?.description ||
      'JS evaluation error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

function executeScriptInFrame(tabId, frameId, func, args = [], world = 'MAIN') {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world,
      func,
      args,
    }, (results) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(results?.[0]?.result);
    });
  });
}

export async function evaluateInFrameMainWorld(tabId, frameSpec, expression, awaitPromise = true) {
  const frameTarget = frameSpec?.cdpFrameId ? frameSpec : await resolveFrameTarget(tabId, frameSpec);
  if (typeof frameTarget?.frameId !== 'number') {
    throw new Error(
      'FRAME_UNSUPPORTED_FOR_HANDLER: Chrome frameId is required for MAIN-world frame execution. Run listFrames and retry with an exact frameId.'
    );
  }

  return executeScriptInFrame(
    tabId,
    frameTarget.frameId,
    async (source, shouldAwait) => {
      const value = (0, eval)(source);
      if (shouldAwait && value && typeof value.then === 'function') {
        return await value;
      }
      return value;
    },
    [expression, awaitPromise],
    'MAIN'
  );
}

async function getFrameChain(tabId, frameSpec) {
  const frameTarget = frameSpec?.cdpFrameId ? frameSpec : await resolveFrameTarget(tabId, frameSpec);
  const frames = await listFrameContexts(tabId, { flat: true });
  const byId = new Map(frames.map((frame) => [frame.cdpFrameId, frame]));
  const chain = [];
  let current = byId.get(frameTarget.cdpFrameId);
  while (current) {
    chain.unshift(current);
    current = current.parentCdpFrameId ? byId.get(current.parentCdpFrameId) : null;
  }
  return chain;
}

async function getChildFrameElementRect(tabId, parentFrame, childFrame) {
  const info = await evaluateInFrame(tabId, parentFrame, `
    (() => {
      const childIndex = ${Number(childFrame.childIndex)};
      const childName = ${JSON.stringify(childFrame.name || '')};
      const childUrl = ${JSON.stringify(childFrame.url || '')};
      const frames = Array.from(document.querySelectorAll('iframe, frame'));
      let el = frames[childIndex] || null;
      if ((!el || (childName && el.getAttribute('name') !== childName)) && childName) {
        el = frames.find((frame) => frame.getAttribute('name') === childName) || el;
      }
      if ((!el || (childUrl && el.src !== childUrl)) && childUrl) {
        el = frames.find((frame) => frame.src === childUrl || childUrl.includes(frame.src)) || el;
      }
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    })()
  `);

  if (!info) {
    throw new Error(`FRAME_NOT_FOUND: Could not locate iframe element for frame ${childFrame.cdpFrameId}.`);
  }
  return info;
}

export async function getFrameViewportOffset(tabId, frameSpec) {
  const chain = await getFrameChain(tabId, frameSpec);
  let x = 0;
  let y = 0;

  for (let index = 1; index < chain.length; index += 1) {
    const rect = await getChildFrameElementRect(tabId, chain[index - 1], chain[index]);
    x += Number(rect.left) || 0;
    y += Number(rect.top) || 0;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
  };
}
