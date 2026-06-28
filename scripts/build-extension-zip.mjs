#!/usr/bin/env node
// Builds a clean Chrome Web Store upload zip from webmcp-extension/dist.
//
// Excludes internal planning docs and OS junk so the published package only
// contains what the extension needs to run. Output: webmcp-extension/build/.
//
// Usage: node scripts/build-extension-zip.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "webmcp-extension", "dist");
const buildDir = join(root, "webmcp-extension", "build");

const manifest = JSON.parse(
  readFileSync(join(distDir, "manifest.json"), "utf8"),
);
const version = manifest.version;
const zipName = `webmcp-extension-v${version}.zip`;
const zipPath = join(buildDir, zipName);

// Paths inside dist/ that must never ship to the store.
const excludes = [
  "docs/*", // internal planning notes
  ".DS_Store",
  "*/.DS_Store",
  "__MACOSX/*",
];

mkdirSync(buildDir, { recursive: true });
if (existsSync(zipPath)) rmSync(zipPath);

const args = ["-r", "-X", zipPath, ".", "-x", ...excludes];
execFileSync("zip", args, { cwd: distDir, stdio: "inherit" });

console.log(`\nBuilt ${zipPath}`);
console.log("Contents:");
execFileSync("unzip", ["-l", zipPath], { stdio: "inherit" });
