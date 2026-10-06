import process from 'node:process';
import { createRequire } from 'node:module';
import { readLocalCookies } from '../../local-cookie-reader.mjs';
import { getGatewayApiUrl, gatewayHeaders, fetchJson } from '../gateway-client.mjs';

const require = createRequire(import.meta.url);
const { findProfileById } = require('../../../chrome-launcher/profiles.js');

function printCookiesHelp() {
  console.log(`webmcp-browser cookies — Manage browser cookies across profiles

Usage:
  webmcp-browser cookies copy --source-profile <id> --target-profile <id> --url <site-url> [options]

Options:
  --source-profile <id>     Source Chrome profile launcher ID (e.g. Chrome:Default, Chrome:Profile 1)
  --target-profile <id>     Target Chrome profile connected extension ID
  --url <url>               Target site URL scope (mandatory)
  --domain <domain>         Explicit parent domain selector (must apply to the URL)
  --name <name>             Filter by cookie name (repeatable)
  --path <path>             Filter by cookie path (repeatable)
  --include-http-only       Explicit opt-in to copy HttpOnly cookies
  --dry-run                 Validate profiles, schema, and collisions without decrypting or copying
  --json                    Output machine-readable JSON
  --help, -h                Show this help message
`);
}

export function parseArgs(args) {
  const options = {
    sourceProfile: null,
    targetProfile: null,
    url: null,
    domain: null,
    names: [],
    paths: [],
    includeHttpOnly: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--source-profile') {
      options.sourceProfile = args[++i];
    } else if (arg === '--target-profile') {
      options.targetProfile = args[++i];
    } else if (arg === '--url') {
      options.url = args[++i];
    } else if (arg === '--domain') {
      options.domain = args[++i];
    } else if (arg === '--name') {
      options.names.push(args[++i]);
    } else if (arg === '--path') {
      options.paths.push(args[++i]);
    } else if (arg === '--include-http-only') {
      options.includeHttpOnly = true;
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

export async function defaultGatewayCall(method, params, profileId) {
  const body = { method, params, profileId };
  const { response, payload } = await fetchJson(getGatewayApiUrl(), {
    method: 'POST',
    headers: gatewayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });

  if (!response.ok || payload?.error) {
    const errorMsg = payload?.error || `HTTP ${response.status}`;
    const err = new Error(errorMsg);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  return payload?.result ?? payload;
}

/**
 * Compute distinct candidate URLs covering all cookie paths and domains.
 * Ensures CDP getCookies queries all paths where cookies might reside.
 */
export function collectTargetUrlsForCookies(originUrl, cookies) {
  let parsed;
  try {
    parsed = new URL(originUrl);
  } catch {
    return [originUrl];
  }

  const urls = new Set([originUrl]);

  for (const cookie of cookies || []) {
    const scheme = cookie.secure ? 'https:' : (parsed.protocol || 'http:');
    let host = parsed.hostname;
    if (cookie.domain) {
      const cleanDomain = cookie.domain.replace(/^\./, '');
      if (host !== cleanDomain && !host.endsWith(`.${cleanDomain}`)) {
        host = cleanDomain;
      }
    }
    const cookiePath = cookie.path || '/';
    const normalizedPath = cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`;
    const port = parsed.port ? `:${parsed.port}` : '';
    const candUrl = `${scheme}//${host}${port}${normalizedPath}`;
    urls.add(candUrl);
  }

  return Array.from(urls);
}

/**
 * Check if candidate cookies collide with cookies already present on the target profile.
 * Fail before mutation policy (MVP): any collision throws COLLISION_DETECTED.
 */
export function checkTargetCollisions(candidateCookies, targetCookies, urlHostname) {
  for (const candidate of candidateCookies) {
    const candName = candidate.name;
    const candPath = candidate.path || '/';
    const candDomain = (candidate.domain || urlHostname).toLowerCase().replace(/^\./, '');

    for (const existing of targetCookies) {
      const existName = existing.name;
      const existPath = existing.path || '/';
      const existDomain = (existing.domain || urlHostname).toLowerCase().replace(/^\./, '');

      if (candName === existName && candPath === existPath && candDomain === existDomain) {
        const err = new Error(`COLLISION_DETECTED: Cookie '${candName}' already exists on target profile for domain '${candDomain}' path '${candPath}'`);
        err.code = 'COLLISION_DETECTED';
        throw err;
      }
    }
  }
}

/**
 * Core execution engine for copying cookies between profiles.
 */
export async function copyCookies(options, dependencies = {}) {
  const {
    profileResolver = findProfileById,
    gatewayCall = defaultGatewayCall,
    cookieReader = readLocalCookies,
  } = dependencies;

  const {
    sourceProfile: sourceProfileId,
    targetProfile: targetProfileId,
    url,
    domain = null,
    names = [],
    paths = [],
    includeHttpOnly = false,
    dryRun = false,
  } = options;

  if (!sourceProfileId) {
    const err = new Error('MISSING_SOURCE_PROFILE: Required option "--source-profile" is missing');
    err.code = 'MISSING_SOURCE_PROFILE';
    throw err;
  }

  if (!targetProfileId) {
    const err = new Error('MISSING_TARGET_PROFILE: Required option "--target-profile" is missing');
    err.code = 'MISSING_TARGET_PROFILE';
    throw err;
  }

  if (sourceProfileId === targetProfileId) {
    const err = new Error('IDENTICAL_PROFILES: Source and target profiles cannot be identical');
    err.code = 'IDENTICAL_PROFILES';
    throw err;
  }

  if (!url) {
    const err = new Error('MISSING_URL: Required option "--url" is missing');
    err.code = 'MISSING_URL';
    throw err;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    const err = new Error(`INVALID_URL: ${e.message}`);
    err.code = 'INVALID_URL';
    throw err;
  }

  // 1. Resolve source profile
  const source = profileResolver(sourceProfileId);
  if (!source) {
    const err = new Error(`SOURCE_PROFILE_NOT_FOUND: Source profile '${sourceProfileId}' could not be resolved`);
    err.code = 'SOURCE_PROFILE_NOT_FOUND';
    throw err;
  }

  // 2. Read source cookies (dry-run or real)
  const readResult = cookieReader(source, {
    url,
    domain,
    names,
    paths,
    includeHttpOnly,
    dryRun,
  });

  // 3. Compute distinct candidate URLs covering all cookie paths/domains
  const targetUrls = collectTargetUrlsForCookies(url, readResult.cookies);

  // 4. Fetch target profile cookies for preflight collision check across all candidate URLs
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
    const error = new Error(`${code}: Failed to query target profile`);
    error.code = code;
    throw error;
  }

  // 5. Preflight collision detection (fail before mutation)
  checkTargetCollisions(readResult.cookies, targetCookies, parsedUrl.hostname);

  if (dryRun) {
    return {
      status: 'dry-run',
      sourceProfile: sourceProfileId,
      targetProfile: targetProfileId,
      selectedCount: readResult.selectedCount,
      expiredCount: readResult.expiredCount,
    };
  }

  // 6. Normal copy execution
  let appliedCount = 0;
  const appliedCookies = [];

  for (const cookie of readResult.cookies) {
    const cookieUrl = cookie.secure && parsedUrl.protocol !== 'https:'
      ? `https://${parsedUrl.hostname}${parsedUrl.port ? `:${parsedUrl.port}` : ''}${cookie.path || '/'}`
      : url;

    const setParams = {
      name: cookie.name,
      value: cookie.value,
      url: cookieUrl,
      path: cookie.path || '/',
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    };

    if (cookie.hostOnly) {
      // Host-only: CDP requires domain omitted and url provided
    } else if (cookie.domain) {
      setParams.domain = cookie.domain;
    }

    if (cookie.sameSite) setParams.sameSite = cookie.sameSite;
    if (cookie.expires !== undefined) setParams.expires = cookie.expires;
    if (cookie.priority) setParams.priority = cookie.priority;

    try {
      const setRes = await gatewayCall('setCookie', setParams, targetProfileId);
      if (setRes?.success !== false) {
        appliedCount++;
        appliedCookies.push(cookie);
      } else {
        return {
          status: 'partial',
          sourceProfile: sourceProfileId,
          targetProfile: targetProfileId,
          url,
          selectedCount: readResult.selectedCount,
          appliedCount,
          failedCount: readResult.selectedCount - appliedCount,
          expiredCount: readResult.expiredCount,
          error: 'SET_COOKIE_REJECTED',
        };
      }
    } catch (err) {
      return {
        status: 'partial',
        sourceProfile: sourceProfileId,
        targetProfile: targetProfileId,
        url,
        selectedCount: readResult.selectedCount,
        appliedCount,
        failedCount: readResult.selectedCount - appliedCount,
        expiredCount: readResult.expiredCount,
        error: 'MUTATION_ERROR',
      };
    }
  }

  // 6. Read-back verification in private runtime
  let verifiedCount = 0;
  try {
    const readBackRes = await gatewayCall('getCookies', { urls: targetUrls }, targetProfileId);
    const readBackCookies = Array.isArray(readBackRes?.cookies) ? readBackRes.cookies : [];

    for (const applied of appliedCookies) {
      const match = readBackCookies.find((rb) => {
        const nameMatch = rb.name === applied.name;
        const valueMatch = rb.value === applied.value;
        const httpOnlyMatch = Boolean(rb.httpOnly) === Boolean(applied.httpOnly);
        const secureMatch = Boolean(rb.secure) === Boolean(applied.secure);
        const pathMatch = (rb.path || '/') === (applied.path || '/');

        let domainMatch = true;
        const isRbHostOnly = rb.hostOnly !== undefined ? Boolean(rb.hostOnly) : !rb.domain?.startsWith('.');
        if (applied.hostOnly) {
          const expectedHost = parsedUrl.hostname.toLowerCase();
          const rbDom = (rb.domain || '').toLowerCase().replace(/^\./, '');
          domainMatch = isRbHostOnly && (rbDom === expectedHost || !rb.domain);
        } else if (applied.domain) {
          const appliedDom = applied.domain.toLowerCase().replace(/^\./, '');
          const rbDom = (rb.domain || '').toLowerCase().replace(/^\./, '');
          // Both source and target must be domain cookies (not host-only)
          domainMatch = !isRbHostOnly && (appliedDom === rbDom);
        }

        let sameSiteMatch = true;
        if (applied.sameSite) {
          sameSiteMatch = Boolean(rb.sameSite) && applied.sameSite.toLowerCase() === rb.sameSite.toLowerCase();
        }

        let priorityMatch = true;
        if (applied.priority) {
          const expectedPri = applied.priority.toLowerCase();
          const actualPri = (rb.priority || 'medium').toLowerCase();
          priorityMatch = expectedPri === actualPri;
        }

        let expiresMatch = true;
        const appliedExp = applied.expires;
        const rbExp = rb.expires;
        const isAppliedSession = appliedExp === undefined || appliedExp === null || appliedExp <= 0;
        const isRbSession = rbExp === undefined || rbExp === null || rbExp <= 0 || rbExp === -1;
        if (isAppliedSession || isRbSession) {
          expiresMatch = isAppliedSession && isRbSession;
        } else {
          // Allow up to 2 seconds tolerance for timestamp rounding
          expiresMatch = Math.abs(Number(appliedExp) - Number(rbExp)) <= 2;
        }

        return nameMatch && valueMatch && httpOnlyMatch && secureMatch && pathMatch && domainMatch && sameSiteMatch && priorityMatch && expiresMatch;
      });
      if (match) verifiedCount++;
    }
  } catch (err) {
    return {
      status: 'partial',
      sourceProfile: sourceProfileId,
      targetProfile: targetProfileId,
      url,
      selectedCount: readResult.selectedCount,
      appliedCount,
      failedCount: 0,
      verifiedCount,
      expiredCount: readResult.expiredCount,
      warning: 'READ_BACK_VERIFICATION_FAILED',
    };
  }

  if (verifiedCount !== appliedCount) {
    return {
      status: 'partial',
      sourceProfile: sourceProfileId,
      targetProfile: targetProfileId,
      url,
      selectedCount: readResult.selectedCount,
      appliedCount,
      failedCount: appliedCount - verifiedCount,
      verifiedCount,
      expiredCount: readResult.expiredCount,
      error: 'READ_BACK_MISMATCH: Read-back verification count did not match applied count',
    };
  }

  return {
    status: 'success',
    sourceProfile: sourceProfileId,
    targetProfile: targetProfileId,
    url,
    selectedCount: readResult.selectedCount,
    appliedCount,
    expiredCount: readResult.expiredCount,
  };
}

export const ERROR_MESSAGES = {
  MISSING_SOURCE_PROFILE: 'Source profile option is required',
  MISSING_TARGET_PROFILE: 'Target profile option is required',
  IDENTICAL_PROFILES: 'Source and target profiles cannot be identical',
  MISSING_URL: 'Target URL is required',
  INVALID_URL: 'Provided URL is invalid',
  SOURCE_PROFILE_NOT_FOUND: 'Source profile could not be resolved',
  SOURCE_PROFILE_BUSY: 'Source profile is locked or currently running',
  SOURCE_FILE_OUTSIDE_PROFILE: 'Cookie database path escapes profile directory',
  SOURCE_DATABASE_NOT_FOUND: 'Cookie database does not exist for source profile',
  SOURCE_DATABASE_READ_ERROR: 'Unable to open source cookie database',
  SOURCE_DATABASE_WAL_ACTIVE: 'Source cookie database has uncheckpointed WAL file; close Chrome',
  SOURCE_DATABASE_JOURNAL_ACTIVE: 'Source cookie database has active journal file; close Chrome',
  INVALID_DOMAIN_SELECTOR: 'Specified domain does not apply to the target URL',
  KEYCHAIN_DENIED: 'Access to safe storage password was denied',
  UNKNOWN_ENCRYPTION_PREFIX: 'Unknown cookie encryption prefix',
  UNSUPPORTED_PARTITIONED_COOKIE: 'Partitioned cookies are not supported',
  LIMIT_EXCEEDED: 'Cookie limit exceeded',
  DECRYPT_FAILED: 'Decryption of cookie payload failed',
  COOKIE_HOST_DIGEST_MISMATCH: 'Cookie host digest does not match host key',
  COLLISION_DETECTED: 'Cookie collision detected on target profile',
  TARGET_PROFILE_DISCONNECTED: 'Target profile is disconnected',
  TARGET_FETCH_ERROR: 'Failed to query target profile cookies',
  TARGET_EXTENSION_UNSUPPORTED: 'Target extension does not support full CDP cookie transfer attributes',
  MUTATION_ERROR: 'Failed to set cookie on target profile',
  READ_BACK_MISMATCH: 'Read-back verification mismatch',
  COOKIE_COPY_FAILED: 'Cookie copy operation failed',
};

export async function runCookies(args) {
  const subcommand = args[0];
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printCookiesHelp();
    return 0;
  }

  if (subcommand === 'copy') {
    const options = parseArgs(args.slice(1));
    if (options.help) {
      printCookiesHelp();
      return 0;
    }

    try {
      const result = await copyCookies(options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.status === 'success') {
          console.log(`Successfully copied ${result.appliedCount}/${result.selectedCount} cookies from '${result.sourceProfile}' to '${result.targetProfile}' (url: ${result.url})`);
        } else if (result.status === 'dry-run') {
          console.log(`Dry-run OK: ${result.selectedCount} cookies match scope (expired: ${result.expiredCount}). No cookies were copied.`);
        } else {
          console.warn(`Cookie copy completed with status '${result.status}': applied ${result.appliedCount}/${result.selectedCount}`);
        }
      }
      return result.status === 'success' || result.status === 'dry-run' ? 0 : 1;
    } catch (err) {
      const code = err.code || 'COOKIE_COPY_FAILED';
      const message = ERROR_MESSAGES[code] || 'Cookie copy operation failed';
      const sanitized = {
        status: 'error',
        error: code,
        message,
      };
      if (options.json) {
        console.error(JSON.stringify(sanitized, null, 2));
      } else {
        console.error(`Error: [${sanitized.error}] ${sanitized.message}`);
      }
      return 1;
    }
  }

  console.error(`Unknown cookies command: '${subcommand}'. See 'webmcp-browser cookies --help'.`);
  return 1;
}
