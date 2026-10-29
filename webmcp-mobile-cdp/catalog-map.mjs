import { tap, scroll, swipe, key, type, screenshot, cookies, emulation, upload, evalInMain } from './primitives.mjs';
import { getSnapshot, resolveRef } from './aria.mjs';

function flattenFrames(node) {
  const list = [];
  if (!node?.frame) return list;
  list.push({ frameId: node.frame.id, parentId: node.frame.parentId, url: node.frame.url, name: node.frame.name });
  for (const child of node.childFrames || []) list.push(...flattenFrames(child));
  return list;
}

export const CATALOG_MAP = {
  batch: async (s, sid, p) => { throw new Error('Batch handled by dispatchCommand'); },
  listTabs: s => s.listTabs(),
  navigate: async (s, sid, p) => { await s.send('Page.navigate', { url: p.url }, sid); return { ok: true, url: p.url }; },
  newTab: (s, _, p) => s.createTab(p?.url),
  closeTab: (s, _, p) => s.closeTab(p?.tabId),
  activateTab: (s, _, p) => s.activateTab(p?.tabId),
  getActiveTab: async s => { const tabs = await s.listTabs(); return tabs.find(t => t.active) || tabs[0] || null; },
  renameTab: async (s, sid, p) => {
    if (p?.title != null) {
      await evalInMain(s, sid, `document.title = ${JSON.stringify(p.title)}`);
      s.customTitles.set(p.tabId || s.activeTargetId, p.title);
    }
    return { ok: true };
  },
  listFrames: async (s, sid, p) => {
    const res = await s.send('Page.getFrameTree', {}, sid);
    return p?.flat ? flattenFrames(res.frameTree) : res.frameTree;
  },
  listWindows: async s => { const tabs = await s.listTabs(); return { windows: [{ id: 1, focused: true, type: 'normal', tabCount: tabs.length }] }; },
  createWindow: (s, _, p) => s.createTab(p?.url),
  getAriaSnapshot: (s, sid, p) => getSnapshot(s, sid, p),
  clickByRef: async (s, sid, p) => {
    const r = await resolveRef(s, sid, p.ref, p);
    if (r.pointX == null && !r.hit) throw new Error(r.error || 'Ref not found');
    return tap(s, sid, r.pointX, r.pointY, p);
  },
  typeByRef: async (s, sid, p) => {
    const r = await resolveRef(s, sid, p.ref, { prepareType: true, ...p });
    if (r.pointX == null && !r.hit && !r.focused) throw new Error(r.error || 'Ref not found');
    return type(s, sid, p.text, p);
  },
  hoverByRef: (s, sid, p) => resolveRef(s, sid, p.ref, { action: 'hover', ...p }),
  selectByRef: (s, sid, p) => resolveRef(s, sid, p.ref, { action: 'select', values: p.values, ...p }),
  dispatchClick: (s, sid, p) => tap(s, sid, p.x, p.y, p),
  scroll: (s, sid, p) => scroll(s, sid, p),
  pressKey: (s, sid, p) => key(s, sid, p.key),
  typeText: (s, sid, p) => type(s, sid, p.text, p),
  moveMouse: (s, sid, p) => swipe(s, sid, p.fromX ?? p.x, p.fromY ?? p.y, p.x, p.y, p.steps || 6),
  click: async (s, sid, p) => {
    const b = await evalInMain(s, sid, `(() => { const el = document.querySelector(${JSON.stringify(p.selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    if (!b) throw new Error(`Element not found: ${p.selector}`);
    return tap(s, sid, b.x, b.y, p);
  },
  type: async (s, sid, p) => {
    await evalInMain(s, sid, `(() => { const el = document.querySelector(${JSON.stringify(p.selector)}); if (el) { el.focus(); if (el.select) el.select(); } })()`);
    return type(s, sid, p.text, p);
  },
  hover: (s, sid, p) => evalInMain(s, sid, `(() => { const el = document.querySelector(${JSON.stringify(p.selector)}); if (el) { el.scrollIntoView({ block: 'center' }); el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); } })()`),
  selectOption: (s, sid, p) => evalInMain(s, sid, `(() => { const el = document.querySelector(${JSON.stringify(p.selector)}); if (el?.tagName === 'SELECT') { if (${JSON.stringify(p.value)} != null) el.value = ${JSON.stringify(p.value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; } return false; })()`),
  waitForSelector: (s, sid, p) => evalInMain(s, sid, `new Promise((res, rej) => { if (document.querySelector(${JSON.stringify(p.selector)})) return res(true); const t = setTimeout(() => rej(new Error('Timeout waiting for selector: ' + ${JSON.stringify(p.selector)})), ${p.timeout || 10000}); const obs = new MutationObserver(() => { if (document.querySelector(${JSON.stringify(p.selector)})) { clearTimeout(t); obs.disconnect(); res(true); } }); obs.observe(document.body || document.documentElement, { childList: true, subtree: true }); })`, { awaitPromise: true }),
  waitForStable: (s, sid, p) => evalInMain(s, sid, `new Promise(res => { let timer; const reset = () => { clearTimeout(timer); timer = setTimeout(() => { obs.disconnect(); res(true); }, ${p.minStableMs || 300}); }; const obs = new MutationObserver(reset); obs.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true }); reset(); })`, { awaitPromise: true }),
  getPageText: (s, sid, p) => evalInMain(s, sid, `(() => { const root = document.querySelector('article, main, [role=main]') || document.body; const full = (root ? root.innerText : '') || ''; const offset = ${p?.offset || 0}; const len = ${p?.maxLength || 100000}; return { text: full.slice(offset, offset + len), totalLength: full.length }; })()`),
  readPage: async (s, sid, p) => {
    if (p?.url) await s.send('Page.navigate', { url: p.url }, sid);
    await CATALOG_MAP.waitForStable(s, sid, p);
    return CATALOG_MAP.getPageText(s, sid, p);
  },
  getPageContent: (s, sid) => evalInMain(s, sid, `(() => ({ title: document.title, url: location.href, text: document.body?.innerText || '', html: document.documentElement.outerHTML }))()`),
  querySelectorAll: (s, sid, p) => evalInMain(s, sid, `(() => { const els = [...document.querySelectorAll(${JSON.stringify(p.selector)})].slice(${p.offset || 0}, ${p.limit ? (p.offset || 0) + p.limit : undefined}); return els.map(el => { const r = el.getBoundingClientRect(); return { tagName: el.tagName, text: el.innerText, bounds: { x: r.left, y: r.top, width: r.width, height: r.height } }; }); })()`),
  getWindowVariable: (s, sid, p) => evalInMain(s, sid, `(() => { const parts = ${JSON.stringify(p.path)}.split('.'); let curr = window; for (const k of parts) { if (curr == null) return null; curr = curr[k]; } return curr; })()`),
  findByText: (s, sid, p) => evalInMain(s, sid, `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const res = []; while (w.nextNode() && res.length < (${p.maxResults || 20})) { const n = w.currentNode; if (n.nodeValue && (${p.exact ? 'n.nodeValue.trim() === ' + JSON.stringify(p.text) : 'n.nodeValue.includes(' + JSON.stringify(p.text) + ')'})) { const el = n.parentElement; if (el) { const r = el.getBoundingClientRect(); res.push({ text: n.nodeValue.trim(), tagName: el.tagName, bounds: { x: r.left, y: r.top, width: r.width, height: r.height } }); } } } return res; })()`),
  pageFetch: (s, sid, p) => evalInMain(s, sid, `fetch(${JSON.stringify(p.url)}, ${JSON.stringify(p.init || {})}).then(async r => ({ status: r.status, ok: r.ok, text: await r.text() }))`, { awaitPromise: true }),
  evaluateJS: (s, sid, p) => evalInMain(s, sid, p.code, { awaitPromise: true }),
  executeCDP: (s, sid, p) => s.send(p.method, p.params || {}, sid),
  screenshot: (s, sid, p) => screenshot(s, sid, p),
  getElementBounds: (s, sid, p) => evalInMain(s, sid, `(() => { const el = document.querySelector(${JSON.stringify(p.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`),
  getInteractiveElements: (s, sid) => evalInMain(s, sid, `(() => [...document.querySelectorAll('a, button, input, select, textarea, [role=button]')].map(el => { const r = el.getBoundingClientRect(); return { tagName: el.tagName, text: el.innerText || el.value, bounds: { x: r.left, y: r.top, width: r.width, height: r.height } }; }))()`),
  getAccessibilityTree: async (s, sid, p) => {
    await s.send('Accessibility.enable', {}, sid);
    return (await s.send('Accessibility.getFullAXTree', { depth: p?.depth }, sid)).nodes;
  },
  getDOMSnapshot: (s, sid, p) => s.send('DOMSnapshot.captureSnapshot', { computedStyles: p?.computedStyles || [] }, sid),
  'webmcp.listTools': (s, sid) => evalInMain(s, sid, 'window.navigator.modelContext?.listTools?.() || []'),
  'webmcp.invokeTool': (s, sid, p) => evalInMain(s, sid, `window.navigator.modelContext?.invokeTool?.(${JSON.stringify(p.toolName)}, ${JSON.stringify(p.input)})`, { awaitPromise: true }),
  getCookies: (s, sid, p) => cookies(s, sid, 'get', p),
  setCookie: (s, sid, p) => cookies(s, sid, 'set', p),
  deleteCookies: (s, sid, p) => cookies(s, sid, 'delete', p),
  getLocalStorage: (s, sid) => evalInMain(s, sid, 'Object.fromEntries(Object.entries(localStorage))'),
  setLocalStorage: (s, sid, p) => evalInMain(s, sid, `localStorage.setItem(${JSON.stringify(p.key)}, ${JSON.stringify(p.value)})`),
  startConsoleCapture: async (s, sid) => { await s.send('Log.enable', {}, sid); await s.send('Runtime.enable', {}, sid); return { ok: true }; },
  stopConsoleCapture: async (s, sid) => { s.consoleLogs.delete(s.sessions.get(sid) || sid); return { ok: true }; },
  readConsoleMessages: async (s, sid, p) => {
    const logs = s.consoleLogs.get(s.sessions.get(sid) || sid) || [];
    if (p?.clear) s.consoleLogs.set(s.sessions.get(sid) || sid, []);
    return logs;
  },
  clearConsoleMessages: async (s, sid) => { s.consoleLogs.set(s.sessions.get(sid) || sid, []); return { ok: true }; },
  listDownloadEvents: async s => s.downloads,
  clearDownloadEvents: async s => { s.downloads.length = 0; return { ok: true }; },
  setViewport: (s, sid, p) => emulation(s, sid, { setViewport: p, forceEmulation: p?.forceEmulation }),
  resetViewport: (s, sid) => emulation(s, sid, { resetViewport: true }),
  ping: async () => ({ ok: true, pong: Date.now() }),
  getExtensionInfo: async s => ({ name: 'webmcp-mobile-cdp', version: '1.0.0', platform: 'Android Chrome', serial: s.serial }),
  browser_raw_command: async (s, sid, p) => {
    if (!CATALOG_MAP[p.method]) throw new Error('Unknown raw method: ' + p.method);
    return CATALOG_MAP[p.method](s, sid, p.params);
  },
  list_profiles: async s => [{ profileId: s.profileId || 'mobile-xm13', name: s.profileName || 'Android Chrome CDP' }],
  set_profile_name: async (s, sid, p) => { s.profileName = p.name; return { ok: true }; },
  wait: async (_, __, p) => new Promise(res => setTimeout(res, p?.ms || p?.timeout || 1000)),
  delay: async (_, __, p) => new Promise(res => setTimeout(res, p?.ms || p?.timeout || 1000)),
  uploadFile: (s, sid, p) => upload(s, sid, p.selector, p.filePath || p.localPath),
  'passkey.status': async () => ({ supported: false, reason: 'Passkey not implemented on mobile CDP' }),
  'vault.autofill': async () => ({ supported: false }),
  closeBrowser: async s => {
    if (s.serial && s.adbExec) s.adbExec('adb', ['-s', s.serial, 'shell', 'am', 'force-stop', 'com.android.chrome']);
    return { ok: true };
  },
  reloadExtension: async s => { await s.close?.(); return { ok: true }; },
};

CATALOG_MAP.webmcp_list_tools = CATALOG_MAP['webmcp.listTools'];
CATALOG_MAP.webmcp_invoke_tool = CATALOG_MAP['webmcp.invokeTool'];
