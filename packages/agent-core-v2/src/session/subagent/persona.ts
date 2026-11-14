import * as pathe from 'pathe';

import type {
  AgentProfile,
  AgentProfileMode,
  PersonaBinding,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { Error2, ErrorCodes } from '#/errors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { isSensitiveFile, isWithinDirectory } from '#/tool/path-access';
import {
  AgentFileParseError,
  parseAgentFileText,
} from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';
import type { AgentFileDefinition } from '#/workspace/workspaceAgentProfileLoader/internal/types';

export const PERSONA_FILE_MAX_BYTES = 32 * 1024;

const MAX_REALPATH_WALK = 256;

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
  readonly mode: AgentProfileMode;
  readonly text: string;
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly declaredBase: string;
}

export async function resolvePersona(options: ResolvePersonaOptions): Promise<ResolvedPersona> {
  const reference = options.reference.trim();
  const catalogProfile = options.catalog.get(reference);
  const source =
    catalogProfile === undefined
      ? await personaFromPath(reference, options)
      : personaFromCatalogProfile(reference, catalogProfile);
  return {
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
  const realPath = await realpathExistingPrefix(options.fs, path);
  await assertRealPathInsideWorkspace(path, realPath, reference, options);
  await assertParentNotSymlinked(path, reference, options.fs);
  assertNotSensitive(path, realPath, reference);
  const stat = await options.fs.lstat(path);
  if (!stat.isFile || stat.isSymbolicLink === true) {
    throw new Error2(ErrorCodes.VALIDATION_FAILED, `Persona file "${path}" is not a regular file.`, {
      details: { persona: reference, path },
    });
  }
  if (stat.size > PERSONA_FILE_MAX_BYTES) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Persona file "${path}" is too large: ${stat.size} bytes (limit ${PERSONA_FILE_MAX_BYTES} bytes).`,
      { details: { persona: reference, path } },
    );
  }
  const text = await readPersonaText(realPath, reference, options.fs);
  const definition = parsePersonaText(path, reference, text);
  return {
    mode: definition.mode,
    text: definition.prompt,
    skills: definition.skills,
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    subagents: definition.subagents,
    declaredBase: definition.extends,
  };
}

async function realpathExistingPrefix(fs: IHostFileSystem, abs: string): Promise<string> {
  const tail: string[] = [];
  let current = abs;
  for (let i = 0; i < MAX_REALPATH_WALK; i++) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : pathe.join(real, ...tail.toReversed());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = pathe.dirname(current);
      if (parent === current) return abs;
      tail.push(pathe.basename(current));
      current = parent;
    }
  }
  return abs;
}

async function assertRealPathInsideWorkspace(
  path: string,
  realPath: string,
  reference: string,
  options: ResolvePersonaOptions,
): Promise<void> {
  const roots = await workspaceRealRoots(options.fs, options.workspace);
  if (roots.some((root) => isWithinDirectory(realPath, root))) return;
  throw personaSymlinkError(reference, path, realPath, 'symlink_outside');
}

async function workspaceRealRoots(
  fs: IHostFileSystem,
  workspace: ISessionWorkspaceContext,
): Promise<readonly string[]> {
  const roots: string[] = [];
  for (const dir of [workspace.workDir, ...workspace.additionalDirs]) {
    roots.push(await realpathOrSelf(fs, dir));
  }
  return roots;
}

async function realpathOrSelf(fs: IHostFileSystem, path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return path;
  }
}

async function assertParentNotSymlinked(
  path: string,
  reference: string,
  fs: IHostFileSystem,
): Promise<void> {
  const parent = pathe.normalize(pathe.dirname(path));
  let realParent: string;
  try {
    realParent = await fs.realpath(parent);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  const normalizedRealParent = pathe.normalize(realParent);
  if (normalizedRealParent === parent) return;
  throw personaSymlinkError(reference, path, normalizedRealParent, 'symlink_parent');
}

function assertNotSensitive(path: string, realPath: string, reference: string): void {
  if (!isSensitiveFile(path) && !isSensitiveFile(realPath)) return;
  throw new Error2(
    ErrorCodes.VALIDATION_FAILED,
    `Persona file "${path}" matches a sensitive-file pattern (env / credential / SSH key); access is blocked to protect secrets.`,
    { details: { persona: reference, path } },
  );
}

function personaSymlinkError(
  reference: string,
  path: string,
  realPath: string,
  reason: 'symlink_outside' | 'symlink_parent',
): Error2 {
  return new Error2(
    ErrorCodes.FS_PATH_ESCAPES,
    `Persona file "${path}" escapes the workspace through a symlink`,
    { details: { persona: reference, path, realPath, reason } },
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof HostFsError &&
    (error.code === OsFsErrors.codes.OS_FS_NOT_FOUND ||
      error.code === OsFsErrors.codes.OS_FS_NOT_DIRECTORY)
  );
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
): AgentFileDefinition & { readonly extends: string } {
  try {
    return parseAgentFileText({
      path,
      source: 'explicit',
      text,
      requireExtends: true,
    });
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
