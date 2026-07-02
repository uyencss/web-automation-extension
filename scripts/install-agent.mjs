#!/usr/bin/env node
/**
 * Installer for the WebMCP Browser automation kit.
 *
 * Each "target" is a common AI runtime. Installation is GLOBAL (per provider,
 * not into this project) and has two parts:
 *   1) Skill  — copy the skill directory from skills/<name> into the runtime's
 *               global skill directory (~/.claude/skills, ~/.codex/skills) when supported.
 *   2) MCP    — register the MCP server in the runtime's global config.
 *
 * Safety philosophy: only WRITE automatically where we are sure it will not break
 * existing config (copy the skill into the global skill directory, call
 * `claude mcp add -s user`, append the MCP section to ~/.codex/config.toml when absent,
 * write ~/.cursor/mcp.json only if it does not already exist). For shared config that
 * the script cannot safely merge yet (VS Code user settings), it only PRINTS the snippet
 * to paste, avoiding accidental overwrites.
 *
 * Usage:
 *   node scripts/install-agent.mjs <claude|codex|copilot|antigravity|cursor|all>
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = join(ROOT, 'server', 'mcp_server.mjs');
const SKILL_NAMES = ['webmcp-browser-automation', 'webmcp-chrome-launcher'];
const SERVER_NAME = 'webmcp';
const PACKAGE_NAME = process.env.WEBMCP_NPM_PACKAGE || '@gyga-browser/webmcp-browser-automation-kit';
const INSTALL_MODE = (process.env.WEBMCP_INSTALL_MODE || 'npx').toLowerCase();

const log = (...a) => console.log(...a);
const ok = (m) => log(`  ✓ ${m}`);
const note = (m) => log(`  → ${m}`);
const head = (m) => log(`\n=== ${m} ===`);

function copySkill(skillName, dest) {
  const skillSrc = join(ROOT, 'skills', skillName);
  if (!existsSync(skillSrc)) {
    note(`Skipping skill: ${skillSrc} not found`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(skillSrc, dest, { recursive: true });
  ok(`Skill copied -> ${dest}`);
}

function copySkills(destRoot) {
  for (const skillName of SKILL_NAMES) {
    copySkill(skillName, join(destRoot, skillName));
  }
}

function getMcpCommandConfig() {
  if (INSTALL_MODE === 'npx') {
    return { command: 'npx', args: ['-y', PACKAGE_NAME, 'mcp'] };
  }

  if (INSTALL_MODE !== 'local') {
    throw new Error(`Invalid WEBMCP_INSTALL_MODE: "${INSTALL_MODE}". Choose "local" or "npx".`);
  }

  return { command: 'node', args: [MCP_SERVER] };
}

function mcpServerConfig() {
  const { command, args } = getMcpCommandConfig();
  return { command, args };
}

function printMcpJson(label, file) {
  const config = mcpServerConfig();
  note(`Add to ${label}: ${file}`);
  log(JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: config,
    },
  }, null, 2));
}

// Write permission "mcp__webmcp__*" to ~/.claude/settings.json (global).
// Safe merge: read the existing JSON, add to the allow array if missing, then write it back.
function addClaudeGlobalPermission() {
  const settingsFile = join(homedir(), '.claude', 'settings.json');
  const PERM = 'mcp__webmcp__*';
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
    ok(`Permission "${PERM}" added to ${settingsFile}`);
  } else {
    ok(`Permission "${PERM}" already exists in ${settingsFile}`);
  }
}

function writeIfAbsent(file, content) {
  if (existsSync(file)) {
    note(`${file} already exists; not overwriting. Merge the snippet below manually:`);
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
  const { command, args } = getMcpCommandConfig();
  const block = [
    ``,
    section,
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`,
    ``,
  ].join('\n');

  let config = '';
  if (existsSync(configFile)) {
    config = readFileSync(configFile, 'utf8');
  }

  if (config.includes(section)) {
    ok(`MCP "${SERVER_NAME}" already exists in ${configFile}`);
    note(`To switch to install mode "${INSTALL_MODE}", replace the existing section with:`);
    log(block.trim());
    return;
  }

  mkdirSync(dirname(configFile), { recursive: true });
  const prefix = config && !config.endsWith('\n') ? '\n' : '';
  writeFileSync(configFile, config + prefix + block);
  ok(`MCP "${SERVER_NAME}" added to ${configFile}`);
}

const TARGETS = {
  // Claude Code: global skill in ~/.claude/skills, available to every project.
  claude() {
    head('Claude Code');
    copySkills(join(homedir(), '.claude', 'skills'));
    try {
      const { command, args } = getMcpCommandConfig();
      execFileSync(
        'claude',
        ['mcp', 'add', SERVER_NAME, '-s', 'user', '--', command, ...args],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      ok(`Registered MCP "${SERVER_NAME}" (user scope)`);
    } catch (e) {
      const combined = `${e.stdout || ''}${e.stderr || ''}`;
      if (combined.includes('already exists')) {
        ok(`MCP "${SERVER_NAME}" is already registered (user scope)`);
      } else if (combined.includes('command not found') || !combined) {
        note('`claude` CLI not found. Run manually:');
        const { command, args } = getMcpCommandConfig();
        log(`  claude mcp add ${SERVER_NAME} -s user -- ${[command, ...args].join(' ')}`);
      } else {
        note(`claude mcp add: ${combined.trim()}`);
      }
    }
    addClaudeGlobalPermission();
  },

  // Codex: global skill in ~/.codex/skills, global MCP in ~/.codex/config.toml.
  codex() {
    head('Codex');
    copySkills(join(homedir(), '.codex', 'skills'));
    addCodexMcpConfig();
  },

  // GitHub Copilot (VS Code agent mode): global MCP in VS Code user settings.
  // User paths differ by OS, so only print JSON for safe manual pasting.
  copilot() {
    head('GitHub Copilot (VS Code)');
    note('Copilot does not support file-based skills; usage guidance is in SKILL.md.');
    note('Paste into the global VS Code user config (Command Palette -> "MCP: Open User Configuration"):');
    const config = mcpServerConfig();
    log(JSON.stringify({
      servers: { [SERVER_NAME]: { type: 'stdio', ...config } },
    }, null, 2));
  },

  // Gemini CLI: MCP configuration in ~/.gemini/config/mcp_config.json and global skills under ~/.gemini/config/skills/.
  gemini() {
    head('Gemini CLI');
    copySkills(join(homedir(), '.gemini', 'config', 'skills'));

    const configFile = join(homedir(), '.gemini', 'config', 'mcp_config.json');
    const { command, args } = getMcpCommandConfig();
    let config = {};
    if (existsSync(configFile)) {
      try {
        config = JSON.parse(readFileSync(configFile, 'utf8'));
      } catch (e) {
        note(`Could not parse ${configFile}; it will be overwritten.`);
      }
    }
    config.mcpServers ??= {};
    config.mcpServers[SERVER_NAME] = { command, args };

    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    ok(`MCP "${SERVER_NAME}" updated in ${configFile}`);
  },

  // Antigravity: MCP configuration in ~/.gemini/config/mcp_config.json and global skills under ~/.gemini/config/skills/.
  antigravity() {
    head('Antigravity');
    copySkills(join(homedir(), '.gemini', 'config', 'skills'));

    const configFile = join(homedir(), '.gemini', 'antigravity-ide', 'mcp_config.json');
    const { command, args } = getMcpCommandConfig();
    let config = {};
    if (existsSync(configFile)) {
      try {
        config = JSON.parse(readFileSync(configFile, 'utf8'));
      } catch (e) {
        note(`Could not parse ${configFile}; it will be overwritten.`);
      }
    }
    config.mcpServers ??= {};
    config.mcpServers[SERVER_NAME] = { command, args };

    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    ok(`MCP "${SERVER_NAME}" updated in ${configFile}`);
  },

  // Cursor: global MCP in ~/.cursor/mcp.json, available to every project.
  cursor() {
    head('Cursor');
    note('Cursor uses "rules" instead of skills; you can paste SKILL.md content into ~/.cursor/rules.');
    const config = mcpServerConfig();
    const content = JSON.stringify({
      mcpServers: { [SERVER_NAME]: config },
    }, null, 2);
    writeIfAbsent(join(homedir(), '.cursor', 'mcp.json'), content + '\n');
  },
};

function reminder() {
  log(`\n${'-'.repeat(64)}`);
  log(`MCP install mode: ${INSTALL_MODE}${INSTALL_MODE === 'npx' ? ` (${PACKAGE_NAME})` : ` (${MCP_SERVER})`}`);
  log('Browser bootstrap:');
  log('  1) Preferred: `webmcp launch --name agent-session --gateway --json`');
  log('  2) Manual fallback: `webmcp gateway start`, then load webmcp-extension/dist in Chrome');
  log('  3) Open the AI client -> it spawns the MCP server, which connects to the running gateway');
  log('  The released package is used by default. To point at a local checkout: WEBMCP_INSTALL_MODE=local npm run install:<target>');
  log(`${'-'.repeat(64)}`);
}

const arg = (process.argv[2] || '').toLowerCase();
if (arg === 'all' || arg === '') {
  if (arg === '') note('No target provided -> printing config for all runtimes.\n');
  for (const fn of Object.values(TARGETS)) fn();
} else if (TARGETS[arg]) {
  TARGETS[arg]();
} else {
  console.error(`Invalid target: "${arg}". Choose: ${Object.keys(TARGETS).join(', ')}, all`);
  process.exit(1);
}
reminder();
