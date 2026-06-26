export async function resolveTabId(params) {
  if (params.tabId) return params.tabId;
  // Default to the active tab in the current window
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
}
