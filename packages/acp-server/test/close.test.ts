import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestClient, type TestClient } from './_helpers/acpClient';
import { writeFakeModelConfig } from './_helpers/fakeModelConfig';
import { createScriptedProvider, type ScriptedProvider } from './_helpers/scriptedProvider';

describe('acp-server session/close', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;
  let scripted: ScriptedProvider | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-close-'));
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  it(
    'advertises the close capability and closes a live session',
    async () => {
      const c = await boot();
      const init = (await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} })) as {
        agentCapabilities?: { sessionCapabilities?: { close?: unknown } };
      };
      expect(init.agentCapabilities?.sessionCapabilities?.close).toBeDefined();

      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.send('session/close', { sessionId: created.sessionId });

      // After close the server no longer routes the session — a follow-up
      // prompt must surface invalid_params for the now-unknown sessionId.
      await expect(
        c.send('session/prompt', { sessionId: created.sessionId, prompt: [] }),
      ).rejects.toThrow();
      await c.close();
      await expect(c.close()).resolves.toBeUndefined();
    },
    30_000,
  );

  it(
    'closing an unknown sessionId is a best-effort no-op',
    async () => {
      const c = await boot();
      await expect(c.send('session/close', { sessionId: 'does-not-exist' })).resolves.toEqual({});
    },
    30_000,
  );

  it(
    'close-after-prompt flushes the assistant wire journal before disposing the agent scope',
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'acp-close-'));
      await writeFakeModelConfig(homeDir);
      scripted = createScriptedProvider();
      client = await createTestClient({ homeDir, extraSeeds: [scripted.seed] });
      const c = client;
      await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} });

      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.waitForSessionUpdate('available_commands_update', 10_000);

      scripted!.mockNextText('hello from the scripted model');
      const result = (await c.send('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'say hi' }],
      })) as { stopReason: string };
      expect(result.stopReason).toBe('end_turn');

      // The prompt response settles on `turn.ended`, but the loop's
      // `content.part` / `turn.ended` wire records are still queued behind the
      // async blob offload. `session/close` must flush them before the agent
      // scope is disposed — otherwise the journal is missing the tail and the
      // assistant output is lost (Refs #2727).
      await c.send('session/close', { sessionId: created.sessionId });
      // The wire journal lives under the session's workspace bucket:
      // `<homeDir>/sessions/<wd_key>/<sessionId>/agents/main/wire.jsonl`.
      const sessionsRoot = join(homeDir, 'sessions');
      const [bucket] = await readdir(sessionsRoot);
      expect(bucket).toBeDefined();
      const journal = await readFile(
        join(sessionsRoot, bucket!, created.sessionId, 'agents', 'main', 'wire.jsonl'),
        'utf8',
      );
      expect(journal).toContain('hello from the scripted model');
      expect(journal).toContain('turn.ended');
    },
    30_000,
  );
});
