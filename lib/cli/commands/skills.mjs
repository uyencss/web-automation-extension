import process from 'node:process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { ROOT, getWebmcpHome, parseFlags } from '../context.mjs';

export function buildSkillsDoctorReport() {
  const inventory = readSkillInventory();
  if (!inventory) {
    return {
      schema: 'webmcp-skills-doctor/1',
      ok: false,
      inventory: null,
      total: 0,
      available: 0,
      missing: [],
      receipt: skillsReceiptPath(),
      receiptPresent: Boolean(readSkillsReceipt()),
      orphanCandidates: [],
      error: 'WebMCP skill inventory not found.',
    };
  }
  const receipt = readSkillsReceipt();
  const kitId = process.env.WEBMCP_KIT_ID || inventory.kitId || 'webmcp-automation-kit';
  const mode = resolveSkillsMode(receiptOwner(receipt, kitId));
  const expected = doctorSkillNames(inventory, receipt, mode);
  const skills = skillReport(inventory);
  const relevantSkills = skills.filter((skill) => expected.has(skill.name));
  const missing = relevantSkills.filter((skill) => !skill.available).map((skill) => skill.name);
  const known = new Set(receiptInstalledEntries(receipt));
  const orphanCandidates = [];
  for (const [provider, root] of Object.entries(providerSkillRoots())) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!known.has(name) && adoptableNames(inventory).has(name)) {
        orphanCandidates.push({ provider, name, path: resolve(root, name) });
      }
    }
  }
  return {
    schema: 'webmcp-skills-doctor/1',
    ok: missing.length === 0,
    inventory: inventory.file,
    total: relevantSkills.length,
    available: relevantSkills.length - missing.length,
    missing,
    receipt: skillsReceiptPath(),
    receiptPresent: Boolean(receipt),
    orphanCandidates,
  };
}


function readSkillInventory() {
  const explicit = process.env.WEBMCP_KIT_MANIFEST;
  const candidates = explicit
    ? [resolve(process.cwd(), explicit)]
    : [
        resolve(ROOT, '..', '..', 'webmcp-kit.json'),
        resolve(getWebmcpHome(), 'webmcp-kit.json'),
        resolve(getWebmcpHome(), 'skills', 'catalog.json'),
      ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const superseded = Array.isArray(data.supersededSkills) ? data.supersededSkills : [];
      if (data.schema === 'webmcp-kit/1' && Array.isArray(data.skills)) {
        return { file, root: dirname(file), kitId: data.kitId ?? 'webmcp-automation-kit', skills: data.skills, superseded };
      }
      if (data.schema === 'webmcp-skill-catalog/1' && Array.isArray(data.skills)) {
        return { file, root: resolve(dirname(file), '..'), skills: data.skills, superseded };
      }
    } catch {
      // Try the next inventory candidate.
    }
  }
  return null;
}

function installedSkillPaths(name) {
  return [
    resolve(homedir(), '.codex', 'skills', name),
    resolve(homedir(), '.claude', 'skills', name),
    resolve(homedir(), '.gemini', 'config', 'skills', name),
  ];
}

function skillPath(inventory, skill) {
  const canonical = resolve(inventory.root, skill.source);
  if (existsSync(canonical)) return canonical;
  return installedSkillPaths(skill.name).find((candidate) => existsSync(candidate)) || null;
}

function skillReport(inventory) {
  return [...inventory.skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => {
      const path = skillPath(inventory, skill);
      return { ...skill, path, available: Boolean(path) };
    });
}

function printSkillsHelp() {
  console.log(`WebMCP Skills

Usage:
  webmcp skills list [--json]
  webmcp skills path <name>
  webmcp skills doctor [--json]
  webmcp skills adopt [--provider <name> | --all] [--dry-run] [--yes]
  webmcp skills prune [--dry-run] [--yes]
  webmcp skills uninstall [--provider <name> | --all] [--dry-run] [--yes]
`);
}

