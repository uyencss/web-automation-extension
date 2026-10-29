import fs from 'node:fs';

const ARIA_SOURCE = fs.readFileSync(new URL('../webmcp-extension/dist/content-scripts/aria-snapshot.js', import.meta.url), 'utf8');
export const isolatedWorlds = new Map();

export function bindSessionEvents(session) {
  if (session._ariaBound) return;
  session._ariaBound = true;
  session.onEvent(evt => {
    const { method, sessionId } = evt;
    if (['Page.frameNavigated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Target.targetDestroyed', 'Target.targetCrashed'].includes(method)) {
      for (const k of isolatedWorlds.keys()) if (!sessionId || k.startsWith(`${sessionId}::`)) isolatedWorlds.delete(k);
    }
  });
}

export async function ensureIsolatedWorld(session, sessionId, frameId) {
  bindSessionEvents(session);
  let targetFrameId = frameId;
  if (!targetFrameId) {
    const tree = await session.send('Page.getFrameTree', {}, sessionId);
    targetFrameId = tree.frameTree?.frame?.id;
  }
  const key = `${sessionId}::${targetFrameId}`;
  if (isolatedWorlds.has(key)) return { contextId: isolatedWorlds.get(key), frameId: targetFrameId };
  const res = await session.send('Page.createIsolatedWorld', { frameId: targetFrameId, worldName: 'webmcp-mobile-isolated', grantUniversalAccess: true }, sessionId);
  const contextId = res.executionContextId;
  await session.send('Runtime.evaluate', { contextId, expression: ARIA_SOURCE, returnByValue: true }, sessionId);
  isolatedWorlds.set(key, contextId);
  return { contextId, frameId: targetFrameId };
}

export async function getSnapshot(session, sessionId, params = {}) {
  const { contextId } = await ensureIsolatedWorld(session, sessionId, params.frameId);
  const expr = `window.__WEBMCP_FAST_ARIA_API__.buildSnapshot(${JSON.stringify(params)})`;
  const res = await session.send('Runtime.evaluate', { contextId, expression: expr, returnByValue: true }, sessionId);
  return res.result?.value;
}

export async function resolveRef(session, sessionId, rawRef, { prepareType = false, action = 'resolve', ...rest } = {}) {
  const refStr = String(rawRef || '').replace(/^@/, '');
  const iframeMatch = refStr.match(/^f(\d+)(r\d+)$/i);
  let frameId = rest.frameId, actionRef = refStr, iframeOffset = { left: 0, top: 0 };

  if (iframeMatch) {
    const frameIdx = parseInt(iframeMatch[1], 10) - 1;
    actionRef = iframeMatch[2].toUpperCase();
    const tree = await session.send('Page.getFrameTree', {}, sessionId);
    const childFrames = tree.frameTree?.childFrames || [];
    if (childFrames[frameIdx]?.frame?.id) frameId = childFrames[frameIdx].frame.id;
    const offRes = await session.send('Runtime.evaluate', {
      expression: `(() => { const f = document.querySelectorAll('iframe, frame')[${frameIdx}]; if (!f) return { left: 0, top: 0 }; const r = f.getBoundingClientRect(); return { left: r.left, top: r.top }; })()`,
      returnByValue: true
    }, sessionId);
    if (offRes.result?.value) iframeOffset = offRes.result.value;
  } else {
    actionRef = refStr.toUpperCase();
  }

  const { contextId } = await ensureIsolatedWorld(session, sessionId, frameId);
  const expr = `window.__WEBMCP_FAST_ARIA_API__.runRefAction(${JSON.stringify({ action, ref: actionRef, prepareType, human: true, ...rest })})`;
  const res = await session.send('Runtime.evaluate', { contextId, expression: expr, returnByValue: true }, sessionId);
  const result = res.result?.value || { success: false, error: 'Empty evaluation result' };

  if (iframeOffset.left || iframeOffset.top) {
    if (result.pointX != null) result.pointX += iframeOffset.left;
    if (result.pointY != null) result.pointY += iframeOffset.top;
    if (result.bounds) {
      result.bounds.x += iframeOffset.left;
      result.bounds.y += iframeOffset.top;
    }
  }
  return result;
}
