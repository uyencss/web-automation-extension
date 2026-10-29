import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

export function createMobileSession(options = {}) {
  const { serial, metaDir = os.tmpdir(), adbExec = execFileSync, fetchFn = globalThis.fetch } = options;
  const sessions = new Map(), customTitles = new Map(), consoleLogs = new Map();
  const downloads = [], eventListeners = new Set(), pending = new Map();
  let ws = options.ws || null, reqId = 1, port = options.port || null, activeTargetId = null;

  function emitEvent(evt) { for (const l of eventListeners) try { l(evt); } catch {} }
  function handleMsg(raw) {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      return msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
    }
    const { method, params, sessionId } = msg;
    if (method === 'Target.attachedToTarget') {
      const { targetInfo, sessionId: sid } = params;
      sessions.set(targetInfo.targetId, sid); sessions.set(sid, targetInfo.targetId);
      if (!activeTargetId || targetInfo.type === 'page') activeTargetId = targetInfo.targetId;
    } else if (method === 'Target.detachedFromTarget') {
      const tid = sessions.get(params.sessionId);
      sessions.delete(params.sessionId); if (tid) sessions.delete(tid);
    } else if (method === 'Target.targetDestroyed' || method === 'Target.targetCrashed') {
      const sid = sessions.get(params.targetId);
      sessions.delete(params.targetId); if (sid) sessions.delete(sid);
      if (activeTargetId === params.targetId) activeTargetId = null;
    } else if (method === 'Log.entryAdded' || method === 'Runtime.consoleAPICalled') {
      const tid = (sessionId && sessions.get(sessionId)) || activeTargetId || 'main';
      const arr = consoleLogs.get(tid) || [];
      arr.push(params); if (arr.length > 200) arr.shift();
      consoleLogs.set(tid, arr);
    } else if (method === 'Page.downloadWillBegin' || method === 'Page.downloadProgress') downloads.push(params);
    emitEvent({ method, params, sessionId });
  }

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      pending.set(id, { resolve, reject });
      const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      if (options.transport) options.transport.send(payload, handleMsg);
      else if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
      else reject(new Error('WebSocket not connected'));
    });
  }

  async function init() {
    if (options.ws) { ws.on('message', m => handleMsg(m.toString())); return session; }
    if (options.transport) return session;
    const adbArgs = [...(serial ? ['-s', serial] : []), 'forward', 'tcp:0', 'localabstract:chrome_devtools_remote'];
    port = parseInt(adbExec('adb', adbArgs).toString().trim(), 10);
    const metaPath = path.join(metaDir, '.webmcp-mobile-meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({ serial, port, updatedAt: Date.now() }));
    const v = await fetchFn(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
    ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.on('message', m => handleMsg(m.toString()));
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    return session;
  }

  const session = {
    serial, get port() { return port; }, sessions, customTitles, consoleLogs, downloads,
    get activeTargetId() { return activeTargetId; }, set activeTargetId(id) { activeTargetId = id; },
    send, emitEvent, onEvent: fn => { eventListeners.add(fn); return () => eventListeners.delete(fn); },
    getSessionId: tid => sessions.get(tid || activeTargetId),
    createTab: async (url = 'about:blank') => {
      const res = await send('Target.createTarget', { url });
      if (!sessions.has(res.targetId)) {
        const att = await send('Target.attachToTarget', { targetId: res.targetId, flatten: true });
        if (att?.sessionId) { sessions.set(res.targetId, att.sessionId); sessions.set(att.sessionId, res.targetId); }
      }
      activeTargetId = res.targetId;
      return res;
    },
    closeTab: async tid => {
      const targetId = tid || activeTargetId;
      const res = await send('Target.closeTarget', { targetId });
      const sid = sessions.get(targetId);
      sessions.delete(targetId); if (sid) sessions.delete(sid);
      if (activeTargetId === targetId) activeTargetId = null;
      return res;
    },
    activateTab: async tid => {
      const res = await send('Target.activateTarget', { targetId: tid });
      activeTargetId = tid; return res;
    },
    listTabs: async () => {
      const { targetInfos = [] } = await send('Target.getTargets', {});
      return targetInfos.filter(t => t.type === 'page').map(t => ({
        id: t.targetId, url: t.url, title: customTitles.get(t.targetId) || t.title, active: t.targetId === activeTargetId,
      }));
    },
    close: async () => {
      try { if (ws) ws.close(); } catch {}
      if (port) try { adbExec('adb', [...(serial ? ['-s', serial] : []), 'forward', '--remove', `tcp:${port}`]); } catch {}
    },
    init, handleMsg, adbExec
  };
  return session;
}
