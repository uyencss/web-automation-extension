import process from 'node:process';
import { spawn } from 'node:child_process';

export function runJsonChild(command, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolveChild) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveChild(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, status: null, error: 'command timed out' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ ok: false, status: null, error: error.message }));
    child.on('exit', (status, signal) => {
      let payload = null;
      try { payload = stdout.trim() ? JSON.parse(stdout) : null; } catch { payload = null; }
      finish({
        ok: status === 0 && payload && typeof payload === 'object',
        status,
        signal,
        payload,
        error: payload ? null : (stderr || stdout || 'command returned no JSON').slice(0, 500),
      });
    });
  });
}
