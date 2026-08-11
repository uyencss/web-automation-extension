#!/usr/bin/env node

'use strict';

const { mkdirSync, writeFileSync, readFileSync, unlinkSync } = require('node:fs');
const path = require('node:path');

const {
  gatewayCall, sleep, resolveProfileId, findClearance, parseArgs, cookieDomainMatches,
} = require('./lib');
const { markerProbeCode, classifyMarkers } = require('./classify');

const DEFAULT_MAX_WAIT_MS = 30000;
const LOCK_STALE_MS = 15 * 60 * 1000;

function printUsage() {
  console.error(`Usage:
  node scripts/antibot/solve-and-harvest.js --url <url> --run-dir <dir> [options]

Options:
  --profileId <id>        Chrome profile id (else WEBMCP_PROFILE_ID)
  --max-wait-ms <ms>      Poll window for auto-resolve (default ${DEFAULT_MAX_WAIT_MS})
  --success-signal <sel>  CSS selector that only appears after the challenge passes
  --ip-probe <url>        Egress-IP probe used by the page (default https://api.ipify.org?format=json)

Writes runDir/artifacts/session.json and prints a summary (cookie values and
the User-Agent stay in the artifact, never in stdout).`);
}

function acquireLock(runDir, profileId) {
  mkdirSync(runDir, { recursive: true });
  const lockPath = path.join(runDir, 'antibot.lock');
  let stale = false;
  try {
    const existing = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (existing.profileId === profileId || Date.now() - existing.startedAt < LOCK_STALE_MS) {
      throw new Error(
        `another antibot harvest is using profile ${existing.profileId} (lock ${lockPath}, started ${new Date(existing.startedAt).toISOString()})`,
      );
    }
    stale = true;
  } catch (err) {
    if (err instanceof SyntaxError || err.code === 'ENOENT') {
      // No lock or a torn lock file — take it over.
    } else {
      throw err;
    }
  }
  if (stale) {
    console.error(`warning: taking over stale lock at ${lockPath}`);
  }
  writeFileSync(lockPath, JSON.stringify({ profileId, pid: process.pid, startedAt: Date.now() }));
  return lockPath;
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

function harvestCookies(cookies, hostname) {
  return (cookies || [])
    .filter((c) => /^(cf_|__cf_|_cf_)/.test(c.name)
      && cookieDomainMatches(c.domain, hostname))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires ?? null,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite ?? null,
      session: Boolean(c.session),
    }));
}

