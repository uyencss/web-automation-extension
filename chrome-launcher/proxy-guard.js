'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Parse and sanitize managed proxy configuration, stripping inline credentials
 * that Chromium ignores in --proxy-server=.
 */
function resolveManagedProxyConfig(proxy) {
  if (!proxy) return { cleanUrl: null, warning: null, timezone: null };
  if (typeof proxy === 'object' && proxy.mode === 'direct' && !proxy.url && !proxy.host) {
    return { cleanUrl: null, warning: null, timezone: proxy.timezone || null };
  }
  const timezone = (typeof proxy === 'object' && proxy.timezone) ? String(proxy.timezone) : null;
  const objCreds = typeof proxy === 'object' && Boolean(proxy.username || proxy.password);
  let rawUrl = typeof proxy === 'string' ? proxy.trim() : (typeof proxy.url === 'string' ? proxy.url.trim() : '');
  if (!rawUrl && typeof proxy === 'object' && proxy.host && proxy.port) {
    const scheme = String(proxy.protocol || proxy.scheme || 'http').replace(/:$/, '');
    const hostStr = String(proxy.host).trim();
    const formattedHost = hostStr.includes(':') && !hostStr.startsWith('[') ? `[${hostStr}]` : hostStr;
    rawUrl = `${scheme}://${formattedHost}:${proxy.port}`;
  }
  if (!rawUrl || !isNonDirectProxyValue(stripMatchingQuotes(rawUrl))) {
    return { cleanUrl: null, warning: null, timezone };
  }

  let hasUrlCreds = false;
  let cleanUrl = rawUrl;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
    const u = new URL(withScheme);
    if (!u.host) {
      return { cleanUrl: null, warning: null, timezone };
    }
    hasUrlCreds = Boolean(u.username || u.password);
    cleanUrl = `${u.protocol}//${u.host}`;
  } catch {
    // Keep non-URL host:port syntax verbatim
  }

  const warning = (objCreds || hasUrlCreds)
    ? 'Proxy URL contained inline credentials (username/password), which Chromium ignores in --proxy-server=; credentials were stripped.'
    : null;
  return { cleanUrl, warning, timezone };
}

function stripMatchingQuotes(val) {
  const str = String(val ?? '').trim();
  if (
    str.length >= 2 &&
    ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'")))
  ) {
    return str.slice(1, -1).trim();
  }
  return str;
}

function stripEdgeQuotes(val) {
  return String(val ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
}

function updateOpenQuote(chunk, openQuote) {
  let q = openQuote;
  for (let k = 0; k < chunk.length; k += 1) {
    const ch = chunk[k];
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    }
  }
  return q;
}

function isWildcardBypassEntry(entry) {
  const clean = stripEdgeQuotes(entry).toLowerCase();
  if (!clean) return false;
  if (clean === '0.0.0.0/0' || clean === '::/0') return true;
  return /^((\*|[a-z][a-z0-9+.-]*):\/\/)?\*(\.\*)*(:(\*|[0-9]+))?(\/\*?)?$/.test(clean);
}

function isProxySwitchToken(tok) {
  const s = String(tok ?? '').trim();
  return s === '--' || /^(--?|\/)(no-proxy-server|proxy-auto-detect|proxy-pac-url|proxy-bypass-list|proxy-server)(=|$)/i.test(s);
}

