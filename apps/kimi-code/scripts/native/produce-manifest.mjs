/**
 * Aggregate per-platform zip archive `.sha256` files into a single
 * `manifest.json` written into the same input directory.
 *
 * Usage:
 *   node produce-manifest.mjs <input-dir> <release-tag>
 *
 * Input dir must contain files matching: kimi-code-<target>.zip.sha256
 * (produced by package.mjs across the 6 native-build matrix runners).
 *
 * Output:
 *   <input-dir>/manifest.json   ← consumed by the staged updater
 *     (apps/kimi-code/src/cli/update/native-manifest.ts). The updater
 *     downloads the referenced archive and extracts it before staging (see
 *     native-stage.ts), so the manifest lists the ZIP with the zip's sha256.
 *
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const [, , inputDir, tag] = process.argv;
if (!inputDir || !tag) {
  console.error('Usage: produce-manifest.mjs <input-dir> <release-tag>');
  process.exit(1);
}

// Tag 格式 `@mbuckaway/kimi-code@x.y.z-MB.n.m` 或 `vx.y.z` 或 `x.y.z`，都归一化到 semver 本体（保留预发布后缀）
const version = tag.replace(/^@mbuckaway\/kimi-code@/, '').replace(/^v/, '');

const entries = await readdir(inputDir);
const sumFiles = entries.filter((f) => /^kimi-code-[a-z0-9-]+\.zip\.sha256$/.test(f));

if (sumFiles.length === 0) {
  console.error(`No kimi-code-<target>.zip.sha256 files found in ${inputDir}`);
  process.exit(1);
}

// A release must never silently omit a supported platform. KIMI_CODE_REQUIRED_PLATFORMS
// lets a single-platform test/dry-run scope the check down.
const requiredPlatforms = (process.env.KIMI_CODE_REQUIRED_PLATFORMS ?? 'darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-arm64,win32-x64').split(',').map((s) => s.trim()).filter(Boolean);
const present = new Set(sumFiles.map((f) => f.replace(/^kimi-code-/, '').replace(/\.zip\.sha256$/, '')));
const missing = requiredPlatforms.filter((p) => !present.has(p));
if (missing.length > 0) {
  console.error(`Missing native artifacts for required platforms: ${missing.join(', ')}`);
  process.exit(1);
}

const platforms = {};
for (const sumFile of sumFiles.sort()) {
  const text = await readFile(resolve(inputDir, sumFile), 'utf-8');
  const [checksum] = text.trim().split(/\s+/, 1);
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
    console.error(`Invalid checksum in ${sumFile}: ${checksum}`);
    process.exit(1);
  }
  const filename = basename(sumFile, '.sha256');
  // kimi-code-darwin-arm64.zip → darwin-arm64
  const target = filename.replace(/^kimi-code-/, '').replace(/\.zip$/, '');
  platforms[target] = { filename, checksum };
}

const manifest = { version, tag, platforms };
const manifestPath = resolve(inputDir, 'manifest.json');

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${manifestPath} (${Object.keys(platforms).length} platforms)`);
