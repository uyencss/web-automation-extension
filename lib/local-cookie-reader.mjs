import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const CHROME_EPOCH_OFFSET_SECONDS = 11644473600;
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
          // Unparseable lock symlink format, fail-closed
          isAlive = true;
        }
      } catch {
        // Cannot readlink, lock exists, fail-closed
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
 * Read the safe storage password from macOS Keychain.
 */
export function getMacKeychainPassword(options = {}) {
  const {
    service = 'Chrome Safe Storage',
    account = 'Chrome',
    exec = execFileSync,
  } = options;

  try {
    const stdout = exec('security', ['find-generic-password', '-w', '-s', service, '-a', account], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      const err = new Error('KEYCHAIN_EMPTY_PASSWORD: Empty password returned from Keychain');
      err.code = 'KEYCHAIN_DENIED';
      throw err;
    }
    return trimmed;
  } catch (err) {
    if (err.code === 'KEYCHAIN_DENIED') throw err;
    const error = new Error(`KEYCHAIN_DENIED: Failed to read safe storage key from Keychain (${err.message})`);
    error.code = 'KEYCHAIN_DENIED';
    throw error;
  }
}

/**
 * Derive AES-128 key from Keychain password.
 */
export function deriveMacAesKey(password) {
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

/**
 * Decrypt a single encrypted cookie value on macOS.
 * For Chrome cookie databases at schema version 24 or later, the decrypted payload
 * includes a 32-byte SHA-256 digest of host_key before the actual cookie value.
 */
export function decryptMacCookieValue(encryptedRaw, key, options = {}) {
  const { hostKey = null, schemaVersion = 0 } = options;
  if (!encryptedRaw || encryptedRaw.length === 0) return '';
  const buf = Buffer.isBuffer(encryptedRaw) ? encryptedRaw : Buffer.from(encryptedRaw);
  const prefix = buf.subarray(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') {
    const err = new Error(`UNKNOWN_ENCRYPTION_PREFIX: Expected v10 or v11 prefix, got '${prefix}'`);
    err.code = 'UNKNOWN_ENCRYPTION_PREFIX';
    throw err;
  }
  const iv = Buffer.alloc(16, 0x20); // 16 spaces (0x20)
  const payload = buf.subarray(3);
  let decryptedBuf;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true);
    decryptedBuf = Buffer.concat([decipher.update(payload), decipher.final()]);
  } catch (err) {
    const error = new Error(`DECRYPT_FAILED: ${err.message}`);
    error.code = 'DECRYPT_FAILED';
    throw error;
  }

  // Schema version 24+ prepends a 32-byte SHA-256 digest of host_key
  if (schemaVersion >= 24) {
    if (decryptedBuf.length < 32) {
      const err = new Error('DECRYPT_FAILED: Decrypted payload too short for schema version 24+ host digest');
      err.code = 'DECRYPT_FAILED';
      throw err;
    }
    if (hostKey) {
      const expectedDigest = crypto.createHash('sha256').update(hostKey).digest();
      const actualDigest = decryptedBuf.subarray(0, 32);
      if (!crypto.timingSafeEqual(expectedDigest, actualDigest)) {
        const err = new Error(`COOKIE_HOST_DIGEST_MISMATCH: Decrypted cookie host digest does not match host_key '${hostKey}'`);
        err.code = 'COOKIE_HOST_DIGEST_MISMATCH';
        throw err;
      }
    }
    return decryptedBuf.subarray(32).toString('utf8');
  }

  return decryptedBuf.toString('utf8');
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
 * - In dry-run: extracts only metadata without fetching Keychain key or decrypting values.
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
      // meta table does not exist or version not found (defaults to 0)
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
      // Partitioned cookie check (CHIPS): top_frame_site_key is non-empty or is_partitioned is 1
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

    // 7. If dry-run, return metadata only without Keychain or decryption
    if (dryRun) {
      const cookies = activeRows.map((row) => {
        const isHostOnly = !row.host_key.startsWith('.');
        const domainVal = isHostOnly ? undefined : row.host_key;
        const expiresSeconds = convertChromeExpires(row.expires_utc, row.has_expires);
        return {
          name: row.name,
          domain: domainVal,
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

    // 8. Normal run: derive Keychain key and decrypt values
    let key;
    if (activeRows.some((r) => r.encrypted_value && r.encrypted_value.length > 0)) {
      const password = keychainPasswordOverride !== null
        ? keychainPasswordOverride
        : getMacKeychainPassword();
      key = deriveMacAesKey(password);
    }

    let totalPayloadBytes = 0;
    const cookies = [];

    for (const row of activeRows) {
      let value = '';
      if (row.encrypted_value && row.encrypted_value.length > 0) {
        value = decryptMacCookieValue(row.encrypted_value, key, {
          hostKey: row.host_key,
          schemaVersion,
        });
      } else if (row.value) {
        value = String(row.value);
      }

      totalPayloadBytes += Buffer.byteLength(value, 'utf8') + Buffer.byteLength(row.name, 'utf8');
      if (totalPayloadBytes > MAX_PAYLOAD_BYTES) {
        const err = new Error(`LIMIT_EXCEEDED: Decrypted payload exceeds maximum limit of 1 MiB`);
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

export function convertChromeExpires(expiresUtc, hasExpires) {
  if (!hasExpires || !expiresUtc) return undefined;
  try {
    const big = BigInt(expiresUtc);
    if (big <= 0n) return undefined;
    return Number((big / 1000000n) - BigInt(CHROME_EPOCH_OFFSET_SECONDS));
  } catch {
    return undefined;
  }
}

function mapSameSite(val) {
  if (val === 1) return 'Lax';
  if (val === 2) return 'Strict';
  if (val === 0) return 'None';
  return undefined;
}

function mapPriority(val) {
  if (val === 0) return 'Low';
  if (val === 1) return 'Medium';
  if (val === 2) return 'High';
  return undefined;
}