function isNonDirectProxyValue(val) {
  const clean = stripMatchingQuotes(val);
  if (!clean) return false;
  let hasPerScheme = false;
  const schemes = new Set();
  for (const rawEntry of clean.split(/[,;]/)) {
    let entry = stripMatchingQuotes(rawEntry);
    if (!entry || entry.startsWith('=')) {
      return false;
    }
    if (entry.includes('=')) {
      const m = entry.match(/^([a-z0-9+.-]+)=(.+)$/i);
      if (!m) {
        return false;
      }
      hasPerScheme = true;
      schemes.add(m[1].toLowerCase());
      entry = stripMatchingQuotes(m[2]);
    }
    if (
      !entry ||
      /[ \t\r\n\v\f="']/.test(entry) ||
      /^direct:(\/\/)?$/i.test(entry) ||
      /^[a-z0-9+.-]+:\/\/$/i.test(entry)
    ) {
      return false;
    }
  }
  if (hasPerScheme && !schemes.has('socks') && !schemes.has('socks4') && !schemes.has('socks5') && !(schemes.has('http') && schemes.has('https'))) {
    return false;
  }
  return true;
}

function collectFlagContinuation(tokens, startIdx, firstChunk) {
  const chunks = [firstChunk];
  let idx = startIdx;
  let openQuote = updateOpenQuote(firstChunk, null);
  while (idx + 1 < tokens.length) {
    const nextRaw = String(tokens[idx + 1] ?? '').trim();
    if (isProxySwitchToken(nextRaw) || nextRaw.startsWith('--')) {
      break;
    }
    const lastChunk = chunks[chunks.length - 1];
    const continuesFromPrev = openQuote !== null || /[,;]$/.test(lastChunk.trimEnd());
    const continuesAtNext = /^[,;]/.test(nextRaw);
    if (!continuesFromPrev && !continuesAtNext) {
      break;
    }
    chunks.push(nextRaw);
    openQuote = updateOpenQuote(nextRaw, openQuote);
    idx += 1;
  }
  return { nextIdx: idx, chunks };
}

function hasClosingQuote(str, startIdx, quoteChar) {
  for (let j = startIdx; j < str.length; j += 1) {
    if (quoteChar === '"' && str[j] === '\\' && (str[j + 1] === '"' || str[j + 1] === '\\')) {
      j += 1;
      continue;
    }
    if (str[j] === quoteChar) {
      return true;
    }
  }
  return false;
}

/**
 * Tokenize a process command line string while preserving single- and double-quoted arguments.
 */
function tokenizeCmdline(cmdline) {
  if (!cmdline || typeof cmdline !== 'string') return [];
  const normalized = cmdline.replace(/[\r\n\u00a0]/g, ' ');
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && (normalized[i + 1] === '"' || normalized[i + 1] === '\\')) {
        current += normalized[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (/[ \t\v\f]/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const atTokenStart = !inToken;
      const afterFirstFlagEq =
        inToken &&
        current.startsWith('-') &&
        current.endsWith('=') &&
        current.indexOf('=') === current.length - 1;
      if ((atTokenStart || afterFirstFlagEq) && hasClosingQuote(normalized, i + 1, ch)) {
        quote = ch;
        inToken = true;
        continue;
      }
    }
    current += ch;
    inToken = true;
  }

  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Evaluate tokenized Chromium arguments left-to-right mirroring Chromium's proxy precedence
 * and bypass switches (--no-proxy-server, --proxy-auto-detect, --proxy-pac-url, --proxy-bypass-list=*, direct://).
 */
function evaluateProxyArgs(tokens) {
  if (!Array.isArray(tokens)) return false;
  let hasBypassSwitch = false;
  let hasWildcardBypass = false;
  let lastProxyVal = '';

  for (let i = 0; i < tokens.length; i += 1) {
    const raw = String(tokens[i] ?? '').trim();
    if (raw === '--') break;

    if (/^(--?|\/)(no-proxy-server|proxy-auto-detect|proxy-pac-url)(=|$)/i.test(raw)) {
      hasBypassSwitch = true;
      if (/^(--?|\/)proxy-pac-url$/i.test(raw) && i + 1 < tokens.length && !isProxySwitchToken(tokens[i + 1])) {
        i += 1;
      }
      continue;
    }

    const bypassEqMatch = raw.match(/^(?:--?|\/)proxy-bypass-list=(.*)$/i);
    if (bypassEqMatch || /^(--?|\/)proxy-bypass-list$/i.test(raw)) {
      let firstChunk = null;
      if (bypassEqMatch) {
        firstChunk = bypassEqMatch[1];
      } else if (i + 1 < tokens.length && !isProxySwitchToken(tokens[i + 1])) {
        i += 1;
        firstChunk = String(tokens[i] ?? '').trim();
      }
      if (firstChunk !== null) {
        const { nextIdx, chunks } = collectFlagContinuation(tokens, i, firstChunk);
        i = nextIdx;
        for (const chunk of chunks) {
          const entries = stripEdgeQuotes(chunk).split(/[,;]/);
          if (entries.some((entry) => isWildcardBypassEntry(entry))) {
            hasWildcardBypass = true;
          }
        }
      }
      continue;
    }

    if (raw.startsWith('--proxy-server=')) {
      const firstChunk = raw.slice('--proxy-server='.length);
      const { nextIdx, chunks } = collectFlagContinuation(tokens, i, firstChunk);
      i = nextIdx;
      lastProxyVal = stripMatchingQuotes(chunks.join(' '));
      continue;
    }

    if (/^(--?|\/)proxy-server(=|$)/i.test(raw)) {
      lastProxyVal = '';
    }
  }

  return !hasBypassSwitch && !hasWildcardBypass && isNonDirectProxyValue(lastProxyVal);
}

/**
 * Check whether an argv array enforces a non-direct --proxy-server without bypass switches.
 */
function hasProxyServerArg(args) {
  if (!Array.isArray(args)) return false;
  return evaluateProxyArgs(args);
}

function hasExplicitProxyServerFlag(args) {
  if (!Array.isArray(args)) return false;
  for (const arg of args) {
    const s = String(arg ?? '').trim();
    if (s === '--') break;
    if (s.startsWith('--proxy-server=')) return true;
  }
  return false;
}

/**
 * Append --proxy-server= and WebRTC leak-prevention flags when proxyCfg has a bound URL.
 */
function applyProxyLaunchArgs(extraArgs, proxyCfg) {
  const out = [...(Array.isArray(extraArgs) ? extraArgs : [])];
  let proxyAuthWarning = null;
  if (proxyCfg?.cleanUrl && !hasExplicitProxyServerFlag(out)) {
    out.push(`--proxy-server=${proxyCfg.cleanUrl}`);
    if (proxyCfg.warning) {
      proxyAuthWarning = proxyCfg.warning;
    }
  }
  if (hasProxyServerArg(out) && !out.some((a) => String(a).startsWith('--force-webrtc-ip-handling-policy='))) {
    out.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  }
  return { extraArgs: out, proxyAuthWarning };
}

/**
 * Fail closed when proxy is required by caller or profile metadata but no bound proxy exists
 * or extraArgs disable/bypass proxy routing.
 */
function assertRequireProxy({
  mode = 'managed',
  requireProxy = false,
  meta = {},
  proxyCfg = null,
  extraArgs = [],
  userDataDir = '',
} = {}) {
  const hasBoundUrl = Boolean(proxyCfg?.cleanUrl);
  const mustRequire = requireProxy === true || meta?.requireProxy === true || hasBoundUrl;
  if (!mustRequire) return;
  const satisfied = mode === 'existing'
    ? hasProxyServerArg(extraArgs)
    : (hasBoundUrl && hasProxyServerArg(extraArgs));
  if (!satisfied) {
    const err = new Error(
      `Refusing to launch ${mode} Chrome on direct IP without a bound proxy (${userDataDir}).`,
    );
    err.code = 'ERR_PROXY_UNBOUND_BLOCKED';
    throw err;
  }
}

/**
 * Check whether a process command-line string enforces a non-direct --proxy-server flag.
 */
function cmdlineHasProxyServer(cmdline) {
  if (!cmdline || typeof cmdline !== 'string') return false;
  const normalized = cmdline.replace(/[\r\n\u00a0]/g, ' ');
  return evaluateProxyArgs(tokenizeCmdline(normalized));
}

async function readPidCmdline(pid, options = {}) {
  const numPid = Number(pid);
  if (!Number.isInteger(numPid) || numPid <= 0) return null;

  if (typeof options.inspectPidCmdlineFn === 'function') {
    try {
      const raw = await options.inspectPidCmdlineFn(numPid);
      if (Array.isArray(raw)) {
        const joined = raw.map((x) => String(x || '').trim()).filter(Boolean).join(' ');
        return joined || null;
      }
      const str = raw == null ? '' : String(raw).trim();
      return str || null;
    } catch {
      return null;
    }
  }

  const platform = options.platform || process.platform;
  if (platform === 'linux') {
    try {
      const rawBuf = fs.readFileSync(`/proc/${numPid}/cmdline`);
      const text = rawBuf.toString('utf8').replace(/\0+/g, ' ').trim();
      if (text) return text;
    } catch {}
  }

  if (platform === 'win32') {
    return await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${numPid}").CommandLine`],
        { encoding: 'utf8', timeout: 2500, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null);
          const text = String(stdout || '').trim();
          resolve(text || null);
        },
      );
    });
  }

  return await new Promise((resolve) => {
    execFile(
      'ps',
      ['-ww', '-p', String(numPid), '-o', 'args='],
      { encoding: 'utf8', timeout: 2500, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const text = String(stdout || '').trim();
        resolve(text || null);
      },
    );
  });
}

