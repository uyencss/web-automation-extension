import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WEBMCP_CALL = '/Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-browser-kit/scripts/webmcp-call.js';

async function callWebmcp(method, params = {}) {
  const { stdout } = await execFileAsync('node', [WEBMCP_CALL, method, JSON.stringify(params)]);
  const parsed = JSON.parse(stdout);
  return parsed.result ?? parsed;
}

const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>WebMCP Human Behavior Live Test</title>
  <style>
    body { font-family: sans-serif; padding: 40px; }
    #btn-primary { width: 160px; height: 48px; font-size: 16px; margin-bottom: 24px; display: block; }
    #inp-search { width: 240px; height: 36px; font-size: 16px; margin-bottom: 24px; display: block; }
    .occluded-wrap { position: relative; width: 160px; height: 48px; margin-top: 20px; }
    #btn-occluded { width: 160px; height: 48px; }
    #overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.5); z-index: 10; }
  </style>
</head>
<body>
  <button id="btn-primary" type="button">Mua Ngay</button>
  <form id="search-form" onsubmit="event.preventDefault(); window.__testLog.formSubmitted = true;">
    <label for="inp-search" id="lbl-search">Tìm kiếm sản phẩm</label>
    <input id="inp-search" type="text" placeholder="Tìm kiếm" value="giá trị cũ" />
  </form>
  <div class="occluded-wrap">
    <button id="btn-occluded" type="button">Nút Bị Che</button>
    <div id="overlay">Che phủ</div>
  </div>
  <script>
    window.__testLog = {
      mouseMoves: [],
      mouseDowns: [],
      mouseUps: [],
      clicks: [],
      keyDowns: [],
      keyUps: [],
      inputs: [],
      formSubmitted: false,
    };
    window.addEventListener('mousemove', (e) => {
      window.__testLog.mouseMoves.push({ x: e.clientX, y: e.clientY, buttons: e.buttons, isTrusted: e.isTrusted });
    }, true);
    window.addEventListener('mousedown', (e) => {
      window.__testLog.mouseDowns.push({ x: e.clientX, y: e.clientY, button: e.button, buttons: e.buttons, detail: e.detail, isTrusted: e.isTrusted, target: e.target.id });
    }, true);
    window.addEventListener('mouseup', (e) => {
      window.__testLog.mouseUps.push({ x: e.clientX, y: e.clientY, button: e.button, buttons: e.buttons, detail: e.detail, isTrusted: e.isTrusted, target: e.target.id });
    }, true);
    window.addEventListener('click', (e) => {
      window.__testLog.clicks.push({ x: e.clientX, y: e.clientY, detail: e.detail, isTrusted: e.isTrusted, target: e.target.id });
    }, true);
    window.addEventListener('keydown', (e) => {
      window.__testLog.keyDowns.push({ key: e.key, code: e.code, keyCode: e.keyCode, shiftKey: e.shiftKey, isTrusted: e.isTrusted });
    }, true);
    window.addEventListener('keyup', (e) => {
      window.__testLog.keyUps.push({ key: e.key, code: e.code, keyCode: e.keyCode, isTrusted: e.isTrusted });
    }, true);
    window.addEventListener('input', (e) => {
      window.__testLog.inputs.push({ data: e.data, inputType: e.inputType, value: e.target.value, isTrusted: e.isTrusted });
    }, true);
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/`;
console.log('Test server listening at:', url);

let tabId = null;
try {
  const opened = await callWebmcp('newTab', { url });
  tabId = opened.tabId;
  console.log('Opened tabId:', tabId);

  const snap = await callWebmcp('getAriaSnapshot', { tabId, forceFresh: true });
  console.log('ARIA Snapshot:\n' + snap.snapshot);

  const click1 = await callWebmcp('clickByRef', { tabId, ref: 'r1' });
  console.log('clickByRef(r1) result:', JSON.stringify(click1));

  const type1 = await callWebmcp('typeByRef', { tabId, ref: 'r2', text: 'Chào A1', submit: true });
  console.log('typeByRef(r2) result:', JSON.stringify(type1));

  const clickOccluded = await callWebmcp('clickByRef', { tabId, ref: 'r3' });
  console.log('clickByRef(r3 occluded) result:', JSON.stringify(clickOccluded));

  const stableRes = await callWebmcp('waitForStable', { tabId, minStableMs: 200, maxWaitMs: 1000 });
  console.log('waitForStable result:', JSON.stringify(stableRes));

  const pageReport = await callWebmcp('evaluateJS', {
    tabId,
    code: `({
      log: window.__testLog,
      inputValue: document.getElementById('inp-search').value,
      webmcpGlobals: Object.keys(window).filter((k) => k.toLowerCase().includes('webmcp')),
    })`,
  });
  console.log('Page Report:', JSON.stringify(pageReport, null, 2));
} finally {
  if (tabId) {
    try { await callWebmcp('closeTab', { tabId }); } catch {}
  }
  server.close();
}
