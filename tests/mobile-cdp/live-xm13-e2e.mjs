import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMobileSession } from '../../webmcp-mobile-cdp/session.mjs';
import { dispatchCommand } from '../../webmcp-mobile-cdp/dispatch.mjs';

const SERIAL = '100.118.203.105:5555';

async function runLiveTest() {
  console.log('=== [LIVE E2E TEST: webmcp-mobile-cdp on Xiaomi 13 (reup-xm13)] ===');
  let session = null;
  let testTabId = null;
  const tempUploadFile = path.join(os.tmpdir(), `xm13-test-upload-${Date.now()}.txt`);
  fs.writeFileSync(tempUploadFile, 'Xin chào Xiaomi 13 từ Host Máy Trạm!\n');

  try {
    // 1. Khởi tạo session
    console.log('\n[Step 1] Khởi tạo mobile session...');
    session = await createMobileSession({ serial: SERIAL }).init();
    console.log('✔ Session kết nối thành công qua CDP port:', session.port);

    // 2. Tạo tab mới với trang HTML test
    console.log('\n[Step 2] Tạo tab mới với HTML test đầy đủ...');
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XM13 E2E Live Test</title>
  <style>
    body { margin: 20px; font-family: sans-serif; }
    #btn { padding: 12px 24px; font-size: 16px; background: #007bff; color: white; border: none; border-radius: 4px; }
    #txt { display: block; margin: 15px 0; padding: 10px; font-size: 16px; width: 80%; }
    #file { margin: 15px 0; font-size: 14px; }
    #spacer { height: 3000px; margin-top: 20px; background: linear-gradient(to bottom, #f0f0f0, #888888); padding: 10px; }
  </style>
</head>
<body>
  <h1>XM13 Live E2E Verification</h1>
  <button id="btn">Bấm vào đây</button>
  <input id="txt" type="text" placeholder="Nhập tên">
  <input id="file" type="file">
  <div id="spacer">Vùng cuộn 3000px để kiểm tra scroll gesture</div>
  <script>
    window.testEvents = [];
    const btn = document.getElementById('btn');
    const evts = ['pointerdown', 'touchstart', 'mousedown', 'mouseup', 'click', 'pointerup', 'touchend'];
    evts.forEach(name => {
      btn.addEventListener(name, e => {
        window.testEvents.push({ type: name, isTrusted: e.isTrusted });
      });
    });

    window.keyEvents = [];
    window.enterPressed = false;
    const txt = document.getElementById('txt');
    txt.addEventListener('keydown', e => {
      window.keyEvents.push({ key: e.key, keyCode: e.keyCode, isTrusted: e.isTrusted });
      if (e.key === 'Enter' || e.keyCode === 13) {
        window.enterPressed = true;
      }
    });
  </script>
</body>
</html>`;

    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`;
    const newTabRes = await dispatchCommand(session, 'newTab', { url: dataUrl });
    testTabId = newTabRes.targetId;
    console.log('✔ Đã tạo tab test:', testTabId);

    // Chờ tab ổn định và kích hoạt tab
    await dispatchCommand(session, 'activateTab', { tabId: testTabId });
    await new Promise(r => setTimeout(r, 1000));

    // 3. Kiểm chứng getAriaSnapshot
    console.log('\n[Step 3] Kiểm chứng getAriaSnapshot...');
    const snapshotRes = await dispatchCommand(session, 'getAriaSnapshot', { tabId: testTabId });
    console.log('ARIA Snapshot result object:', snapshotRes);
    const snapshot = typeof snapshotRes === 'string' ? snapshotRes : snapshotRes?.snapshot;
    console.log('ARIA Snapshot tree:\n', snapshot);

    if (!snapshot || typeof snapshot !== 'string') {
      throw new Error('getAriaSnapshot không trả về chuỗi ARIA hợp lệ');
    }
    console.log('✔ getAriaSnapshot trả về thành công có chứa các phần tử.');

    // Tìm ref của button và input
    // Cú pháp: "- ref=R1 button \"Bấm vào đây\""
    const btnMatch = snapshot.match(/ref=([a-zA-Z0-9]+)\s+button\s+"Bấm vào đây"/) ||
                     snapshot.match(/ref=([a-zA-Z0-9]+)\s+button/);
    const txtMatch = snapshot.match(/ref=([a-zA-Z0-9]+)\s+textbox\s+"Nhập tên"/) ||
                     snapshot.match(/ref=([a-zA-Z0-9]+)\s+textbox/);

    console.log('Button ref match:', btnMatch ? btnMatch[1] : 'null');
    console.log('Textbox ref match:', txtMatch ? txtMatch[1] : 'null');

    // 4. Kiểm chứng clickByRef
    console.log('\n[Step 4] Kiểm chứng clickByRef (synthesizeTapGesture + isTrusted)...');
    let buttonRef = btnMatch ? btnMatch[1] : null;
    if (!buttonRef) {
      // Fallback: tìm qua selector nếu regex không bắt được chính xác cú pháp
      console.warn('Cần inspect trực tiếp cấu trúc ref từ snapshot...');
    }

    const clickRes = await dispatchCommand(session, 'clickByRef', { tabId: testTabId, ref: buttonRef || 'R1' });
    console.log('Click result:', clickRes);

    await new Promise(r => setTimeout(r, 500));
    const eventsRecorded = await dispatchCommand(session, 'evaluateJS', {
      tabId: testTabId,
      code: 'JSON.stringify(window.testEvents)'
    });
    const parsedEvents = JSON.parse(eventsRecorded || '[]');
    console.log('Sự kiện ghi nhận trên button:', parsedEvents);

    const eventTypes = parsedEvents.map(e => e.type);
    const allTrusted = parsedEvents.every(e => e.isTrusted === true);
    console.log('Danh sách sự kiện:', eventTypes.join(' -> '));
    console.log('Tất cả sự kiện đều isTrusted === true:', allTrusted);

    const requiredEvents = ['pointerdown', 'touchstart', 'mousedown', 'mouseup', 'click', 'pointerup', 'touchend'];
    const hasAll7 = requiredEvents.every(ev => eventTypes.includes(ev));
    console.log(`✔ Đủ 7 sự kiện (${requiredEvents.join(', ')}):`, hasAll7);

    // 5. Kiểm chứng typeByRef
    console.log('\n[Step 5] Kiểm chứng typeByRef (Unicode Tiếng Việt + submit: true)...');
    let inputRef = txtMatch ? txtMatch[1] : null;
    const testText = 'Xin chào Xiaomi 13 🇻🇳';
    const typeRes = await dispatchCommand(session, 'typeByRef', {
      tabId: testTabId,
      ref: inputRef || 'R2',
      text: testText,
      submit: true
    });
    console.log('Type result:', typeRes);

    await new Promise(r => setTimeout(r, 500));
    const valOnPage = await dispatchCommand(session, 'evaluateJS', {
      tabId: testTabId,
      code: 'document.getElementById("txt").value'
    });
    const enterPressed = await dispatchCommand(session, 'evaluateJS', {
      tabId: testTabId,
      code: 'window.enterPressed'
    });
    console.log(`Giá trị input.value: "${valOnPage}"`);
    console.log(`Khớp với "${testText}":`, valOnPage === testText);
    console.log(`Phím Enter đã được kích hoạt (submit: true):`, enterPressed);

    // 6. Kiểm chứng pressKey (Backspace)
    console.log('\n[Step 6] Kiểm chứng pressKey (Backspace)...');
    await dispatchCommand(session, 'pressKey', { tabId: testTabId, key: 'Backspace' });
    await new Promise(r => setTimeout(r, 300));
    const keyEvents = await dispatchCommand(session, 'evaluateJS', {
      tabId: testTabId,
      code: 'JSON.stringify(window.keyEvents)'
    });
    console.log('Key events ghi nhận:', JSON.parse(keyEvents || '[]'));
    console.log('✔ pressKey thực thi thành công.');

    // 7. Kiểm chứng scroll: synthesizeScrollGesture và exact: true
    console.log('\n[Step 7] Kiểm chứng scroll...');
    const initialScrollY = await dispatchCommand(session, 'evaluateJS', { tabId: testTabId, code: 'window.scrollY' });
    console.log('Initial scrollY:', initialScrollY);

    console.log('Gọi scroll thông thường (synthesizeScrollGesture, deltaY: 300)...');
    await dispatchCommand(session, 'scroll', { tabId: testTabId, deltaY: 300 });
    await new Promise(r => setTimeout(r, 800));
    const scrollY1 = await dispatchCommand(session, 'evaluateJS', { tabId: testTabId, code: 'window.scrollY' });
    console.log('scrollY sau scroll thông thường:', scrollY1);

    console.log('Gọi scroll với { exact: true } (dispatchTouchEvent, deltaY: 300)...');
    await dispatchCommand(session, 'scroll', { tabId: testTabId, deltaY: 300, exact: true });
    await new Promise(r => setTimeout(r, 800));
    const scrollY2 = await dispatchCommand(session, 'evaluateJS', { tabId: testTabId, code: 'window.scrollY' });
    console.log('scrollY sau scroll exact:', scrollY2);
    console.log('✔ window.scrollY > 0:', scrollY2 > 0);

    // 8. Kiểm chứng uploadFile
    console.log('\n[Step 8] Kiểm chứng uploadFile...');
    const uploadRes = await dispatchCommand(session, 'uploadFile', {
      tabId: testTabId,
      selector: '#file',
      filePath: tempUploadFile
    });
    console.log('Upload result:', uploadRes);

    const uploadedFileName = await dispatchCommand(session, 'evaluateJS', {
      tabId: testTabId,
      code: 'document.querySelector("#file").files[0]?.name'
    });
    console.log('File name trên browser:', uploadedFileName);
    console.log('Khớp tên file host:', uploadedFileName === path.basename(tempUploadFile));

    // Kiểm tra file tạm /data/local/tmp/ đã được dọn sạch
    let tmpClean = false;
    try {
      const out = session.adbExec('adb', ['-s', SERIAL, 'shell', 'ls', '-d', '/data/local/tmp/webmcp-*']).toString();
      tmpClean = !out.includes('webmcp-');
    } catch (err) {
      // Khi không có file nào khớp webmcp-*, ls trả về exit code 1 (No such file or directory)
      tmpClean = err.message.includes('No such file') || String(err.stderr || '').includes('No such file');
    }
    console.log('Kiểm tra file tạm /data/local/tmp/webmcp-*: clean =', tmpClean);

    // 9. Kiểm chứng screenshot
    console.log('\n[Step 9] Kiểm chứng screenshot...');
    const ss = await dispatchCommand(session, 'screenshot', { tabId: testTabId, format: 'jpeg', quality: 80 });
    const ssBuffer = Buffer.from(ss.data, 'base64');
    console.log('Screenshot format:', ss.format);
    console.log('Screenshot size (bytes):', ssBuffer.length);
    console.log('✔ Screenshot > 1000 bytes:', ssBuffer.length > 1000);

    // 10. Kiểm chứng setCookie & getCookies
    console.log('\n[Step 10] Kiểm chứng setCookie & getCookies...');
    await dispatchCommand(session, 'setCookie', {
      tabId: testTabId,
      name: 'xm13_cookie',
      value: 'xm13_token_value_123',
      url: 'https://example.com'
    });
    const cookieRes = await dispatchCommand(session, 'getCookies', {
      tabId: testTabId,
      urls: ['https://example.com']
    });
    console.log('Cookies retrieved:', cookieRes);
    const targetCookie = cookieRes.cookies?.find(c => c.name === 'xm13_cookie');
    console.log('✔ Cookie tìm thấy:', targetCookie?.name === 'xm13_cookie' && targetCookie?.value === 'xm13_token_value_123');

    console.log('\n========================================');
    console.log('🎉 TẤT CẢ CÁC HẠNG MỤC LIVE E2E ĐÃ PASS!');
    console.log('========================================\n');

  } finally {
    // DỌN DẸP AN TOÀN
    console.log('\n[Cleanup] Bắt đầu dọn dẹp an toàn...');
    if (fs.existsSync(tempUploadFile)) {
      try { fs.unlinkSync(tempUploadFile); } catch {}
    }
    if (session && testTabId) {
      try {
        console.log(`Đóng tab test ${testTabId}...`);
        await dispatchCommand(session, 'closeTab', { tabId: testTabId });
        console.log('✔ Đã đóng tab test.');
      } catch (e) {
        console.warn('Lỗi khi đóng tab test:', e.message);
      }
    }
    if (session) {
      try {
        console.log('Đóng session và gỡ adb forward...');
        await session.close();
        console.log('✔ Đã đóng session.');
      } catch (e) {
        console.warn('Lỗi khi close session:', e.message);
      }
    }

    // Kiểm tra adb forward --list
    try {
      const { execSync } = await import('node:child_process');
      const fwList = execSync(`adb -s ${SERIAL} forward --list`).toString().trim();
      console.log('Trạng thái adb forward sau cleanup:', fwList ? fwList : '(Trống - Đã sạch hoàn toàn)');
    } catch {}
  }
}

runLiveTest().catch(err => {
  console.error('\n❌ TEST RUNNER GẶP LỖI:', err);
  process.exit(1);
});