/**
 * Inspect an already-running Chrome PID's command line to verify --proxy-server= is active.
 * Fails closed (hasProxy: false) when PID or cmdline is unavailable.
 */
async function inspectRunningChromeHasProxy(pid, options = {}) {
  const numPid = Number(pid);
  if (!Number.isInteger(numPid) || numPid <= 0) {
    return { ok: false, pid: null, hasProxy: false, cmdlineAvailable: false, cmdline: null, reason: 'missing_pid' };
  }
  const cmdline = await readPidCmdline(numPid, options);
  if (!cmdline) {
    return { ok: false, pid: numPid, hasProxy: false, cmdlineAvailable: false, cmdline: null, reason: 'cmdline_unavailable' };
  }
  const hasProxy = cmdlineHasProxyServer(cmdline);
  return {
    ok: hasProxy,
    pid: numPid,
    hasProxy,
    cmdlineAvailable: true,
    cmdline,
    reason: hasProxy ? 'proxy_arg_present' : 'missing_proxy_arg',
  };
}

/**
 * Fail closed with ERR_RUNNING_CHROME_MISSING_PROXY (needsRelaunch=true) if attaching to
 * a running Chrome while proxy policy is active and the live PID lacks --proxy-server=.
 */
async function assertRunningChromeHasProxy(options = {}) {
  const {
    pid: rawPid = null,
    resolvePid,
    requireProxy = false,
    meta = {},
    proxyCfg = null,
    extraArgs = [],
    dryRun = false,
    userDataDir = '',
  } = options;
  const proxyPolicyActive = Boolean(
    requireProxy === true ||
    meta?.requireProxy === true ||
    proxyCfg?.cleanUrl ||
    hasProxyServerArg(extraArgs),
  );
  if (!proxyPolicyActive || dryRun) {
    return { ok: true, skipped: true };
  }

  let targetPid = rawPid;
  if (!targetPid && typeof resolvePid === 'function') {
    targetPid = await resolvePid();
  }
  const inspected = await inspectRunningChromeHasProxy(targetPid, options);
  if (!inspected.hasProxy) {
    const detail = inspected.cmdlineAvailable
      ? `Running Chrome PID ${inspected.pid} lacks --proxy-server= in cmdline`
      : (inspected.pid
        ? `Unable to inspect cmdline for running Chrome PID ${inspected.pid}`
        : 'Unable to resolve running Chrome PID to verify --proxy-server=');
    const err = new Error(
      `ERR_RUNNING_CHROME_MISSING_PROXY: ${detail}; refusing to silently reuse unproxied Chrome window (${userDataDir}). Relaunch via WebMCP (--relaunch).`,
    );
    err.code = 'ERR_RUNNING_CHROME_MISSING_PROXY';
    err.needsRelaunch = true;
    err.pid = inspected.pid;
    err.reason = inspected.reason;
    throw err;
  }
  return inspected;
}

