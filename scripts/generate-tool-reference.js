#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const process = require('process');

const ROOT = path.resolve(__dirname, '..');
const REGISTER_TOOLS_PATH = path.join(
  ROOT,
  'webmcp-extension/dist/content-scripts/register-tools.js'
);
const HANDLERS_DIR = path.join(ROOT, 'webmcp-extension/dist/bg/handlers');
const WS_CLIENT_PATH = path.join(ROOT, 'webmcp-extension/dist/bg/ws-client.js');
const OUTPUT_PATH = path.join(
  ROOT,
  'skills/webmcp-browser-automation/references/generated-tools.md'
);

const COMMAND_PARAM_HINTS = {
  ping: '{}',
  getExtensionInfo: '{}',
  getActiveTab: '{}',
  listTabs: '{}',
  newTab: '{ url? }',
  navigate: '{ url, tabId? }',
  closeTab: '{ tabId? }',
  listFrames: '{ flat?, force?, tabId? }',
  waitForSelector: '{ selector, timeout?, frame?, tabId? }',
  getPageContent: '{ format?, maxLength?, offset?, frame?, tabId? }',
  click: '{ selector, frame?, tabId? }',
  type: '{ selector, text, frame?, tabId? }',
  querySelectorAll: '{ selector, limit?, offset?, fields?, textMaxLength?, pierceShadow?, frame?, tabId? }',
  getWindowVariable: '{ path, maxLength?, offset?, frame?, tabId? }',
  findByText: '{ text, exact?, selector?, maxResults?, pierceShadow?, frame?, tabId? }',
  pageFetch: '{ url, method?, headers?, body?, responseType?, credentials?, maxLength?, offset?, frame?, tabId? }',
  evaluateJS: '{ code, frame?, tabId? }',
  executeCDP: '{ method, params?, tabId? }',
  screenshot: '{ fullPage?, tabId? }',
  'webmcp.listTools': '{ frame?, tabId? }',
  'webmcp.invokeTool': '{ toolName, input?, frame?, tabId? }',
  getAccessibilityTree: '{ interestingOnly?, depth?, tabId? }',
  getDOMSnapshot: '{ computedStyles?, tabId? }',
  getElementBounds: '{ selector, pierceShadow?, frame?, tabId? }',
  getInteractiveElements: '{ pierceShadow?, frame?, tabId? }',
  dispatchClick: '{ x, y, button?, clickCount?, frame?, tabId? }',
  moveMouse: '{ x, y, steps?, fromX?, fromY?, frame?, tabId? }',
  pressKey: '{ key, text?, modifiers?, tabId? }',
  typeText: '{ text, tabId? }',
  scroll: '{ deltaX?, deltaY?, x?, y?, tabId? }',
  hover: '{ selector, frame?, tabId? }',
  selectOption: '{ selector, value?, index?, text?, frame?, tabId? }',
  getCookies: '{ tabId? }',
  setCookie: '{ name, value, domain?, path?, tabId? }',
  deleteCookies: '{ name, domain?, url?, tabId? }',
  getLocalStorage: '{ tabId? }',
  setLocalStorage: '{ key, value, tabId? }',
  listWindows: '{}',
  createWindow: '{ url?, width?, height?, type? }',
  setViewport: '{ width, height, deviceScaleFactor?, mobile?, tabId? }',
  resetViewport: '{ tabId? }',
};

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_$.-]/.test(char);
}

function skipQuoted(text, index) {
  const quote = text[index];
  index += 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  return index;
}

function skipLineComment(text, index) {
  const next = text.indexOf('\n', index + 2);
  return next === -1 ? text.length : next + 1;
}

function skipBlockComment(text, index) {
  const next = text.indexOf('*/', index + 2);
  return next === -1 ? text.length : next + 2;
}

function skipIgnorable(text, index) {
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      index = skipLineComment(text, index);
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipBlockComment(text, index);
      continue;
    }
    break;
  }
  return index;
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' || char === "'" || char === '`') {
      index = skipQuoted(text, index) - 1;
      continue;
    }
    if (char === '/' && next === '/') {
      index = skipLineComment(text, index) - 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipBlockComment(text, index) - 1;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`No matching brace found at index ${openIndex}`);
}

function findObjectBlocks(source, marker) {
  const blocks = [];
  let index = 0;
  while (index < source.length) {
    const markerIndex = source.indexOf(marker, index);
    if (markerIndex === -1) break;
    const openIndex = source.indexOf('{', markerIndex + marker.length);
    if (openIndex === -1) break;
    const closeIndex = findMatchingBrace(source, openIndex);
    blocks.push(source.slice(openIndex, closeIndex + 1));
    index = closeIndex + 1;
  }
  return blocks;
}

function extractStringProperty(block, propertyName) {
  const pattern = new RegExp(`${propertyName}:\\s*(['"\`])([\\s\\S]*?)\\1`);
  const match = block.match(pattern);
  return match ? unescapeJsString(match[2]).trim() : '';
}

