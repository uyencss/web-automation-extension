#!/usr/bin/env node

// Local deterministic fixture for the antibot scripts. Proves detect/harvest
// MECHANICS with the real gateway — it does not prove reuse (a fake cookie
// cannot test UA/IP/TLS binding; see the antibot plan §2.10).
//
//   /          simulates a JS challenge: cf-chl- marker first, then after 4s
//              sets cf_clearance (fake) and swaps in the success signal #content
//   /plain     normal page, no markers, no cookie
//   /turnstile simulates the descoped Turnstile case: .cf-turnstile marker,
//              no auto-resolve, no cookie

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || process.env.ANTIBOT_FIXTURE_PORT || 18765);

const PAGE = (title, markerHtml, script) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
</head>
<body>
  ${markerHtml}
  <div id="content" hidden>challenge passed</div>
  ${script}
</body>
</html>`;

const jsChallenge = PAGE(
  'fixture js-challenge',
  '<div id="cf-chl-wrapper"><span class="cf-chl-test"></span>Verifying you are human…</div>',
  `<script>
    setTimeout(() => {
      document.cookie = 'cf_clearance=fixture-clearance-token; path=/; max-age=3600';
      document.getElementById('cf-chl-wrapper').remove();
      document.getElementById('content').hidden = false;
    }, 4000);
  </script>`,
);

const plain = PAGE(
  'fixture plain',
  '<h1>plain page</h1>',
  `<script>document.getElementById('content').hidden = false;</script>`,
);

const turnstile = PAGE(
  'fixture turnstile',
  '<div class="cf-turnstile" data-sitekey="fixture-key"></div>',
  '',
);

const reset = PAGE(
  'fixture reset',
  '<div id="content" hidden>reset done</div>',
  '<script>document.getElementById("content").hidden = false;</script>',
);

createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  console.error(`[fixture] ${req.method} ${path}`);
  if (path === '/') {
    res.end(jsChallenge);
  } else if (path === '/plain') {
    res.end(plain);
  } else if (path === '/turnstile') {
    res.end(turnstile);
  } else if (path === '/reset') {
    // Clear any stale fixture-issued cf_clearance so cases stay deterministic.
    res.setHeader('Set-Cookie', 'cf_clearance=; Path=/; Max-Age=0');
    res.end(reset);
  } else {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.error(`[fixture] antibot fixture server on http://127.0.0.1:${PORT}`);
});
