import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { getNativePackageRoot, type NativeAssetOptions } from './native-assets';

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

interface ModuleWithLoad {
  _load?: ModuleLoad;
}

const nodeRequire = createRequire(import.meta.url);
let installed = false;

// pi-tui loads its platform-specific native helpers via an absolute-path
// require() computed from import.meta.url / process.execPath
// (see pi-tui dist/terminal.js and dist/native-modifiers.js). In a SEA binary
// those .node files live in the native-asset cache, so redirect any absolute
// require of a pi-tui native helper to the cached copy.
//
// Path shape: native/<darwin|win32>/prebuilds/<arch>/<file>.node — note the
// two path segments after "prebuilds", so ".+" (not "[^/]+") is required.
const PI_TUI_NATIVE_PATTERN = /native[\\/](?:win32|darwin)[\\/]prebuilds[\\/].+\.node$/;

function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'MODULE_NOT_FOUND'
  );
}

export function createNativeModuleLoad(
  originalLoad: ModuleLoad,
  options: NativeAssetOptions = {},
): ModuleLoad {
  return function loadWithNativeAssets(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    if (
      typeof request === 'string' &&
      PI_TUI_NATIVE_PATTERN.test(request) &&
      !existsSync(request)
    ) {
      const pkgRoot = getNativePackageRoot('@moonshot-ai/pi-tui', options);
      if (pkgRoot !== null) {
        const match = request.match(PI_TUI_NATIVE_PATTERN);
        if (match !== null) {
          const redirected = join(pkgRoot, match[0]);
          return originalLoad.call(this, redirected, parent, isMain);
        }
      }
    }
    // fsevents is an optional darwin-only dependency loaded via createRequire
    // by agent-core-v2. Inside the SEA there is no node_modules, so when the
    // bare specifier fails to resolve, retry from the native-asset cache.
    if (request === 'fsevents') {
      try {
        return originalLoad.call(this, request, parent, isMain);
      } catch (error) {
        if (!isModuleNotFound(error)) throw error;
        const pkgRoot = getNativePackageRoot('fsevents', options);
        if (pkgRoot === null) throw error;
        return originalLoad.call(this, pkgRoot, parent, isMain);
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

export function installNativeModuleHook(): void {
  if (installed) return;
  installed = true;

  const moduleBuiltin = nodeRequire('node:module') as ModuleWithLoad;
  const originalLoad = moduleBuiltin._load;
  if (originalLoad === undefined) return;

  moduleBuiltin._load = createNativeModuleLoad(originalLoad);
}
