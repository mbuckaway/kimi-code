import { Error2, ErrorCodes } from '#/errors';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';

export const MAX_AGENT_NAME_LENGTH = 64;

const AGENT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const AGENT_ID_SHAPED_NAME = /^agent-\d+$/;

export function agentNameOf(meta: AgentMeta | undefined): string | undefined {
  const name = meta?.labels?.['name'];
  return name === undefined || name.length === 0 ? undefined : name;
}

export function normalizeAgentName(raw: string): string {
  const name = raw.trim();
  if (name.toLowerCase() === 'main') {
    throw new Error2(
      ErrorCodes.AGENT_NAME_RESERVED,
      'The name "main" is reserved for the root agent.',
    );
  }
  if (AGENT_ID_SHAPED_NAME.test(name)) {
    throw new Error2(
      ErrorCodes.AGENT_NAME_INVALID,
      `Agent names must not look like an agent id ("${name}").`,
    );
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error2(
      ErrorCodes.AGENT_NAME_INVALID,
      `Agent name "${name}" must be 1-64 characters of letters, digits, ".", "_" or "-".`,
    );
  }
  return name;
}
