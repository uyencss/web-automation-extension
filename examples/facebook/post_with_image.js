const { sendCommand } = require('./gateway_client');
const fs = require('fs');

async function main() {
  console.log('Finding Facebook tab...');
  try {
    const listResult = await sendCommand('listTabs');
    let fbTab = listResult.tabs.find(t => t.url.includes('facebook.com'));
    let tabId;
    if (fbTab) {
      console.log(`Disabling beforeunload on existing Facebook tab: ${fbTab.id}`);
      try {
        await sendCommand('evaluateJS', {
          tabId: fbTab.id,
          code: 'window.onbeforeunload = null; window.addEventListener("beforeunload", (e) => { e.stopImmediatePropagation(); }, true);'
        });
      } catch (err) {
        console.log('Could not disable beforeunload:', err.message);
      }
      console.log(`Closing existing Facebook tab: ${fbTab.id}`);
      try {
        await sendCommand('closeTab', { tabId: fbTab.id });
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.log('Error closing tab:', err.message);
      }
    }

    console.log('Opening a new tab to Facebook...');
    const newTabResult = await sendCommand('newTab', { url: 'https://www.facebook.com' });
    console.log('Opened Facebook in tab:', newTabResult.tabId);
    tabId = newTabResult.tabId;

    console.log('Waiting 5 seconds for page load & assets...');
    await new Promise(r => setTimeout(r, 5000));

    // Helper to check and dismiss WhatsApp popup
    const dismissWhatsAppPopup = async () => {
      console.log('Checking for WhatsApp "Not Now" / "Để sau" popup...');
      const dismissResult = await sendCommand('evaluateJS', {
        tabId,
        code: `
          const dismissBtn = Array.from(document.querySelectorAll('div[role="button"], button')).find(e => {
            const txt = e.textContent.trim().toLowerCase();
            return txt === 'not now' || txt === 'để sau' || txt === 'lúc khác';
          });
          if (dismissBtn) {
            dismissBtn.click();
            return { success: true, dismissed: dismissBtn.textContent.trim() };
          }
          return { success: false };
        `
      });
      if (dismissResult?.success) {
        console.log(`Dismissed WhatsApp popup: "${dismissResult.dismissed}"`);
        await new Promise(r => setTimeout(r, 2000)); // Wait for transition
      }
    };

    // 1. Click "What's on your mind" box
    console.log('Clicking the "What\'s on your mind" box...');
    const clickTriggerResult = await sendCommand('evaluateJS', {
      tabId,
      code: `
        const el = Array.from(document.querySelectorAll('div[role="button"]')).find(e => 
          e.textContent.toLowerCase().includes("what's on your mind") || 
          e.textContent.toLowerCase().includes("đang nghĩ gì")
        );
        if (el) {
          el.click();
          return { success: true };
        }
        return { success: false };
      `
    });

    if (!clickTriggerResult.result?.success) {
      throw new Error('Failed to click trigger');
    }

    console.log('Waiting 3 seconds for Create Post modal to open...');
    await new Promise(r => setTimeout(r, 3000));

    // 2. Click "Photo/video" button while mocking click to prevent OS dialog
    console.log('Switching composer layout while mocking file input click...');
    const mockRes = await sendCommand('evaluateJS', {
      tabId,
      code: `
        const originalClick = HTMLInputElement.prototype.click;
        let clickCalled = false;
        HTMLInputElement.prototype.click = function() {
          if (this.type === 'file') {
            clickCalled = true;
            return;
          }
          originalClick.apply(this, arguments);
        };

        const photoBtn = document.querySelector('div[role="button"][aria-label="Photo/video"], div[role="button"][aria-label="Ảnh/video"]');
        if (photoBtn) {
          photoBtn.click();
        }

        setTimeout(() => {
          HTMLInputElement.prototype.click = originalClick;
        }, 500);

        return { photoBtnFound: !!photoBtn, clickCalled };
      `
    });
    console.log('Mock/Click switch result:', mockRes.result);

    console.log('Waiting 2 seconds for Photo/video layout to load...');
    await new Promise(r => setTimeout(r, 2000));

    // 3. Inject image file using DataTransfer and base64
    const imagePath = '/Users/ttcenter/.gemini/antigravity-ide/brain/ab179dd8-8f2e-4869-a7f9-e3e955b8ba92/sunset_gradient_1782449668910.png';
    console.log(`Reading image file: ${imagePath}`);
    let base64Data;
    try {
      base64Data = fs.readFileSync(imagePath, { encoding: 'base64' });
    } catch (e) {
      // Fallback: search for any PNG in brain directory
      console.log('Primary image path not found, looking for alternative PNG in brain folder...');
      const files = fs.readdirSync('/Users/ttcenter/.gemini/antigravity-ide/brain/ab179dd8-8f2e-4869-a7f9-e3e955b8ba92');
      const pngFile = files.find(f => f.endsWith('.png'));
      if (pngFile) {
        base64Data = fs.readFileSync(`/Users/ttcenter/.gemini/antigravity-ide/brain/ab179dd8-8f2e-4869-a7f9-e3e955b8ba92/${pngFile}`, { encoding: 'base64' });
      } else {
        throw new Error('No sunset image found in brain folder. Please verify image exists.');
      }
    }
    const dataUrl = `data:image/png;base64,${base64Data}`;

    console.log('Injecting base64 file via DataTransfer...');
    const injectRes = await sendCommand('evaluateJS', {
      tabId,
      code: `
        return (async () => {
          const dialog = document.querySelector('div[role="dialog"]');
          if (!dialog) return { success: false, error: 'Dialog not found' };
          const input = dialog.querySelector('input[type="file"]');
          if (!input) return { success: false, error: 'File input not found inside dialog' };

          try {
            const res = await fetch(${JSON.stringify(dataUrl)});
            const blob = await res.blob();
            const file = new File([blob], 'sunset.png', { type: 'image/png' });
            
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true, fileName: file.name, fileSize: file.size };
          } catch (e) {
            return { success: false, error: e.message };
          }
        })();
      `
    });
    console.log('Injection result:', injectRes);

    if (!injectRes.result?.success) {
      throw new Error(injectRes.result?.error || 'Failed to inject file');
    }

    console.log('Waiting 3 seconds for upload processing...');
    await new Promise(r => setTimeout(r, 3000));

    // 4. Focus the textbox and insert text
    const postContent = 'A beautiful sunset over mountains! 🌄 #Nature #Sunset';
    console.log(`Focusing and inserting text: "${postContent}"`);
    const textResult = await sendCommand('evaluateJS', {
      tabId,
      code: `
        return new Promise((resolve) => {
          const el = document.querySelector('div[role="textbox"]');
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
          
          document.execCommand('insertText', false, ${JSON.stringify(postContent)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          
          // Wait for popover to appear, then check and press Escape if listbox is active
          setTimeout(() => {
            const listbox = document.querySelector('div[role="listbox"], [role="listbox"]');
            if (listbox) {
              el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, code: 'Escape', which: 27, bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, code: 'Escape', which: 27, bubbles: true }));
            }
            setTimeout(() => {
              el.blur();
              resolve({ success: true });
            }, 200);
          }, 300);
        });
      `
    });

    if (!textResult.result?.success) {
      throw new Error(textResult.result?.error || 'Failed to insert text');
    }

    // Dismiss WhatsApp popup if any
    await dismissWhatsAppPopup();

    // 5. Click the "Post" / "Đăng" or "Next" / "Tiếp" button (polling until enabled)
    console.log('Waiting for the primary button to become enabled...');
    const clickPrimaryResult = await sendCommand('evaluateJS', {
      tabId,
      code: `
        return new Promise((resolve) => {
          let attempts = 0;
          const checkButton = () => {
            const el = Array.from(document.querySelectorAll('div[role="button"]')).find(e => 
              ['Post', 'Đăng', 'Next', 'Tiếp'].includes(e.textContent.trim())
            );
            if (el) {
              const clickedText = el.textContent.trim();
              const isDisabled = el.getAttribute('aria-disabled') === 'true';
              if (!isDisabled) {
                el.click();
                return resolve({ success: true, clicked: clickedText });
              }
            }
            attempts++;
            if (attempts >= 20) {
              return resolve({ success: false, error: 'Button remained disabled or not found after 20s' });
            }
            setTimeout(checkButton, 1000);
          };
          checkButton();
        });
      `
    });
    console.log('Click primary button result:', clickPrimaryResult);

    if (!clickPrimaryResult.result?.success) {
      throw new Error(clickPrimaryResult.result?.error || 'Failed to click primary button');
    }

    // If it was "Next" or "Tiếp", click "Post" on the second screen
    if (['Next', 'Tiếp'].includes(clickPrimaryResult.result.clicked)) {
      console.log('Waiting 5 seconds for the second step of post creation...');
      await new Promise(r => setTimeout(r, 5000));

      await dismissWhatsAppPopup();

      console.log('Ensuring all popovers and textboxes are dismissed on settings screen...');
      await sendCommand('evaluateJS', {
        tabId,
        code: `
          return new Promise((resolve) => {
            const listbox = document.querySelector('div[role="listbox"], [role="listbox"]');
            const activeEl = document.activeElement;
            const isTextbox = activeEl && (activeEl.getAttribute('role') === 'textbox' || activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
            
            if (listbox || isTextbox) {
              const target = isTextbox ? activeEl : (document.querySelector('div[role="textbox"]') || activeEl);
              if (target) {
                target.focus();
                target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, code: 'Escape', which: 27, bubbles: true }));
                target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, code: 'Escape', which: 27, bubbles: true }));
                setTimeout(() => {
                  target.blur();
                  setTimeout(() => resolve({ dismissed: true }), 300);
                }, 100);
                return;
              }
            }
            resolve({ dismissed: false });
          });
        `
      });

      console.log('Clicking the final "Post" / "Đăng" / "Share" / "Chia sẻ" button...');
      const clickFinalResult = await sendCommand('evaluateJS', {
        tabId,
        code: `
          const el = Array.from(document.querySelectorAll('div[role="button"]')).find(e => 
            ['Post', 'Đăng', 'Share', 'Chia sẻ'].includes(e.textContent.trim())
          );
          if (el) {
            const isDisabled = el.getAttribute('aria-disabled') === 'true';
            if (isDisabled) {
              return { success: false, error: 'Final button is disabled' };
            }
            el.click();
            return { success: true };
          }
          return { success: false, error: 'Final Post/Share button not found' };
        `
      });
      console.log('Click final button result:', clickFinalResult);

      if (!clickFinalResult.result?.success) {
        throw new Error(clickFinalResult.result?.error || 'Failed to click final button');
      }
    }

    // Final WhatsApp popup dismissal
    await new Promise(r => setTimeout(r, 2000));
    await dismissWhatsAppPopup();

    console.log('Waiting 5 seconds for posting to complete...');
    await new Promise(r => setTimeout(r, 5000));

    console.log('Image post completed successfully!');
  } catch (err) {
    console.error('Error during Facebook post:', err.message);
  }
}

main();
