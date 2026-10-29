import WebSocket from 'ws';
import { CATALOG_MAP } from './catalog-map.mjs';

export async function dispatchCommand(session, method, params = {}) {
  if (method === 'batch') {
    const actions = params.actions || [];
    let currentTargetId = params.tabId || session.activeTargetId;
    const results = [];
    let errors = 0;

    for (let i = 0; i < actions.length; i++) {
      const act = actions[i], start = Date.now(), entry = { index: i, method: act.method, ok: true };
      try {
        const actParams = { ...act.params };
        if (!actParams.tabId && currentTargetId) actParams.tabId = currentTargetId;
        const res = await dispatchCommand(session, act.method, actParams);
        entry.result = res;
        if (act.method === 'newTab' && res?.targetId) currentTargetId = res.targetId;
        else if (act.method === 'activateTab' && actParams.tabId) currentTargetId = actParams.tabId;
        if (params.screenshotAfter) {
          const sid = session.getSessionId(currentTargetId);
          const ss = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 50 }, sid);
          entry.screenshot = ss.data;
        }
      } catch (err) {
        entry.ok = false;
        entry.error = err.message || String(err);
        errors++;
      }
      entry.duration = Date.now() - start;
      results.push(entry);
      if (!entry.ok && (params.onError === 'stop' || params.onError === 'stop-on-error')) break;
    }
    return { total: actions.length, executed: results.length, success: errors === 0, errors, results };
  }

  const handler = CATALOG_MAP[method];
  if (!handler) throw new Error(`Unknown command: ${method}`);
  const sid = session.getSessionId(params?.tabId);
  return await handler(session, sid, params);
}

export function connectGateway(session, options = {}) {
  const { gatewayUrl = 'ws://127.0.0.1:7865', profileId = 'mobile-xm13', profileName = 'Android Chrome CDP', WebSocketImpl = WebSocket } = options;
  const ws = new WebSocketImpl(gatewayUrl);
  ws.on('open', () => {
    const capabilities = Object.keys(CATALOG_MAP).filter(k => k !== 'batch');
    ws.send(JSON.stringify({ method: 'extensionReady', params: { profileId, profileName, version: '1.0.0', capabilities } }));
  });
  ws.on('message', async data => {
    try {
      const req = JSON.parse(data.toString());
      if (!req.id || !req.method) return;
      try {
        const result = await dispatchCommand(session, req.method, req.params || {});
        ws.send(JSON.stringify({ id: req.id, result }));
      } catch (err) {
        ws.send(JSON.stringify({ id: req.id, error: { code: -32000, message: err.message || String(err) } }));
      }
    } catch {}
  });
  return { ws, close: () => ws.close() };
}
