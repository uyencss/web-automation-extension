import { ensureDebuggerAttached, sendCDPCommand } from '../cdp-bridge.js';
import { resolveTabId } from '../utils.js';

const MAX_MESSAGES_PER_SESSION = 500;
const VALID_LEVELS = new Set([
  'log',
  'warn',
  'error',
  'info',
  'debug',
  'exception',
  'assert',
  'trace',
  'table',
  'dir',
  'dirxml',
  'clear',
  'startGroup',
  'startGroupCollapsed',
  'endGroup',
  'profile',
  'profileEnd',
  'count',
  'timeEnd',
]);

const consoleSessions = new Map();
let messageIdCounter = 0;

function getSession(tabId) {
  return consoleSessions.get(tabId);
}

function normalizeLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(Math.floor(parsed), MAX_MESSAGES_PER_SESSION);
}

function validateLevel(level) {
  if (!level) return null;
  if (!VALID_LEVELS.has(level)) {
    throw new Error(`Unsupported console level "${level}".`);
  }
  return level;
}

function normalizeConsoleApiLevel(level) {
  if (level === 'warning') return 'warn';
  return level || 'log';
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function previewToText(preview) {
  if (!preview || typeof preview !== 'object') return '';
  if (preview.description) return preview.description;

  const properties = Array.isArray(preview.properties) ? preview.properties : [];
  if (!properties.length) return '';

  const body = properties
    .slice(0, 8)
    .map((prop) => {
      const name = prop.name || '';
      const value = prop.value ?? prop.description ?? prop.type ?? '';
      return `${name}: ${value}`;
    })
    .join(', ');

  if (preview.subtype === 'array') return `[${body}]`;
  return `{${body}}`;
}

function remoteObjectToText(arg) {
  if (!arg || typeof arg !== 'object') return '';

  if (arg.type === 'string') return arg.value ?? '';
  if (arg.type === 'number' || arg.type === 'boolean' || arg.type === 'bigint') {
    return String(arg.value ?? arg.unserializableValue ?? arg.description ?? '');
  }
  if (arg.type === 'undefined') return 'undefined';
  if (arg.subtype === 'null') return 'null';
  if (arg.type === 'symbol' || arg.type === 'function') {
    return arg.description || arg.type;
  }
  if (arg.type === 'object') {
    return arg.description ||
      previewToText(arg.preview) ||
      safeStringify(arg.value) ||
      '[object]';
  }

  return arg.description || String(arg.value ?? '');
}

function stackTraceToText(stackTrace) {
  const frames = stackTrace?.callFrames;
  if (!Array.isArray(frames) || !frames.length) return undefined;

  return frames
    .map((frame) => {
      const name = frame.functionName || '(anonymous)';
      const url = frame.url || '<anonymous>';
      const line = frame.lineNumber ?? -1;
      const column = frame.columnNumber ?? -1;
      return `  at ${name} (${url}:${line}:${column})`;
    })
    .join('\n');
}

function firstCallFrame(stackTrace) {
  return stackTrace?.callFrames?.[0] || {};
}

function pushMessage(tabId, message) {
  const session = getSession(tabId);
  if (!session) return;

  session.messages.push({
    id: ++messageIdCounter,
    timestamp: Date.now(),
    ...message,
  });

  while (session.messages.length > MAX_MESSAGES_PER_SESSION) {
    session.messages.shift();
  }
}

export async function startConsoleCapture(tabId) {
  if (consoleSessions.has(tabId)) {
    return { success: true, already_running: true, tabId };
  }

  await ensureDebuggerAttached(tabId);
  await sendCDPCommand(tabId, 'Runtime.enable', {});

  consoleSessions.set(tabId, {
    messages: [],
    startedAt: Date.now(),
  });

  return { success: true, tabId };
}

export async function stopConsoleCapture(tabId) {
  const session = getSession(tabId);
  if (!session) return { success: true, was_running: false, tabId };

  consoleSessions.delete(tabId);
  try {
    await sendCDPCommand(tabId, 'Runtime.disable', {});
  } catch {
    // The tab or debugger session may already be gone.
  }

  return {
    success: true,
    was_running: true,
    tabId,
    captured_count: session.messages.length,
  };
}

export async function readConsoleMessages(tabId, {
  level,
  pattern,
  limit = 100,
  since,
  clear = false,
} = {}) {
  const session = getSession(tabId);
  if (!session) {
    throw new Error('Console capture not started. Call startConsoleCapture first.');
  }

  const normalizedLevel = validateLevel(level);
  const normalizedLimit = normalizeLimit(limit);
  const sinceTimestamp = since === undefined || since === null ? null : Number(since);
  if (sinceTimestamp !== null && !Number.isFinite(sinceTimestamp)) {
    throw new Error('readConsoleMessages "since" must be a timestamp number.');
  }

  let results = session.messages;
  if (normalizedLevel) {
    results = results.filter((message) => message.level === normalizedLevel);
  }
  if (pattern) {
    const needle = String(pattern);
    results = results.filter((message) => message.text.includes(needle));
  }
  if (sinceTimestamp !== null) {
    results = results.filter((message) => message.timestamp >= sinceTimestamp);
  }

  const messages = results.slice(-normalizedLimit);
  if (clear) {
    const consumedIds = new Set(messages.map((message) => message.id));
    session.messages = session.messages.filter((message) => !consumedIds.has(message.id));
  }

  return {
    tabId,
    count: messages.length,
    total_buffered: session.messages.length,
    capture_started_at: session.startedAt,
    messages,
  };
}

export async function clearConsoleMessages(tabId) {
  const session = getSession(tabId);
  if (!session) {
    throw new Error('Console capture not started. Call startConsoleCapture first.');
  }

  const cleared = session.messages.length;
  session.messages = [];
  return { success: true, tabId, cleared_count: cleared };
}

chrome.debugger.onEvent.addListener((source, method, params = {}) => {
  const tabId = source.tabId;
  if (tabId === undefined || tabId === null || !consoleSessions.has(tabId)) return;

  if (method === 'Runtime.consoleAPICalled') {
    const callFrame = firstCallFrame(params.stackTrace);
    pushMessage(tabId, {
      level: normalizeConsoleApiLevel(params.type),
      text: (params.args || []).map(remoteObjectToText).join(' '),
      url: callFrame.url || '',
      lineNumber: callFrame.lineNumber ?? -1,
      columnNumber: callFrame.columnNumber ?? -1,
      stackTrace: stackTraceToText(params.stackTrace),
    });
    return;
  }

  if (method === 'Runtime.exceptionThrown') {
    const detail = params.exceptionDetails || {};
    const exception = detail.exception || {};
    pushMessage(tabId, {
      level: 'exception',
      text: exception.description || exception.value || detail.text || 'Unknown exception',
      url: detail.url || '',
      lineNumber: detail.lineNumber ?? -1,
      columnNumber: detail.columnNumber ?? -1,
      stackTrace: stackTraceToText(detail.stackTrace),
    });
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined && source.tabId !== null) {
    consoleSessions.delete(source.tabId);
  }
});

export const consoleCaptureHandlers = {
  async startConsoleCapture(params) {
    const tabId = await resolveTabId(params);
    return startConsoleCapture(tabId, params);
  },

  async stopConsoleCapture(params) {
    const tabId = await resolveTabId(params);
    return stopConsoleCapture(tabId, params);
  },

  async readConsoleMessages(params) {
    const tabId = await resolveTabId(params);
    return readConsoleMessages(tabId, params);
  },

  async clearConsoleMessages(params) {
    const tabId = await resolveTabId(params);
    return clearConsoleMessages(tabId, params);
  },
};
