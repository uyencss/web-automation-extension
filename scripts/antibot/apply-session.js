#!/usr/bin/env node

'use strict';

const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const { gatewayCall, sleep, resolveProfileId, findClearance, parseArgs } = require('./lib');

function printUsage() {
  console.error(`Usage:
  node scripts/antibot/apply-session.js --session <session.json> [options]

Options:
  --mode <http|browser>   http = curl_cffi request (default, official reuse path);
                          browser = inject cookies into a browser profile via
                          executeCDP Network.setCookie with full attributes
  --url <url>             Override the target URL from the session artifact
  --profileId <id>        Chrome profile id (else WEBMCP_PROFILE_ID) — browser mode
  --python <path>         Python interpreter with curl_cffi (else WEBMCP_CURL_CFFI_PYTHON;
                          falls back to python3 if curl_cffi imports)

The artifact must contain userAgent + cookies; missing User-Agent fails closed
(cf_clearance is bound to the UA that minted it).`);
}

const CURL_CFFI_PROGRAM = `
import json, re, sys
from curl_cffi import requests as creq
from curl_cffi.requests.impersonate import BrowserType

session_path, url = sys.argv[1], sys.argv[2]
with open(session_path, encoding='utf-8') as fh:
    sess = json.load(fh)
ua = sess['userAgent']
cookies = {c['name']: c['value'] for c in sess.get('cookies', []) if c.get('name') and c.get('value')}
chrome_versions = sorted(
    (int(m.name[6:]) for m in BrowserType if m.name.startswith('chrome') and m.name[6:].isdigit()),
    reverse=True,
)
m = re.search(r'Chrome/(\\d+)', ua or '')
want = int(m.group(1)) if m else None
impersonate = None
if want is not None:
    for v in chrome_versions:
        if v <= want:
            impersonate = f'chrome{v}'
            break
if impersonate is None:
    impersonate = f'chrome{chrome_versions[0]}' if chrome_versions else 'chrome124'
headers = {'User-Agent': ua, 'Cookie': '; '.join(f'{k}={v}' for k, v in cookies.items())}
resp = creq.get(url, headers=headers, impersonate=impersonate, timeout=30, allow_redirects=True)
print(json.dumps({'statusCode': resp.status_code, 'finalUrl': str(resp.url),
                  'impersonate': impersonate, 'bodySnippet': resp.text[:400]}))
`;

function resolvePython(args) {
  const explicit = args.python || process.env.WEBMCP_CURL_CFFI_PYTHON;
  const candidates = explicit ? [explicit] : ['python3'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import curl_cffi'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function applyHttp(sessionPath, url, args) {
  const python = resolvePython(args);
  if (!python) {
    throw new Error(
      'curl_cffi not available — install it (e.g. `pip install curl_cffi`; the webmcp-captcha-solver .venv already has it) or pass --python <venv-python>',
    );
  }
  const result = spawnSync(python, ['-c', CURL_CFFI_PROGRAM, sessionPath, url], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`curl_cffi request failed: ${(result.stderr || result.stdout || 'no output').trim().slice(0, 800)}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`curl_cffi request returned unparsable output: ${result.stdout.slice(0, 800)}`);
  }
  const challenged = /challenges\.cloudflare\.com|cf-chl-|managed-challenge/i.test(report.bodySnippet || '');
  report.ok = report.statusCode === 200 && !challenged;
  return report;
}

async function applyBrowser(session, url, gateway, tabId) {
  const records = session.cookies || [];
  if (!records.length) throw new Error('session artifact has no cookies — nothing to set');
  for (const cookie of records) {
    const params = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    };
    if (cookie.sameSite) params.sameSite = cookie.sameSite;
    if (cookie.session !== true && cookie.expires) params.expires = cookie.expires;
    const result = await gatewayCall('executeCDP', { method: 'Network.setCookie', params }, gateway);
    if (result && result.result === false) {
      throw new Error(`Network.setCookie rejected ${cookie.name} — re-harvest the session`);
    }
  }
  await sleep(1500);
  const hostname = new URL(url).hostname;
  const probe = await findClearance(tabId, hostname, gateway);
  return { ok: Boolean(probe.clearance), hasClearance: Boolean(probe.clearance) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionArg = args.session;
  if (!sessionArg || args['help'] === 'true') {
    printUsage();
    process.exit(sessionArg ? 0 : 1);
  }

  const session = JSON.parse(readFileSync(sessionArg, 'utf8'));
  if (!session.userAgent || !(session.cookies || []).length) {
    throw new Error('session artifact must contain userAgent and cookies — fail closed (cf_clearance is bound to the UA that minted it)');
  }
  const url = args.url || session.url;
  if (!url) throw new Error('no target url in artifact and no --url given');
  const mode = args.mode || 'http';

  if (mode === 'http') {
    const report = applyHttp(sessionArg, url, args);
    console.log(JSON.stringify({ mode, url, ...report }));
    process.exit(report.ok ? 0 : 3);
  }

  if (mode === 'browser') {
    const gateway = { profileId: resolveProfileId(args.profileId) };
    const created = await gatewayCall('newTab', { url }, gateway);
    const tabId = created && created.tabId;
    if (!tabId) throw new Error('newTab did not return a tabId');
    try {
      await sleep(2000);
      const report = await applyBrowser(session, url, gateway, tabId);
      console.log(JSON.stringify({ mode, url, ...report }));
      process.exit(report.ok ? 0 : 3);
    } finally {
      try {
        await gatewayCall('closeTab', { tabId }, gateway);
      } catch {
        // Tab may already be gone.
      }
    }
  }

  throw new Error(`unknown mode: ${mode} (expected http|browser)`);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }, null, 2));
  process.exit(1);
});
