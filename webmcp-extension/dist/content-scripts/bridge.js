// ============================================================
// WebMCP Tools Provider — Content Script Bridge
//
// Runs in the ISOLATED world.
// Forwards messages between MAIN world (register-tools.js)
// and Background Service Worker.
// ============================================================

window.addEventListener('message', (event) => {
  // Only accept messages from our own window
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.type !== 'WEBMCP_BG_REQUEST') return;

  // Forward to background script
  chrome.runtime.sendMessage(data.payload, (response) => {
    // Send response back to MAIN world
    window.postMessage({
      type: 'WEBMCP_BG_RESPONSE',
      id: data.id,
      response: response || chrome.runtime.lastError
    }, '*');
  });
});
