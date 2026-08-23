import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function modulesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...modulesBelow(full));
    else if (entry.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

test('modular Browser CLI and legacy profile-pool graphs contain no relative import cycles', () => {
  const files = [
    ...modulesBelow(path.join(ROOT, 'lib', 'cli')),
    ...modulesBelow(path.join(ROOT, 'lib', 'profile-pool')),
  ];
  const graph = new Map(files.map((file) => [file, []]));
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const specs = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]).filter((spec) => spec.startsWith('.'));
    for (const spec of specs) {
      const resolved = path.resolve(path.dirname(file), spec);
      if (graph.has(resolved)) graph.get(file).push(resolved);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (file, stack) => {
    if (visiting.has(file)) {
      const cycleStart = stack.indexOf(file);
      assert.fail(`relative import cycle: ${[...stack.slice(cycleStart), file].map((item) => path.relative(ROOT, item)).join(' -> ')}`);
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file)) visit(dependency, [...stack, file]);
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of graph.keys()) visit(file, []);
  assert.equal(visited.size, files.length);
});
