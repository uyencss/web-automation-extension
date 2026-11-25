import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { handleExport } from '../../lib/cli/commands/cookies-export.mjs';

const require = createRequire(import.meta.url);
const launcher = require('../../chrome-launcher/launcher.js');
const { findProfileById } = require('../../chrome-launcher/profiles.js');
const {
  probeMacosAquaKeychainSession,
  assertMacosAquaKeychainSession,
} = require('../../chrome-launcher/mac-keychain-guard.js');

const ALLOWED_LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SAFE_BROKER_ENV_KEYS = new Set(['TZ', 'WEBMCP_COOKIE_MODE', 'LANG']);

const APP_BUNDLE_MAP = {
  'webmcp-desktop': ['/Applications/WebMCP Desktop.app', path.join(os.homedir(), 'Applications', 'WebMCP Desktop.app')],
  'webmcp-vault': ['/Applications/WebMCP Vault.app', path.join(os.homedir(), 'Applications', 'WebMCP Vault.app')],
  'webmcp-floating-bot': ['/Applications/WebMCP Floating Bot.app', path.join(os.homedir(), 'Applications', 'WebMCP Floating Bot.app')],
  'ai-cli-usage-tray': [
    '/Applications/AI CLI Usage.app',
    path.join(os.homedir(), 'Desktop', 'VIBE_CODE', 'apps', 'ai-cli-usage-tray', 'bin', 'AI CLI Usage.app'),
  ],
  antigravity: ['/Applications/Antigravity.app'],
  capcut: ['/Applications/CapCut.app'],
};

export function isLoopbackAddress(remoteAddress) {
  if (!remoteAddress) return false;
  return ALLOWED_LOOPBACK_ADDRS.has(String(remoteAddress).trim());
}

function writeAquaJson(res, statusCode, payload, extraHeaders = null) {
  if (!res || res.writableEnded || res.destroyed) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(payload));
}

