import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getNativeCacheBase,
  getNativePackageRoot,
  NATIVE_ASSET_MANIFEST_VERSION,
  type NativeAssetManifest,
  type NativeAssetSource,
} from '#/native/native-assets';
import { createNativeModuleLoad } from '#/native/module-hook';
import { loadNativePackage } from '#/native/native-require';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeManifest(
  files: Record<string, string>,
  packageName = 'fake-native',
): {
  manifest: NativeAssetManifest;
  source: NativeAssetSource;
} {
  const assetEntries = Object.entries(files).map(([relativePath, content]) => {
    const assetKey = `native/test-target/${relativePath}`;
    return {
      assetKey,
      relativePath,
      sha256: sha256(content),
    };
  });
  const manifest: NativeAssetManifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target: 'test-target',
    packages: [
      {
        name: packageName,
        root: `node_modules/${packageName}`,
        files: assetEntries,
      },
    ],
  };
  const manifestKey = 'native/test-target/manifest.json';
  const assets = new Map<string, Buffer>([
    [manifestKey, Buffer.from(JSON.stringify(manifest))],
    ...Object.entries(files).map(([relativePath, content]) => [
      `native/test-target/${relativePath}`,
      Buffer.from(content),
    ] as const),
  ]);
  return {
    manifest,
    source: {
      getAssetKeys: () => [...assets.keys()],
      getRawAsset: (assetKey) => {
        const asset = assets.get(assetKey);
        if (asset === undefined) throw new Error(`missing test asset: ${assetKey}`);
        return asset;
      },
    },
  };
}

describe('native assets', () => {
  it('uses KIMI_CODE_CACHE_DIR as the native cache base when present', () => {
    expect(
      getNativeCacheBase({
        env: { KIMI_CODE_CACHE_DIR: '/tmp/kimi-cache' },
        homeDir: '/home/kimi',
        platform: 'linux',
      }),
    ).toBe('/tmp/kimi-cache');
  });

  it('extracts package assets and repairs corrupted cache files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-assets-'));
    try {
      const { manifest, source } = fakeManifest({
        'node_modules/fake-native/package.json': '{"main":"index.js"}',
        'node_modules/fake-native/index.js': "module.exports = { value: 'ok' };\n",
      });

      const packageRoot = getNativePackageRoot('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      expect(packageRoot).toBe(join(dir, 'native', 'test', 'test-target', sha256(JSON.stringify(manifest)), 'node_modules', 'fake-native'));
      expect(readFileSync(join(packageRoot ?? '', 'index.js'), 'utf-8')).toContain("value: 'ok'");

      writeFileSync(join(packageRoot ?? '', 'index.js'), 'broken');
      const repairedRoot = getNativePackageRoot('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      expect(repairedRoot).toBe(packageRoot);
      expect(readFileSync(join(repairedRoot ?? '', 'index.js'), 'utf-8')).toContain("value: 'ok'");
      expect(existsSync(join(dir, 'native', 'test', 'test-target'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a package from extracted native assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-require-'));
    try {
      const { manifest, source } = fakeManifest({
        'node_modules/fake-native/package.json': '{"main":"index.js"}',
        'node_modules/fake-native/index.js': "module.exports = { value: 'ok' };\n",
      });

      const pkg = loadNativePackage<{ value: string }>('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });

      expect(pkg).toEqual({ value: 'ok' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('native module hook', () => {
  function moduleNotFound(): Error & { code: string } {
    const error = new Error("Cannot find module 'fsevents'") as Error & { code: string };
    error.code = 'MODULE_NOT_FOUND';
    return error;
  }

  it('passes fsevents through when normal resolution succeeds', () => {
    const sentinel = { native: true };
    const load = createNativeModuleLoad(() => sentinel);
    expect(load('fsevents', null, false)).toBe(sentinel);
  });

  it('redirects fsevents to the native package root when resolution fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-module-hook-'));
    try {
      const { manifest, source } = fakeManifest(
        {
          'node_modules/fsevents/package.json': '{"main":"fsevents.js"}',
          'node_modules/fsevents/fsevents.js':
            "module.exports = { value: 'fsevents-from-cache' };\n",
        },
        'fsevents',
      );

      const realRequire = createRequire(import.meta.url);
      const load = createNativeModuleLoad(
        (request) => {
          if (request === 'fsevents') throw moduleNotFound();
          return realRequire(request);
        },
        { cacheBase: dir, manifest, source, version: 'test' },
      );

      expect(load('fsevents', null, false)).toEqual({ value: 'fsevents-from-cache' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rethrows the original error when fsevents is not in the native assets', () => {
    const error = moduleNotFound();
    const load = createNativeModuleLoad(
      () => {
        throw error;
      },
      {
        manifest: {
          version: NATIVE_ASSET_MANIFEST_VERSION,
          target: 'test-target',
          packages: [],
        },
      },
    );
    expect(() => load('fsevents', null, false)).toThrow(error);
  });

  it('rethrows non-MODULE_NOT_FOUND errors from fsevents resolution', () => {
    const error = new Error('boom');
    const load = createNativeModuleLoad(() => {
      throw error;
    });
    expect(() => load('fsevents', null, false)).toThrow(error);
  });

  it('passes non-fsevents requests through untouched', () => {
    const error = moduleNotFound();
    const load = createNativeModuleLoad(
      (request) => {
        if (request === 'failing-module') throw error;
        return `loaded:${request}`;
      },
      {
        manifest: {
          version: NATIVE_ASSET_MANIFEST_VERSION,
          target: 'test-target',
          packages: [],
        },
      },
    );
    expect(load('some-module', null, false)).toBe('loaded:some-module');
    expect(() => load('failing-module', null, false)).toThrow(error);
  });

  it('still redirects pi-tui native helpers to the native package root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-module-hook-pi-tui-'));
    try {
      const { manifest, source } = fakeManifest({}, '@moonshot-ai/pi-tui');
      const load = createNativeModuleLoad((request) => request, {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });

      const helperRelative = 'native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node';
      const redirected = load(`/sea/${helperRelative}`, null, false);
      const pkgRoot = join(
        dir,
        'native',
        'test',
        'test-target',
        sha256(JSON.stringify(manifest)),
        'node_modules',
        '@moonshot-ai',
        'pi-tui',
      );
      expect(redirected).toBe(join(pkgRoot, helperRelative));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
