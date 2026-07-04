#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { buildMcpTools } from './mcp-tool-catalog.mjs';

const DEFAULT_GATEWAY_URL = 'http://localhost:7865';
const gatewayUrl = normalizeGatewayUrl(process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL);
const profileId = process.env.WEBMCP_PROFILE_ID || undefined;
const serverDir = dirname(fileURLToPath(import.meta.url));
// Best-practice MCP installs keep the gateway lifecycle explicit. Enable
// dev-mode autostart with WEBMCP_GATEWAY_AUTOSTART=1 when desired.
const autoStartGateway = process.env.WEBMCP_GATEWAY_AUTOSTART === '1' &&
  process.env.WEBMCP_NO_AUTOSTART !== '1';
const tools = buildMcpTools();
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

function normalizeGatewayUrl(rawUrl) {
  const trimmed = rawUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
}

function isLocalGateway(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

async function fetchHealth(timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${gatewayUrl}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Make sure the gateway process is up. Idempotent: if it is already listening
// (started by hand or by another MCP instance) we reuse it; otherwise we spawn
// it detached so it outlives this stdio MCP server across restarts.
async function ensureGateway() {
  let health = await fetchHealth();
  if (health) return health;

  if (!autoStartGateway || !isLocalGateway(gatewayUrl)) {
    console.error(`[mcp] gateway not reachable at ${gatewayUrl}. Start it with "webmcp gateway start" or set WEBMCP_GATEWAY_AUTOSTART=1 for dev-mode autostart.`);
    return null;
  }

  const port = new URL(gatewayUrl).port || '7865';
  console.error(`[mcp] gateway not running, starting it on port ${port}...`);

  const child = spawn(process.execPath, [join(serverDir, 'gateway_server.js')], {
    cwd: serverDir,
    env: { ...process.env, WEBMCP_GATEWAY_PORT: port },
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (err) => console.error(`[mcp] failed to spawn gateway: ${err.message}`));
  child.unref();

  // Poll /health until ready. A rival process may have won the port (EADDRINUSE);
  // that is fine as long as *some* gateway answers.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    health = await fetchHealth();
    if (health) return health;
  }

  console.error('[mcp] gateway did not become ready within 10s.');
  return null;
}

function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

async function readGatewayJson(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function callGateway(method, params, requestProfileId) {
  const body = { method, params: params || {} };
  const targetProfileId = requestProfileId || profileId;
  if (targetProfileId) body.profileId = targetProfileId;
  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.WEBMCP_GATEWAY_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${gatewayUrl}/api`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const payload = await readGatewayJson(response);
  if (!response.ok || payload.error) {
    const detail = payload.error || `Gateway HTTP ${response.status}`;
    throw new Error(`${detail}. Make sure webmcp gateway start is running and the Chrome extension is connected.`);
  }

  return payload.result;
}

function contentFromResult(result) {
  // Batch result: flatten per-action outcomes, interleave any screenshots.
  if (
    result && typeof result === 'object' &&
    Array.isArray(result.results) && typeof result.total === 'number'
  ) {
    const content = [{
      type: 'text',
      text: `Batch: ${result.success}/${result.total} ok, ${result.errors} error(s), ${result.executed} executed`,
    }];
    for (const item of result.results) {
      const status = item.ok ? '✓' : `✗ ${item.error}`;
      const body = item.ok && item.result
        ? '\n' + JSON.stringify(item.result, null, 2) : '';
      content.push({
        type: 'text',
        text: `[${item.index}] ${item.method} ${status} (${item.duration}ms)${body}`,
      });
      if (item.screenshot?.base64) {
        content.push({
          type: 'image',
          data: item.screenshot.base64,
          mimeType: `image/${item.screenshot.format || 'png'}`,
        });
      }
    }
    return content;
  }

  if (result && typeof result === 'object' && typeof result.base64 === 'string') {
    return [
      {
        type: 'image',
        data: result.base64,
        mimeType: `image/${result.format || 'png'}`,
      },
      {
        type: 'text',
        text: JSON.stringify({ ...result, base64: '[base64 image omitted from text]' }, null, 2),
      },
    ];
  }

  return [
    {
      type: 'text',
      text: typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2),
    },
  ];
}

const server = new Server(
  {
    name: 'webmcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(publicTool),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = toolsByName.get(request.params.name);
  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments || {};
  let method = tool.method || args.method;
  const requestProfileId = args.profileId;

  let params;
  if (tool.method) {
    params = { ...args };
    delete params.profileId;
  } else {
    params = args.params || {};
  }

  if (method === 'browser_raw_command') {
    method = args.method;
    params = args.params || {};
  } else if (method === 'set_profile_name') {
    method = 'setProfileName';
  }

  if (method === 'list_profiles') {
    try {
      const health = await fetchHealth();
      if (!health) {
        throw new Error('Gateway is unreachable');
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            profiles: health.profileDetails || [],
            profileCount: health.profileCount || 0,
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }]
      };
    }
  }

  if (!method || typeof method !== 'string') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Missing raw gateway command method.' }],
    };
  }

  try {
    const result = await callGateway(method, params, requestProfileId);
    return { content: contentFromResult(result) };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
    };
  }
});

const health = await ensureGateway();
const transport = new StdioServerTransport();
await server.connect(transport);

if (!health) {
  console.error(`[mcp] webmcp ready, but gateway is NOT reachable at ${gatewayUrl}. Run "webmcp gateway start" or "npm run gateway".`);
} else if (!health.extensionConnected) {
  console.error(`[mcp] webmcp ready, gateway=${gatewayUrl}, but the Chrome extension is not connected. Install WebMCP Tools Provider from https://chromewebstore.google.com/detail/webmcp-tools-provider/lbodkmkjbcemodklopcfdmpjomdoapae, or load/reload the unpacked extension from webmcp-extension/dist for local development.`);
} else {
  console.error(`[mcp] webmcp ready, gateway=${gatewayUrl}, extension connected.`);
}