export function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const chunks = [];
    const removeListener = typeof req.off === 'function' ? req.off.bind(req) : (typeof req.removeListener === 'function' ? req.removeListener.bind(req) : null);
    const cleanup = () => {
      if (!removeListener) return;
      removeListener('data', onData);
      removeListener('end', onEnd);
      removeListener('error', onError);
      removeListener('close', onClose);
    };
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const onData = (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('Request body too large');
        err.statusCode = 413;
        chunks.length = 0;
        req.pause();
        done(reject, err);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return done(resolve, {});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('JSON object body required');
          err.statusCode = 400;
          return done(reject, err);
        }
        done(resolve, parsed);
      } catch {
        const err = new Error('Invalid JSON payload');
        err.statusCode = 400;
        done(reject, err);
      }
    };
    const onError = (err) => done(reject, err);
    const onClose = () => {
      if (!settled && !req.complete) {
        const err = new Error('Request aborted before completion');
        err.code = 'ECONNRESET';
        err.statusCode = 499;
        done(reject, err);
      }
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

function sanitizeBrokerEnv(rawEnv) {
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (SAFE_BROKER_ENV_KEYS.has(k) && v !== undefined && v !== null && String(v).trim() !== '') {
      out[k] = String(v).trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeExtraArgs(rawArgs) {
  if (!Array.isArray(rawArgs)) return [];
  const args = rawArgs.filter((a) => typeof a === 'string' && a.length > 0 && a.length < 2048);
  launcher.assertNoForbiddenManagedArgs(args);
  return args;
}

async function waitForConnectedProfile(connectedProfileIdsFn, beforeIds, timeoutMs = 25000) {
  if (typeof connectedProfileIdsFn !== 'function') return null;
  const before = new Set(beforeIds || []);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = connectedProfileIdsFn() || [];
    const added = ids.find((id) => !before.has(id));
    if (added) return added;
    if (ids.length === 1 && before.size === 0) return ids[0];
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

function mapGuardErrorStatus(err) {
  if (err?.code === 'ERR_FORBIDDEN_MOCK_KEYCHAIN' || err?.code === 'INVALID_REQUEST' || err?.code === 'MISSING_PROFILE') return 400;
  if (err?.code === 'EXISTING_PROFILE_DIR_NOT_FOUND' || err?.code === 'MANAGED_PROFILE_DIR_NOT_FOUND' || err?.code === 'SOURCE_PROFILE_NOT_FOUND') return 404;
  if (err?.needsRelaunch || err?.code === 'ERR_RUNNING_CHROME_MISSING_PROXY' || err?.code === 'ERR_PROXY_UNBOUND_BLOCKED') return 409;
  if (err?.code?.startsWith('ERR_MACOS_') || err?.code === 'KEYCHAIN_DENIED') return 503;
  return 500;
}

export async function handleAquaBrokerRequest(req, res, {
  tokenMatches,
  extractToken,
  token,
  connectedProfileIds,
  port,
} = {}) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return writeAquaJson(res, 403, {
      ok: false,
      error: 'ERR_AQUA_BROKER_LOOPBACK_ONLY',
      code: 'ERR_AQUA_BROKER_LOOPBACK_ONLY',
      message: 'Aqua broker endpoints only accept loopback connections (127.0.0.1 / ::1).',
    });
  }
  if (req.headers.origin) {
    return writeAquaJson(res, 403, {
      ok: false,
      error: 'ERR_AQUA_BROKER_ORIGIN_FORBIDDEN',
      code: 'ERR_AQUA_BROKER_ORIGIN_FORBIDDEN',
      message: 'Browser cross-origin requests with Origin header are forbidden on /api/aqua/*.',
    });
  }
  if (typeof tokenMatches === 'function' && typeof extractToken === 'function' && !tokenMatches(extractToken(req), token)) {
    return writeAquaJson(res, 401, {
      ok: false,
      error: 'UNAUTHORIZED',
      code: 'UNAUTHORIZED',
      message: 'Unauthorized: missing or invalid gateway token',
    });
  }

  const pathname = (req.url || '').split('?')[0];

  if (req.method === 'GET' && pathname === '/api/aqua/status') {
    const status = probeMacosAquaKeychainSession();
    return writeAquaJson(res, 200, { viaAquaService: true, ...status });
  }

  if (req.method !== 'POST') {
    return writeAquaJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'Use GET /api/aqua/status or POST /api/aqua/*' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const isTooLarge = err?.statusCode === 413;
    if (isTooLarge) {
      if (typeof res.setHeader === 'function' && !res.headersSent) res.setHeader('Connection', 'close');
      if (typeof res.once === 'function') {
        res.once('finish', () => {
          const destroyTimer = setTimeout(() => { try { req.destroy(); } catch {} }, 50);
          destroyTimer.unref?.();
          req.socket?.once?.('close', () => clearTimeout(destroyTimer));
        });
      }
    }
    return writeAquaJson(
      res,
      err?.statusCode || 400,
      { ok: false, error: isTooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON', message: err?.message || 'Invalid JSON payload' },
      isTooLarge ? { Connection: 'close' } : null,
    );
  }

  try {
    if (pathname === '/api/aqua/launch') {
      assertMacosAquaKeychainSession({ forceCheck: true });
      const queryId = body.profileId || body.query || null;
      const resolvedProfile = queryId ? findProfileById(String(queryId)) : (body.profile && body.profile.userDataDir ? body.profile : null);
      if (queryId && !resolvedProfile && !body.profile?.userDataDir) {
        return writeAquaJson(res, 404, {
          ok: false,
          viaAquaService: true,
          code: 'PROFILE_NOT_FOUND',
          error: 'PROFILE_NOT_FOUND',
          message: `Profile not found: ${queryId}`,
        });
      }
      const mode = body.mode || (resolvedProfile?.kind === 'existing' ? 'existing' : 'managed');
      const extraArgs = sanitizeExtraArgs(body.extraArgs);
      const env = sanitizeBrokerEnv(body.env);
      let validatedManagedProfilesDir;
      if (body.managedProfilesDir !== undefined && body.managedProfilesDir !== null && body.managedProfilesDir !== '') {
        if (typeof body.managedProfilesDir !== 'string') {
          return writeAquaJson(res, 400, { ok: false, viaAquaService: true, code: 'INVALID_REQUEST', error: 'INVALID_REQUEST', message: 'managedProfilesDir must be a string' });
        }
        const resolvedDir = path.resolve(body.managedProfilesDir);
        const allowedRoots = [path.resolve(path.join(os.homedir(), '.webmcp')), path.resolve(os.tmpdir())];
        if (process.env.WEBMCP_HOME && process.env.WEBMCP_HOME.trim()) {
          allowedRoots.unshift(path.resolve(process.env.WEBMCP_HOME.trim()));
        }
        const inAllowed = allowedRoots.some((root) => resolvedDir === root || resolvedDir.startsWith(root + path.sep));
        if (!inAllowed) {
          return writeAquaJson(res, 400, {
            ok: false,
            viaAquaService: true,
            code: 'INVALID_REQUEST',
            error: 'INVALID_REQUEST',
            message: 'managedProfilesDir must stay within ~/.webmcp or system temp directory',
          });
        }
        validatedManagedProfilesDir = resolvedDir;
      }
      const beforeIds = typeof connectedProfileIds === 'function' ? connectedProfileIds() : [];
      const launchRes = await launcher.launchChrome({
        mode,
        profile: resolvedProfile || body.profile || null,
        newProfileName: typeof body.newProfileName === 'string' ? body.newProfileName : (typeof body.name === 'string' ? body.name : 'webmcp'),
        forceCreate: Boolean(body.forceCreate),
        relaunch: Boolean(body.relaunch),
        dryRun: Boolean(body.dryRun),
        focusIfRunning: body.focusIfRunning !== false && body.focus === true ? true : Boolean(body.focusIfRunning),
        requireProxy: Boolean(body.requireProxy),
        cookieMode: body.cookieMode,
        stripDbsc: body.stripDbsc,
        extraArgs,
        env,
        ...(validatedManagedProfilesDir ? { managedProfilesDir: validatedManagedProfilesDir } : {}),
      });
      if (launchRes?.needsRelaunch || launchRes?.ok === false) {
        return writeAquaJson(res, launchRes?.needsRelaunch ? 409 : 500, {
          ...launchRes,
          viaAquaService: true,
          code: launchRes?.code || (launchRes?.needsRelaunch ? 'NEEDS_RELAUNCH' : 'LAUNCH_FAILED'),
        });
      }
      let connectedId = null;
      if (body.gateway && !body.dryRun) {
        connectedId = await waitForConnectedProfile(connectedProfileIds, beforeIds, Number(body.gatewayTimeoutMs) || 25000);
      }
      return writeAquaJson(res, 200, {
        ...launchRes,
        viaAquaService: true,
        ...(body.gateway ? { profileId: connectedId } : {}),
      });
    }

    if (pathname === '/api/aqua/cookies-export') {
      assertMacosAquaKeychainSession({ forceCheck: true });
      const opts = {
        profileId: body.profileId || body.sourceProfile,
        domain: body.domain,
        url: body.url,
        names: Array.isArray(body.names) ? body.names : [],
        paths: Array.isArray(body.paths) ? body.paths : [],
        format: body.format || 'playwright',
        output: body.output,
        secureOnly: Boolean(body.secureOnly),
        includeHttpOnly: body.includeHttpOnly !== false,
        pretty: body.pretty !== false,
        allowOnline: Boolean(body.allowOnline),
      };
      const result = await handleExport(opts);
      return writeAquaJson(res, 200, { ok: true, viaAquaService: true, ...result });
    }

    if (pathname === '/api/aqua/profile-action') {
      assertMacosAquaKeychainSession({ forceCheck: true });
      const action = String(body.action || '').trim().toLowerCase();
      if (action === 'close') {
        const resClose = await launcher.closeChrome({
          profileId: body.profileId,
          all: Boolean(body.all),
          gatewayUrl: `http://127.0.0.1:${port || 7865}`,
        });
        return writeAquaJson(res, 200, { ok: true, viaAquaService: true, ...resClose });
      }
      if (action === 'focus') {
        const resolved = body.profileId ? findProfileById(String(body.profileId)) : null;
        const udd = body.userDataDir || resolved?.userDataDir;
        const pdir = body.profileDir || resolved?.profileDir || 'Default';
        const mode = body.mode || (resolved?.kind === 'existing' ? 'existing' : 'managed');
        const chromePath = launcher.findChromeBinary();
        if (!udd || !chromePath) {
          return writeAquaJson(res, 404, { ok: false, viaAquaService: true, code: 'PROFILE_NOT_FOUND', error: 'PROFILE_NOT_FOUND', message: 'Profile or Chrome binary not found' });
        }
        const focusRes = await launcher.focusOrOpenRunningChrome({
          chromePath,
          userDataDir: udd,
          profileDir: pdir,
          mode,
          requireProxy: Boolean(body.requireProxy || resolved?.proxy),
          initialUrl: typeof body.url === 'string' && /^https?:\/\//i.test(body.url) ? body.url : undefined,
        });
        return writeAquaJson(res, 200, { ok: true, viaAquaService: true, ...focusRes });
      }
      return writeAquaJson(res, 400, { ok: false, error: 'INVALID_ACTION', code: 'INVALID_ACTION', message: `Unsupported profile action: ${action}` });
    }

    if (pathname === '/api/aqua/app-open') {
      assertMacosAquaKeychainSession({ forceCheck: true });
      const appKey = String(body.app || '').trim();
      const candidates = APP_BUNDLE_MAP[appKey];
      if (!candidates) {
        return writeAquaJson(res, 400, {
          ok: false,
          viaAquaService: true,
          code: 'ERR_AQUA_APP_NOT_ALLOWED',
          error: 'ERR_AQUA_APP_NOT_ALLOWED',
          message: `App '${appKey}' is not in the authorized Aqua app-open allowlist.`,
        });
      }
      const appPath = candidates.find((p) => fs.existsSync(p));
      if (!appPath) {
        return writeAquaJson(res, 404, {
          ok: false,
          viaAquaService: true,
          code: 'APP_NOT_FOUND',
          error: 'APP_NOT_FOUND',
          message: `Application bundle for '${appKey}' was not found on disk.`,
        });
      }
      await new Promise((resolve, reject) => {
        execFile('/usr/bin/open', ['-a', appPath], { timeout: 10000 }, (err, _stdout, stderr) => {
          if (err) reject(new Error(String(stderr || err.message || err).trim()));
          else resolve();
        });
      });
      return writeAquaJson(res, 200, { ok: true, viaAquaService: true, app: appKey, path: appPath });
    }

    return writeAquaJson(res, 404, { ok: false, error: 'NOT_FOUND', message: `Unknown Aqua broker route: ${pathname}` });
  } catch (err) {
    return writeAquaJson(res, mapGuardErrorStatus(err), {
      ok: false,
      viaAquaService: true,
      code: err?.code || 'ERR_MACOS_AQUA_CALL_FAILED',
      error: err?.code || 'ERR_MACOS_AQUA_CALL_FAILED',
      message: err?.message || String(err),
      ...(err?.needsRelaunch ? { needsRelaunch: true } : {}),
      ...(err?.details ? { details: err.details } : {}),
    });
  }
}
