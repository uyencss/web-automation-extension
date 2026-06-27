#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { buildMcpTools } from './mcp-tool-catalog.mjs';

const DEFAULT_GATEWAY_URL = 'http://localhost:7865';
const gatewayUrl = normalizeGatewayUrl(process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL);
const tools = buildMcpTools();
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

function normalizeGatewayUrl(rawUrl) {
  const trimmed = rawUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
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

async function callGateway(method, params) {
  const response = await fetch(`${gatewayUrl}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: params || {} }),
  });

  const payload = await readGatewayJson(response);
  if (!response.ok || payload.error) {
    const detail = payload.error || `Gateway HTTP ${response.status}`;
    throw new Error(`${detail}. Make sure npm run gateway is running and the Chrome extension is connected.`);
  }

  return payload.result;
}

function contentFromResult(result) {
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
    name: 'webmcp-browser',
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
  const method = tool.method || args.method;
  const params = tool.method ? args : (args.params || {});

  if (!method || typeof method !== 'string') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Missing raw gateway command method.' }],
    };
  }

  try {
    const result = await callGateway(method, params);
    return { content: contentFromResult(result) };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp] webmcp-browser ready, gateway=${gatewayUrl}`);
