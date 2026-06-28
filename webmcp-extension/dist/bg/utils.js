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
