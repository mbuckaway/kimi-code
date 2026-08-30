/**
 * Aggregate per-platform native artifacts into a single `manifest.json`
 * written into the same input directory.
 *
 * Usage:
 *   node produce-manifest.mjs <input-dir> <release-tag>
 *
 * Input dir must contain files matching: kimi-code-<target>.zip.sha256
 * (produced by package.mjs across the 6 native-build matrix runners).
 *
 * Output:
 *   <input-dir>/manifest.json   ← consumed by the staged updater
 *     (apps/kimi-code/src/cli/update/native-manifest.ts): each platform entry
 *     points at the BARE executable (kimi-code-<target>) with the
 *     executable's sha256 — the updater downloads and stages it directly, so
 *     the archive must be extracted here, not referenced.
 *
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const [, , inputDir, tag] = process.argv;
if (!inputDir || !tag) {
  console.error('Usage: produce-manifest.mjs <input-dir> <release-tag>');
  process.exit(1);
}

// Tag 格式 `@mbuckaway/kimi-code@x.y.z-MB.n.m` 或 `vx.y.z` 或 `x.y.z`，都归一化到 semver 本体（保留预发布后缀）
const version = tag.replace(/^@mbuckaway\/kimi-code@/, '').replace(/^v/, '');

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

const entries = await readdir(inputDir);
const sumFiles = entries.filter((f) => /^kimi-code-[a-z0-9-]+\.zip\.sha256$/.test(f));

if (sumFiles.length === 0) {
  console.error(`No kimi-code-<target>.zip.sha256 files found in ${inputDir}`);
  process.exit(1);
}

const platforms = {};
for (const sumFile of sumFiles.sort()) {
  const zipName = basename(sumFile, '.sha256'); // kimi-code-<target>.zip
  const target = zipName.replace(/^kimi-code-/, '').replace(/\.zip$/, '');
  // Verify the zip arrived intact against its published checksum.
  const expected = (await readFile(resolve(inputDir, sumFile), 'utf-8')).trim().split(/\s+/, 1)[0];
  const zipSha = sha256Hex(await readFile(resolve(inputDir, zipName)));
  if (!expected || zipSha !== expected) {
    console.error(`Checksum mismatch for ${zipName}: expected ${expected}, got ${zipSha}`);
    process.exit(1);
  }
  // The staged updater downloads the BARE executable the manifest points at,
  // so extract the zip and hash the binary inside.
  const extractDir = resolve(inputDir, `.extract-${target}`);
  await mkdir(extractDir, { recursive: true });
  await execFileP('unzip', ['-o', '-q', resolve(inputDir, zipName), '-d', extractDir]);
  const checksum = sha256Hex(
    await readFile(resolve(extractDir, target.startsWith('win32') ? 'kimi.exe' : 'kimi')),
  );
  await rm(extractDir, { recursive: true, force: true });
  platforms[target] = { filename: `kimi-code-${target}`, checksum };
}

const manifest = { version, tag, platforms };
const manifestPath = resolve(inputDir, 'manifest.json');

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${manifestPath} (${Object.keys(platforms).length} platforms)`);
