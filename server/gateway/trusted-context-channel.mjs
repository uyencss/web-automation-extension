import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verify } from 'node:crypto';
import {
  canonicalJson,
  digestCanonical,
  toKeyObject,
  keysMatch,
  validateTrustedContextMessage,
  SCHEMAS,
} from './trusted-context-schema.mjs';

const MAX_MESSAGE_BYTES = 65536; // 64 KB bounded framing

export class TrustedContextChannel {
  constructor({
    socketPath = null,
    publicKey = null,
    keyId = null,
    onContextUpdate = null,
    permitStore = null,
  } = {}) {
    this.socketPath =
      socketPath ||
      process.env.WEBMCP_TRUSTED_CONTEXT_SOCKET ||
      path.join(os.tmpdir(), `webmcp-ctx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`);
    this.publicKey = publicKey;
    this.keyId = keyId || null;
    this.onContextUpdate = onContextUpdate;
    this.permitStore = permitStore;
    this.server = null;
    this.seenMessageIds = new Map(); // messageId -> expiresAtMs
    this.lastSeq = 0;
    this.currentContext = null;
  }

  start() {
    if (this.server) return Promise.resolve(this.socketPath);
    return new Promise((resolve, reject) => {
      try {
        if (fs.existsSync(this.socketPath)) {
          fs.unlinkSync(this.socketPath);
        }
      } catch {
        // ignore unlink errors
      }

      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        resolve(this.socketPath);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        try {
          if (fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
          }
        } catch {
          // ignore
        }
        this.server = null;
        resolve();
      });
    });
  }

  handleConnection(socket) {
    let buffer = '';
    let bytesRead = 0;
    let handled = false;

    socket.setEncoding('utf8');

    const replyAndClose = (responseObj, destroy = false) => {
      if (handled) return;
      handled = true;
      try {
        const payload = `${JSON.stringify(responseObj)}\n`;
        socket.write(payload, () => {
          if (destroy) socket.destroy();
          else socket.end();
        });
      } catch {
        socket.destroy();
      }
    };

    socket.on('data', (chunk) => {
      bytesRead += Buffer.byteLength(chunk, 'utf8');
      if (bytesRead > MAX_MESSAGE_BYTES) {
        return replyAndClose(
          {
            ok: false,
            schema: SCHEMAS.ACK,
            error: 'MESSAGE_TOO_LARGE',
            reason: 'TRUSTED_CONTEXT_SIZE_EXCEEDED',
          },
          true,
        );
      }

      buffer += chunk;
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        if (!line) {
          return replyAndClose({
            ok: false,
            schema: SCHEMAS.ACK,
            error: 'EMPTY_MESSAGE',
            reason: 'TRUSTED_CONTEXT_MALFORMED',
          });
        }
        this.processMessage(line, replyAndClose);
      }
    });

    socket.on('end', () => {
      if (!handled && buffer.trim()) {
        this.processMessage(buffer.trim(), replyAndClose);
      }
    });

    socket.on('error', () => {
      socket.destroy();
    });
  }

  processMessage(rawLine, finish) {
    let msg;
    try {
      msg = JSON.parse(rawLine);
    } catch {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'JSON_PARSE_ERROR',
        reason: 'TRUSTED_CONTEXT_MALFORMED',
      });
    }

    const validation = validateTrustedContextMessage(msg);
    if (!validation.ok) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'SCHEMA_VALIDATION_ERROR',
        reason: validation.reason,
        details: validation.error,
      });
    }

    const nowMs = Date.now();
    const expiresAtMs = Date.parse(msg.expiresAt);
    const notBeforeMs = msg.notBefore ? Date.parse(msg.notBefore) : NaN;

    // Validity window checks
    if (!Number.isNaN(expiresAtMs) && nowMs > expiresAtMs) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'CONTEXT_EXPIRED',
        reason: 'TRUSTED_CONTEXT_EXPIRED',
      });
    }
    if (msg.ttlMs !== undefined) {
      const issuedAtMs = Date.parse(msg.issuedAt);
      if (!Number.isNaN(issuedAtMs) && nowMs > issuedAtMs + msg.ttlMs) {
        return finish({
          ok: false,
          schema: SCHEMAS.ACK,
          error: 'CONTEXT_EXPIRED',
          reason: 'TRUSTED_CONTEXT_EXPIRED',
        });
      }
    }
    if (!Number.isNaN(notBeforeMs) && nowMs < notBeforeMs - 1000) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'CONTEXT_NOT_YET_VALID',
        reason: 'TRUSTED_CONTEXT_NOT_YET_VALID',
      });
    }

    // Message ID anti-replay check
    this.gcSeenMessages(nowMs);
    if (this.seenMessageIds.has(msg.messageId)) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'MESSAGE_REPLAY',
        reason: 'TRUSTED_CONTEXT_REPLAY',
      });
    }

    // Monotonic sequence check
    if (typeof msg.seq === 'number') {
      if (msg.seq <= this.lastSeq) {
        return finish({
          ok: false,
          schema: SCHEMAS.ACK,
          error: 'STALE_SEQUENCE',
          reason: 'TRUSTED_CONTEXT_STALE',
        });
      }
    }

    // Pinned machine-local public key requirement & binding verification
    const pinnedKey = this.publicKey;
    if (!pinnedKey) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'NO_PINNED_PUBLIC_KEY',
        reason: 'TRUSTED_CONTEXT_FORGED',
      });
    }

    if (!msg.signature) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'SIGNATURE_MISSING',
        reason: 'TRUSTED_CONTEXT_FORGED',
      });
    }

    // Reject alternate-key context: if msg provides a publicKey, it MUST match the pinned key
    if (msg.publicKey) {
      if (!keysMatch(msg.publicKey, pinnedKey)) {
        return finish({
          ok: false,
          schema: SCHEMAS.ACK,
          error: 'ALTERNATE_KEY_REJECTED',
          reason: 'TRUSTED_CONTEXT_FORGED',
        });
      }
    }

    // KeyId binding check
    if (this.keyId && msg.keyId && msg.keyId !== this.keyId) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'KEY_ID_MISMATCH',
        reason: 'TRUSTED_CONTEXT_FORGED',
      });
    }

    // Verify trusted-context digest/signature exactly once with the frozen canonical/domain contract
    const { signature: _sig, contextDigest: _cd, ...projection } = msg;
    const expectedDigest = digestCanonical('webmcp-digest-v1:trusted-context', projection);

    if (!msg.contextDigest || msg.contextDigest !== expectedDigest) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'CONTEXT_DIGEST_MISMATCH',
        reason: 'TRUSTED_CONTEXT_FORGED',
      });
    }

    const verified = this.verifySignature(msg, pinnedKey);
    if (!verified) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'SIGNATURE_INVALID',
        reason: 'TRUSTED_CONTEXT_FORGED',
      });
    }

    // Commit anti-replay and sequence
    this.seenMessageIds.set(msg.messageId, Number.isNaN(expiresAtMs) ? nowMs + 60000 : expiresAtMs);
    if (typeof msg.seq === 'number') {
      this.lastSeq = msg.seq;
    }

    // Process revocations
    if (Array.isArray(msg.revocations) && this.permitStore) {
      for (const revId of msg.revocations) {
        if (typeof revId === 'string') {
          this.permitStore.revoke(revId);
        }
      }
    }

    // Update cache-backed active context
    this.currentContext = Object.freeze({ ...msg, contextDigest: expectedDigest });
    if (typeof this.onContextUpdate === 'function') {
      this.onContextUpdate(this.currentContext);
    }

    return finish({
      ok: true,
      schema: SCHEMAS.ACK,
      messageId: msg.messageId,
      seq: msg.seq ?? null,
      contextDigest: expectedDigest,
      acceptedAt: new Date().toISOString(),
    });
  }

  verifySignature(msg, keyInput) {
    try {
      const keyObj = toKeyObject(keyInput);
      if (!keyObj) return false;

      const { signature: _sig, contextDigest: _cd, ...projection } = msg;
      const canonical = canonicalJson(projection);
      const sigBuffer = Buffer.from(msg.signature, 'hex');

      // Exact frozen canonical/domain contract: 'webmcp-digest-v1:trusted-context\n' + canonicalJson
      const toSign = Buffer.from(`webmcp-digest-v1:trusted-context\n${canonical}`, 'utf8');
      return verify(null, toSign, keyObj, sigBuffer);
    } catch {
      return false;
    }
  }

  gcSeenMessages(nowMs = Date.now()) {
    for (const [msgId, exp] of this.seenMessageIds) {
      if (exp < nowMs) this.seenMessageIds.delete(msgId);
    }
  }

  getContext() {
    if (!this.currentContext) return null;
    const nowMs = Date.now();
    const expiresAtMs = Date.parse(this.currentContext.expiresAt);
    if (!Number.isNaN(expiresAtMs) && nowMs > expiresAtMs) {
      return null; // context expired
    }
    if (this.currentContext.ttlMs !== undefined) {
      const issuedAtMs = Date.parse(this.currentContext.issuedAt);
      if (!Number.isNaN(issuedAtMs) && nowMs > issuedAtMs + this.currentContext.ttlMs) {
        return null; // context expired by TTL
      }
    }
    return this.currentContext;
  }
}
