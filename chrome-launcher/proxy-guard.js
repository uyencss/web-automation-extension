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
  if (!rawUrl) return { cleanUrl: null, warning: null, timezone };

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

function isNonDirectProxyValue(val) {
  const clean = String(val || '').trim();
  return clean.length > 0 && !/^direct:\/\/$/i.test(clean);
}

/**
 * Check whether an argv array contains an explicit non-direct --proxy-server flag.
 */
function hasProxyServerArg(args) {
  if (!Array.isArray(args)) return false;
  for (let i = 0; i < args.length; i += 1) {
    const raw = String(args[i] || '').trim();
    if (raw.startsWith('--proxy-server=')) {
      if (isNonDirectProxyValue(raw.slice('--proxy-server='.length))) return true;
    } else if (raw === '--proxy-server') {
      const next = String(args[i + 1] || '').trim();
      if (next && !next.startsWith('--') && isNonDirectProxyValue(next)) return true;
    }
  }
  return false;
}

/**
 * Append --proxy-server= and WebRTC leak-prevention flags when proxyCfg has a bound URL.
 */
function applyProxyLaunchArgs(extraArgs, proxyCfg) {
  const out = [...(Array.isArray(extraArgs) ? extraArgs : [])];
  let proxyAuthWarning = null;
  if (proxyCfg?.cleanUrl && !hasProxyServerArg(out)) {
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
 * Fail closed when proxy is required by caller or profile metadata but no bound proxy exists.
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
    ? (hasBoundUrl || hasProxyServerArg(extraArgs))
    : hasBoundUrl;
  if (!satisfied) {
    const err = new Error(
      `Refusing to launch ${mode} Chrome on direct IP without a bound proxy (${userDataDir}).`,
    );
    err.code = 'ERR_PROXY_UNBOUND_BLOCKED';
    throw err;
  }
}

/**
 * Check whether a process command-line string contains a non-direct --proxy-server flag.
 */
function cmdlineHasProxyServer(cmdline) {
  if (!cmdline || typeof cmdline !== 'string') return false;
  const re = /(?:^|\s)--proxy-server(?:=(?:"([^"]+)"|'([^']+)'|([^\s"']+))|\s+(?:"([^"]+)"|'([^']+)'|([^-\s"']\S*)))/g;
  let match;
  while ((match = re.exec(cmdline)) !== null) {
    const val = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? '';
    if (isNonDirectProxyValue(val)) return true;
  }
  return false;
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
    extraArgs: mode === 'existing' ? proxyApplied.extraArgs : options.extraArgs,
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
  hasProxyServerArg,
  applyProxyLaunchArgs,
  assertRequireProxy,
  cmdlineHasProxyServer,
  readPidCmdline,
  inspectRunningChromeHasProxy,
  assertRunningChromeHasProxy,
  prepareLaunchProxy,
};
