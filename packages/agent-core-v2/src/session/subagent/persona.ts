import { AGENTS_MD_RECOMMENDED_MAX_BYTES } from '#/agent/profile/context';
import type {
  AgentProfile,
  AgentProfileMode,
  PersonaBinding,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { Error2, ErrorCodes } from '#/errors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { isSensitiveFile } from '#/tool/path-access';
import {
  AgentFileParseError,
  parseAgentFileText,
} from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';
import type { AgentFileDefinition } from '#/workspace/workspaceAgentProfileLoader/internal/types';

export interface ResolvedPersona extends PersonaBinding {
  readonly base: string;
}

export interface ResolvePersonaOptions {
  readonly reference: string;
  readonly baseProfileName?: string;
  readonly catalog: {
    get(name: string): AgentProfile | undefined;
    list(): readonly AgentProfile[];
  };
  readonly fs: IHostFileSystem;
  readonly workspace: ISessionWorkspaceContext;
}

interface PersonaSource {
  readonly name: string;
  readonly mode: AgentProfileMode;
  readonly text: string;
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly declaredBase: string;
}

type PersonaFileDefinition = AgentFileDefinition & { readonly extends: string };

export async function resolvePersona(options: ResolvePersonaOptions): Promise<ResolvedPersona> {
  const reference = options.reference.trim();
  const catalogProfile = options.catalog.get(reference);
  const source =
    catalogProfile === undefined
      ? await personaFromPath(reference, options)
      : personaFromCatalogProfile(reference, catalogProfile);
  return {
    name: source.name,
    mode: source.mode,
    text: source.text,
    skills: source.skills,
    tools: source.tools,
    disallowedTools: source.disallowedTools,
    subagents: source.subagents,
    base: resolveBase(reference, source.declaredBase, options.baseProfileName),
  };
}

function personaFromCatalogProfile(reference: string, profile: AgentProfile): PersonaSource {
  if (profile.extends === undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Persona profile "${profile.name}" must declare a base profile (persona.base_required).`,
      { details: { reason: 'persona.base_required', persona: reference } },
    );
  }
  const text = profile.persona;
  if (text === undefined || text.trim().length === 0) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Persona profile "${profile.name}" has no persona body.`,
      { details: { reason: 'persona.body_required', persona: reference } },
    );
  }
  return {
    name: profile.name,
    mode: profile.mode ?? 'overlay',
    text,
    skills: profile.skills,
    tools: profile.tools,
    disallowedTools: profile.disallowedTools,
    subagents: profile.subagents,
    declaredBase: profile.extends,
  };
}

function looksLikePath(reference: string): boolean {
  return reference.includes('/') || reference.includes('\\') || reference.endsWith('.md');
}

async function personaFromPath(
  reference: string,
  options: ResolvePersonaOptions,
): Promise<PersonaSource> {
  if (!looksLikePath(reference)) {
    const available = options.catalog.list().map((profile) => profile.name).join(', ');
    throw new Error2(
      ErrorCodes.PROFILE_UNKNOWN,
      `Unknown persona: "${reference}". Available profiles: ${available}`,
      { details: { persona: reference, available } },
    );
  }
  const resolved = options.workspace.resolve(reference);
  const path = options.workspace.assertAllowed(resolved, 'read');
  if (isSensitiveFile(path)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Persona file "${path}" matches a sensitive-file pattern (env / credential / SSH key); access is blocked to protect secrets.`,
      { details: { persona: reference, path } },
    );
  }
  const stat = await options.fs.lstat(path);
  if (!stat.isFile || stat.isSymbolicLink === true) {
    throw new Error2(ErrorCodes.VALIDATION_FAILED, `Persona file "${path}" is not a regular file.`, {
      details: { persona: reference, path },
    });
  }
  if (stat.size > AGENTS_MD_RECOMMENDED_MAX_BYTES) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Persona file "${path}" is too large: ${stat.size} bytes (limit ${AGENTS_MD_RECOMMENDED_MAX_BYTES} bytes).`,
      { details: { persona: reference, path } },
    );
  }
  const text = await readPersonaText(path, reference, options.fs);
  const definition = parsePersonaText(path, reference, text);
  return {
    name: path,
    mode: definition.mode,
    text: definition.prompt,
    skills: definition.skills,
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    subagents: definition.subagents,
    declaredBase: definition.extends,
  };
}

async function readPersonaText(
  path: string,
  reference: string,
  fs: IHostFileSystem,
): Promise<string> {
  try {
    return await fs.readText(path);
  } catch (error) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Failed to read persona file "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, details: { persona: reference, path } },
    );
  }
}

function parsePersonaText(
  path: string,
  reference: string,
  text: string,
): PersonaFileDefinition {
  try {
    return parseAgentFileText({
      path,
      source: 'explicit',
      text,
      requireExtends: true,
    }) as PersonaFileDefinition;
  } catch (error) {
    if (error instanceof AgentFileParseError) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, error.message, {
        cause: error,
        details: { persona: reference, path },
      });
    }
    throw error;
  }
}

function resolveBase(
  reference: string,
  declaredBase: string,
  baseProfileName: string | undefined,
): string {
  if (baseProfileName === undefined || baseProfileName === declaredBase) return declaredBase;
  throw new Error2(
    ErrorCodes.VALIDATION_FAILED,
    `persona.base_mismatch: persona "${reference}" is based on "${declaredBase}", but subagent_type is "${baseProfileName}".`,
    {
      details: {
        reason: 'persona.base_mismatch',
        persona: reference,
        extends: declaredBase,
        requested: baseProfileName,
      },
    },
  );
}
