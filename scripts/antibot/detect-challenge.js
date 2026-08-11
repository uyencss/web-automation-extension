#!/usr/bin/env node

'use strict';

const { gatewayCall, sleep, resolveProfileId, findClearance, parseArgs } = require('./lib');
const { markerProbeCode, classifyMarkers } = require('./classify');

function printUsage() {
  console.error(`Usage:
  node scripts/antibot/detect-challenge.js --url <url> [options]

Options:
  --profileId <id>        Chrome profile id (else WEBMCP_PROFILE_ID)
  --success-signal <sel>  CSS selector that only appears after the challenge passes
  --max-wait-ms <ms>      Poll window for auto-resolve (default 10000)
  --tab-id <id>           Reuse an existing tab instead of opening one

Output (stdout, JSON):
  { url, type: "js-challenge"|"managed"|"turnstile"|"none",
    status: "blocked"|"clear", hasClearance: bool }`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  if (!url || args['help'] === 'true' || args['h'] === 'true') {
    printUsage();
    process.exit(url ? 0 : 1);
  }

  const gateway = { profileId: resolveProfileId(args.profileId) };
  const hostname = new URL(url).hostname;
  const maxWaitMs = Number(args['max-wait-ms'] || 10000);
  const successSignal = args['success-signal'];

  let tabId = args['tab-id'] ? Number(args['tab-id']) : null;
  let openedTab = false;
  if (!tabId) {
    const created = await gatewayCall('newTab', { url }, gateway);
    tabId = created && created.tabId;
    if (!tabId) throw new Error('newTab did not return a tabId');
    openedTab = true;
  } else {
    await gatewayCall('navigate', { url, tabId }, gateway);
  }
  await sleep(2000);

  try {
    const deadline = Date.now() + maxWaitMs;
    let clearance = null;
    let markers = { turnstile: false, managed: false, jsChallenge: false };
    let successSeen = false;

    while (Date.now() < deadline) {
      const probe = await findClearance(tabId, hostname, gateway);
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
        if (successSignal) {
          const hit = await gatewayCall(
            'evaluateJS',
            { code: `document.querySelector(${JSON.stringify(successSignal)}) !== null`, tabId },
            gateway,
          );
          successSeen = Boolean(hit && hit.result);
          if (successSeen) break;
        }
      } catch (err) {
        // Page still settling — keep polling; ground truth is the cookie.
      }
      await sleep(1000);
    }

    const type = classifyMarkers(markers);
    const hasClearance = Boolean(clearance);
    let status;
    if (hasClearance) status = 'clear';
    else if (successSignal) status = successSeen ? 'clear' : 'blocked';
    else status = type === 'none' ? 'clear' : 'blocked';
    console.log(JSON.stringify({ url, type, status, hasClearance }));
    process.exit(status === 'clear' ? 0 : 2);
  } finally {
    if (openedTab) {
      try {
        await gatewayCall('closeTab', { tabId }, gateway);
      } catch {
        // Tab may already be gone; nothing to clean up.
      }
    }
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }, null, 2));
  process.exit(1);
});
