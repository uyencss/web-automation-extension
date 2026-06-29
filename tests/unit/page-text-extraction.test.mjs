// Unit tests for the getPageText / readPage smart-extraction expression.
//
// Run with: node tests/unit/page-text-extraction.test.mjs
//
// We import the real buildTextExtractionExpr (dependency-free, no `chrome`/DOM)
// and evaluate the generated page expression under Node against a minimal DOM
// stub to confirm container selection, whitespace cleanup, pagination, and the
// empty-page guard.

import { buildTextExtractionExpr } from '../../webmcp-extension/dist/bg/handlers/page-text-extract.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.log('FAIL:', msg); } else console.log('PASS:', msg);
}

const makeEl = (text) => ({ innerText: text });

function installDom({ article, main, body }) {
  globalThis.document = {
    title: 'Test Page',
    body: makeEl(body),
    querySelectorAll(sel) {
      if (sel === 'article' && article != null) return [makeEl(article)];
      if (sel === 'main' && main != null) return [makeEl(main)];
      return [];
    },
  };
  globalThis.location = { href: 'https://example.com/x' };
}

// 1) Picks the dominant semantic container, not the first that matches.
const mainText = 'The Main Article Body.\n\n\n\nWith   messy    whitespace \n and blank lines.\n\n\n\nEnd.';
installDom({ article: 'Short related card', main: mainText, body: 'nav junk ' + 'x'.repeat(50) + '\n\n\n' + mainText });
const r = eval(buildTextExtractionExpr(50000, 0));
assert(r.source === 'main', 'picks <main> (largest semantic) over tiny <article>');
assert(!/\n{3,}/.test(r.text), 'collapses 3+ newlines to blank line');
assert(!/  +/.test(r.text), 'collapses horizontal whitespace runs');
assert(r.text.includes('messy whitespace'), 'whitespace normalized to single spaces');
assert(r.totalLength === r.text.length && r.truncated === false, 'totalLength matches when not truncated');

// 2) Pagination.
const r2 = eval(buildTextExtractionExpr(10, 0));
assert(r2.truncated === true && r2.nextOffset === 10 && r2.returnedLength === 10, 'pagination truncates and reports nextOffset');

// 3) Falls back to <body> when no semantic container is large enough.
installDom({ article: null, main: null, body: 'Just a plain body paragraph with enough text to pass the guard.' });
const r3 = eval(buildTextExtractionExpr(50000, 0));
assert(r3.source === 'body' && r3.text.startsWith('Just a plain body'), 'falls back to <body>');

// 4) Empty-page guard.
installDom({ article: null, main: null, body: '' });
const r4 = eval(buildTextExtractionExpr(50000, 0));
assert(r4.error && r4.text === '', 'empty page returns guard error');

if (failed === 0) {
  console.log('\nALL PASS');
  process.exit(0);
} else {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
