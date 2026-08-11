'use strict';

// Marker probe evaluated in the challenged page. Markup is only ever used to
// LABEL the challenge type — presence/absence of a valid cf_clearance cookie
// plus the caller-configured success signal is the ground truth (plan §Phase 1).
function markerProbeCode() {
  return `(() => {
    const text = (document.title || '') + ' ' + (document.body && document.body.innerText || '') + ' '
      + document.documentElement.outerHTML.slice(0, 20000);
    const hasChallengeFrame = [...document.querySelectorAll('iframe')]
      .some((f) => (f.src || '').includes('challenges.cloudflare.com'));
    return {
      turnstile: hasChallengeFrame
        || !!document.querySelector('.cf-turnstile, .cf-turnstile-wrapper, [data-cf-turnstile]'),
      managed: /managed-challenge|cf-chl-managed/i.test(text),
      jsChallenge: /cf-chl-|challenge-platform/i.test(text),
    };
  })()`;
}

// Turnstile wins over generic JS-challenge markers (its widget is the harder
// signal); "managed" is a narrower claim than "js-challenge".
function classifyMarkers(markers) {
  const m = markers || {};
  if (m.turnstile) return 'turnstile';
  if (m.managed) return 'managed';
  if (m.jsChallenge) return 'js-challenge';
  return 'none';
}

module.exports = { markerProbeCode, classifyMarkers };
