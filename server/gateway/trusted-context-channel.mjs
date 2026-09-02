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

export function assertNoTcpTransport(source) {
  if (!source || typeof source !== 'object') return;
  if (
    source.host !== undefined ||
    source.port !== undefined ||
    source.contextHost !== undefined ||
    source.contextPort !== undefined ||
    source.trustedContextHost !== undefined ||
    source.trustedContextPort !== undefined ||
    source.contextTcp !== undefined ||
    source.WEBMCP_GATEWAY_CONTEXT_PORT !== undefined ||
    source.WEBMCP_GATEWAY_CONTEXT_HOST !== undefined ||
    source.WEBMCP_GATEWAY_TRUSTED_CONTEXT_PORT !== undefined ||
    source.WEBMCP_GATEWAY_TRUSTED_CONTEXT_HOST !== undefined ||
    source.WEBMCP_GATEWAY_CONTEXT_TCP !== undefined ||
    source.WEBMCP_CONTEXT_PORT !== undefined ||
    source.WEBMCP_CONTEXT_HOST !== undefined ||
    source.WEBMCP_TRUSTED_CONTEXT_HOST !== undefined ||
    source.WEBMCP_TRUSTED_CONTEXT_PORT !== undefined
  ) {
    throw new Error('Trusted context forbids TCP host/port transport; machine-local stream IPC required');
  }
  const endpoint =
    source.endpoint ||
    source.socketPath ||
    source.contextEndpoint ||
    source.WEBMCP_GATEWAY_CONTEXT_ENDPOINT ||
    source.WEBMCP_TRUSTED_CONTEXT_SOCKET;
  if (typeof endpoint === 'string') {
    if (/^(https?|tcp|ws|wss):\/\//i.test(endpoint)) {
      throw new Error('Trusted context forbids TCP host/port transport; machine-local stream IPC required');
    }
  }
}

export function assertValidEndpoint(endpoint, platform = process.platform) {
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
    throw new Error('Trusted context endpoint must be a non-empty string');
  }
  if (/^(https?|tcp|ws|wss):\/\//i.test(endpoint)) {
    throw new Error('Trusted context forbids TCP host/port transport; machine-local stream IPC required');
  }
  if (platform === 'win32') {
    if (!endpoint.startsWith('\\\\.\\pipe\\webmcp-gateway-')) {
      throw new Error('Windows trusted context endpoint must be a named pipe in the webmcp-gateway- namespace (\\\\.\\pipe\\webmcp-gateway-...)');
    }
    return;
  }
  if (!path.isAbsolute(endpoint)) {
    throw new Error(`POSIX trusted context endpoint must be an absolute path (got: ${endpoint})`);
  }
  const segments = endpoint.split(/[/\\]/);
  if (segments.includes('..')) {
    throw new Error(`POSIX trusted context endpoint must not contain ".." traversal segments (got: ${endpoint})`);
  }
  if (!endpoint.endsWith('.sock')) {
    throw new Error('POSIX trusted context endpoint must be a local .sock socket');
  }
  if (Buffer.byteLength(endpoint, 'utf8') > 103) {
    throw new Error(
      `POSIX trusted context endpoint exceeds maximum allowed length of 103 bytes (got ${Buffer.byteLength(endpoint, 'utf8')} bytes: ${endpoint})`
    );
  }
}

export class TrustedContextChannel {
  constructor({
    socketPath = null,
    publicKey = null,
    keyId = null,
    onContextUpdate = null,
    permitStore = null,
    endpoint = null,
  } = {}) {
    assertNoTcpTransport({ socketPath, endpoint });
    assertNoTcpTransport(process.env);
    const envSocket = process.env.WEBMCP_TRUSTED_CONTEXT_SOCKET;
    const envEndpoint = process.env.WEBMCP_GATEWAY_CONTEXT_ENDPOINT;
    const hasEnvSocket = typeof envSocket === 'string' && envSocket.trim() && envSocket !== 'undefined' && envSocket !== 'null';
    const hasEnvEndpoint = typeof envEndpoint === 'string' && envEndpoint.trim() && envEndpoint !== 'undefined' && envEndpoint !== 'null';
    const hasSocketPath = typeof socketPath === 'string' && socketPath.trim() && socketPath !== 'undefined' && socketPath !== 'null';
    const hasEndpoint = typeof endpoint === 'string' && endpoint.trim() && endpoint !== 'undefined' && endpoint !== 'null';
    const effectivePath =
      (hasSocketPath ? socketPath : null) ||
      (hasEndpoint ? endpoint : null) ||
      (hasEnvSocket ? envSocket : null) ||
      (hasEnvEndpoint ? envEndpoint : null) ||
      path.join(os.tmpdir(), `webmcp-ctx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`);
    const isExplicit = hasSocketPath || hasEndpoint || hasEnvSocket || hasEnvEndpoint;
    if (isExplicit) {
      assertValidEndpoint(effectivePath, process.platform);
    } else {
      // auto-generated: still validate to ensure short path when TMPDIR=/tmp
      assertValidEndpoint(effectivePath, process.platform);
    }
    this.socketPath = effectivePath;
    this.publicKey = publicKey;
    this.keyId = keyId || null;
    this.onContextUpdate = onContextUpdate;
    this.permitStore = permitStore;
    this.server = null;
    this.seenMessageIds = new Map(); // messageId -> expiresAtMs
    this.lastSeq = 0;
    this.currentContext = null;
    this._socketOwned = false;
  }