function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Metadata root must be a plain JSON object');
    }
    return parsed;
  } catch (err) {
    const e = new Error(`Corrupt profile metadata at ${filePath}: ${err.message}`);
    e.code = 'ERR_META_UNREADABLE';
    throw e;
  }
}

/**
 * Shared proxy resolution, pre-launch fail-closed gate, and attach-time verification builder
 * for both `existing` and `managed` launch modes.
 */
function prepareLaunchProxy({ mode = 'managed', userDataDir, profileDir = 'Default', meta = null, options = {} }) {
  const effectiveMeta = meta || readJsonSafe(path.join(userDataDir, profileDir, '.webmcp-meta.json'));
  const rawProxy = mode === 'existing'
    ? (options.proxy || options.profile?.proxy || effectiveMeta.proxy)
    : effectiveMeta.proxy;
  const proxyCfg = resolveManagedProxyConfig(rawProxy);
  const proxyApplied = applyProxyLaunchArgs(options.extraArgs, proxyCfg);
  const requireProxy = options.requireProxy === true || effectiveMeta.requireProxy === true;

  assertRequireProxy({
    mode,
    requireProxy,
    meta: effectiveMeta,
    proxyCfg,
    extraArgs: proxyApplied.extraArgs,
    userDataDir,
  });

  const assertAttached = (resolvePid) => assertRunningChromeHasProxy({
    resolvePid,
    requireProxy,
    meta: effectiveMeta,
    proxyCfg,
    extraArgs: proxyApplied.extraArgs,
    dryRun: options.dryRun,
    userDataDir,
    inspectPidCmdlineFn: options.inspectPidCmdlineFn,
  });

  return {
    meta: effectiveMeta,
    proxyCfg,
    extraArgs: proxyApplied.extraArgs,
    proxyAuthWarning: proxyApplied.proxyAuthWarning,
    assertAttached,
  };
}

module.exports = {
  resolveManagedProxyConfig,
  isProxySwitchToken,
  isWildcardBypassEntry,
  isNonDirectProxyValue,
  tokenizeCmdline,
  evaluateProxyArgs,
  hasProxyServerArg,
  hasExplicitProxyServerFlag,
  applyProxyLaunchArgs,
  assertRequireProxy,
  cmdlineHasProxyServer,
  readPidCmdline,
  inspectRunningChromeHasProxy,
  assertRunningChromeHasProxy,
  prepareLaunchProxy,
};
