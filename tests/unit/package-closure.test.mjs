import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('npm packed inventory contains every relative module imported by shipped Browser CLI files', (t) => {
  const packRoot = mkdtempSync(path.join(tmpdir(), 'webmcp-browser-pack-'));
  t.after(() => rmSync(packRoot, { recursive: true, force: true }));
  const globalConfig = path.join(packRoot, 'empty-global.npmrc');
  writeFileSync(globalConfig, '');
  const packed = spawnSync('npm', [
    `--userconfig=/dev/null`,
    `--globalconfig=${globalConfig}`,
    `--cache=${path.join(packRoot, 'cache')}`,
    'pack', '--dry-run', '--ignore-scripts', '--json',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.equal(packed.status, 0, packed.stderr);
  const inventory = JSON.parse(packed.stdout)[0].files;
  const files = new Set(inventory.map((entry) => entry.path));
  assert.equal(inventory.find((entry) => entry.path === 'bin/webmcp.mjs')?.mode, 0o755);
  assert.equal(inventory.find((entry) => entry.path === 'bin/profile-pool.mjs')?.mode, 0o644);
  assert.ok([...files].some((file) => file.startsWith('lib/cli/')));
  assert.ok([...files].some((file) => file.startsWith('lib/profile-pool/')));

  const moduleFiles = [...files].filter((file) => /\.(?:mjs|js)$/.test(file));
  for (const file of moduleFiles) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    const specs = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]).filter((spec) => spec.startsWith('.'));
    for (const spec of specs) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      assert.ok(files.has(resolved), `${file} imports ${spec}, but ${resolved} is absent from the tarball`);
    }
  }
});
