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

// Top-frame Tab Title Lock & MutationObserver
if (window.top === window) {
  let lockedTitle = null;
  let pageTitle = '';
  let hasCapturedPageTitle = false;
  let headObserver = null;

  function syncTitle() {
    if (!chrome.runtime?.id) {
      if (headObserver) {
        headObserver.disconnect();
        headObserver = null;
      }
      return;
    }
    if (lockedTitle !== null && document.title !== lockedTitle) {
      if (document.title) {
        pageTitle = document.title;
        hasCapturedPageTitle = true;
      }
      document.title = lockedTitle;
    }
  }

  function attachHeadObserver() {
    if (headObserver) return;
    headObserver = new MutationObserver(syncTitle);
    const startObserve = () => {
      const target = document.head || document.documentElement;
      if (target && headObserver) {
        headObserver.observe(target, { subtree: true, childList: true, characterData: true });
      }
    };

    if (document.head) {
      startObserve();
    } else {
      startObserve();
      window.addEventListener(
        'DOMContentLoaded',
        () => {
          if (headObserver) {
            headObserver.disconnect();
            startObserve();
          }
        },
        { once: true }
      );
    }
  }

  function applyLockedTitle(nextTitle) {
    if (nextTitle) {
      if (lockedTitle === null && document.title !== nextTitle) {
        pageTitle = document.title;
        hasCapturedPageTitle = true;
      }
      lockedTitle = nextTitle;
      if (document.head || document.title !== lockedTitle) {
        document.title = lockedTitle;
      }
      attachHeadObserver();
    } else {
      lockedTitle = null;
      if (headObserver) {
        headObserver.disconnect();
        headObserver = null;
      }
      if (hasCapturedPageTitle) {
        document.title = pageTitle;
      }
    }
    return { ok: true, title: document.title, customTitle: lockedTitle };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'WEBMCP_TAB_TITLE') return false;
    sendResponse(applyLockedTitle(msg.title || null));
    return false;
  });

  try {
    chrome.runtime.sendMessage({ type: 'WEBMCP_TAB_TITLE_INIT' }, (res) => {
      if (!chrome.runtime?.id || chrome.runtime.lastError) return;
      if (res?.customTitle) {
        applyLockedTitle(res.customTitle);
      }
    });
  } catch {
    // context might be invalidated or unavailable
  }
}
