const { sendCommand } = require('./gateway_client');
const fs = require('fs');

async function main() {
  try {
    const listResult = await sendCommand('listTabs');
    const fbTab = listResult.tabs.find(t => t.url.includes('facebook.com'));
    if (!fbTab) {
      console.error('No Facebook tab found!');
      process.exit(1);
    }
    
    console.log(`Taking screenshot of tab ${fbTab.id}...`);
    const screenshotResult = await sendCommand('screenshot', { tabId: fbTab.id });
    const buffer = Buffer.from(screenshotResult.base64, 'base64');
    fs.writeFileSync('/Users/ttcenter/.gemini/antigravity-ide/brain/ab179dd8-8f2e-4869-a7f9-e3e955b8ba92/facebook_screenshot.png', buffer);
    console.log('Screenshot saved to facebook_screenshot.png');
    process.exit(0);
  } catch (err) {
    console.error('Error taking screenshot:', err.message);
    process.exit(1);
  }
}

main();
