import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  CHROME_EPOCH_OFFSET_SECONDS,
  getMacKeychainPassword,
  deriveMacAesKey,
  getLinuxSafeStoragePassword,
  deriveLinuxAesKey,
  getPlatformAesKey,
  getPlatformKeyContext,
  decryptCookieValue,
  decryptMacCookieValue,
} from './cookie-crypto.mjs';

import {
  convertChromeExpires,
  mapSameSite,
  mapPriority,
  formatPlaywrightStorageState,
  formatNetscapeCookies,
} from './cookie-formatters.mjs';

// Re-export crypto & formatters for backward compatibility
export {
  CHROME_EPOCH_OFFSET_SECONDS,
  getMacKeychainPassword,
  deriveMacAesKey,
  getLinuxSafeStoragePassword,
  deriveLinuxAesKey,
  getPlatformAesKey,
  getPlatformKeyContext,
  decryptCookieValue,
  decryptMacCookieValue,
  convertChromeExpires,
  mapSameSite,
  formatPlaywrightStorageState,
  formatNetscapeCookies,
};

export const MAX_COOKIE_LIMIT = 500;
export const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB

/**
 * Check if the source profile is offline and its database has no uncheckpointed WAL/journal.
 * Throws typed errors if source is busy, running, or has active transaction journals.
 */
export function assertSourceProfileOffline(profile, options = {}) {
  const { checkProcess = true, dbPathOverride = null } = options;
  const userDataDir = profile.userDataDir;

  if (checkProcess && userDataDir) {
    const singletonLockPath = path.join(userDataDir, 'SingletonLock');
    let lockExists = false;
    try {
      fs.lstatSync(singletonLockPath);
      lockExists = true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        lockExists = false;
      } else {
        // Permission or I/O error -> fail closed!
        const error = new Error(`SOURCE_PROFILE_BUSY: Unable to verify profile lock state (${err.code || err.message})`);
        error.code = 'SOURCE_PROFILE_BUSY';
        throw error;
      }
    }

    if (lockExists) {
      let isAlive = false;
      try {
        const link = fs.readlinkSync(singletonLockPath);
        const match = link.match(/-(\d+)$/);
        if (match) {
          const pid = parseInt(match[1], 10);
          try {
            process.kill(pid, 0);
            isAlive = true;
          } catch (err) {
            if (err.code === 'ESRCH') {
              isAlive = false; // dead pid, stale lock
            } else {
              // EPERM or other error -> process exists or access denied -> fail closed!
              isAlive = true;
            }
          }
        } else {
          isAlive = true;
        }
      } catch {
        isAlive = true;
      }

      if (isAlive) {
        const err = new Error(`SOURCE_PROFILE_BUSY: Source Chrome profile is currently locked or running (${singletonLockPath})`);
        err.code = 'SOURCE_PROFILE_BUSY';
        throw err;
      }
    }
  }

  const dbPath = dbPathOverride || resolveSourceCookieDbPath(profile);
  const walPath = `${dbPath}-wal`;
  const journalPath = `${dbPath}-journal`;

  if (fs.existsSync(walPath)) {
    const stat = fs.statSync(walPath);
    if (stat.size > 0) {
      const err = new Error(`SOURCE_DATABASE_WAL_ACTIVE: Source cookie database has uncheckpointed WAL file (${stat.size} bytes)`);
      err.code = 'SOURCE_DATABASE_WAL_ACTIVE';
      throw err;
    }
  }

  if (fs.existsSync(journalPath)) {
    const stat = fs.statSync(journalPath);
    if (stat.size > 0) {
      const err = new Error(`SOURCE_DATABASE_JOURNAL_ACTIVE: Source cookie database has active journal file (${stat.size} bytes)`);
      err.code = 'SOURCE_DATABASE_JOURNAL_ACTIVE';
      throw err;
    }
  }

  return true;
}

/**
 * Resolve the cookie database path within the given profile.
 * Strictly verifies the path stays within the profile directory (prevents path traversal / symlink escapes).
 */
