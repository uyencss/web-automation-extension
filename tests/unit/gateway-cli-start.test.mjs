import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const BIN = join(ROOT, 'bin', 'webmcp-browser.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForListening(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`gateway CLI did not become ready\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/WebMCP Gateway listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) finish(null, { port: Number(match[1]), stdout, stderr });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      finish(new Error(`gateway CLI exited before readiness (code=${code}, signal=${signal})\nstdout=${stdout}\nstderr=${stderr}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs) => Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(timeoutMs),
  ]);
  child.kill('SIGTERM');
  await waitForExit(3000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(1000);
  }
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    'gateway child must exit during test teardown',
  );
}

test('webmcp gateway start owns a foreground server and exposes health', async (t) => {
  const child = spawn(process.execPath, [BIN, 'gateway', 'start'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WEBMCP_GATEWAY_HOST: '127.0.0.1',
      WEBMCP_GATEWAY_PORT: '0',
      PORT: '7999',
      WEBMCP_GATEWAY_TOKEN: 'cli-start-test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await stopChild(child);
  });

  const { port } = await waitForListening(child);
  assert.ok(port > 0, 'gateway must report the bound port');
  assert.notEqual(port, 7999, 'explicit port 0 must not fall back to PORT');
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Authorization: 'Bearer cli-start-test-token' },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.extensionConnected, false);
  assert.equal(payload.apiUrl, `http://localhost:${port}/api`);
});
