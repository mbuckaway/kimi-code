/**
 * Generate the fork's update-channel files (served from GitHub Pages at
 * https://mbuckaway.github.io/kimi-code) into <out-dir>:
 *
 *   latest                 plain-text semver, consumed by already-shipped clients
 *   latest.json            rollout manifest (schema: apps/kimi-code/src/cli/update/cdn.ts)
 *   install.sh             native installer, copied verbatim from fork/install.sh
 *   install.ps1            Windows installer, copied verbatim from fork/install.ps1
 *   sha256/<target>.sha256 per-platform checksums, consumed by install.sh / install.ps1
 *   binaries/<version>/    per-release native manifest + BARE platform binaries,
 *                          consumed by the staged updater (native-manifest.ts)
 *
 * Usage:
 *   node fork/scripts/publish-update-channel.mjs <version> <native-artifacts-dir> <out-dir>
 *
 * <native-artifacts-dir> must contain the kimi-code-<target>.zip.sha256 files
 * downloaded from the native-build matrix (same layout produce-manifest.mjs
 * consumes).
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const [, , version, artifactsDir, outDir] = process.argv;
if (!version || !artifactsDir || !outDir) {
  console.error(
    'Usage: publish-update-channel.mjs <version> <native-artifacts-dir> <out-dir>',
  );
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+-MB\.\d+\.\d+$/.test(version)) {
  console.error(`Version ${version} does not match <base>-MB.<x>.<y>`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await mkdir(resolve(outDir, 'sha256'), { recursive: true });

await writeFile(resolve(outDir, 'latest'), `${version}\n`);
await writeFile(
  resolve(outDir, 'latest.json'),
  `${JSON.stringify({ version, publishedAt: new Date().toISOString(), rollout: [] }, null, 2)}\n`,
);

const installShSource = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'install.sh',
);
await copyFile(installShSource, resolve(outDir, 'install.sh'));

const installPsSource = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'install.ps1',
);
await copyFile(installPsSource, resolve(outDir, 'install.ps1'));

const entries = await readdir(artifactsDir);
const sumFiles = entries.filter((f) => /^kimi-code-[a-z0-9-]+\.zip\.sha256$/.test(f));
if (sumFiles.length === 0) {
  console.error(`No kimi-code-<target>.zip.sha256 files found in ${artifactsDir}`);
  process.exit(1);
}
for (const sumFile of sumFiles) {
  const target = sumFile.replace(/^kimi-code-/, '').replace(/\.zip\.sha256$/, '');
  await copyFile(resolve(artifactsDir, sumFile), resolve(outDir, 'sha256', `${target}.sha256`));
}

// The staged updater (native-manifest.ts) downloads the BARE executable
// referenced by the manifest from /binaries/<version>/ — publish the manifest
// plus the extracted platform binaries alongside the channel files, or
// upgrades 404 on the manifest / stage a zip as an executable. manifest.json
// is written into the artifacts dir by produce-manifest.mjs before this runs.
const binariesDir = resolve(outDir, 'binaries', version);
await mkdir(binariesDir, { recursive: true });
const manifestSource = resolve(artifactsDir, 'manifest.json');
try {
  await copyFile(manifestSource, resolve(binariesDir, 'manifest.json'));
} catch {
  console.error(`manifest.json not found in ${artifactsDir} — run apps/kimi-code/scripts/native/produce-manifest.mjs first`);
  process.exit(1);
}
for (const zipFile of entries.filter((f) => /^kimi-code-[a-z0-9-]+\.zip$/.test(f))) {
  const target = zipFile.replace(/^kimi-code-/, '').replace(/\.zip$/, '');
  const extractDir = resolve(outDir, `.tmp-${target}`);
  await mkdir(extractDir, { recursive: true });
  await execFileP('unzip', ['-o', '-q', resolve(artifactsDir, zipFile), '-d', extractDir]);
  await copyFile(
    resolve(extractDir, target.startsWith('win32') ? 'kimi.exe' : 'kimi'),
    resolve(binariesDir, `kimi-code-${target}`),
  );
  await rm(extractDir, { recursive: true, force: true });
}

console.log(`Wrote update channel for ${version} (${sumFiles.length} platforms) to ${outDir}`);