export function resolveSourceCookieDbPath(profile) {
  const profileRoot = path.resolve(profile.userDataDir, profile.profileDir);
  const realProfileRoot = fs.existsSync(profileRoot) ? fs.realpathSync(profileRoot) : profileRoot;
  const candidateNetwork = path.join(profileRoot, 'Network', 'Cookies');
  const candidateRoot = path.join(profileRoot, 'Cookies');

  let dbPath = candidateNetwork;
  if (fs.existsSync(candidateNetwork)) {
    dbPath = candidateNetwork;
  } else if (fs.existsSync(candidateRoot)) {
    dbPath = candidateRoot;
  }

  // Containment check using realpathSync to detect symlink escapes
  const realDbPath = fs.existsSync(dbPath) ? fs.realpathSync(dbPath) : path.resolve(dbPath);
  const normalizedRoot = realProfileRoot.endsWith(path.sep) ? realProfileRoot : `${realProfileRoot}${path.sep}`;
  if (realDbPath !== realProfileRoot && !realDbPath.startsWith(normalizedRoot)) {
    const err = new Error('SOURCE_FILE_OUTSIDE_PROFILE: Cookie file path escapes profile directory');
    err.code = 'SOURCE_FILE_OUTSIDE_PROFILE';
    throw err;
  }

  return realDbPath;
}

/**
 * Resolve allowed candidate host_keys for the target URL.
 * Strictly scopes to the URL's hostname unless an explicit parent domain selector is provided.
 */
export function resolveCandidateDomains(urlStr, explicitDomain = null) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlStr);
  } catch (err) {
    const error = new Error(`INVALID_URL: ${err.message}`);
    error.code = 'INVALID_URL';
    throw error;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (!hostname) {
    const error = new Error('INVALID_URL: URL missing valid hostname');
    error.code = 'INVALID_URL';
    throw error;
  }

  const candidateDomains = new Set([hostname, `.${hostname}`]);

  if (explicitDomain) {
    const cleanDomain = explicitDomain.toLowerCase().replace(/^\./, '');
    // Validate that explicitDomain applies to the URL
    if (hostname !== cleanDomain && !hostname.endsWith(`.${cleanDomain}`)) {
      const err = new Error(`INVALID_DOMAIN_SELECTOR: Explicit domain '${explicitDomain}' does not apply to URL '${urlStr}'`);
      err.code = 'INVALID_DOMAIN_SELECTOR';
      throw err;
    }
    // Only domain cookies apply to subdomains; host-only parent cookies do NOT apply
    candidateDomains.add(`.${cleanDomain}`);
    if (hostname === cleanDomain) {
      candidateDomains.add(cleanDomain);
    }
  }

  return Array.from(candidateDomains);
}

/**
 * Read local cookies scoped to a specific URL and profile.
 * - Enforces offline-only source.
 * - Reads SQLite database read-only.
 * - Domain filter parameterized in SQLite (no whole-profile dump).
 * - Partitioned records detected and rejected before mutation.
 * - Expired records counted and skipped.
 * - In dry-run: extracts only metadata without fetching key or decrypting values.
 */