  async _preparePosixSocket(endpoint) {
    if (!fs.existsSync(endpoint)) return;
    let stat;
    try {
      stat = fs.lstatSync(endpoint);
    } catch {
      return;
    }
    if (!stat.isSocket()) {
      throw new Error(`Cannot bind trusted context socket: '${endpoint}' exists and is not a socket`);
    }
    const isLive = await new Promise((res) => {
      const client = net.connect(endpoint);
      const timer = setTimeout(() => {
        try { client.destroy(); } catch {}
        res(true);
      }, 300);
      client.on('connect', () => {
        clearTimeout(timer);
        try { client.destroy(); } catch {}
        res(true);
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
          res(false);
        } else {
          res(true);
        }
      });
    });
    if (isLive) {
      throw new Error(`Cannot bind trusted context socket: endpoint '${endpoint}' is in use by another process`);
    }
    try {
      fs.unlinkSync(endpoint);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  start() {
    if (this.server) return Promise.resolve(this.socketPath);
    assertNoTcpTransport({ socketPath: this.socketPath });
    assertValidEndpoint(this.socketPath, process.platform);
    const prepare = process.platform !== 'win32' ? this._preparePosixSocket(this.socketPath) : Promise.resolve();
    return prepare.then(
      () =>
        new Promise((resolve, reject) => {
          this.server = net.createServer((socket) => {
            this.handleConnection(socket);
          });
          this.server.on('error', (err) => {
            reject(err);
          });
          this.server.listen(this.socketPath, () => {
            this._socketOwned = process.platform !== 'win32';
            resolve(this.socketPath);
          });
        })
    );
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        try {
          if (this._socketOwned && fs.existsSync(this.socketPath)) {
            const stat = fs.lstatSync(this.socketPath);
            if (stat.isSocket()) {
              fs.unlinkSync(this.socketPath);
            }
          }
        } catch {
          // ignore
        }
        this.server = null;
        this._socketOwned = false;
        resolve();
      });
    });
  }

  close() {
    return this.stop();
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

    this.gcSeenMessages(nowMs);
    if (this.seenMessageIds.has(msg.messageId)) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'MESSAGE_REPLAY',
        reason: 'TRUSTED_CONTEXT_REPLAY',
      });
    }

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

    if (this.keyId && msg.keyId && msg.keyId !== this.keyId) {
      return finish({
        ok: false,
        schema: SCHEMAS.ACK,
        error: 'KEY_ID_MISMATCH',
        reason: 'TRUSTED_CONTEXT_FORGED',
      });
    }

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

    this.seenMessageIds.set(msg.messageId, Number.isNaN(expiresAtMs) ? nowMs + 60000 : expiresAtMs);
    if (typeof msg.seq === 'number') {
      this.lastSeq = msg.seq;
    }

    if (Array.isArray(msg.revocations) && this.permitStore) {
      for (const revId of msg.revocations) {
        if (typeof revId === 'string') {
          this.permitStore.revoke(revId);
        }
      }
    }

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
      return null;
    }
    if (this.currentContext.ttlMs !== undefined) {
      const issuedAtMs = Date.parse(this.currentContext.issuedAt);
      if (!Number.isNaN(issuedAtMs) && nowMs > issuedAtMs + this.currentContext.ttlMs) {
        return null;
      }
    }
    return this.currentContext;
  }

  getTrustedContext() {
    return this.getContext();
  }

  getCurrentContext() {
    return this.getContext();
  }
}

export async function createTrustedContextChannel(options = {}) {
  const channel = new TrustedContextChannel(options);
  await channel.start();
  return channel;
}