function skillsReceiptPath() {
  return resolve(getWebmcpHome(), 'skills', 'install-receipt.json');
}

function readSkillsReceipt() {
  const file = skillsReceiptPath();
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function providerSkillRoots() {
  return {
    codex: resolve(homedir(), '.codex', 'skills'),
    claude: resolve(homedir(), '.claude', 'skills'),
    gemini: resolve(homedir(), '.gemini', 'config', 'skills'),
  };
}

function receiptTarget(root, name) {
  if (!root || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`Invalid skill receipt target: ${root}/${name}`);
  }
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || rel.includes('/') || rel.includes('\\')) {
    throw new Error(`Skill receipt target escapes provider root: ${target}`);
  }
  return target;
}

// Directories this kit could plausibly have installed: what the registry
// declares now, plus the names it used to declare before a rename. A
// `webmcp-*` prefix is not evidence of ownership — the user may have authored
// one — so it is never used to decide adoptability.
function adoptableNames(inventory) {
  return new Set([
    ...inventory.skills.map((skill) => skill.name),
    ...(inventory.superseded || []),
  ]);
}

// One default for every call site. `doctor` and `prune`/`uninstall` disagreeing
// here means the same receipt gets diagnosed under one mode and pruned under
// another.
function resolveSkillsMode(receipt) {
  return receipt?.skillsMode === 'separate' ? 'separate' : 'umbrella';
}

function receiptOwners(receipt) {
  if (!receipt) return {};
  if (receipt.schema === 'webmcp-install-receipt/2' && receipt.owners && typeof receipt.owners === 'object') {
    return receipt.owners;
  }
  if (receipt.schema === 'webmcp-install-receipt/1' || receipt.providers) {
    return {
      'webmcp-automation-kit': {
        installedAt: receipt.installedAt ?? null,
        skillsMode: receipt.skillsMode ?? 'umbrella',
        providers: receipt.providers ?? {},
      },
    };
  }
  return {};
}

function receiptOwner(receipt, kitId) {
  return receiptOwners(receipt)[kitId] ?? null;
}

function receiptInstalledEntries(receipt) {
  return Object.values(receiptOwners(receipt))
    .flatMap((owner) => Object.values(owner.providers || {}))
    .flatMap((provider) => provider.entries || []);
}

function publicSkillNames(inventory, mode) {
  return inventory.skills
    .filter((skill) => mode === 'separate'
      ? skill.name !== 'webmcp'
      : skill.exposure === 'public' || !skill.exposure)
    .filter((skill) => skill.defaultInstall !== false)
    .map((skill) => skill.name)
    .sort();
}

function doctorSkillNames(inventory, receipt, mode) {
  const expected = new Set(publicSkillNames(inventory, mode));
  const installed = new Set(receiptInstalledEntries(receipt));
  for (const skill of inventory.skills) {
    if (installed.has(skill.name)) expected.add(skill.name);
  }
  return expected;
}

function receiptRemovalPlan(receipt, ownerReceipt, kitId, inventory, providerFilter, mode) {
  const desired = new Set(publicSkillNames(inventory, mode));
  const removals = [];
  const otherOwners = Object.entries(receiptOwners(receipt)).filter(([ownerId]) => ownerId !== kitId);
  for (const [provider, value] of Object.entries(ownerReceipt?.providers || {})) {
    if (providerFilter && providerFilter !== '*' && provider !== providerFilter) continue;
    const keep = providerFilter ? new Set() : desired;
    for (const name of value.entries || []) {
      const shared = otherOwners.some(([, owner]) => {
        const other = owner.providers?.[provider];
        return other && resolve(other.root) === resolve(value.root) && (other.entries || []).includes(name);
      });
      if (!keep.has(name) && !shared) removals.push({ provider, name, path: receiptTarget(value.root, name) });
    }
  }
  return removals;
}

