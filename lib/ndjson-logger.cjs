'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const FLUSH_INTERVAL_MS = 250;
const FLUSH_THRESHOLD_BYTES = 32 * 1024;
const MAX_QUEUE_LEN = 2000;
const MAX_DEPTH = 6;
const MAX_STR = 2048;
const MAX_REGEX_INPUT = 65536;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const APPEND_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW;

const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
const SAFE_KEYS = new Set([
  'haspassword', 'hasotp', 'hastoken', 'cookiecount', 'cookiehostcount', 'tokenpreview',
]);
const SENSITIVE_KEY_RE = /(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|auth(?:orization)?|cookie|set-cookie|credential|private[_-]?key|otp(?:secret)?|totp|raw[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|session[_-]?id|permit|executionpermit|signature|claimtoken|nonce|email)/i;
const AUTH_COOKIE_KEY_RE = /^(?:c_user|xs|datr|sb|fr|sid|hsid|ssid|apisid|sapisid|lsid|login_info|__secure-3papisid|__secure-3psid|__secure-1psid|__host-user_session_same_site|__host-3plsid|__host-1plsid|spc_ec|spc_st|user_session|ct0|auth_token|sid_tt|sessionid_ss|sessionid|connect\.sid|tt_webid|mstoken)$/i;

const STRING_SWEEPS = [
  [/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PEM]'],
  [/\b(Authorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?(?:(?:Bearer|Basic|Token)\s+)?|Bearer\s+)([^\s'",;}\\)]+)/gi, '$1[REDACTED]'],
  [/\b(x-webmcp-token|WEBMCP_GATEWAY_TOKEN|api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|password|passwd|passphrase|vaultPassphrase|masterPassword|rawKey|otpSecret|fleetHubToken|apiTokens)((?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)([^\s'",;&}\\)]+)/gi, '$1$2[REDACTED]'],
  [/\b((?:Set-)?Cookie(?:\\?["'])?\s*[:=]\s*)(?:\\"(?:[^"\\\r\n]|\\(?!"))*\\"|"(?:[^"\r\n])*"|'(?:[^'\r\n])*'|[^\r\n]+)/gi, '$1[REDACTED_COOKIE]'],
  [/\b(c_user|xs|datr|sb|fr|SID|HSID|SSID|APISID|SAPISID|LSID|LOGIN_INFO|__Secure-3PAPISID|__Secure-3PSID|__Secure-1PSID|__Host-user_session_same_site|__Host-3PLSID|__Host-1PLSID|SPC_EC|SPC_ST|user_session|ct0|auth_token|sid_tt|sessionid_ss|sessionid|connect\.sid|tt_webid|msToken)((?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)([^;\s'",}&\\]+)/gi, '$1$2[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/\b(?:ya29\.[A-Za-z0-9._-]{20,}|1\/\/0[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_OAUTH]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35})\b/g, '[REDACTED_KEY]'],
  [/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)[^/\s@]+(@)/gi, '$1[REDACTED]$2'],
  [/([?&](?:token|access_token|refresh_token|key|api_key|secret|password|code|sig|signature|auth)=)[^&#\s'"]+/gi, '$1[REDACTED]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[REDACTED_EMAIL]'],
  [/(?:\/Users|\/home)\/[^/\s"'\\,;)]+/g, '[HOME]'],
  [/[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"'`,;)]+/g, '[HOME]'],
  [/(managed-profiles(?:\\{1,2}|\/))[^/\s"'\\,;)]+/gi, '$1[PROFILE]'],
];

const corrStore = new AsyncLocalStorage();

function newCorrId() {
  return `c_${crypto.randomBytes(4).toString('hex')}`;
}

function getCorrId() {
  return corrStore.getStore();
}

function runWithCorrId(corrId, fn) {
  const id = typeof corrId === 'string' && corrId.trim() ? corrId.trim().slice(0, 64) : newCorrId();
  return corrStore.run(id, fn);
}

function normalizeLevel(level) {
  const s = String(level || 'info').toLowerCase();
  if (s === 'danger') return 'error';
  return LEVELS.has(s) ? s : 'info';
}

function redactString(raw) {
  let s = raw.length > MAX_REGEX_INPUT ? raw.slice(0, MAX_REGEX_INPUT) : raw;
  for (let i = 0; i < STRING_SWEEPS.length; i++) {
    s = s.replace(STRING_SWEEPS[i][0], STRING_SWEEPS[i][1]);
  }
  return s.length > MAX_STR ? `${s.slice(0, MAX_STR)}...[truncated]` : s;
}

function redactValue(val, seen, depth) {
  if (val === null || val === undefined) return val;
  const t = typeof val;
  if (t === 'string') return redactString(val);
  if (t === 'number' || t === 'boolean') return val;
  if (t === 'bigint') return String(val);
  if (t !== 'object') return String(val);
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? 'Invalid Date' : val.toISOString();
  if (Buffer.isBuffer(val)) return `[Buffer:${val.length}]`;
  if (val instanceof RegExp) return String(val);
  if (seen.has(val)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(val);
  if (val instanceof Error) {
    const out = { name: String(val.name || 'Error'), message: redactString(String(val.message || '')) };
    if (val.code !== undefined) out.code = String(val.code);
    if (val.stack) out.stack = redactString(String(val.stack));
    return out;
  }
  if (Array.isArray(val)) return val.map((item) => redactValue(item, seen, depth + 1));
  if (val instanceof Set) return Array.from(val, (item) => redactValue(item, seen, depth + 1));
  const entries = val instanceof Map ? Array.from(val.entries()) : Object.entries(val);
  const out = {};
  for (let i = 0; i < entries.length; i++) {
    const k = String(entries[i][0]);
    const v = entries[i][1];
    if (v === undefined) continue;
    const kl = k.toLowerCase();
    if (!SAFE_KEYS.has(kl) && (SENSITIVE_KEY_RE.test(k) || AUTH_COOKIE_KEY_RE.test(k))) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactValue(v, seen, depth + 1);
    }
  }
  return out;
}

function redact(val) {
  return redactValue(val, new WeakSet(), 0);
}

function isSymlink(p) {
  if (!p) return false;
  try { return fs.lstatSync(path.resolve(p)).isSymbolicLink(); } catch { return false; }
}

function safeChmod(p, mode) {
  try { if (!isSymlink(p)) fs.chmodSync(p, mode); } catch {}
}

function ensureSecureDir(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (isSymlink(resolved)) {
    const err = new Error(`Refusing to use symlinked log directory: ${resolved}`);
    err.code = 'ELOOP';
    throw err;
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  if (isSymlink(resolved)) {
    const err = new Error(`Refusing to use symlinked log directory: ${resolved}`);
    err.code = 'ELOOP';
    throw err;
  }
  safeChmod(resolved, 0o700);
}

function safeOpenAppendSync(filePath) {
  if (isSymlink(filePath)) {
    const err = new Error(`Refusing to write symlink log: ${filePath}`);
    err.code = 'ELOOP';
    throw err;
  }
  ensureSecureDir(path.dirname(filePath));
  const fd = fs.openSync(filePath, APPEND_FLAGS, 0o600);
  safeChmod(filePath, 0o600);
  return fd;
}

function rotateChainSync(filePath, maxFiles = DEFAULT_MAX_FILES) {
  if (!filePath || isSymlink(filePath)) return false;
  const keep = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES);
  try {
    if (keep === 1) {
      if (fs.existsSync(filePath) && !isSymlink(filePath)) fs.unlinkSync(filePath);
      return true;
    }
    const oldest = `${filePath}.${keep - 1}`;
    if (fs.existsSync(oldest) && !isSymlink(oldest)) fs.unlinkSync(oldest);
    for (let i = keep - 2; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (fs.existsSync(src) && !isSymlink(src) && !isSymlink(dst)) fs.renameSync(src, dst);
    }
    const first = `${filePath}.1`;
    if (fs.existsSync(filePath) && !isSymlink(first)) fs.renameSync(filePath, first);
    return true;
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) return false;
    return false;
  }
}

function rotateFileIfNeeded(filePath, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES) {
  if (!filePath) return false;
  let st;
  try { st = fs.lstatSync(filePath); } catch { return false; }
  if (st.isSymbolicLink() || !st.isFile() || st.size < maxBytes) return false;
  return rotateChainSync(filePath, maxFiles);
}

function getOpenFdCount() {
  if (process.platform === 'win32') return -1;
  try { return fs.readdirSync('/dev/fd').length; } catch {
    try { return fs.readdirSync('/proc/self/fd').length; } catch { return -1; }
  }
}

function writeAllAsync(fd, buf) {
  return new Promise((resolve, reject) => {
    let off = 0;
    const step = () => {
      fs.write(fd, buf, off, buf.length - off, null, (err, written) => {
        if (err) return reject(err);
        off += written;
        if (off >= buf.length) return resolve();
        step();
      });
    };
    step();
  });
}

// ponytail: single-writer assumption per <proc>.ndjson; add lockfile if multi-process writers share one file.
function createLogger(opts = {}) {
  const proc = String(opts.proc || 'app');
  const filePath = opts.filePath ? path.resolve(opts.filePath) : '';
  const maxBytes = Math.max(128, Number(opts.maxBytes) || DEFAULT_MAX_BYTES);
  const maxFiles = Math.max(1, Number(opts.maxFiles) || DEFAULT_MAX_FILES);
  const ringSize = Math.max(0, opts.ringSize === undefined ? 200 : Number(opts.ringSize));
  const mirrorStderr = Boolean(opts.mirrorStderr);
  const onEntry = typeof opts.onEntry === 'function' ? opts.onEntry : null;

  const queue = [];
  const ring = [];
  let queuedBytes = 0;
  let droppedLogs = 0;
  let totalLogged = 0;
  let bytesWritten = 0;
  let bytesSeeded = false;
  let fd = null;
  let timer = null;
  let flushing = false;
  let rotating = false;
  let closed = false;
  let activeFlush = null;

  function seedBytes() {
    if (bytesSeeded || !filePath) return;
    try {
      const st = fs.lstatSync(filePath);
      if (!st.isSymbolicLink() && st.isFile()) bytesWritten = st.size;
    } catch {}
    bytesSeeded = true;
  }

  function closeFd() {
    if (fd !== null) {
      const target = fd;
      fd = null;
      try { fs.closeSync(target); } catch {}
    }
  }

  function rotateIfNeededLocked(force = false) {
    if (!filePath || rotating) return false;
    seedBytes();
    if (!force && bytesWritten < maxBytes) return false;
    rotating = true;
    try {
      closeFd();
      if (rotateChainSync(filePath, maxFiles)) {
        bytesWritten = 0;
        return true;
      }
      return false;
    } finally {
      rotating = false;
    }
  }

  async function drainAsync() {
    if (!filePath) { queue.length = 0; queuedBytes = 0; return; }
    while (queue.length > 0) {
      const batch = queue.join('');
      queue.length = 0;
      queuedBytes = 0;
      const buf = Buffer.from(batch, 'utf8');
      seedBytes();
      if (bytesWritten >= maxBytes || (bytesWritten > 0 && bytesWritten + buf.length > maxBytes)) {
        rotateIfNeededLocked(true);
      }
      try {
        if (fd === null) fd = safeOpenAppendSync(filePath);
        await writeAllAsync(fd, buf);
        bytesWritten += buf.length;
        if (bytesWritten >= maxBytes) rotateIfNeededLocked(false);
      } catch {
        closeFd();
      }
    }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (flushing && activeFlush) return activeFlush.then(() => (queue.length > 0 ? flush() : undefined));
    if (queue.length === 0) return Promise.resolve();
    flushing = true;
    activeFlush = drainAsync().finally(() => {
      flushing = false;
      activeFlush = null;
      if (closed) closeFd();
    });
    return activeFlush;
  }

  function flushSync() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!filePath || queue.length === 0) { queue.length = 0; queuedBytes = 0; return; }
    const batch = queue.join('');
    queue.length = 0;
    queuedBytes = 0;
    if (!flushing) closeFd();
    seedBytes();
    const byteLen = Buffer.byteLength(batch, 'utf8');
    if (!flushing && (bytesWritten >= maxBytes || (bytesWritten > 0 && bytesWritten + byteLen > maxBytes))) {
      rotateIfNeededLocked(true);
    }
    let syncFd = null;
    try {
      syncFd = safeOpenAppendSync(filePath);
      fs.writeSync(syncFd, batch, null, 'utf8');
      try { fs.fsyncSync(syncFd); } catch {}
      bytesWritten += byteLen;
    } catch {} finally {
      if (syncFd !== null) { try { fs.closeSync(syncFd); } catch {} }
    }
    if (!flushing && bytesWritten >= maxBytes) rotateIfNeededLocked(false);
  }

  function enqueue(line) {
    if (closed || !filePath) return;
    if (queue.length >= MAX_QUEUE_LEN) { droppedLogs += 1; return; }
    queue.push(line);
    queuedBytes += Buffer.byteLength(line, 'utf8');
    if (queuedBytes >= FLUSH_THRESHOLD_BYTES) {
      void flush();
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; void flush(); }, FLUSH_INTERVAL_MS);
      timer.unref?.();
    }
  }

  function makeView(viewProc, viewMod) {
    function emit(rawLevel, msg, second, third) {
      const level = normalizeLevel(rawLevel);
      let errVal = null;
      let metaVal = null;
      if (second instanceof Error) {
        errVal = second;
        if (third && typeof third === 'object') metaVal = third;
      } else if (second && typeof second === 'object') {
        metaVal = second;
        if (second.err instanceof Error || (second.err && typeof second.err === 'object')) {
          errVal = second.err;
        }
      }
      const corrId = (metaVal && typeof metaVal.corrId === 'string' && metaVal.corrId.trim())
        ? metaVal.corrId.trim().slice(0, 64)
        : getCorrId();
      const entry = {
        ts: new Date().toISOString(),
        level,
        proc: viewProc,
        mod: viewMod,
        msg: redactString(String(msg === undefined || msg === null ? '' : msg)),
      };
      if (corrId) entry.corrId = corrId;
      if (errVal) entry.err = redact(errVal);
      if (metaVal) {
        const cleaned = {};
        for (const [k, v] of Object.entries(metaVal)) {
          if (k === 'err' || k === 'corrId' || v === undefined) continue;
          cleaned[k] = v;
        }
        const safeMeta = redact(cleaned);
        if (safeMeta && typeof safeMeta === 'object' && Object.keys(safeMeta).length > 0) {
          entry.meta = safeMeta;
        }
      }
      totalLogged += 1;
      if (ringSize > 0) {
        if (ring.length >= ringSize) ring.shift();
        ring.push(entry);
      }
      const line = `${JSON.stringify(entry)}\n`;
      if (mirrorStderr) { try { process.stderr.write(line); } catch {} }
      if (onEntry) { try { onEntry(entry); } catch {} }
      enqueue(line);
      if (level === 'fatal') flushSync();
      return entry;
    }

    return {
      debug: (msg, a, b) => emit('debug', msg, a, b),
      info: (msg, a, b) => emit('info', msg, a, b),
      warn: (msg, a, b) => emit('warn', msg, a, b),
      error: (msg, a, b) => emit('error', msg, a, b),
      fatal: (msg, a, b) => emit('fatal', msg, a, b),
      log: (level, msg, a, b) => emit(level, msg, a, b),
      child(modOrOpts) {
        if (typeof modOrOpts === 'string') return makeView(viewProc, modOrOpts || viewMod);
        const o = modOrOpts && typeof modOrOpts === 'object' ? modOrOpts : {};
        return makeView(o.proc ? String(o.proc) : viewProc, o.mod ? String(o.mod) : viewMod);
      },
      flush,
      flushSync,
      recent: (limit) => (limit && limit > 0 ? ring.slice(-limit) : ring.slice()),
      close() {
        closed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        flushSync();
        if (!flushing) closeFd();
        return activeFlush || Promise.resolve();
      },
      redact,
      getFilePath: () => filePath,
      stats: () => ({ proc: viewProc, mod: viewMod, queued: queue.length, queuedBytes, droppedLogs, totalLogged, bytesWritten }),
    };
  }

  return makeView(proc, String(opts.mod || 'core'));
}

function captureHeapSnapshot(procName = 'node', logDir) {
  const dir = logDir ? path.resolve(logDir) : path.join(process.env.WEBMCP_HOME || path.join(os.homedir(), '.webmcp'), 'logs');
  ensureSecureDir(dir);
  const safeProc = String(procName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const prefix = `heap-${safeProc}-`;
  const target = path.join(dir, `${prefix}${Date.now()}-${crypto.randomBytes(2).toString('hex')}.heapsnapshot`);
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
  fs.closeSync(fd);
  const written = v8.writeHeapSnapshot(target);
  safeChmod(written, 0o600);
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.heapsnapshot'))
      .sort()
      .reverse();
    for (let i = 2; i < files.length; i++) {
      const p = path.join(dir, files[i]);
      if (!isSymlink(p)) { try { fs.unlinkSync(p); } catch {} }
    }
  } catch {}
  return written;
}

function startMemHeartbeat(logger, opts = {}) {
  const intervalMs = Math.max(1000, Number(opts.intervalMs) || 600000);
  const rssWarnMb = Number(opts.rssWarnMb) || 256;
  const fdWarn = Number(opts.fdWarn) || 512;
  const enableSigusr2 = opts.enableSigusr2 !== undefined ? Boolean(opts.enableSigusr2) : !process.env.NODE_TEST_CONTEXT;
  const procName = String(opts.proc || logger?.stats?.().proc || 'node');
  const logDir = opts.logDir || (logger?.getFilePath?.() ? path.dirname(logger.getFilePath()) : path.join(process.env.WEBMCP_HOME || path.join(os.homedir(), '.webmcp'), 'logs'));

  const sample = () => {
    const mem = process.memoryUsage();
    const info = {
      rssMb: Math.round((mem.rss / 1048576) * 10) / 10,
      heapUsedMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
      externalMb: Math.round((mem.external / 1048576) * 10) / 10,
      fds: getOpenFdCount(),
      pid: process.pid,
    };
    if (info.rssMb > rssWarnMb || (info.fds >= 0 && info.fds > fdWarn)) {
      logger?.warn?.('Memory/FD threshold exceeded', info);
    } else {
      logger?.debug?.('Memory heartbeat', info);
    }
    return info;
  };

  const snap = () => {
    const written = captureHeapSnapshot(procName, logDir);
    logger?.warn?.('Heap snapshot written', { file: path.basename(written) });
    return written;
  };

  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  let sigHandler = null;
  if (enableSigusr2 && process.platform !== 'win32') {
    sigHandler = () => {
      try { snap(); } catch (err) { logger?.error?.('Heap snapshot failed', err); }
    };
    process.on('SIGUSR2', sigHandler);
  }
  return {
    sample,
    captureHeapSnapshot: snap,
    stop() {
      clearInterval(timer);
      if (sigHandler) { process.off('SIGUSR2', sigHandler); sigHandler = null; }
    },
  };
}

module.exports = {
  createLogger,
  redact,
  runWithCorrId,
  getCorrId,
  newCorrId,
  rotateFileIfNeeded,
  getOpenFdCount,
  captureHeapSnapshot,
  startMemHeartbeat,
  ensureSecureDir,
  safeOpenAppendSync,
  isSymlink,
  O_NOFOLLOW,
};
