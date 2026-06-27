#!/usr/bin/env node
/**
 * Installer cho WebMCP Browser automation kit.
 *
 * Mỗi "target" là một AI runtime phổ biến. Cài đặt là GLOBAL (theo provider,
 * không phải vào dự án này), gồm 2 phần:
 *   1) Skill  — copy thư mục skill từ skills/<name> vào skill-dir global của
 *               runtime (~/.claude/skills, ~/.codex/skills) nếu runtime hỗ trợ.
 *   2) MCP    — đăng ký server/mcp_server.mjs vào config global của runtime.
 *
 * Triết lý an toàn: chỉ TỰ GHI vào những chỗ chắc chắn không phá hỏng cấu hình
 * có sẵn (copy skill vào skill-dir global, gọi `claude mcp add -s user`,
 * append section MCP vào ~/.codex/config.toml nếu chưa có, ghi ~/.cursor/mcp.json
 * nếu chưa tồn tại). Với config dùng chung mà script chưa biết merge an toàn
 * (VS Code user settings), script chỉ IN ra đoạn cần dán — tránh ghi đè nhầm.
 *
 * Usage:
 *   node scripts/install-agent.mjs <claude|codex|copilot|antigravity|cursor|all>
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = join(ROOT, 'server', 'mcp_server.mjs');
const SKILL_NAME = 'webmcp-browser-automation';
const SKILL_SRC = join(ROOT, 'skills', SKILL_NAME);
const SERVER_NAME = 'webmcp-browser';

const log = (...a) => console.log(...a);
const ok = (m) => log(`  ✓ ${m}`);
const note = (m) => log(`  → ${m}`);
const head = (m) => log(`\n=== ${m} ===`);

function copySkill(dest) {
  if (!existsSync(SKILL_SRC)) {
    note(`Bỏ qua skill: không tìm thấy ${SKILL_SRC}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(SKILL_SRC, dest, { recursive: true });
  ok(`Skill copied -> ${dest}`);
}

function printMcpJson(label, file) {
  note(`Thêm vào ${label}: ${file}`);
  log(JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: { command: 'node', args: [MCP_SERVER] },
    },
  }, null, 2));
}

// Ghi permission "mcp__webmcp-browser__*" vào ~/.claude/settings.json (global).
// Merge an toàn: đọc JSON hiện có, thêm vào mảng allow nếu chưa có, ghi lại.
function addClaudeGlobalPermission() {
  const settingsFile = join(homedir(), '.claude', 'settings.json');
  const PERM = 'mcp__webmcp-browser__*';
  let settings = {};
  if (existsSync(settingsFile)) {
    try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch {}
  }
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  if (!settings.permissions.allow.includes(PERM)) {
    settings.permissions.allow.push(PERM);
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    ok(`Permission "${PERM}" thêm vào ${settingsFile}`);
  } else {
    ok(`Permission "${PERM}" đã có trong ${settingsFile}`);
  }
}

function writeIfAbsent(file, content) {
  if (existsSync(file)) {
    note(`${file} đã tồn tại — không ghi đè. Hãy tự gộp đoạn dưới:`);
    log(content);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  ok(`Wrote ${file}`);
}

function addCodexMcpConfig() {
  const configFile = join(homedir(), '.codex', 'config.toml');
  const section = `[mcp_servers.${SERVER_NAME}]`;
  const block = [
    ``,
    section,
    `command = "node"`,
    `args = ["${MCP_SERVER}"]`,
    ``,
  ].join('\n');

  let config = '';
  if (existsSync(configFile)) {
    config = readFileSync(configFile, 'utf8');
  }

  if (config.includes(section)) {
    ok(`MCP "${SERVER_NAME}" đã có trong ${configFile}`);
    return;
  }

  mkdirSync(dirname(configFile), { recursive: true });
  const prefix = config && !config.endsWith('\n') ? '\n' : '';
  writeFileSync(configFile, config + prefix + block);
  ok(`MCP "${SERVER_NAME}" thêm vào ${configFile}`);
}

const TARGETS = {
  // Claude Code: global skill ở ~/.claude/skills — có tác dụng với mọi project.
  claude() {
    head('Claude Code');
    copySkill(join(homedir(), '.claude', 'skills', SKILL_NAME));
    try {
      const out = execSync(
        `claude mcp add ${SERVER_NAME} -s user -- node ${JSON.stringify(MCP_SERVER)}`,
        { encoding: 'utf8', stdio: 'pipe' },
      );
      ok(`Đăng ký MCP "${SERVER_NAME}" (user scope)`);
    } catch (e) {
      const combined = (e.stdout || '') + (e.stderr || '');
      if (combined.includes('already exists')) {
        ok(`MCP "${SERVER_NAME}" đã đăng ký (user scope)`);
      } else if (combined.includes('command not found') || !combined) {
        note('Không tìm thấy `claude` CLI. Chạy thủ công:');
        log(`  claude mcp add ${SERVER_NAME} -s user -- node ${MCP_SERVER}`);
      } else {
        note(`claude mcp add: ${combined.trim()}`);
      }
    }
    addClaudeGlobalPermission();
  },

  // Codex: skill global ở ~/.codex/skills, MCP global ở ~/.codex/config.toml.
  codex() {
    head('Codex');
    copySkill(join(homedir(), '.codex', 'skills', SKILL_NAME));
    addCodexMcpConfig();
  },

  // GitHub Copilot (VS Code agent mode): MCP global trong VS Code user settings.
  // Đường dẫn user khác nhau theo OS nên chỉ in JSON để bạn dán an toàn.
  copilot() {
    head('GitHub Copilot (VS Code)');
    note('Copilot không có file-skill; hướng dẫn dùng nằm trong SKILL.md.');
    note('Dán vào VS Code user config global (Command Palette → "MCP: Open User Configuration"):');
    log(JSON.stringify({
      servers: { [SERVER_NAME]: { type: 'stdio', command: 'node', args: [MCP_SERVER] } },
    }, null, 2));
  },

  // Antigravity: MCP khai báo dạng mcpServers (kiểm tra lại đường dẫn settings của bản bạn dùng).
  antigravity() {
    head('Antigravity');
    note('Antigravity không có file-skill; dùng SKILL.md làm hướng dẫn.');
    printMcpJson('MCP settings của Antigravity (Settings → MCP → Edit config)', '(client config)');
  },

  // Cursor: MCP global ở ~/.cursor/mcp.json (áp dụng cho mọi project).
  cursor() {
    head('Cursor');
    note('Cursor dùng "rules" thay cho skill; có thể dán nội dung SKILL.md vào ~/.cursor/rules.');
    const content = JSON.stringify({
      mcpServers: { [SERVER_NAME]: { command: 'node', args: [MCP_SERVER] } },
    }, null, 2);
    writeIfAbsent(join(homedir(), '.cursor', 'mcp.json'), content + '\n');
  },
};

function reminder() {
  log(`\n${'-'.repeat(64)}`);
  log('QUAN TRỌNG — bước thủ công duy nhất là load extension vào Chrome:');
  log('  1) Mở Chrome đã load extension (webmcp-extension/dist) -> tự connect');
  log('  2) Mở AI client -> nó tự spawn MCP server, MCP tự khởi động gateway');
  log('  (Gọi script/curl trực tiếp thì cần `npm run gateway` thủ công.)');
  log(`${'-'.repeat(64)}`);
}

const arg = (process.argv[2] || '').toLowerCase();
if (arg === 'all' || arg === '') {
  if (arg === '') note('Không truyền target -> in cấu hình cho tất cả runtime.\n');
  for (const fn of Object.values(TARGETS)) fn();
} else if (TARGETS[arg]) {
  TARGETS[arg]();
} else {
  console.error(`Target không hợp lệ: "${arg}". Chọn: ${Object.keys(TARGETS).join(', ')}, all`);
  process.exit(1);
}
reminder();
