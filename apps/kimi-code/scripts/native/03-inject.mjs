import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { fail, run, tryRun } from './exec.mjs';
import {
  appRoot,
  isCrossTarget,
  nativeBinDir,
  nativeBinPath,
  nativeBlobPath,
  nativeIntermediatesDir,
  SEA_SENTINEL_FUSE,
  targetArch,
  targetPlatform,
  targetTriple,
} from './paths.mjs';

const execFileAsync = promisify(execFile);

function postjectPath() {
  const command = process.platform === 'win32' ? 'postject.cmd' : 'postject';
  return resolve(appRoot, 'node_modules/.bin', command);
}

async function ensureBlobExists() {
  try {
    await stat(nativeBlobPath());
  } catch {
    fail(`SEA blob not found at ${nativeBlobPath()}. Run 02-sea-blob.mjs first.`);
  }
}

function nodeCacheDir(target) {
  return resolve(nativeIntermediatesDir(), 'node-cache', `v${process.versions.node}-${target}`);
}

async function downloadTargetNode(target) {
  const platform = targetPlatform(target);
  const arch = targetArch(target);
  const version = process.versions.node;
  const cacheDir = nodeCacheDir(target);
  const binaryName = platform === 'win32' ? 'node.exe' : 'node';
  const cachedBinary = resolve(cacheDir, binaryName);
  if (existsSync(cachedBinary)) return cachedBinary;

  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  const archiveName = `node-v${version}-${platform}-${arch}.${extension}`;
  const archivePath = resolve(cacheDir, archiveName);
  const url = `https://nodejs.org/dist/v${version}/${archiveName}`;

  await mkdir(cacheDir, { recursive: true });
  console.log(`==> Target Node.js binary not cached; downloading ${url}`);
  await run('curl', ['-sSfL', url, '-o', archivePath]);
  if (extension === 'zip') {
    await run('unzip', [
      '-o',
      '-j',
      archivePath,
      `node-v${version}-win32-${arch}/node.exe`,
      '-d',
      cacheDir,
    ]);
  } else {
    await run('tar', [
      '-xzf',
      archivePath,
      '-C',
      cacheDir,
      '--strip-components=2',
      `node-v${version}-${platform}-${arch}/bin/node`,
    ]);
  }
  await rm(archivePath, { force: true });
  if (!existsSync(cachedBinary)) {
    fail(`Downloaded Node.js archive did not contain ${binaryName} (${url}).`);
  }
  return cachedBinary;
}

async function copyNodeExecutable(target) {
  await mkdir(nativeBinDir(target), { recursive: true });
  const out = nativeBinPath(target);
  if (isCrossTarget(target)) {
    await copyFile(await downloadTargetNode(target), out);
  } else {
    await copyFile(process.execPath, out);
  }
  if (targetPlatform(target) !== 'win32') {
    await run('chmod', ['755', out]);
  }
}

async function removeSignatureIfNeeded(target) {
  const out = nativeBinPath(target);
  if (process.platform === 'darwin') {
    await tryRun('codesign', ['--remove-signature', out]);
  }
  if (process.platform === 'win32') {
    await tryRun('signtool', ['remove', '/s', out]);
  }
}

async function injectSeaBlob(target) {
  const out = nativeBinPath(target);
  const args = [out, 'NODE_SEA_BLOB', nativeBlobPath(), '--sentinel-fuse', SEA_SENTINEL_FUSE];
  if (targetPlatform(target) === 'darwin') {
    args.push('--macho-segment-name', 'NODE_SEA');
  }
  await run(postjectPath(), args);
}

async function ensureCrossSignerAvailable(command) {
  try {
    await execFileAsync(command, ['--version'], { cwd: appRoot });
  } catch {
    fail(
      'rcodesign is required to ad-hoc sign cross-compiled macOS binaries. ' +
        'Set KIMI_CODE_RCODESIGN to its path or add rcodesign to PATH.',
    );
  }
}

async function signCrossCompiledDarwinBinary(target) {
  if (targetPlatform(target) !== 'darwin' || process.platform === 'darwin') return;
  const rcodesign = process.env.KIMI_CODE_RCODESIGN ?? 'rcodesign';
  await ensureCrossSignerAvailable(rcodesign);
  await run(rcodesign, ['sign', nativeBinPath(target)]);
}

export async function runInjectStep() {
  const target = targetTriple();
  await ensureBlobExists();
  await copyNodeExecutable(target);
  await removeSignatureIfNeeded(target);
  await injectSeaBlob(target);
  await signCrossCompiledDarwinBinary(target);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runInjectStep();
}
