import { execFileSync } from 'node:child_process';
import path from 'node:path';

const KEY_CODES = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46
};

export async function evalInMain(session, sessionId, expression, { awaitPromise = true, returnByValue = true } = {}) {
  const res = await session.send('Runtime.evaluate', { expression, awaitPromise, returnByValue }, sessionId);
  return res.result?.value;
}

export async function tap(session, sessionId, x, y, { clickCount = 1, duration = 50 } = {}) {
  const scale = await evalInMain(session, sessionId, 'window.visualViewport?.scale').catch(() => 1);
  if (scale && Math.abs(scale - 1) > 0.01) {
    console.warn('[mobile-cdp] visualViewport.scale !== 1; tap on pinched viewport warns if scale !== 1 # ponytail: tap on pinched viewport warns if scale !== 1');
  }
  const rx = Math.round(x), ry = Math.round(y);
  await session.send('Input.synthesizeTapGesture', {
    x: rx, y: ry, gestureSourceType: 'touch', duration, tapCount: clickCount
  }, sessionId);
  return { success: true, x: rx, y: ry };
}

export async function scroll(session, sessionId, { x = 200, y = 500, deltaX = 0, deltaY = 400, exact = false, speed = 800 } = {}) {
  const rx = Math.round(x), ry = Math.round(y), dx = Math.round(deltaX), dy = Math.round(deltaY);
  if (exact) {
    const moveSteps = 6;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rx, y: ry }] }, sessionId);
    for (let i = 1; i <= moveSteps; i++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: Math.round(rx - (dx * i) / moveSteps), y: Math.round(ry - (dy * i) / moveSteps) }]
      }, sessionId);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  } else {
    await session.send('Input.synthesizeScrollGesture', {
      x: rx, y: ry, xDistance: -dx, yDistance: -dy, gestureSourceType: 'touch', speed
    }, sessionId);
  }
  return { success: true };
}

export async function swipe(session, sessionId, fromX, fromY, toX, toY, steps = 8) {
  const fx = Math.round(fromX), fy = Math.round(fromY), tx = Math.round(toX), ty = Math.round(toY);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fx, y: fy }] }, sessionId);
  for (let i = 1; i <= steps; i++) {
    const cx = Math.round(fx + ((tx - fx) * i) / steps), cy = Math.round(fy + ((ty - fy) * i) / steps);
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx, y: cy }] }, sessionId);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  return { success: true };
}

export async function key(session, sessionId, keyName) {
  const code = KEY_CODES[keyName] || 0;
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: keyName, code: keyName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code
  }, sessionId);
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: keyName, code: keyName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code
  }, sessionId);
  return { success: true, key: keyName };
}

export async function type(session, sessionId, text, { submit = false, clear = false } = {}) {
  if (clear || text === '') {
    await evalInMain(session, sessionId, 'document.activeElement?.select?.()').catch(() => {});
    await key(session, sessionId, 'Backspace');
  }
  if (text !== '') await session.send('Input.insertText', { text: String(text) }, sessionId);
  if (submit) await key(session, sessionId, 'Enter');
  return { success: true };
}

export async function screenshot(session, sessionId, { fullPage = false, format = 'jpeg', quality = 80 } = {}) {
  const res = await session.send('Page.captureScreenshot', {
    format, quality: format === 'png' ? undefined : quality, captureBeyondViewport: Boolean(fullPage)
  }, sessionId);
  return { data: res.data, format };
}

export async function cookies(session, sessionId, action, params = {}) {
  if (action === 'get') return await session.send('Network.getCookies', { urls: params.urls }, sessionId);
  if (action === 'set') return await session.send('Network.setCookie', params, sessionId);
  if (action === 'delete') return await session.send('Network.deleteCookies', params, sessionId);
  return { success: true };
}

export async function emulation(session, sessionId, params = {}) {
  if (params.timezoneId) await session.send('Emulation.setTimezoneOverride', { timezoneId: params.timezoneId }, sessionId);
  if (params.locale) await session.send('Emulation.setLocaleOverride', { locale: params.locale }, sessionId);
  if (params.resetViewport) await session.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  else if (params.setViewport && params.forceEmulation) {
    await session.send('Emulation.setDeviceMetricsOverride', params.setViewport, sessionId);
  }
  return { success: true };
}

export async function upload(session, sessionId, selector, localFilePath) {
  const fileName = path.basename(localFilePath);
  const remoteDir = `/data/local/tmp/webmcp-${Date.now()}`;
  const remotePath = `${remoteDir}/${fileName}`;
  const exec = session.adbExec || execFileSync;
  const serialArgs = session.serial ? ['-s', session.serial] : [];
  exec('adb', [...serialArgs, 'shell', 'mkdir', '-p', remoteDir]);
  exec('adb', [...serialArgs, 'push', localFilePath, remotePath]);
  try {
    const doc = await session.send('DOM.getDocument', {}, sessionId);
    const node = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }, sessionId);
    if (!node?.nodeId) throw new Error(`Selector "${selector}" not found for file upload`);
    await session.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [remotePath] }, sessionId);
    return { success: true, remotePath };
  } finally {
    try { exec('adb', [...serialArgs, 'shell', 'rm', '-f', remotePath]); } catch {}
    try { exec('adb', [...serialArgs, 'shell', 'rmdir', remoteDir]); } catch {}
  }
}
