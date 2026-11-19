/**
 * Scenario: Session cross-session inbound policy.
 * Responsibilities: read and change a session's cross-session inbound policy through KimiHarness.
 * Wiring: the real v2 engine boots on a temp KIMI_CODE_HOME; no model provider is exercised.
 * Run: pnpm exec vitest run test/session-cross-session-inbound.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  createKimiHarness,
  createKimiHarnessV2,
  type CrossSessionInbound,
  type KimiError,
} from '#/index';
import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

const POLICY_VALUES: readonly CrossSessionInbound[] = ['hold', 'refuse', 'accept'];

// v2 engine bootstrap/teardown can exceed Vitest's 5s default on slow hosts.
const TEST_TIMEOUT_MS = 20_000;

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session cross-session inbound policy', () => {
  it('defaults to accept', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-inbound-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-inbound-work-');
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_inbound_default', workDir });
      expect(await session.getCrossSessionInbound()).toBe('accept');
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it.each(POLICY_VALUES)('round-trips the %s policy', async (value) => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-inbound-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-inbound-work-');
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: `ses_inbound_${value}`, workDir });
      await session.setCrossSessionInbound(value);
      expect(await session.getCrossSessionInbound()).toBe(value);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('rejects invalid inbound policies', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-inbound-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-inbound-work-');
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_inbound_invalid', workDir });

      await expect(session.setCrossSessionInbound('maybe' as never)).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.invalid',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('rejects reads and writes after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-inbound-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-inbound-work-');
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_inbound_closed', workDir });
      await session.close();

      await expect(session.getCrossSessionInbound()).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
      await expect(session.setCrossSessionInbound('hold')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('rejects on the v1 engine, which has no cross-session messaging', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-inbound-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-inbound-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_inbound_v1', workDir });

      await expect(session.getCrossSessionInbound()).rejects.toMatchObject({
        code: 'not_implemented',
      });
      await expect(session.setCrossSessionInbound('hold')).rejects.toMatchObject({
        code: 'not_implemented',
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});
