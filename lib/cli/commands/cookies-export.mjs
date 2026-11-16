import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  exportLocalCookies,
  resolveCandidateDomains,
  formatPlaywrightStorageState,
  formatNetscapeCookies,
} from '../../local-cookie-reader.mjs';
import { getGatewayHealth, defaultGatewayCall } from '../gateway-client.mjs';

const require = createRequire(import.meta.url);
const { findProfileById, listAllProfiles } = require('../../../chrome-launcher/profiles.js');

export function parseExportArgs(args) {
  const options = {
    profileId: null,
    domain: null,
    url: null,
    names: [],
    paths: [],
    format: 'playwright',
    output: null,
    secureOnly: false,
    includeHttpOnly: true,
    pretty: true,
    json: false,
    help: false,
    allowOnline: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow-online') {
      options.allowOnline = true;
    } else if (arg === '--profile' || arg === '--profile-id' || arg === '-p') {
      options.profileId = args[++i];
    } else if (arg.startsWith('--profile=')) {
      options.profileId = arg.slice(10);
    } else if (arg.startsWith('--profile-id=')) {
      options.profileId = arg.slice(13);
    } else if (arg === '--domain' || arg === '-d') {
      options.domain = args[++i];
    } else if (arg.startsWith('--domain=')) {
      options.domain = arg.slice(9);
    } else if (arg === '--url' || arg === '-u') {
      options.url = args[++i];
    } else if (arg.startsWith('--url=')) {
      options.url = arg.slice(6);
    } else if (arg === '--name' || arg === '-n') {
      options.names.push(args[++i]);
    } else if (arg.startsWith('--name=')) {
      options.names.push(arg.slice(7));
    } else if (arg === '--path') {
      options.paths.push(args[++i]);
    } else if (arg.startsWith('--path=')) {
      options.paths.push(arg.slice(7));
    } else if (arg === '--format' || arg === '-f') {
      options.format = args[++i];
    } else if (arg.startsWith('--format=')) {
      options.format = arg.slice(9);
    } else if (arg === '--output' || arg === '-o') {
      options.output = args[++i];
    } else if (arg.startsWith('--output=')) {
      options.output = arg.slice(9);
    } else if (arg === '--secure-only') {
      options.secureOnly = true;
    } else if (arg === '--no-http-only') {
      options.includeHttpOnly = false;
    } else if (arg === '--include-http-only') {
      options.includeHttpOnly = true;
    } else if (arg === '--no-pretty') {
      options.pretty = false;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

export function findConnectedProfileDetail(profile, profileDetails = []) {
  if (!Array.isArray(profileDetails) || profileDetails.length === 0) return null;
  const targetId = String(profile.id || '').trim();
  const targetClean = targetId.replace(/^managed:/i, '').toLowerCase();
  const targetName = String(profile.name || '').trim().toLowerCase();
  const targetEmail = String(profile.email || '').trim().toLowerCase();
  const targetDir = String(profile.profileDir || '').trim().toLowerCase();

  return profileDetails.find((p) => {
    const pid = String(p.profileId || '').trim();
    const pidClean = pid.replace(/^managed:/i, '').toLowerCase();
    const pname = String(p.name || '').trim().toLowerCase();
    const pemail = String(p.email || '').trim().toLowerCase();

    if (pid === targetId) return true;
    if (targetClean && (pidClean === targetClean || pid.toLowerCase() === targetClean)) return true;
    if (targetName && pname === targetName) return true;
    if (targetEmail && pemail === targetEmail) return true;
    if (targetDir && pidClean === targetDir) return true;
    return false;
  }) || null;
}

export function resolveProfile(profileId, options = {}) {
  const { profileResolver = findProfileById, listProfilesFn = listAllProfiles } = options;
  if (!profileId) return null;

  // 1. Direct match via launcher ID
  let profile = profileResolver(profileId);
  if (profile) return profile;

  // 2. Case-insensitive match on ID, profileDir, name, or email
  try {
    const all = listProfilesFn();
    const candidateList = [...(all?.managed || []), ...(all?.existing || [])];
    const query = profileId.toLowerCase().trim();

    profile = candidateList.find((p) =>
      (p.id && p.id.toLowerCase() === query) ||
      (p.profileDir && p.profileDir.toLowerCase() === query) ||
      (p.name && p.name.toLowerCase() === query) ||
      (p.email && p.email.toLowerCase() === query)
    );
    if (profile) return profile;
  } catch {
    // fallback
  }

  // 3. Absolute or relative disk directory fallback
  try {
    const resolvedPath = path.resolve(profileId);
    if (fs.existsSync(resolvedPath)) {
      const isDir = fs.statSync(resolvedPath).isDirectory();
      if (isDir) {
        if (fs.existsSync(path.join(resolvedPath, 'Network', 'Cookies')) || fs.existsSync(path.join(resolvedPath, 'Cookies'))) {
          return {
            id: path.basename(resolvedPath),
            userDataDir: path.dirname(resolvedPath),
            profileDir: path.basename(resolvedPath),
          };
        }
        if (fs.existsSync(path.join(resolvedPath, 'Default'))) {
          return {
            id: 'Default',
            userDataDir: resolvedPath,
            profileDir: 'Default',
          };
        }
      }
    }
  } catch {
    // fallback
  }

  return null;
}

export async function handleExport(options, dependencies = {}) {
  const {
    profileResolver = resolveProfile,
    cookieExporter = exportLocalCookies,
    gatewayHealthLookup = getGatewayHealth,
    gatewayCaller = defaultGatewayCall,
  } = dependencies;

  const profileId = options.profileId || options.sourceProfile;
  if (!profileId) {
    const err = new Error('MISSING_PROFILE: Required option "--profile" or "--profile-id" is missing');
    err.code = 'MISSING_PROFILE';
    throw err;
  }

  const profile = profileResolver(profileId, dependencies);
  if (!profile) {
    const err = new Error(`SOURCE_PROFILE_NOT_FOUND: Profile '${profileId}' could not be resolved`);
    err.code = 'SOURCE_PROFILE_NOT_FOUND';
    throw err;
  }

  let exportResult = null;
  let keychainDeniedError = null;

  try {
    exportResult = cookieExporter(profile, {
      domain: options.domain,
      url: options.url,
      names: options.names,
      paths: options.paths,
      secureOnly: options.secureOnly,
      includeHttpOnly: options.includeHttpOnly,
      format: options.format,
      checkProcess: options.checkProcess !== false,
      dbPathOverride: options.dbPathOverride,
      keyOverride: options.keyOverride,
      keychainPasswordOverride: options.keychainPasswordOverride,
      linuxPasswordOverride: options.linuxPasswordOverride,
      allowOnline: Boolean(options.allowOnline),
    });
  } catch (err) {
    if (options.allowOnline && err?.code === 'KEYCHAIN_DENIED') {
      keychainDeniedError = err;
    } else {
      throw err;
    }
  }

  // Fallback via Gateway CDP if allowOnline is enabled and (keychain denied or 0 cookies exported)
  if (options.allowOnline && (keychainDeniedError || (exportResult && exportResult.exportedCount === 0))) {
    const caller = dependencies.gatewayCaller || dependencies.gatewayCall || gatewayCaller;
    const healthLookup = dependencies.gatewayHealthLookup || gatewayHealthLookup;
    let connectedProfileId = null;

    if (typeof healthLookup === 'function') {
      try {
        const health = await healthLookup();
        const details = Array.isArray(health?.profileDetails) ? health.profileDetails : [];
        if (details.length > 0) {
          const matched = findConnectedProfileDetail(profile, details);
          if (matched && matched.profileId) {
            connectedProfileId = matched.profileId;
          }
        }
      } catch {}
    }

    if (connectedProfileId && typeof caller === 'function') {
      let cdpRes;
      try {
        cdpRes = await caller('executeCDP', { method: 'Network.getAllCookies', params: {} }, connectedProfileId);
      } catch (err) {
        const errMsg = err?.message || String(err);
        if (/Cannot access|Cannot attach|No tab|No active tab|TARGET_NOT_FOUND|EXECUTION_FAILED/i.test(errMsg)) {
          try {
            await caller('newTab', { url: 'about:blank' }, connectedProfileId);
            cdpRes = await caller('executeCDP', { method: 'Network.getAllCookies', params: {} }, connectedProfileId);
          } catch {
            if (keychainDeniedError) throw keychainDeniedError;
          }
        } else if (keychainDeniedError) {
          throw keychainDeniedError;
        }
      }

      const rawCookies = Array.isArray(cdpRes?.cookies)
        ? cdpRes.cookies
        : (Array.isArray(cdpRes?.result?.cookies) ? cdpRes.result.cookies : null);
      if (Array.isArray(rawCookies)) {
        const nowSeconds = Date.now() / 1000;
        let expiredCount = 0;

        let candidateDomains = null;
        if (options.url) {
          candidateDomains = new Set(resolveCandidateDomains(options.url, options.domain).map((d) => d.toLowerCase()));
        } else if (options.domain) {
          const cleanDomain = options.domain.toLowerCase().replace(/^\./, '');
          candidateDomains = {
            matches(d) {
              const dl = (d || '').toLowerCase().replace(/^\./, '');
              return dl === cleanDomain || dl.endsWith(`.${cleanDomain}`);
            },
          };
        }

        const nameFilterSet = options.names && options.names.length > 0 ? new Set(options.names) : null;
        const pathFilterSet = options.paths && options.paths.length > 0 ? new Set(options.paths) : null;

        const filtered = [];
        for (const cookie of rawCookies) {
          if (candidateDomains) {
            const cDomain = (cookie.domain || '').toLowerCase();
            if (candidateDomains.has) {
              if (!candidateDomains.has(cDomain) && !candidateDomains.has(cDomain.replace(/^\./, ''))) {
                continue;
              }
            } else if (candidateDomains.matches) {
              if (!candidateDomains.matches(cDomain)) {
                continue;
              }
            }
          }

          if (nameFilterSet && !nameFilterSet.has(cookie.name)) {
            continue;
          }

          if (pathFilterSet && !pathFilterSet.has(cookie.path || '/')) {
            continue;
          }

          if (options.secureOnly && !cookie.secure) {
            continue;
          }

          if (options.includeHttpOnly === false && cookie.httpOnly) {
            continue;
          }

          if (cookie.expires && cookie.expires > 0 && cookie.expires <= nowSeconds) {
            expiredCount++;
            continue;
          }

          const isHostOnly = !cookie.domain.startsWith('.');
          filtered.push({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            hostKey: cookie.domain,
            hostOnly: isHostOnly,
            path: cookie.path || '/',
            secure: Boolean(cookie.secure),
            httpOnly: Boolean(cookie.httpOnly),
            expires: typeof cookie.expires === 'number' ? cookie.expires : -1,
            sameSite: cookie.sameSite || 'Lax',
            priority: cookie.priority || 'Medium',
          });
        }

        const fmt = (options.format || 'playwright').toLowerCase();
        let formatted;
        if (fmt === 'playwright') {
          formatted = formatPlaywrightStorageState(filtered);
        } else if (fmt === 'netscape') {
          formatted = formatNetscapeCookies(filtered);
        } else {
          formatted = filtered;
        }

        exportResult = {
          profileId: profile.id,
          format: fmt,
          totalFound: rawCookies.length,
          exportedCount: filtered.length,
          expiredCount,
          data: formatted,
        };
      } else if (keychainDeniedError) {
        throw keychainDeniedError;
      }
    } else if (keychainDeniedError) {
      throw keychainDeniedError;
    }
  }

  if (!exportResult && keychainDeniedError) {
    throw keychainDeniedError;
  }

  const format = exportResult.format;
  const data = exportResult.data;
  let serialized;
  if (format === 'netscape') {
    serialized = typeof data === 'string' ? data : String(data);
  } else {
    serialized = options.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  }

  let writtenFile = null;
  if (options.output) {
    writtenFile = path.resolve(options.output);
    fs.mkdirSync(path.dirname(writtenFile), { recursive: true });
    // Secure mode: 0o600 (owner read/write only) to protect plaintext session tokens
    fs.writeFileSync(writtenFile, serialized, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(writtenFile, 0o600);
    } catch {
      // safe fallback on filesystems with restricted chmod
    }
  }

  return {
    status: 'success',
    profileId: profile.id,
    format,
    totalFound: exportResult.totalFound,
    exportedCount: exportResult.exportedCount,
    expiredCount: exportResult.expiredCount,
    output: writtenFile,
    data,
    rawText: serialized,
  };
}
