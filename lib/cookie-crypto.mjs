import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const CHROME_EPOCH_OFFSET_SECONDS = 11644473600;

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
 * Derive AES-128 key from Keychain password on macOS (PBKDF2 with 1003 iterations).
 */
export function deriveMacAesKey(password) {
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

/**
 * Read the safe storage password on Linux:
 * 1. options.linuxPasswordOverride (if provided)
 * 2. process.env.CHROME_SAFE_STORAGE_PASSWORD
 * 3. Secret Service lookup via secret-tool (attribute application: chrome)
 * 4. Fallback to default 'peanuts' (Chromium standard fallback for v10)
 */
export function getLinuxSafeStoragePassword(options = {}) {
  if (options.linuxPasswordOverride !== undefined && options.linuxPasswordOverride !== null) {
    return options.linuxPasswordOverride;
  }
  if (process.env.CHROME_SAFE_STORAGE_PASSWORD) {
    return process.env.CHROME_SAFE_STORAGE_PASSWORD;
  }
  const { exec = execFileSync } = options;
  try {
    const stdout = exec('secret-tool', ['lookup', 'application', 'chrome'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    const trimmed = stdout.trim();
    if (trimmed) return trimmed;
  } catch {
    // Secret Service not available or entry not found
  }
  return 'peanuts';
}

/**
 * Derive AES-128 key for Linux Chromium (PBKDF2 with 1 iteration).
 */
export function deriveLinuxAesKey(password = 'peanuts') {
  return crypto.pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
}

/**
 * Universal platform AES key context provider.
 * On Linux, Chromium uses dual keys:
 * - 'v10': Hardcoded fallback key derived from 'peanuts' (PBKDF2 1 iteration)
 * - 'v11': Keyring key derived from GNOME Keyring / Secret Service password (PBKDF2 1 iteration)
 * On macOS, both 'v10' and 'v11' use the Keychain password (PBKDF2 1003 iterations).
 */
export function getPlatformKeyContext(options = {}) {
  const platform = options.platform || process.platform;

  if (platform === 'darwin') {
    const password = options.keychainPasswordOverride !== undefined && options.keychainPasswordOverride !== null
      ? options.keychainPasswordOverride
      : getMacKeychainPassword(options);
    const key = deriveMacAesKey(password);
    return {
      platform: 'darwin',
      resolveKeyForPrefix: (prefix) => {
        if (prefix !== 'v10' && prefix !== 'v11') {
          const err = new Error(`UNKNOWN_ENCRYPTION_PREFIX: Expected v10 or v11 prefix, got '${prefix}'`);
          err.code = 'UNKNOWN_ENCRYPTION_PREFIX';
          throw err;
        }
        return key;
      },
    };
  }

  if (platform === 'linux') {
    const v10Key = deriveLinuxAesKey('peanuts');
    let keyringPassword = null;

    if (options.linuxPasswordOverride !== undefined && options.linuxPasswordOverride !== null) {
      keyringPassword = options.linuxPasswordOverride;
    } else if (process.env.CHROME_SAFE_STORAGE_PASSWORD) {
      keyringPassword = process.env.CHROME_SAFE_STORAGE_PASSWORD;
    } else {
      const { exec = execFileSync } = options;
      try {
        const stdout = exec('secret-tool', ['lookup', 'application', 'chrome'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 3000,
        });
        const trimmed = stdout.trim();
        if (trimmed) keyringPassword = trimmed;
      } catch {
        // secret-tool not available or D-Bus session absent
      }
    }

    const v11Key = keyringPassword ? deriveLinuxAesKey(keyringPassword) : null;

    return {
      platform: 'linux',
      hasKeyring: Boolean(keyringPassword),
      resolveKeyForPrefix: (prefix) => {
        if (prefix === 'v10') {
          return v10Key;
        }
        if (prefix === 'v11') {
          if (!v11Key) {
            const err = new Error('LINUX_KEYRING_UNAVAILABLE: Cookie has prefix v11 (Keyring-encrypted), but Linux Keyring password is unavailable over headless session. Ensure secret-tool is installed or supply CHROME_SAFE_STORAGE_PASSWORD.');
            err.code = 'LINUX_KEYRING_UNAVAILABLE';
            throw err;
          }
          return v11Key;
        }
        const err = new Error(`UNKNOWN_ENCRYPTION_PREFIX: Expected v10 or v11 prefix, got '${prefix}'`);
        err.code = 'UNKNOWN_ENCRYPTION_PREFIX';
        throw err;
      },
    };
  }

  const err = new Error(`UNSUPPORTED_PLATFORM: Cookie decryption on platform '${platform}' is not supported`);
  err.code = 'UNSUPPORTED_PLATFORM';
  throw err;
}

/**
 * Universal platform AES key derivation (supports macOS Keychain & Linux Chromium).
 */
export function getPlatformAesKey(options = {}) {
  const ctx = getPlatformKeyContext(options);
  return ctx.resolveKeyForPrefix(options.prefix || 'v10');
}

/**
 * Decrypt a single encrypted cookie value (supports macOS and Linux Chromium).
 * Handles both key Buffer and keyContext with prefix-aware key derivation.
 */
export function decryptCookieValue(encryptedRaw, keyOrContext, options = {}) {
  const { hostKey = null, schemaVersion = 0 } = options;
  if (!encryptedRaw || encryptedRaw.length === 0) return '';
  const buf = Buffer.isBuffer(encryptedRaw) ? encryptedRaw : Buffer.from(encryptedRaw);
  const prefix = buf.subarray(0, 3).toString('utf8');

  let key;
  if (keyOrContext && typeof keyOrContext.resolveKeyForPrefix === 'function') {
    key = keyOrContext.resolveKeyForPrefix(prefix);
  } else if (Buffer.isBuffer(keyOrContext)) {
    key = keyOrContext;
  } else if (options.keyOverride) {
    key = options.keyOverride;
  } else {
    const err = new Error('MISSING_DECRYPTION_KEY: No key or key context provided for decryption');
    err.code = 'MISSING_DECRYPTION_KEY';
    throw err;
  }

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
 * Backward compatibility alias for decryptCookieValue.
 */
export const decryptMacCookieValue = decryptCookieValue;
