import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { exportLocalCookies } from '../../local-cookie-reader.mjs';

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
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--profile' || arg === '--profile-id' || arg === '-p') {
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

  const exportResult = cookieExporter(profile, {
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
  });

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
