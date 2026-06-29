// Unit tests for the evaluateJS smart-return wrapper.
//
// Run with: node tests/unit/evaluate-wrap.test.mjs
//
// We import the real wrapEvaluateCode from the extension source (it is
// dependency-free, so no `chrome`/DOM stub is needed) and execute each wrapped
// snippet under Node to confirm the resolved value matches intent.

import { wrapEvaluateCode } from '../../webmcp-extension/dist/bg/handlers/evaluate-wrap.js';

globalThis.document = { title: 'Hello' };
globalThis.__rows = [{ a: 1 }, { a: 2 }, { a: 3 }];

let failed = 0;

async function check(code, expected, label) {
  let got;
  try {
    // eslint-disable-next-line no-eval
    got = await eval(wrapEvaluateCode(code));
  } catch (e) {
    got = '[throw] ' + e.message;
  }
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${JSON.stringify(got)} (want ${JSON.stringify(expected)})`);
}

await check('1 + 2', 3, 'bare arithmetic expression');
await check('document.title', 'Hello', 'member expression');
await check('document.title;', 'Hello', 'member expression w/ trailing semicolon');
await check('__rows.map(r => r.a)', [1, 2, 3], 'array map expression (bulk extract)');
await check('(() => { return __rows.map(r => r.a); })()', [1, 2, 3], 'nested IIFE without outer return');
await check('(async () => { return 42; })()', 42, 'nested async IIFE');
await check('return 7', 7, 'explicit return body (back-compat)');
await check('const x = 5; return x * 2;', 10, 'multi-statement explicit return');
await check('({a: 1, b: 2})', { a: 1, b: 2 }, 'object literal expression');
await check('"a;b".length', 3, 'semicolon inside string is not a separator');
await check('const x = 1;', undefined, 'declaration only -> undefined (body, no return)');
await check('await Promise.resolve(99)', 99, 'top-level await expression');

if (failed === 0) {
  console.log('\nALL PASS');
  process.exit(0);
} else {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