export function readLocalCookies(profile, options = {}) {
  const {
    url,
    domain = null,
    names = [],
    paths = [],
    includeHttpOnly = false,
    dryRun = false,
    dbPathOverride = null,
    keychainPasswordOverride = null,
    checkProcess = true,
  } = options;

  if (!url) {
    const err = new Error('MISSING_URL: Required option "url" is missing');
    err.code = 'MISSING_URL';
    throw err;
  }

  // 1. Precondition: source is offline and no active WAL
  assertSourceProfileOffline(profile, { checkProcess, dbPathOverride });

  // 2. Resolve database path
  const dbPath = dbPathOverride || resolveSourceCookieDbPath(profile);
  if (!fs.existsSync(dbPath)) {
    const err = new Error(`SOURCE_DATABASE_NOT_FOUND: Cookie database not found at ${dbPath}`);
    err.code = 'SOURCE_DATABASE_NOT_FOUND';
    throw err;
  }

  // 3. Resolve exact candidate domains
  const candidateDomains = resolveCandidateDomains(url, domain);

  // 4. Connect to SQLite read-only
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    const error = new Error(`SOURCE_DATABASE_READ_ERROR: Could not open database (${err.message})`);
    error.code = 'SOURCE_DATABASE_READ_ERROR';
    throw error;
  }

  try {
    // Probe database schema version from meta table (if present)
    let schemaVersion = 0;
    try {
      const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
      if (metaRow && metaRow.value !== undefined) {
        schemaVersion = parseInt(metaRow.value, 10) || 0;
      }
    } catch {
      schemaVersion = 0;
    }

    // Build parameterized query
    const domainPlaceholders = candidateDomains.map(() => '?').join(',');
    const queryParams = [...candidateDomains];

    // Probe schema for optional partition columns
    const columns = new Set(
      db.prepare("PRAGMA table_info(cookies)").all().map((c) => c.name)
    );
    const isPartitionedCol = columns.has('is_partitioned') ? 'is_partitioned' : '0 AS is_partitioned';

    let sql = `SELECT host_key, top_frame_site_key, ${isPartitionedCol}, name, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, has_expires, is_persistent, priority, samesite, source_scheme, source_port`;

    if (!dryRun) {
      sql += `, value, encrypted_value`;
    }

    sql += ` FROM cookies WHERE host_key COLLATE NOCASE IN (${domainPlaceholders})`;

    if (names.length > 0) {
      const namePlaceholders = names.map(() => '?').join(',');
      sql += ` AND name IN (${namePlaceholders})`;
      queryParams.push(...names);
    }

    if (paths.length > 0) {
      const pathPlaceholders = paths.map(() => '?').join(',');
      sql += ` AND path IN (${pathPlaceholders})`;
      queryParams.push(...paths);
    }

    if (!includeHttpOnly) {
      sql += ` AND is_httponly = 0`;
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...queryParams);

    // 5. Check hard limits
    if (rows.length > MAX_COOKIE_LIMIT) {
      const err = new Error(`LIMIT_EXCEEDED: Scoped cookie count (${rows.length}) exceeds maximum limit (${MAX_COOKIE_LIMIT})`);
      err.code = 'LIMIT_EXCEEDED';
      throw err;
    }

    // 6. Preflight partitioned cookies and expiry
    let expiredCount = 0;
    const activeRows = [];
    const now = Date.now();

    for (const row of rows) {
      const isPartitioned = Boolean(
        (row.top_frame_site_key && String(row.top_frame_site_key).trim() !== '') ||
        row.is_partitioned === 1
      );

      if (isPartitioned) {
        const err = new Error(`UNSUPPORTED_PARTITIONED_COOKIE: Found partitioned cookie '${row.name}'. Partitioned cookies are not supported in MVP.`);
        err.code = 'UNSUPPORTED_PARTITIONED_COOKIE';
        throw err;
      }

      // Expiry check
      if (row.has_expires === 1 && row.expires_utc) {
        const expiresSeconds = convertChromeExpires(row.expires_utc, row.has_expires);
        if (expiresSeconds !== undefined && expiresSeconds * 1000 <= now) {
          expiredCount++;
          continue;
        }
      }

      activeRows.push(row);
    }

    // 7. If dry-run, return metadata only without key resolution or decryption
    if (dryRun) {
      const cookies = activeRows.map((row) => {
        const isHostOnly = !row.host_key.startsWith('.');
        const domainVal = isHostOnly ? undefined : row.host_key;
        const expiresSeconds = convertChromeExpires(row.expires_utc, row.has_expires);
        return {
          name: row.name,
          domain: domainVal,
          hostKey: row.host_key,
          hostOnly: isHostOnly,
          path: row.path || '/',
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
          expires: expiresSeconds,
          sameSite: mapSameSite(row.samesite),
          priority: mapPriority(row.priority),
        };
      });

      return {
        dryRun: true,
        sourceProfileId: profile.id,
        url,
        selectedCount: cookies.length,
        expiredCount,
        cookies,
      };
    }

    // 8. Normal run: derive AES key context and decrypt values
    let keyContext;
    if (activeRows.some((r) => r.encrypted_value && r.encrypted_value.length > 0)) {
      if (options.keyOverride) {
        keyContext = { resolveKeyForPrefix: () => options.keyOverride };
      } else {
        keyContext = getPlatformKeyContext(options);
      }
    }

    let totalPayloadBytes = 0;
    const cookies = [];

    for (const row of activeRows) {
      let value = '';
      if (row.encrypted_value && row.encrypted_value.length > 0) {
        value = decryptCookieValue(row.encrypted_value, keyContext, {
          hostKey: row.host_key,
          schemaVersion,
        });
      } else if (row.value) {
        value = String(row.value);
      }

      totalPayloadBytes += Buffer.byteLength(value, 'utf8') + Buffer.byteLength(row.name, 'utf8');
      if (totalPayloadBytes > MAX_PAYLOAD_BYTES) {
        const err = new Error('LIMIT_EXCEEDED: Decrypted payload exceeds maximum limit of 1 MiB');
        err.code = 'LIMIT_EXCEEDED';
        throw err;
      }

      const isHostOnly = !row.host_key.startsWith('.');
      const domainVal = isHostOnly ? undefined : row.host_key;
      const expiresSeconds = convertChromeExpires(row.expires_utc, row.has_expires);

      cookies.push({
        name: row.name,
        value,
        domain: domainVal,
        hostKey: row.host_key,
        hostOnly: isHostOnly,
        path: row.path || '/',
        secure: Boolean(row.is_secure),
        httpOnly: Boolean(row.is_httponly),
        expires: expiresSeconds,
        sameSite: mapSameSite(row.samesite),
        priority: mapPriority(row.priority),
      });
    }

    return {
      dryRun: false,
      sourceProfileId: profile.id,
      url,
      selectedCount: cookies.length,
      expiredCount,
      cookies,
    };
  } finally {
    db.close();
  }
}

