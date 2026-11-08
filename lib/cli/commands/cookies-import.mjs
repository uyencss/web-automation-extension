import fs from 'node:fs';
import { defaultGatewayCall, checkTargetCollisions } from './cookies.mjs';

/**
 * Parse CLI arguments for 'cookies import' subcommand.
 */
export function parseImportArgs(args) {
  const options = {
    profileId: null,
    input: null,
    domain: null,
    overwrite: false,
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
  const cleanHost = (cookie.domain || '').replace(/^\./, '');
  const scheme = cookie.secure ? 'https' : 'http';
  const cookiePath = cookie.path || '/';
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
      raw = fsModule.readFileSync(0, 'utf8');
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

  // 4. Preflight safety check: check collisions unless overwrite is true
  if (!options.overwrite) {
    const targetUrls = Array.from(new Set(cookies.map(computeCookieUrl)));
    let targetCookies = [];
    try {
      const getRes = await gatewayCall('getCookies', { urls: targetUrls }, targetProfileId);
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
      selectedCount,
      appliedCount: 0,
    };
  }

  // 6. Apply cookies via gatewayCall('setCookie', ...)
  let appliedCount = 0;
  for (const cookie of cookies) {
    const cookieUrl = computeCookieUrl(cookie);
    const setParams = {
      name: cookie.name,
      value: cookie.value ?? '',
      url: cookieUrl,
      path: cookie.path || '/',
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    };

    if (cookie.hostOnly) {
      // Host-only: CDP requires domain omitted and url provided
    } else if (cookie.domain) {
      setParams.domain = cookie.domain;
    }

    if (cookie.sameSite) setParams.sameSite = cookie.sameSite;
    if (cookie.expires !== undefined && cookie.expires > 0) {
      setParams.expires = Number(cookie.expires);
    }
    if (cookie.priority) setParams.priority = cookie.priority;

    try {
      const setRes = await gatewayCall('setCookie', setParams, targetProfileId);
      if (setRes?.success !== false) {
        appliedCount++;
      } else {
        return {
          status: 'partial',
          profileId: targetProfileId,
          selectedCount,
          appliedCount,
          failedCount: selectedCount - appliedCount,
          error: 'SET_COOKIE_REJECTED',
        };
      }
    } catch {
      return {
        status: 'partial',
        profileId: targetProfileId,
        selectedCount,
        appliedCount,
        failedCount: selectedCount - appliedCount,
        error: 'MUTATION_ERROR',
      };
    }
  }

  return {
    status: 'success',
    profileId: targetProfileId,
    selectedCount,
    appliedCount,
  };
}

export const importCookies = handleImport;