function unescapeJsString(value) {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function extractDescription(block) {
  const match = block.match(/description:\s*([\s\S]*?),\s*inputSchema:/);
  if (!match) return '';
  const expression = match[1];
  const parts = [];
  const stringPattern = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let stringMatch;
  while ((stringMatch = stringPattern.exec(expression))) {
    parts.push(unescapeJsString(stringMatch[2]));
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function findNamedObjectBlock(source, propertyName) {
  const markerIndex = source.indexOf(`${propertyName}:`);
  if (markerIndex === -1) return '';
  const openIndex = source.indexOf('{', markerIndex);
  if (openIndex === -1) return '';
  const closeIndex = findMatchingBrace(source, openIndex);
  return source.slice(openIndex, closeIndex + 1);
}

function extractTopLevelKeys(objectBlock) {
  const keys = [];
  let depth = 0;
  for (let index = 0; index < objectBlock.length; index += 1) {
    const char = objectBlock[index];
    const next = objectBlock[index + 1];

    if (char === '"' || char === "'" || char === '`') {
      if (depth === 1) {
        const start = index + 1;
        const end = skipQuoted(objectBlock, index) - 1;
        const key = objectBlock.slice(start, end);
        const after = skipIgnorable(objectBlock, end + 1);
        if (objectBlock[after] === ':') keys.push(key);
        index = end;
        continue;
      }
      index = skipQuoted(objectBlock, index) - 1;
      continue;
    }
    if (char === '/' && next === '/') {
      index = skipLineComment(objectBlock, index) - 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipBlockComment(objectBlock, index) - 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      continue;
    }
    if (depth === 1 && isIdentifierStart(char)) {
      const start = index;
      while (index + 1 < objectBlock.length && isIdentifierPart(objectBlock[index + 1])) {
        index += 1;
      }
      const key = objectBlock.slice(start, index + 1);
      const after = skipIgnorable(objectBlock, index + 1);
      if (objectBlock[after] === ':') keys.push(key);
    }
  }
  return keys;
}

function extractRequired(schemaBlock) {
  const match = schemaBlock.match(/required:\s*\[([\s\S]*?)\]/);
  if (!match) return [];
  const required = [];
  const stringPattern = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let stringMatch;
  while ((stringMatch = stringPattern.exec(match[1]))) {
    required.push(unescapeJsString(stringMatch[2]));
  }
  return required;
}

function extractPageTools() {
  const source = read(REGISTER_TOOLS_PATH);
  return findObjectBlocks(source, 'navigator.modelContext.registerTool(').map((block) => {
    const schemaBlock = findNamedObjectBlock(block, 'inputSchema');
    const propertiesBlock = findNamedObjectBlock(schemaBlock, 'properties');
    return {
      name: extractStringProperty(block, 'name'),
      title: extractStringProperty(block, 'title'),
      description: extractDescription(block),
      inputs: propertiesBlock ? extractTopLevelKeys(propertiesBlock) : [],
      required: extractRequired(schemaBlock),
    };
  });
}

function extractHandlerMethodsFromBlock(block) {
  const methods = [];
  let depth = 0;
  for (let index = 0; index < block.length; index += 1) {
    const char = block[index];
    const next = block[index + 1];

    if (char === '"' || char === "'" || char === '`') {
      if (depth === 1) {
        const end = skipQuoted(block, index);
        const key = block.slice(index + 1, end - 1);
        const afterKey = skipIgnorable(block, end);
        if (block[afterKey] === '(') methods.push(key);
        index = end - 1;
        continue;
      }
      index = skipQuoted(block, index) - 1;
      continue;
    }
    if (char === '/' && next === '/') {
      index = skipLineComment(block, index) - 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipBlockComment(block, index) - 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      continue;
    }

    if (depth === 1 && block.startsWith('async', index)) {
      let cursor = skipIgnorable(block, index + 'async'.length);
      let method = '';
      if (block[cursor] === '"' || block[cursor] === "'" || block[cursor] === '`') {
        const end = skipQuoted(block, cursor);
        method = block.slice(cursor + 1, end - 1);
        cursor = end;
      } else if (isIdentifierStart(block[cursor])) {
        const start = cursor;
        while (cursor + 1 < block.length && isIdentifierPart(block[cursor + 1])) {
          cursor += 1;
        }
        method = block.slice(start, cursor + 1);
        cursor += 1;
      }
      cursor = skipIgnorable(block, cursor);
      if (method && block[cursor] === '(') {
        methods.push(method);
        index = cursor;
        continue;
      }
    }
  }
  return methods;
}

function extractExtensionCommands() {
  const entries = [];
  for (const fileName of fs.readdirSync(HANDLERS_DIR).sort()) {
    if (!fileName.endsWith('.js') || fileName === 'index.js' || fileName === 'network-intercept.js') {
      continue;
    }
    const filePath = path.join(HANDLERS_DIR, fileName);
    const source = read(filePath);
    const blocks = findObjectBlocks(source, 'Handlers =');
    for (const block of blocks) {
      for (const method of extractHandlerMethodsFromBlock(block)) {
        if (entries.some((entry) => entry.method === method)) continue;
        entries.push({ method, fileName });
      }
    }
  }
  return entries.sort((a, b) => a.method.localeCompare(b.method));
}

function extractAnnouncedCapabilities() {
  const source = read(WS_CLIENT_PATH);
  const markerIndex = source.indexOf('capabilities:');
  if (markerIndex === -1) return [];
  const openIndex = source.indexOf('[', markerIndex);
  const closeIndex = source.indexOf(']', openIndex);
  if (openIndex === -1 || closeIndex === -1) return [];

  const body = source.slice(openIndex + 1, closeIndex);
  const capabilities = [];
  const stringPattern = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match;
  while ((match = stringPattern.exec(body))) {
    capabilities.push(unescapeJsString(match[2]));
  }
  return capabilities;
}

function markdownEscape(value) {
  return String(value || '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .trim();
}

function formatList(values) {
  return values.length ? values.map((value) => `\`${value}\``).join(', ') : '-';
}

function generateMarkdown() {
  const commands = extractExtensionCommands();
  const pageTools = extractPageTools();
  const announcedCapabilities = extractAnnouncedCapabilities();
  const commandNames = new Set(commands.map((entry) => entry.method));
  const announced = new Set(announcedCapabilities);
  const announcedMissingHandlers = announcedCapabilities.filter((name) => !commandNames.has(name));
  const handlersNotAnnounced = commands
    .map((entry) => entry.method)
    .filter((name) => !announced.has(name));

  const lines = [];
  lines.push('# Generated WebMCP Tool Reference');
  lines.push('');
  lines.push('> Generated by `npm run tools:generate`. Do not edit by hand.');
  lines.push('>');
  lines.push('> Sources: `webmcp-extension/dist/content-scripts/register-tools.js`, `webmcp-extension/dist/bg/handlers/*.js`, and `webmcp-extension/dist/bg/ws-client.js`.');
  lines.push('');
  lines.push(`## Extension Commands (${commands.length})`);
  lines.push('');
  lines.push('Call these as gateway/direct extension methods: `{ "method": "<command>", "params": { ... } }`.');
  lines.push('');
  lines.push('| Command | Params | Handler |');
  lines.push('|---|---|---|');
  for (const { method, fileName } of commands) {
    lines.push(`| \`${method}\` | \`${COMMAND_PARAM_HINTS[method] || '{ ... }'}\` | \`${fileName}\` |`);
  }
  lines.push('');
  lines.push('## Page-Registered WebMCP Tools (' + pageTools.length + ')');
  lines.push('');
  lines.push('Call these only through `webmcp.invokeTool` after `webmcp.listTools` has confirmed they exist on the target tab.');
  lines.push('');
  lines.push('| Tool | Required | Inputs | Description |');
  lines.push('|---|---|---|---|');
  for (const tool of pageTools) {
    lines.push(
      `| \`${tool.name}\` | ${formatList(tool.required)} | ${formatList(tool.inputs)} | ${markdownEscape(tool.description)} |`
    );
  }
  lines.push('');
  lines.push('## Capability Announcement Check');
  lines.push('');
  lines.push(`- Announced capabilities: ${announcedCapabilities.length}`);
  lines.push(`- Commands with handlers: ${commands.length}`);
  lines.push(
    `- Announced without handler: ${announcedMissingHandlers.length ? formatList(announcedMissingHandlers) : 'none'}`
  );
  lines.push(
    `- Handler not announced: ${handlersNotAnnounced.length ? formatList(handlersNotAnnounced) : 'none'}`
  );
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- `webmcp.listTools` returns descriptors for page tools registered on the current page.');
  lines.push('- `webmcp.invokeTool` takes a page tool name in `params.toolName`; page tool names are not top-level extension commands.');
  lines.push('- Network capture tools are page-registered tools. They internally use the content-script bridge to reach the background service worker.');
  lines.push('');

  return {
    markdown: `${lines.join('\n')}`,
    announcedMissingHandlers,
  };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const { markdown, announcedMissingHandlers } = generateMarkdown();

  if (announcedMissingHandlers.length) {
    console.error(
      `Capabilities missing handlers: ${announcedMissingHandlers.join(', ')}`
    );
    process.exit(1);
  }

  if (checkOnly) {
    const existing = fs.existsSync(OUTPUT_PATH) ? read(OUTPUT_PATH) : '';
    if (existing !== markdown) {
      console.error(`Generated reference is stale: ${path.relative(ROOT, OUTPUT_PATH)}`);
      console.error('Run `npm run tools:generate`.');
      process.exit(1);
    }
    console.log(`Generated reference is up to date: ${path.relative(ROOT, OUTPUT_PATH)}`);
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, markdown);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
}

main();
