import { attachedTabs } from './state.js';

const CDP_TIMEOUT_MS = 30000;

export async function ensureDebuggerAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  } catch (err) {
    // Already attached (by another extension like Codex?)
    if (err.message?.includes('Another debugger is already attached')) {
      throw new Error(
        `Tab ${tabId} already has a debugger attached (likely Codex). ` +
        'Detach it first or use a different tab.'
      );
    }
    // Already attached by us
    if (err.message?.includes('already attached')) {
      attachedTabs.add(tabId);
      return;
    }
    throw err;
  }
}

export async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignore
  }
  attachedTabs.delete(tabId);
}

export async function sendCDPCommand(tabId, method, commandParams = {}) {
  await ensureDebuggerAttached(tabId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CDP command "${method}" timed out after ${CDP_TIMEOUT_MS}ms`));
    }, CDP_TIMEOUT_MS);

    chrome.debugger.sendCommand({ tabId }, method, commandParams, (result) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// Clean up when debugger detaches
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

export async function evaluateInTab(tabId, expression, awaitPromise = true) {
  const result = await sendCDPCommand(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.text ||
      result.exceptionDetails.exception?.description ||
      'JS evaluation error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}
