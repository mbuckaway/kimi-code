// Fork-owned web-bundle selector: stage or verify apps/kimi-code/dist-web.
//
// Without a selector, this script verifies the committed upstream bundle,
// exactly like upstream's check-web-assets.mjs. With KIMI_WEB_BUNDLE=<path>
// (or --web-bundle <path>) it replaces dist-web with the given build output
// from the mbuckaway/kimi-code-web repo, then verifies it. dist-web is a
// tracked directory, so a staged fork bundle shows up as working-tree
// changes — commit them to ship the fork bundle, or restore the upstream
// bundle with: git checkout upstream/main -- apps/kimi-code/dist-web

import { cp, readdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(appRoot, 'dist-web');

function resolveBundleSource() {
  const flagIndex = process.argv.indexOf('--web-bundle');
  if (flagIndex !== -1) {
    const value = process.argv[flagIndex + 1];
    if (!value) throw new Error('--web-bundle requires a path argument');
    return resolve(value);
  }
  const fromEnv = process.env.KIMI_WEB_BUNDLE;
  return fromEnv ? resolve(fromEnv) : undefined;
}

async function assertBundle(dir, origin) {
  try {
    const info = await stat(resolve(dir, 'index.html'));
    if (!info.isFile()) throw new Error('index.html is not a file');
  } catch {
    throw new Error(
      `No web bundle at ${dir}/index.html (${origin}). ` +
        'Build one in the mbuckaway/kimi-code-web repo, or restore the ' +
        'committed upstream bundle with: git checkout upstream/main -- apps/kimi-code/dist-web',
    );
  }
}

const source = resolveBundleSource();
if (source !== undefined) {
  await assertBundle(source, 'from KIMI_WEB_BUNDLE / --web-bundle');
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  console.warn(
    `Staged fork web bundle from ${source} — dist-web now differs from the ` +
      'committed upstream bundle. Commit it to ship, or restore with: ' +
      'git checkout upstream/main -- apps/kimi-code/dist-web',
  );
}

await assertBundle(target, source === undefined ? 'committed bundle' : 'staged bundle');
const files = await readdir(target, { recursive: true });
console.log(`Web assets OK: ${target} (${files.length} entries)`);
