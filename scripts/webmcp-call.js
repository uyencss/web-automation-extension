#!/usr/bin/env node

const process = require('process');

const DEFAULT_GATEWAY_URL = 'http://localhost:7865/api';
const gatewayUrl = process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL;
const profileId = process.env.WEBMCP_PROFILE_ID || undefined;

function printUsage() {
  console.error(`Usage:
  npm run health
  npm run call -- <method> [jsonParams]

Examples:
  npm run call -- getActiveTab
  npm run call -- newTab '{"url":"https://example.com"}'
  npm run call -- webmcp.listTools '{"tabId":123}'
  npm run call -- webmcp.invokeTool '{"tabId":123,"toolName":"get_page_metadata","input":{"include_headings":true}}'

Environment:
  WEBMCP_GATEWAY_URL=${DEFAULT_GATEWAY_URL}`);
}

function parseJsonParams(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('params must be a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid JSON params: ${err.message}`);
  }
}

async function main() {
  const [, , method, rawParams] = process.argv;
  if (!method || method === '--help' || method === '-h') {
    printUsage();
    process.exit(method ? 0 : 1);
  }

  const params = parseJsonParams(rawParams);
  const requestBody = { method, params };
  if (profileId) requestBody.profileId = profileId;
  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  let payload;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `Gateway returned HTTP ${response.status}` };
  }

  console.log(JSON.stringify(payload, null, 2));
  if (!response.ok || payload.error) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }, null, 2));
  process.exit(1);
});
