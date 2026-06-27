import { ensureDebuggerAttached, sendCDPCommand } from '../cdp-bridge.js';

// ─────────────────────────────────────────────────────────────
// Best-in-class network capture
//
// Improvements over the naive version:
//  • Multiple concurrent patterns per tab (start adds, does not overwrite).
//  • Captures EVERY matching request, not just the first finished one.
//  • Rich metadata: method, status, mimeType, timing, resourceType,
//    request/response headers, request post body, response body.
//  • Response bodies are fetched proactively on loadingFinished (CDP evicts
//    bodies quickly, so fetching lazily on wait often failed).
//  • Event-driven waiters (no 500ms polling) with consume semantics, so
//    repeated wait_for calls walk through successive responses.
//  • get_captured_requests to pull the full list at once.
//  • Bounded memory (ring buffer per session) and detach cleanup.
// ─────────────────────────────────────────────────────────────

const MAX_REQUESTS_PER_SESSION = 300;

// tabId -> {
//   patterns: Set<string>,
//   requests: Map<requestId, ReqRecord>,
//   order: requestId[],            // insertion order for eviction
//   waiters: Waiter[],
// }
const captureSessions = new Map();

// Waiter = { pattern, resolve, timer, includeBody }

function getSession(tabId) {
  return captureSessions.get(tabId);
}

function matchesAny(url, patterns) {
  for (const p of patterns) if (url.includes(p)) return p;
  return null;
}

function publicRecord(rec, { includeBody = true, includeHeaders = false } = {}) {
  const out = {
    requestId: rec.requestId,
    url: rec.url,
    method: rec.method,
    resourceType: rec.resourceType,
    status: rec.status ?? null,
    statusText: rec.statusText ?? '',
    mimeType: rec.mimeType ?? '',
    fromCache: !!rec.fromCache,
    failed: !!rec.failed,
    errorText: rec.errorText || undefined,
    state: rec.state, // 'pending' | 'finished' | 'failed'
    durationMs: rec.endTime && rec.startTime
      ? Math.round((rec.endTime - rec.startTime) * 1000)
      : undefined,
  };
  if (includeHeaders) {
    out.requestHeaders = rec.requestHeaders || {};
    out.responseHeaders = rec.responseHeaders || {};
  }
  if (rec.postData !== undefined) out.requestBody = rec.postData;
  if (includeBody) {
    out.body = rec.body ?? null;
    out.base64Encoded = !!rec.base64Encoded;
    out.bodyBytes = typeof rec.body === 'string' ? rec.body.length : 0;
  }
  return out;
}

// ─── Public command handlers ─────────────────────────────────

export async function startNetworkCapture(tabId, { url_pattern } = {}) {
  if (!url_pattern || typeof url_pattern !== 'string') {
    throw new Error('start_network_capture requires a string "url_pattern".');
  }
  await ensureDebuggerAttached(tabId);
  await sendCDPCommand(tabId, 'Network.enable', {});

  let session = captureSessions.get(tabId);
  if (!session) {
    session = { patterns: new Set(), requests: new Map(), order: [], waiters: [] };
    captureSessions.set(tabId, session);
  }
  session.patterns.add(url_pattern);

  return { success: true, patterns: [...session.patterns] };
}

export async function stopNetworkCapture(tabId, { url_pattern } = {}) {
  const session = captureSessions.get(tabId);
  if (!session) return { success: true, patterns: [] };

  // Remove a single pattern if specified and others remain; otherwise tear down.
  if (url_pattern && session.patterns.size > 1) {
    session.patterns.delete(url_pattern);
    return { success: true, patterns: [...session.patterns] };
  }

  // Reject any still-pending waiters so callers don't hang.
  for (const w of session.waiters) {
    clearTimeout(w.timer);
    w.resolve({ error: 'Network capture stopped before a response arrived.' });
  }
  captureSessions.delete(tabId);
  try {
    await sendCDPCommand(tabId, 'Network.disable', {});
  } catch {
    // ignore — tab may be gone
  }
  return { success: true, patterns: [] };
}

export async function waitForNetworkResponse(tabId, { url_pattern, timeout_ms = 10000, include_body = true } = {}) {
  const session = captureSessions.get(tabId);
  if (!session) {
    throw new Error('Network capture not started. Call start_network_capture first.');
  }
  if (!url_pattern) throw new Error('wait_for_network_response requires "url_pattern".');

  // Immediate hit: oldest finished + unconsumed match whose body is ready.
  const ready = findReadyMatch(session, url_pattern);
  if (ready) {
    ready.consumed = true;
    return publicRecord(ready, { includeBody: include_body });
  }

  // Otherwise register an event-driven waiter.
  return new Promise((resolve) => {
    const waiter = {
      pattern: url_pattern,
      includeBody: include_body,
      resolve,
      timer: setTimeout(() => {
        const i = session.waiters.indexOf(waiter);
        if (i >= 0) session.waiters.splice(i, 1);
        resolve({ error: `Timeout waiting for network response matching: ${url_pattern}` });
      }, timeout_ms),
    };
    session.waiters.push(waiter);
  });
}

