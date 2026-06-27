#!/usr/bin/env node

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_GATEWAY_URL = 'http://localhost:7865';
const PACKAGE_NAME = '@gyga-browser/webmcp-browser-automation-kit';
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

function printHelp() {
  console.log(`WebMCP Browser Automation

Usage:
  webmcp mcp
  webmcp gateway start
  webmcp gateway health [--json]
  webmcp health [--json]
  webmcp call <method> [jsonParams]
  webmcp extension-path

MCP config example:
  {
    "mcpServers": {
      "webmcp": {
        "command": "npx",
        "args": ["-y", "${PACKAGE_NAME}", "mcp"]
      }
    }
  }

Environment:
  WEBMCP_GATEWAY_URL=${DEFAULT_GATEWAY_URL}
  WEBMCP_GATEWAY_AUTOSTART=1  Enable MCP dev-mode gateway autostart
`);
}

function getGatewayBaseUrl() {
  const raw = process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
}

function getGatewayApiUrl() {
  return `${getGatewayBaseUrl()}/api`;
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `HTTP ${response.status}` };
  }

  return { response, payload };
}

async function printHealth({ json = false } = {}) {
  const { response, payload } = await fetchJson(`${getGatewayBaseUrl()}/health`);
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (response.ok) {
    const state = payload.extensionConnected ? 'extension connected' : 'extension not connected';
    console.log(`Gateway OK at ${payload.apiUrl || getGatewayApiUrl()} (${state})`);
  } else {
    console.error(`Gateway health failed: ${payload.error || response.status}`);
  }

  if (!response.ok || payload.error) process.exit(1);
}

async function callGateway(method, rawParams) {
  const params = parseJsonParams(rawParams);
  const { response, payload } = await fetchJson(getGatewayApiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });

  console.log(JSON.stringify(payload, null, 2));
  if (!response.ok || payload.error) process.exit(1);
}

async function runGateway(args) {
  const [subcommand = 'start', maybeJson] = args;
  if (subcommand === 'start') {
    await import('../server/gateway_server.js');
    return;
  }

  if (subcommand === 'health') {
    await printHealth({ json: maybeJson === '--json' });
    return;
  }

  console.error(`Unknown gateway command: ${subcommand}`);
  process.exit(1);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  if (command === '--version' || command === '-v') {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (command === 'mcp') {
    await import('../server/mcp_server.mjs');
    return;
  }

  if (command === 'gateway') {
    await runGateway(args);
    return;
  }

  if (command === 'health') {
    await printHealth({ json: args.includes('--json') });
    return;
  }

  if (command === 'call') {
    const [method, rawParams] = args;
    if (!method) {
      console.error('Usage: webmcp call <method> [jsonParams]');
      process.exit(1);
    }
    await callGateway(method, rawParams);
    return;
  }

  if (command === 'extension-path') {
    console.log(resolve(ROOT, 'webmcp-extension', 'dist'));
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message || String(err) }, null, 2));
  process.exit(1);
});
