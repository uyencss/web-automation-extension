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
  return (
    /^(([a-z][a-z0-9+.-]*|\*):\/\/)?\*(:(\*|[0-9]+))?(\/\*)?$/.test(clean) ||
    /^\*\.\*(:(\*|[0-9]+))?$/.test(clean)
  );
}

function isNonDirectProxyValue(val) {
  const clean = stripMatchingQuotes(val);
  if (!clean) return false;
  for (const rawEntry of clean.split(/[,;]/)) {
    let entry = stripMatchingQuotes(rawEntry);
    const schemeMatch = entry.match(/^[a-z0-9+.-]+=(.*)$/i);
    if (schemeMatch) {
      entry = stripMatchingQuotes(schemeMatch[1]);
    }
    if (!entry || /^direct:(\/\/)?$/i.test(entry)) {
      return false;
    }
  }
  return true;
}

/**
 * Tokenize a process command line string while preserving single- and double-quoted arguments.
 */
function tokenizeCmdline(cmdline) {
  if (!cmdline || typeof cmdline !== 'string') return [];
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;

  for (let i = 0; i < cmdline.length; i += 1) {
    const ch = cmdline[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && cmdline[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
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
  let hasNoProxy = false;
  let hasAutoDetect = false;
  let hasPacUrl = false;
  let hasWildcardBypass = false;
  let lastProxyVal = '';

  for (let i = 0; i < tokens.length; i += 1) {
    const raw = String(tokens[i] ?? '').trim();
    if (raw === '--') break;
    const lower = raw.toLowerCase();

    if (lower === '--no-proxy-server') {
      hasNoProxy = true;
      continue;
    }
    if (lower.startsWith('--no-proxy-server=')) {
      const val = stripMatchingQuotes(raw.slice('--no-proxy-server='.length)).toLowerCase();
      if (val !== 'false' && val !== '0') {
        hasNoProxy = true;
      }
      continue;
    }

    if (lower === '--proxy-auto-detect') {
      hasAutoDetect = true;
      continue;
    }
    if (lower.startsWith('--proxy-auto-detect=')) {
      const val = stripMatchingQuotes(raw.slice('--proxy-auto-detect='.length)).toLowerCase();
      if (val !== 'false' && val !== '0') {
        hasAutoDetect = true;
      }
      continue;
    }

    if (lower.startsWith('--proxy-pac-url=')) {
      hasPacUrl = true;
      continue;
    }
    if (lower === '--proxy-pac-url') {
      hasPacUrl = true;
      if (i + 1 < tokens.length && !String(tokens[i + 1] ?? '').trim().startsWith('--')) {
        i += 1;
      }
      continue;
    }

    if (lower.startsWith('--proxy-bypass-list=') || lower === '--proxy-bypass-list') {
      let firstChunk = null;
      if (lower.startsWith('--proxy-bypass-list=')) {
        firstChunk = raw.slice('--proxy-bypass-list='.length);
      } else if (i + 1 < tokens.length && !String(tokens[i + 1] ?? '').trim().startsWith('--')) {
        i += 1;
        firstChunk = String(tokens[i] ?? '').trim();
      }
      if (firstChunk !== null) {
        const chunks = [firstChunk];
        let openQuote = updateOpenQuote(firstChunk, null);
        while (i + 1 < tokens.length) {
          const nextRaw = String(tokens[i + 1] ?? '').trim();
          if (nextRaw.startsWith('--')) break;
          const lastChunk = chunks[chunks.length - 1];
          const continuesFromPrev = openQuote !== null || /[,;]$/.test(lastChunk.trimEnd());
          const continuesAtNext = /^[,;]/.test(nextRaw);
          if (!continuesFromPrev && !continuesAtNext) break;
          chunks.push(nextRaw);
          openQuote = updateOpenQuote(nextRaw, openQuote);
          i += 1;
        }
        for (const chunk of chunks) {
          const entries = stripEdgeQuotes(chunk).split(/[,;]/);
          if (entries.some((entry) => isWildcardBypassEntry(entry))) {
            hasWildcardBypass = true;
          }
        }
      }
      continue;
    }

    if (lower.startsWith('--proxy-server=')) {
      lastProxyVal = stripMatchingQuotes(raw.slice('--proxy-server='.length));
      continue;
    }
    if (lower === '--proxy-server') {
      if (i + 1 < tokens.length && !String(tokens[i + 1] ?? '').trim().startsWith('--')) {
        lastProxyVal = stripMatchingQuotes(tokens[i + 1]);
        i += 1;
      } else {
        lastProxyVal = '';
      }
    }
  }

  return !hasNoProxy && !hasAutoDetect && !hasPacUrl && !hasWildcardBypass && isNonDirectProxyValue(lastProxyVal);
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
    const lower = s.toLowerCase();
    if (lower === '--proxy-server' || lower.startsWith('--proxy-server=')) return true;
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
    if (!out.some((a) => String(a).startsWith('--force-webrtc-ip-handling-policy='))) {
      out.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    }
    if (proxyCfg.warning) {
      proxyAuthWarning = proxyCfg.warning;
    }
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
  const mustRequire = requireProxy === true || meta?.requireProxy === true;
  if (!mustRequire) return;
  const hasBoundUrl = Boolean(proxyCfg?.cleanUrl);
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
  return evaluateProxyArgs(tokenizeCmdline(cmdline));
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
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
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