export async function getCapturedRequests(tabId, { url_pattern, include_bodies = false, include_headers = false, limit = 100 } = {}) {
  const session = captureSessions.get(tabId);
  if (!session) {
    throw new Error('Network capture not started. Call start_network_capture first.');
  }
  const records = [];
  for (const id of session.order) {
    const rec = session.requests.get(id);
    if (!rec) continue;
    if (url_pattern && !rec.url.includes(url_pattern)) continue;
    records.push(publicRecord(rec, { includeBody: include_bodies, includeHeaders: include_headers }));
    if (records.length >= limit) break;
  }
  return {
    patterns: [...session.patterns],
    count: records.length,
    requests: records,
  };
}

// ─── Internal helpers ────────────────────────────────────────

function findReadyMatch(session, pattern) {
  for (const id of session.order) {
    const rec = session.requests.get(id);
    if (!rec || rec.consumed) continue;
    if (rec.state !== 'finished' && rec.state !== 'failed') continue;
    if (!rec.bodyReady) continue;
    if (rec.url.includes(pattern)) return rec;
  }
  return null;
}

function notifyWaiters(session) {
  if (!session.waiters.length) return;
  for (let i = session.waiters.length - 1; i >= 0; i--) {
    const w = session.waiters[i];
    const rec = findReadyMatch(session, w.pattern);
    if (rec) {
      rec.consumed = true;
      clearTimeout(w.timer);
      session.waiters.splice(i, 1);
      w.resolve(publicRecord(rec, { includeBody: w.includeBody }));
    }
  }
}

function evictIfNeeded(session) {
  while (session.order.length > MAX_REQUESTS_PER_SESSION) {
    const oldId = session.order.shift();
    session.requests.delete(oldId);
  }
}

async function captureBody(tabId, session, rec) {
  try {
    const res = await sendCDPCommand(tabId, 'Network.getResponseBody', { requestId: rec.requestId });
    rec.body = res.body;
    rec.base64Encoded = !!res.base64Encoded;
  } catch (err) {
    // No body (204/redirect/websocket) or already evicted.
    rec.body = null;
    rec.base64Encoded = false;
    rec.bodyError = err.message;
  } finally {
    rec.bodyReady = true;
    notifyWaiters(session);
  }
}

// ─── CDP event hook (registered once) ────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  const session = captureSessions.get(tabId);
  if (!session) return;

  switch (method) {
    case 'Network.requestWillBeSent': {
      const url = params.request?.url || '';
      if (!matchesAny(url, session.patterns)) return;
      const rec = {
        requestId: params.requestId,
        url,
        method: params.request.method,
        resourceType: params.type || 'Other',
        requestHeaders: params.request.headers || {},
        postData: params.request.hasPostData ? (params.request.postData ?? '[postData not inlined]') : undefined,
        startTime: params.timestamp,
        state: 'pending',
        consumed: false,
        bodyReady: false,
      };
      session.requests.set(params.requestId, rec);
      session.order.push(params.requestId);
      evictIfNeeded(session);
      return;
    }

    case 'Network.responseReceived': {
      const rec = session.requests.get(params.requestId);
      if (!rec) return;
      const r = params.response || {};
      rec.status = r.status;
      rec.statusText = r.statusText;
      rec.mimeType = r.mimeType;
      rec.responseHeaders = r.headers || {};
      rec.fromCache = !!r.fromDiskCache;
      return;
    }

    case 'Network.loadingFinished': {
      const rec = session.requests.get(params.requestId);
      if (!rec) return;
      rec.state = 'finished';
      rec.endTime = params.timestamp;
      // Fetch body now while it is still resident in CDP memory.
      captureBody(tabId, session, rec);
      return;
    }

    case 'Network.loadingFailed': {
      const rec = session.requests.get(params.requestId);
      if (!rec) return;
      rec.state = 'failed';
      rec.failed = true;
      rec.errorText = params.errorText || 'Request failed';
      rec.endTime = params.timestamp;
      rec.bodyReady = true; // unblock waiters with the failure
      notifyWaiters(session);
      return;
    }
  }
});

// Clean up capture state if the debugger detaches from a tab.
chrome.debugger.onDetach.addListener((source) => {
  const session = captureSessions.get(source.tabId);
  if (!session) return;
  for (const w of session.waiters) {
    clearTimeout(w.timer);
    w.resolve({ error: 'Debugger detached during capture.' });
  }
  captureSessions.delete(source.tabId);
});
