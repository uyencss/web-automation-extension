import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import process from 'node:process';
import { defaultGatewayCall, getGatewayHealth } from '../gateway-client.mjs';
import { checkTargetCollisions } from './cookies-collision.mjs';

function stripManagedPrefix(value) {
  return String(value || '').replace(/^managed:/i, '');
}

async function readStdinText(fsModule) {
  if (fsModule !== fs) {
    return fsModule.readFileSync(0, 'utf8');
  }
  if (!process.stdin.readable && process.stdin.readableEnded) {
    return '';
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveGatewayProfileId(targetProfileId, healthLookup) {
  if (!targetProfileId || typeof healthLookup !== 'function') return targetProfileId;
  const health = await healthLookup();
  const details = Array.isArray(health?.profileDetails) ? health.profileDetails : [];
  if (details.length === 0) return targetProfileId;

  const exact = details.find((p) => p?.profileId === targetProfileId);
  if (exact) return exact.profileId;

  const query = stripManagedPrefix(targetProfileId).trim().toLowerCase();
  if (!query) return targetProfileId;

  const matches = details.filter((p) => {
    const name = String(p?.name || '').trim().toLowerCase();
    const email = String(p?.email || '').trim().toLowerCase();
    const emailLocal = email.includes('@') ? email.split('@')[0] : '';
    return name === query || email === query || (emailLocal && emailLocal === query);
  });
  return matches.length === 1 && matches[0]?.profileId ? matches[0].profileId : targetProfileId;
}

/**
 * Parse CLI arguments for 'cookies import' subcommand.
 */
export function parseImportArgs(args) {
  const options = {
    profileId: null,
    input: null,
    domain: null,
    overwrite: false,
    clearFirst: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--profile' || arg === '--profile-id' || arg === '--target-profile' || arg === '-p') {
      options.profileId = args[++i];
    } else if (arg.startsWith('--profile=')) {
      options.profileId = arg.slice(10);
    } else if (arg.startsWith('--profile-id=')) {
      options.profileId = arg.slice(13);
    } else if (arg.startsWith('--target-profile=')) {
      options.profileId = arg.slice(17);
    } else if (arg === '--input' || arg === '-i') {
      options.input = args[++i];
    } else if (arg.startsWith('--input=')) {
      options.input = arg.slice(8);
    } else if (arg.startsWith('-i=')) {
      options.input = arg.slice(3);
    } else if (arg === '--domain' || arg === '-d') {
      options.domain = args[++i];
    } else if (arg.startsWith('--domain=')) {
      options.domain = arg.slice(9);
    } else if (arg === '--overwrite') {
      options.overwrite = true;
    } else if (arg === '--clear-first') {
      options.clearFirst = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

/**
 * Compute the canonical CDP URL for a cookie.
 */
export function computeCookieUrl(cookie) {
  if (cookie.url) return cookie.url;
  const rawDomain = cookie.domain || cookie.hostKey || cookie.host_key || '';
  const cleanHost = String(rawDomain).replace(/^\./, '');
  const isHostPreset = String(cookie.name || '').startsWith('__Host-');
  const scheme = (cookie.secure || isHostPreset || String(cookie.name || '').startsWith('__Secure-')) ? 'https' : 'http';
  const cookiePath = isHostPreset ? '/' : (cookie.path || '/');
  const normalizedPath = cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`;
  return `${scheme}://${cleanHost}${normalizedPath}`;
}

/**
 * Core execution engine for importing cookies into a target profile.
 */
export async function handleImport(options, dependencies = {}) {
  const {
    gatewayCall = defaultGatewayCall,
    fsModule = dependencies.fs || fs,
    collisionChecker = checkTargetCollisions,
    healthLookup = gatewayCall === defaultGatewayCall ? getGatewayHealth : null,
  } = dependencies;

  const targetProfileId = options.profileId || options.targetProfile;
  if (!targetProfileId) {
    const err = new Error('MISSING_PROFILE: Required option "--profile" is missing');
    err.code = 'MISSING_PROFILE';
    throw err;
  }

  if (!options.input) {
    const err = new Error('MISSING_INPUT: Required option "--input" is missing');
    err.code = 'MISSING_INPUT';
    throw err;
  }

  // 1. Read input content (stdin or file)
  let raw;
  if (dependencies.inputContent !== undefined) {
    raw = dependencies.inputContent;
  } else if (options.input === '-') {
    try {
      raw = await readStdinText(fsModule);
    } catch (e) {
      const err = new Error(`STDIN_READ_ERROR: Failed to read from stdin: ${e.message}`);
      err.code = 'STDIN_READ_ERROR';
      throw err;
    }
  } else {
    if (!fsModule.existsSync(options.input)) {
      const err = new Error(`FILE_NOT_FOUND: Input file '${options.input}' not found`);
      err.code = 'FILE_NOT_FOUND';
      throw err;
    }
    try {
      raw = fsModule.readFileSync(options.input, 'utf8');
    } catch (e) {
      const err = new Error(`FILE_READ_ERROR: Failed to read file '${options.input}': ${e.message}`);
      err.code = 'FILE_READ_ERROR';
      throw err;
    }
  }

  // 2. Parse JSON & extract cookie array
  let parsedData;
  try {
    parsedData = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`INVALID_JSON: Failed to parse JSON input: ${e.message}`);
    err.code = 'INVALID_JSON';
    throw err;
  }

  let cookies = [];
  if (Array.isArray(parsedData)) {
    cookies = parsedData;
  } else if (parsedData && Array.isArray(parsedData.cookies)) {
    cookies = parsedData.cookies;
  } else if (parsedData && Array.isArray(parsedData.data)) {
    cookies = parsedData.data;
  } else if (parsedData && parsedData.data && Array.isArray(parsedData.data.cookies)) {
    cookies = parsedData.data.cookies;
  } else {
    const err = new Error('INVALID_COOKIE_FORMAT: Input JSON must be an array of cookies or a Playwright storageState object with a "cookies" array');
    err.code = 'INVALID_COOKIE_FORMAT';
    throw err;
  }

  // Filter valid cookies (must have a valid name)
  cookies = cookies.filter((c) => c && typeof c === 'object' && typeof c.name === 'string' && c.name.length > 0);

  // 3. Domain filtering if specified
  if (options.domain) {
    const targetDomain = options.domain.toLowerCase().replace(/^\./, '');
    cookies = cookies.filter((c) => {
      const candDom = (c.domain || c.hostKey || c.host_key || '').toLowerCase().replace(/^\./, '');
      return candDom === targetDomain || candDom.endsWith(`.${targetDomain}`);
    });
  }

  const selectedCount = cookies.length;
  if (selectedCount === 0) {
    return {
      status: 'success',
      profileId: targetProfileId,
      selectedCount: 0,
      appliedCount: 0,
    };
  }

  const resolvedProfileId = await resolveGatewayProfileId(targetProfileId, healthLookup);
  let openedAttachableTab = false;
  async function callWithAttachableTab(method, params) {
    try {
      return await gatewayCall(method, params, resolvedProfileId);
    } catch (err) {
      const msg = `${err?.message || ''} ${err?.payload?.extensionError || ''}`;
      const isDisconnected = err?.status === 404 || err?.status === 503;
      const isAttachFailure =
        !isDisconnected &&
        !openedAttachableTab &&
        /EXECUTION_FAILED|Cannot access a|chrome:\/\/|Cannot attach|No tab with given id/i.test(msg);
      if (!isAttachFailure) throw err;
      openedAttachableTab = true;
      await gatewayCall('newTab', { url: 'about:blank' }, resolvedProfileId);
      return await gatewayCall(method, params, resolvedProfileId);
    }
  }

  // 4. Preflight safety check: check collisions unless overwrite is true
  if (!options.overwrite) {
    const targetUrls = Array.from(new Set(cookies.map(computeCookieUrl)));
    let targetCookies = [];
    try {
      const getRes = await callWithAttachableTab('getCookies', { urls: targetUrls });
      if (getRes?.supportsCdpCookieAttributes !== true) {
        const error = new Error('TARGET_EXTENSION_UNSUPPORTED: Target extension does not support full CDP cookie transfer attributes');
        error.code = 'TARGET_EXTENSION_UNSUPPORTED';
        throw error;
      }
      targetCookies = Array.isArray(getRes?.cookies) ? getRes.cookies : [];
    } catch (err) {
      if (err.code === 'TARGET_EXTENSION_UNSUPPORTED') throw err;
      const code = err.status === 404 || err.status === 503 ? 'TARGET_PROFILE_DISCONNECTED' : 'TARGET_FETCH_ERROR';
      const error = new Error(`${code}: Failed to query target profile cookies`);
      error.code = code;
      throw error;
    }

    collisionChecker(cookies, targetCookies, '');
  }

  // 5. Dry-run mode: return candidate count without mutating
  if (options.dryRun) {
    return {
      status: 'dry-run',
      profileId: targetProfileId,
      ...(resolvedProfileId !== targetProfileId ? { resolvedProfileId } : {}),
      selectedCount,
      appliedCount: 0,
    };
  }

  if (Boolean(options.clearFirst) && !options.domain && !options.dryRun) {
    await callWithAttachableTab('executeCDP', { method: 'Network.clearBrowserCookies', params: {} });
  }

  // 6. Apply cookies via gatewayCall('setCookie', ...)
  let appliedCount = 0;
  let failedCount = 0;
  let firstError = null;
  for (const cookie of cookies) {
    const rawDomain = cookie.domain || cookie.hostKey || cookie.host_key || '';
    let cleanHost = String(rawDomain).replace(/^\./, '');
    if (!cleanHost && cookie.url) {
      try { cleanHost = new URL(cookie.url).hostname; } catch {}
    }
    const isHostPreset = cookie.name.startsWith('__Host-');
    const isHostOnly = isHostPreset || cookie.hostOnly === true || (Boolean(rawDomain) && !String(rawDomain).startsWith('.'));
    const rawPath = isHostPreset ? '/' : (cookie.path || '/');
    const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const secure = Boolean(cookie.secure || isHostPreset || cookie.name.startsWith('__Secure-'));

    let cookieUrl = cookie.url || '';
    if (isHostPreset) {
      cookieUrl = `https://${cleanHost}/`;
    } else if (isHostOnly && cleanHost) {
      let matchesCleanHost = false;
      if (cookieUrl) {
        try { matchesCleanHost = new URL(cookieUrl).hostname.toLowerCase() === cleanHost.toLowerCase(); } catch {}
      }
      if (!matchesCleanHost) {
        cookieUrl = `${secure ? 'https' : 'http'}://${cleanHost}${normalizedPath}`;
      }
    } else if (!cookieUrl) {
      cookieUrl = computeCookieUrl({ ...cookie, domain: rawDomain, secure, path: normalizedPath });
    }

    const setParams = {
      name: cookie.name,
      value: cookie.value ?? '',
      url: cookieUrl,
      path: normalizedPath,
      secure,
      httpOnly: Boolean(cookie.httpOnly),
    };

    if (isHostPreset || isHostOnly) {
      delete setParams.domain;
    } else if (rawDomain) {
      setParams.domain = String(rawDomain);
    }

    if (cookie.sameSite) setParams.sameSite = cookie.sameSite;
    if (cookie.expires !== undefined && cookie.expires > 0) {
      setParams.expires = Number(cookie.expires);
    }
    if (cookie.priority) setParams.priority = cookie.priority;
    if (cookie.partitionKey) setParams.partitionKey = cookie.partitionKey;

    try {
      const setRes = await callWithAttachableTab('setCookie', setParams);
      if (setRes?.success !== false) {
        appliedCount++;
      } else {
        failedCount++;
        if (!firstError) firstError = setRes?.error || 'SET_COOKIE_REJECTED';
      }
    } catch (err) {
      failedCount++;
      if (!firstError) firstError = err?.code || 'MUTATION_ERROR';
    }
  }

  return {
    status: failedCount > 0 ? 'partial' : 'success',
    profileId: targetProfileId,
    ...(resolvedProfileId !== targetProfileId ? { resolvedProfileId } : {}),
    selectedCount,
    appliedCount,
    ...(failedCount > 0 ? { failedCount, error: firstError } : {}),
  };
}

export const importCookies = handleImport;
