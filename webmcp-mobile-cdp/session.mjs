import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

async function loadMobileFingerprintKit() {
  try { return await import('@webmcp/fingerprint-kit/mobile'); }
  catch { return await import(new URL('../../webmcp-fingerprint-kit/dist/mobile/index.js', import.meta.url).href); }
}

export function createMobileSession(options = {}) {
  const { serial, metaDir = os.tmpdir(), adbExec = execFileSync, fetchFn = globalThis.fetch } = options;
  const sessions = new Map(), customTitles = new Map(), consoleLogs = new Map();
  const downloads = [], eventListeners = new Set(), pending = new Map(), namedListeners = new Map();
  let ws = options.ws || null, reqId = 1, port = options.port || null, activeTargetId = null;

  const on = (event, fn) => { if (!namedListeners.has(event)) namedListeners.set(event, new Set()); namedListeners.get(event).add(fn); return () => off(event, fn); };
  const off = (event, fn) => { const s = namedListeners.get(event); if (s) { s.delete(fn); if (!s.size) namedListeners.delete(event); } };
  const emitEvent = evt => { for (const l of eventListeners) try { l(evt); } catch {}; const s = namedListeners.get(evt.method); if (s) for (const fn of s) try { fn(evt.params); } catch {}; };
  function handleMsg(raw) {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      return msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
    }
    const { method, params, sessionId } = msg;
    if (method === 'Target.attachedToTarget') {
      const { targetInfo, sessionId: sid } = params;
      sessions.set(targetInfo.targetId, sid); sessions.set(sid, targetInfo.targetId);
      if (!activeTargetId || targetInfo.type === 'page') activeTargetId = targetInfo.targetId;
    } else if (method === 'Target.detachedFromTarget') {
      const tid = sessions.get(params.sessionId); sessions.delete(params.sessionId); if (tid) sessions.delete(tid);
    } else if (method === 'Target.targetDestroyed' || method === 'Target.targetCrashed') {
      const sid = sessions.get(params.targetId); sessions.delete(params.targetId); if (sid) sessions.delete(sid);
      if (activeTargetId === params.targetId) activeTargetId = null;
    } else if (method === 'Log.entryAdded' || method === 'Runtime.consoleAPICalled') {
      const tid = (sessionId && sessions.get(sessionId)) || activeTargetId || 'main';
      const arr = consoleLogs.get(tid) || []; arr.push(params); if (arr.length > 200) arr.shift(); consoleLogs.set(tid, arr);
    } else if (method === 'Page.downloadWillBegin' || method === 'Page.downloadProgress') downloads.push(params);
    emitEvent({ method, params, sessionId });
  }

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = reqId++; pending.set(id, { resolve, reject });
      const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      if (options.transport) options.transport.send(payload, handleMsg);
      else if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
      else reject(new Error('WebSocket not connected'));
    });
  }

  async function init() {
    if (options.ws) ws.on('message', m => handleMsg(m.toString()));
    else if (!options.transport) {
      const socketName = options.remoteSocket || 'localabstract:chrome_devtools_remote';
      port = parseInt(adbExec('adb', [...(serial ? ['-s', serial] : []), 'forward', 'tcp:0', socketName]).toString().trim(), 10);
      const nowIso = new Date().toISOString(), { writeMobileMetaAtomic } = await loadMobileFingerprintKit();
      const portEntry = { localPort: port, profileId: options.profileId || 'mobile-default', targetPackage: options.targetPackage || 'com.android.chrome', remoteSocket: socketName, updatedAt: nowIso };
      writeMobileMetaAtomic(path.join(metaDir, '.webmcp-mobile-meta.json'), existing => ({ ...existing, serial, port, updatedAt: nowIso, profiles: { ...(existing.profiles || {}) }, ports: { ...(existing.ports || {}), ...(serial ? { [serial]: portEntry } : {}) } }));
      const v = await fetchFn(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
      ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      ws.on('message', m => handleMsg(m.toString()));
    }
    if (options.stealthConfig || options.attachStealth) {
      const attachFn = typeof options.attachStealth === 'function' ? options.attachStealth : (await loadMobileFingerprintKit()).attachCdpToAndroidTargets;
      await attachFn(session, options.stealthConfig);
    } else if (!options.ws && !options.transport) {
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    }
    return session;
  }

  const session = {
    serial, get port() { return port; }, sessions, customTitles, consoleLogs, downloads,
    get activeTargetId() { return activeTargetId; }, set activeTargetId(id) { activeTargetId = id; },
    send, emitEvent, on, off, onEvent: fn => { eventListeners.add(fn); return () => eventListeners.delete(fn); },
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
      const targetId = tid || activeTargetId, res = await send('Target.closeTarget', { targetId }), sid = sessions.get(targetId);
      sessions.delete(targetId); if (sid) sessions.delete(sid);
      if (activeTargetId === targetId) activeTargetId = null;
      return res;
    },
    activateTab: async tid => { const res = await send('Target.activateTarget', { targetId: tid }); activeTargetId = tid; return res; },
    listTabs: async () => {
      const { targetInfos = [] } = await send('Target.getTargets', {});
      return targetInfos.filter(t => t.type === 'page').map(t => ({ id: t.targetId, url: t.url, title: customTitles.get(t.targetId) || t.title, active: t.targetId === activeTargetId }));
    },
    close: async () => {
      try { if (ws) ws.close(); } catch {}
      if (port) try { adbExec('adb', [...(serial ? ['-s', serial] : []), 'forward', '--remove', `tcp:${port}`]); } catch {}
    },
    init, handleMsg, adbExec
  };
  return session;
}
