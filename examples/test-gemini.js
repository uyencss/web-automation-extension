const { sendCommand } = require('./gateway_client');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('Finding Gemini tab...');
  try {
    const listResult = await sendCommand('listTabs');
    let geminiTab = listResult.tabs.find(t => t.url.includes('gemini.google.com'));
    let tabId;
    if (geminiTab) {
      console.log(`Closing existing Gemini tab: ${geminiTab.id}`);
      try {
        await sendCommand('closeTab', { tabId: geminiTab.id });
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.log('Error closing tab:', err.message);
      }
    }

    console.log('Opening a new tab to Gemini...');
    const newTabResult = await sendCommand('newTab', { url: 'https://gemini.google.com/app' });
    console.log('Opened Gemini in tab:', newTabResult.tabId);
    tabId = newTabResult.tabId;

    console.log('Waiting 5 seconds for page load...');
    await new Promise(r => setTimeout(r, 5000));

    // 1. Type message
    const prompt = 'Xin chào, bạn có thể tóm tắt về WebMCP bằng 3 câu ngắn gọn không?';
    console.log(`Typing prompt: "${prompt}"`);
    const textResult = await sendCommand('evaluateJS', {
      tabId,
      code: `
        return new Promise((resolve) => {
          const el = document.querySelector('rich-textarea p') || document.querySelector('div[role="textbox"]');
          if (!el) {
            return resolve({ success: false, error: 'Textbox not found' });
          }
          el.focus();
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false, null);
          
          document.execCommand('insertText', false, ${JSON.stringify(prompt)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          
          setTimeout(() => {
            resolve({ success: true });
          }, 500);
        });
      `
    });
    
    if (!textResult.result?.success) {
      throw new Error(textResult.result?.error || 'Failed to insert text');
    }
    console.log('Text typed successfully!');

    // Wait a bit for UI to update (Send button to appear)
    await new Promise(r => setTimeout(r, 1000));

    // Get current number of message-contents to know when a NEW one is added
    const preCountRes = await sendCommand('evaluateJS', {
      tabId,
      code: `return document.querySelectorAll('message-content').length;`
    });
    const preCount = preCountRes.result || 0;
    console.log(`Pre-existing messages count: ${preCount}`);

    // 2. Click Send button OR press Enter
    console.log('Pressing Enter to send...');
    const sendResult = await sendCommand('evaluateJS', {
      tabId,
      code: `
        const btn = document.querySelector('button[aria-label*="Send message"], button[aria-label*="Gửi"], button.send-button');
        if (btn && !btn.disabled) {
          btn.click();
          return { success: true, method: 'click' };
        }
        
        // Fallback: Press Enter on the textbox
        const el = document.querySelector('rich-textarea p') || document.querySelector('div[role="textbox"]');
        if (el) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          return { success: true, method: 'enter_key' };
        }
        return { success: false, error: 'Send button and textbox not found' };
      `
    });
    console.log('Send trigger result:', sendResult.result);

    if (!sendResult.result?.success) {
      throw new Error(sendResult.result?.error || 'Failed to trigger send');
    }

    // 3. Wait for new message container to appear
    console.log('Waiting for new message container to appear...');
    let foundNew = false;
    for (let i = 0; i < 20; i++) {
      const curCountRes = await sendCommand('evaluateJS', {
        tabId,
        code: `return document.querySelectorAll('message-content').length;`
      });
      if (curCountRes.result > preCount) {
        foundNew = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!foundNew) {
      console.log('Warning: New message container did not appear within 10s.');
    }

    // 4. Polling DOM to wait for response to finish from Node.js side
    console.log('Waiting for Gemini to generate response (polling DOM)...');
    
    let attempts = 0;
    let lastText = '';
    let sameCount = 0;
    let finalText = null;

    while (attempts < 60) { // 60 * 500ms = 30 seconds
      attempts++;
      
      const responseText = await sendCommand('evaluateJS', {
        tabId,
        code: `
          const responses = Array.from(document.querySelectorAll('message-content'));
          if (responses.length > 0) {
            return responses[responses.length - 1].innerText || responses[responses.length - 1].textContent;
          }
          return "";
        `
      });

      const currentText = responseText.result || "";
      console.log(`[Attempt ${attempts}] Text length: ${currentText.length}`);
      
      if (currentText && currentText.trim().length > 0) {
        if (currentText === lastText) {
          sameCount++;
          if (sameCount >= 5) {
            finalText = currentText;
            break;
          }
        } else {
          sameCount = 0;
          lastText = currentText;
        }
      }
      
      await new Promise(r => setTimeout(r, 500));
    }

    if (!finalText) {
      console.error('DOM Error: Timeout waiting for response generation');
    } else {
      console.log('\n======================================');
      console.log('🌟 GEMINI RESPONSE 🌟');
      console.log('======================================\n');
      console.log(finalText);
      console.log('\n======================================\n');
      
      const outPath = path.join(__dirname, 'gemini_response.txt');
      fs.writeFileSync(outPath, finalText);
      console.log(`✅ Kết quả sạch sẽ (Text) đã được lưu tại: ${outPath}`);
    }

    console.log('Gemini chat test completed successfully!');
  } catch (err) {
    console.error('Error during Gemini automation:', err.message);
  }
}

main();