/**
 * Export local cookies with strict domain/URL/name/path/secureOnly filtering
 * and multiple output formats (playwright StorageState, standard JSON, netscape cookies.txt).
 *
 * Security & Integrity:
 * - SQL LIKE wildcards (% and _) in domain names are escaped to prevent domain traversal.
 * - Decryption errors (such as schema 24 host digest mismatch) fail closed.
 * - Enforces offline checks and read-only database connections.
 */
export function exportLocalCookies(profile, options = {}) {
  const {
    url = null,
    domain = null,
    names = [],
    name = null,
    paths = [],
    path: pathFilter = null,
    secureOnly = false,
    includeHttpOnly = true,
    format = 'playwright',
    checkProcess = true,
    dbPathOverride = null,
    maxLimit = 5000,
  } = options;

  // 1. Precondition: source profile offline & no active journal/WAL
  assertSourceProfileOffline(profile, { checkProcess, dbPathOverride });

  // 2. Resolve database path
  const dbPath = dbPathOverride || resolveSourceCookieDbPath(profile);
  if (!fs.existsSync(dbPath)) {
    const err = new Error(`SOURCE_DATABASE_NOT_FOUND: Cookie database not found at ${dbPath}`);
    err.code = 'SOURCE_DATABASE_NOT_FOUND';
    throw err;
  }

  // 3. Connect to SQLite read-only
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    const error = new Error(`SOURCE_DATABASE_READ_ERROR: Could not open database (${err.message})`);
    error.code = 'SOURCE_DATABASE_READ_ERROR';
    throw error;
  }

  try {
    // Probe database schema version
    let schemaVersion = 0;
    try {
      const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
      if (metaRow && metaRow.value !== undefined) {
        schemaVersion = parseInt(metaRow.value, 10) || 0;
      }
    } catch {
      schemaVersion = 0;
    }

    // Probe columns
    const columns = new Set(
      db.prepare("PRAGMA table_info(cookies)").all().map((c) => c.name)
    );
    const isPartitionedCol = columns.has('is_partitioned') ? 'is_partitioned' : '0 AS is_partitioned';

    // Build query conditions
    const whereClauses = [];
    const queryParams = [];

    // Filter by URL or Domain (Strict scoping without loose substring injection)
    if (url) {
      const candidateDomains = resolveCandidateDomains(url, domain);
      const placeholders = candidateDomains.map(() => '?').join(',');
      whereClauses.push(`host_key COLLATE NOCASE IN (${placeholders})`);
      queryParams.push(...candidateDomains);
    } else if (domain) {
      const cleanDomain = domain.toLowerCase().replace(/^\./, '');
      const escapedDomain = cleanDomain.replace(/[%_\\]/g, '\\$&');
      whereClauses.push(`(host_key = ? OR host_key = ? OR host_key LIKE ? ESCAPE '\\')`);
      queryParams.push(cleanDomain, `.${cleanDomain}`, `%.${escapedDomain}`);
    }

    // Filter by name
    const combinedNames = [...(Array.isArray(names) ? names : []), ...(name ? [name] : [])];
    if (combinedNames.length > 0) {
      const placeholders = combinedNames.map(() => '?').join(',');
      whereClauses.push(`name IN (${placeholders})`);
      queryParams.push(...combinedNames);
    }

    // Filter by path
    const combinedPaths = [...(Array.isArray(paths) ? paths : []), ...(pathFilter ? [pathFilter] : [])];
    if (combinedPaths.length > 0) {
      const placeholders = combinedPaths.map(() => '?').join(',');
      whereClauses.push(`path IN (${placeholders})`);
      queryParams.push(...combinedPaths);
    }

    // Filter secure
    if (secureOnly) {
      whereClauses.push('is_secure = 1');
    }

    // Filter httpOnly
    if (!includeHttpOnly) {
      whereClauses.push('is_httponly = 0');
    }

    let sql = `SELECT host_key, top_frame_site_key, ${isPartitionedCol}, name, value, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, has_expires, is_persistent, priority, samesite, source_scheme, source_port FROM cookies`;
    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    sql += ' ORDER BY host_key, name';

    const stmt = db.prepare(sql);
    const rows = stmt.all(...queryParams);

    if (rows.length > maxLimit) {
      const err = new Error(`LIMIT_EXCEEDED: Export cookie count (${rows.length}) exceeds maximum limit (${maxLimit})`);
      err.code = 'LIMIT_EXCEEDED';
      throw err;
    }

    // Filter active and non-expired
    const now = Date.now();
    let expiredCount = 0;
    const activeRows = [];

    for (const row of rows) {
      // Partitioned cookie check (CHIPS)
      const isPartitioned = Boolean(
        (row.top_frame_site_key && String(row.top_frame_site_key).trim() !== '') ||
        row.is_partitioned === 1
      );
      if (isPartitioned) {
        continue;
      }

      // Expiry check
      if (row.has_expires === 1 && row.expires_utc) {
        const expiresSeconds = convertChromeExpires(row.expires_utc, row.has_expires);
        if (expiresSeconds !== undefined && expiresSeconds * 1000 <= now) {
          expiredCount++;
          continue;
        }
      }
      activeRows.push(row);
    }

    // Key derivation
    let keyContext;
    if (activeRows.some((r) => r.encrypted_value && r.encrypted_value.length > 0)) {
      if (options.keyOverride) {
        keyContext = { resolveKeyForPrefix: () => options.keyOverride };
      } else {
        keyContext = getPlatformKeyContext(options);
      }
    }

    let totalPayloadBytes = 0;
    const decryptedCookies = [];

    for (const row of activeRows) {
      let value = '';
      if (row.encrypted_value && row.encrypted_value.length > 0) {
        // Must fail closed if decryption fails or host digest mismatches
        value = decryptCookieValue(row.encrypted_value, keyContext, {
          hostKey: row.host_key,
          schemaVersion,
        });
      } else if (row.value) {
        value = String(row.value);
      }

      totalPayloadBytes += Buffer.byteLength(value, 'utf8') + Buffer.byteLength(row.name, 'utf8');
      if (totalPayloadBytes > MAX_PAYLOAD_BYTES) {
        const err = new Error('LIMIT_EXCEEDED: Decrypted payload exceeds maximum limit of 1 MiB');
        err.code = 'LIMIT_EXCEEDED';
        throw err;
      }

      const isHostOnly = !row.host_key.startsWith('.');
      const domainVal = row.host_key;
      const expiresSeconds = convertChromeExpires(row.expires_utc, row.has_expires);

      decryptedCookies.push({
        name: row.name,
        value,
        domain: domainVal,
        hostKey: row.host_key,
        hostOnly: isHostOnly,
        path: row.path || '/',
        secure: Boolean(row.is_secure),
        httpOnly: Boolean(row.is_httponly),
        expires: expiresSeconds !== undefined ? expiresSeconds : -1,
        sameSite: mapSameSite(row.samesite) || 'Lax',
        priority: mapPriority(row.priority) || 'Medium',
      });
    }

    // Format output
    const fmt = (format || 'playwright').toLowerCase();
    let formatted;
    if (fmt === 'playwright') {
      formatted = formatPlaywrightStorageState(decryptedCookies);
    } else if (fmt === 'netscape') {
      formatted = formatNetscapeCookies(decryptedCookies);
    } else {
      formatted = decryptedCookies; // standard JSON array
    }

    return {
      profileId: profile.id,
      format: fmt,
      totalFound: rows.length,
      exportedCount: decryptedCookies.length,
      expiredCount,
      data: formatted,
    };
  } finally {
    db.close();
  }
}
