export async function resolveTabId(params) {
  if (params.tabId) return params.tabId;

  // 1. Active tab in the current window (normal case)
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) return tab.id;

  // 2. Last-focused window's active tab (current window may be a devtools/popup)
  [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab.id;

  // 3. Any open tab at all — avoids spurious "No active tab" when focus is
  //    elsewhere (e.g. the user closed the foreground tab).
  const allTabs = await chrome.tabs.query({});
  if (allTabs.length > 0) return allTabs[0].id;

  // 4. No tabs left in the browser — open a blank one so automation can
  //    continue instead of hard-failing.
  const created = await chrome.tabs.create({ url: 'about:blank', active: true });
  return created.id;
}

function isAttachableTabUrl(url) {
  return (
    typeof url === 'string' &&
    url.length > 0 &&
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('devtools://') &&
    !url.startsWith('edge://')
  );
}

export async function resolveAttachableTabId(params) {
  if (params?.tabId) return params.tabId;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id && isAttachableTabUrl(activeTab.url)) return activeTab.id;

  const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focusedTab?.id && isAttachableTabUrl(focusedTab.url)) return focusedTab.id;

  const allTabs = await chrome.tabs.query({});
  const candidate = allTabs.find((t) => t?.id && isAttachableTabUrl(t.url));
  if (candidate?.id) return candidate.id;

  const created = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (!created?.id) {
    throw new Error('ERR_NO_ATTACHABLE_TAB: Could not create about:blank tab for CDP');
  }
  return created.id;
}
