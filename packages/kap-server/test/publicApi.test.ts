import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Scope } from '@moonshot-ai/agent-core-v2';

import {
  classify,
  type ConfigReloadResult,
  reloadConfig,
  rotateServerToken,
  serverTokenPath,
} from '../src/index';

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('server-v2 public API', () => {
  it('exports classify', () => {
    expect(classify('127.0.0.1')).toBe('loopback');
  });

  it('exports rotateServerToken and serverTokenPath', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-v2-public-api-'));
    const token = await rotateServerToken(tmpDir);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(serverTokenPath(tmpDir)).toBe(join(tmpDir, 'server.token'));
  });

  it('exports reloadConfig with a ConfigReloadResult shape', async () => {
    const listeners = new Set<(event: { domain: string; source: string }) => void>();
    const reloaded: string[] = [];
    const result: Promise<ConfigReloadResult> = reloadConfig({
      accessor: {
        get: () => ({
          ready: Promise.resolve(),
          onDidSectionChange: (listener: (event: { domain: string; source: string }) => void) => {
            listeners.add(listener);
            return {
              dispose: () => {
                listeners.delete(listener);
              },
            };
          },
          reload: async () => {
            reloaded.push('reload');
            for (const listener of listeners) {
              listener({ domain: 'providers', source: 'reload' });
            }
          },
          diagnostics: () => [],
        }),
      },
    } as unknown as Scope);

    expect(await result).toEqual({ changedDomains: ['providers'] });
    expect(reloaded).toEqual(['reload']);
    expect(listeners.size).toBe(0);
  });
});