function applyReceiptRemovals(removals, dryRun) {
  for (const item of removals) {
    if (dryRun) console.log(`${item.provider}\t${item.path}`);
    else if (existsSync(item.path)) rmSync(item.path, { recursive: true, force: true });
  }
}

function writeSkillsReceipt(receipt, providers, mode, kitId) {
  const file = skillsReceiptPath();
  mkdirSync(dirname(file), { recursive: true });
  const updatedAt = new Date().toISOString();
  const owners = {
    ...receiptOwners(receipt),
    [kitId]: { installedAt: updatedAt, skillsMode: mode, providers },
  };
  writeFileSync(file, `${JSON.stringify({
    schema: 'webmcp-install-receipt/2', version: 2, updatedAt, owners,
  }, null, 2)}\n`);
}

export function runSkills(args) {
  const first = args[0];
  if (first === '--help' || first === '-h' || first === 'help') {
    printSkillsHelp();
    return 0;
  }
  const subcommand = first && !first.startsWith('--') ? first : 'list';
  const options = subcommand === 'list' && first !== 'list' ? args : args.slice(1);

  const inventory = readSkillInventory();
  if (!inventory) {
    console.error([
      'WebMCP skill inventory not found.',
      'Run from the webmcp-automation-kit checkout, install the full kit, or set WEBMCP_KIT_MANIFEST.',
    ].join('\n'));
    return 1;
  }
  const skills = skillReport(inventory);
  const kitId = process.env.WEBMCP_KIT_ID || inventory.kitId || 'webmcp-automation-kit';

  if (subcommand === 'list') {
    if (options.includes('--json')) {
      console.log(JSON.stringify({
        schema: 'webmcp-skills/1',
        inventory: inventory.file,
        skills,
      }, null, 2));
    } else {
      console.log(`WebMCP Skills (${skills.length})`);
      for (const skill of skills) {
        const state = skill.available ? skill.path : 'not installed';
        console.log(`  ${skill.name.padEnd(28)} ${skill.owner.padEnd(18)} ${state}`);
      }
    }
    return 0;
  }

  if (subcommand === 'path') {
    const name = options[0];
    if (!name) {
      console.error('Usage: webmcp skills path <name>');
      return 1;
    }
    const skill = skills.find((entry) => entry.name === name);
    if (!skill) {
      console.error(`Unknown WebMCP skill: ${name}`);
      return 1;
    }
    if (!skill.path) {
      console.error(`WebMCP skill is registered but not available locally: ${name}`);
      return 1;
    }
    console.log(skill.path);
    return 0;
  }

  if (subcommand === 'doctor') {
    const receipt = readSkillsReceipt();
    const mode = resolveSkillsMode(receiptOwner(receipt, kitId));
    const expected = doctorSkillNames(inventory, receipt, mode);
    const relevantSkills = skills.filter((skill) => expected.has(skill.name));
    const missing = relevantSkills.filter((skill) => !skill.available).map((skill) => skill.name);
    const known = new Set(receiptInstalledEntries(receipt));
    const orphanCandidates = [];
    for (const [provider, root] of Object.entries(providerSkillRoots())) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        if (!known.has(name) && adoptableNames(inventory).has(name)) {
          orphanCandidates.push({ provider, name, path: resolve(root, name) });
        }
      }
    }
    const report = {
      schema: 'webmcp-skills-doctor/1',
      ok: missing.length === 0,
      inventory: inventory.file,
      total: relevantSkills.length,
      available: relevantSkills.length - missing.length,
      missing,
      receipt: skillsReceiptPath(),
      receiptPresent: Boolean(receipt),
      orphanCandidates,
    };
    if (options.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else if (report.ok) console.log(`Skills OK: ${report.available}/${report.total} available`);
    else console.error(`Skills incomplete: ${report.available}/${report.total} available; missing ${missing.join(', ')}`);
    return report.ok ? 0 : 1;
  }

  if (subcommand === 'adopt') {
    const { flags } = parseFlags(options);
    const roots = providerSkillRoots();
    const selected = flags.all ? Object.keys(roots) : [flags.provider].filter(Boolean);
    if (!selected.length || selected.some((provider) => !roots[provider])) {
      console.error('Usage: webmcp skills adopt --provider <codex|claude|gemini> | --all [--dry-run] [--yes]');
      return 1;
    }
    const knownNames = adoptableNames(inventory);
    const currentReceipt = readSkillsReceipt();
    const providers = { ...(receiptOwner(currentReceipt, kitId)?.providers || {}) };
    for (const provider of selected) {
      const root = roots[provider];
      const entries = existsSync(root)
        ? readdirSync(root).filter((name) => knownNames.has(name) && existsSync(receiptTarget(root, name))).sort()
        : [];
      providers[provider] = { root, entries };
      for (const name of entries) console.log(`${provider}\t${receiptTarget(root, name)}`);
    }
    if (!options.includes('--yes') || options.includes('--dry-run')) {
      console.log('Dry run only; pass --yes to adopt these directories into the WebMCP install receipt.');
      return 0;
    }
    const mode = Object.values(providers).some((value) => value.entries.includes('webmcp')) ? 'umbrella' : 'separate';
    writeSkillsReceipt(currentReceipt, providers, mode, kitId);
    console.log(`Adopted receipt entries for ${selected.join(', ')}.`);
    return 0;
  }

  if (subcommand === 'prune' || subcommand === 'uninstall') {
    const receipt = readSkillsReceipt();
    if (!receipt) {
      console.error('No WebMCP install receipt found; refusing to remove unowned skills.');
      return 1;
    }
    const { flags } = parseFlags(options);
    const provider = flags.provider;
    const all = Boolean(flags.all);
    if (subcommand === 'uninstall' && !provider && !all) {
      console.error('Usage: webmcp skills uninstall --provider <name> | --all [--dry-run] [--yes]');
      return 1;
    }
    const owner = receiptOwner(receipt, kitId);
    if (!owner) {
      console.error(`No install receipt ownership found for ${kitId}; refusing to remove skills.`);
      return 1;
    }
    const mode = resolveSkillsMode(owner);
    const removals = receiptRemovalPlan(
      receipt,
      owner,
      kitId,
      inventory,
      subcommand === 'uninstall' ? (all ? '*' : provider) : null,
      mode,
    );
    const dryRun = options.includes('--dry-run') || !options.includes('--yes');
    if (!removals.length) {
      console.log('No receipt-owned skill directories require removal.');
    } else if (dryRun) {
      console.log(`Planned removals (${removals.length}):`);
      applyReceiptRemovals(removals, true);
    } else {
      applyReceiptRemovals(removals, false);
      if (subcommand === 'uninstall' && all) {
        const owners = { ...receiptOwners(receipt) };
        delete owners[kitId];
        if (Object.keys(owners).length === 0) rmSync(skillsReceiptPath(), { force: true });
        else writeFileSync(skillsReceiptPath(), `${JSON.stringify({
          schema: 'webmcp-install-receipt/2',
          version: 2,
          updatedAt: new Date().toISOString(),
          owners,
        }, null, 2)}\n`);
      } else if (subcommand === 'uninstall' && provider) {
        const providers = { ...owner.providers };
        delete providers[provider];
        writeSkillsReceipt(receipt, providers, mode, kitId);
      } else {
        const desired = new Set(publicSkillNames(inventory, mode));
        const providers = {};
        for (const [name, value] of Object.entries(owner.providers || {})) {
          providers[name] = { root: value.root, entries: (value.entries || []).filter((entry) => desired.has(entry)) };
        }
        writeSkillsReceipt(receipt, providers, mode, kitId);
      }
      console.log(`Removed ${removals.length} receipt-owned skill director${removals.length === 1 ? 'y' : 'ies'}.`);
    }
    return 0;
  }

  console.error(`Unknown skills command: ${subcommand}`);
  printSkillsHelp();
  return 1;
}
