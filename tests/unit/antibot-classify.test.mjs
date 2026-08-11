import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { classifyMarkers } = require('../../scripts/antibot/classify.js');
const { cookieDomainMatches, cookieIsValid, findCookie } = require('../../scripts/antibot/lib.js');

test('classifyMarkers labels turnstile above everything', () => {
  assert.equal(classifyMarkers({ turnstile: true, managed: true, jsChallenge: true }), 'turnstile');
  assert.equal(classifyMarkers({ turnstile: true }), 'turnstile');
});

test('classifyMarkers distinguishes managed from js-challenge', () => {
  assert.equal(classifyMarkers({ managed: true, jsChallenge: true }), 'managed');
  assert.equal(classifyMarkers({ jsChallenge: true }), 'js-challenge');
  assert.equal(classifyMarkers({}), 'none');
  assert.equal(classifyMarkers(undefined), 'none');
});

test('cookieDomainMatches handles host-only and parent domains', () => {
  assert.equal(cookieDomainMatches('example.com', 'example.com'), true);
  assert.equal(cookieDomainMatches('.example.com', 'www.example.com'), true);
  assert.equal(cookieDomainMatches('127.0.0.1', '127.0.0.1'), true);
  assert.equal(cookieDomainMatches('example.com', 'notexample.com'), false);
  assert.equal(cookieDomainMatches('evil.com', 'example.com'), false);
});

test('cookieIsValid accepts live and session cookies, rejects expired', () => {
  const now = Date.now() / 1000;
  assert.equal(cookieIsValid({ expires: now + 100 }), true);
  assert.equal(cookieIsValid({ expires: now - 100 }), false);
  assert.equal(cookieIsValid({ session: true }), true);
});

test('findCookie matches name + domain + validity', () => {
  const cookies = [
    { name: 'cf_clearance', domain: '.example.com', expires: 9999999999 },
    { name: 'cf_clearance', domain: '.example.com', expires: 1 },
    { name: 'other', domain: '.example.com', expires: 9999999999 },
  ];
  const found = findCookie(cookies, 'www.example.com', 'cf_clearance');
  assert.equal(found.value, undefined);
  assert.equal(found.expires, 9999999999);
});