function expiresAtOf(clearance) {
  if (!clearance || clearance.session === true || !clearance.expires) return null;
  return new Date(clearance.expires * 1000).toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  const runDir = args['run-dir'];
  if (!url || !runDir || args['help'] === 'true') {
    printUsage();
    process.exit(url && runDir ? 0 : 1);
  }

  const gateway = { profileId: resolveProfileId(args.profileId) };
  const hostname = new URL(url).hostname;
  const maxWaitMs = Number(args['max-wait-ms'] || DEFAULT_MAX_WAIT_MS);
  const successSignal = args['success-signal'];
  const ipProbe = args['ip-probe'] || 'https://api.ipify.org?format=json';

  const lockPath = acquireLock(runDir, gateway.profileId || 'default');

  const artifactsDir = path.join(runDir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const sessionPath = path.join(artifactsDir, 'session.json');

  let tabId = null;
  try {
    const created = await gatewayCall('newTab', { url }, gateway);
    tabId = created && created.tabId;
    if (!tabId) throw new Error('newTab did not return a tabId');
    await sleep(2000);

    const deadline = Date.now() + maxWaitMs;
    let clearance = null;
    let lastCookies = [];
    let markers = { turnstile: false, managed: false, jsChallenge: false };
    let handoffTurnstile = false;

    while (Date.now() < deadline) {
      const probe = await findClearance(tabId, hostname, gateway);
      lastCookies = probe.cookies;
      clearance = probe.clearance;
      if (clearance) break;
      try {
        const evalResult = await gatewayCall(
          'evaluateJS', { code: markerProbeCode(), tabId }, gateway,
        );
        if (evalResult && evalResult.result && typeof evalResult.result === 'object') {
          // Keep the strongest label seen: markers disappear once resolved.
          if (classifyMarkers(evalResult.result) !== 'none') markers = evalResult.result;
        }
        if (classifyMarkers(markers) === 'turnstile') {
          handoffTurnstile = true;
          break;
        }
        if (successSignal) {
          const hit = await gatewayCall(
            'evaluateJS',
            { code: `document.querySelector(${JSON.stringify(successSignal)}) !== null`, tabId },
            gateway,
          );
          if (hit && hit.result) break;
        }
      } catch (err) {
        // Page still settling — keep polling.
      }
      await sleep(1000);
    }

    const type = classifyMarkers(markers);
    const capturedAt = new Date().toISOString();
    let status;
    let notes = [];

    if (!clearance) {
      if (handoffTurnstile) {
        status = 'manual-handoff';
        notes.push(
          'Cloudflare Turnstile detected on the target; Turnstile is descoped — the script does not click widgets. Hand off to webmcp-captcha-solver / a manual agent.',
        );
      } else {
        status = 'timeout';
        notes.push(`no valid cf_clearance appeared within ${maxWaitMs}ms — interactive challenge or blocked network.`);
      }
      const failed = {
        schema: 'webmcp-antibot-session/1',
        url,
        type,
        status,
        capturedAt,
        expiresAt: null,
        userAgent: null,
        egressBinding: null,
        cookies: [],
        turnstileToken: null,
        notes,
      };
      writeFileSync(sessionPath, `${JSON.stringify(failed, null, 2)}\n`);
      console.log(JSON.stringify({ url, type, status, sessionPath }));
      process.exit(1);
    }

    const uaResult = await gatewayCall(
      'evaluateJS', { code: 'navigator.userAgent', tabId }, gateway,
    );
    const userAgent = uaResult && uaResult.result;
    if (!userAgent || typeof userAgent !== 'string') {
      throw new Error('navigator.userAgent missing — fail closed (cf_clearance is bound to the UA that minted it)');
    }

    let egressIp = null;
    try {
      const probeResult = await gatewayCall(
        'evaluateJS',
        { code: `(async () => { const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000); try { const r = await fetch(${JSON.stringify(ipProbe)}, { signal: c.signal }); clearTimeout(t); if (!r.ok) return null; const j = await r.json(); return (j && (j.ip || j.origin)) || null; } catch (e) { clearTimeout(t); return null; } })()` },
        tabId,
        gateway,
      );
      egressIp = probeResult && probeResult.result ? String(probeResult.result) : null;
    } catch (err) {
      egressIp = null;
    }

    const cookies = harvestCookies(lastCookies, hostname);
    if (!cookies.some((c) => c.name === 'cf_clearance')) {
      throw new Error('cf_clearance disappeared between poll and harvest — fail closed, re-run');
    }

    const session = {
      schema: 'webmcp-antibot-session/1',
      url,
      type,
      status: 'harvested',
      capturedAt,
      expiresAt: expiresAtOf(clearance),
      userAgent,
      egressBinding: egressIp
        ? { ip: egressIp, notes: ['reuse must run from the same egress IP as this harvest'] }
        : { ip: null, notes: ['egress IP could not be determined automatically — reuse must run on this machine/network (same egress as the browser)'] },
      cookies,
      turnstileToken: null,
      notes,
    };
    writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    console.log(JSON.stringify({
      url,
      type,
      status: 'harvested',
      sessionPath,
      cookieCount: cookies.length,
      expiresAt: session.expiresAt,
    }));
    process.exit(0);
  } finally {
    if (tabId) {
      try {
        await gatewayCall('closeTab', { tabId }, gateway);
      } catch {
        // Tab may already be gone.
      }
    }
    releaseLock(lockPath);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }, null, 2));
  process.exit(1);
});
