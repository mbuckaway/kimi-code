import { z } from 'zod';

export const envelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    code: z.number().int(),
    msg: z.string(),
    data: data.nullable(),
    request_id: z.string(),
    details: z.unknown().optional(),
    stack: z.string().optional(),
  });

export interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
  stack?: string;
}

export function okEnvelope<T>(data: T, requestId: string): Envelope<T> {
  return { code: 0, msg: 'success', data, request_id: requestId };
}

/** How many stack frames a summarized stack keeps before the omission marker. */
const MAX_STACK_FRAMES = 3;

/**
 * Absolute-looking path segments (POSIX, Windows drive, or `file://`). The
 * negative lookbehind keeps opaque identifiers such as `node:internal/...`
 * intact — those are standard runtime locations, not host filesystem paths.
 */
const ABSOLUTE_PATH_PATTERN = /(?<![\w:])(?:[A-Za-z]:[\\/]|\/)(?:[^\s()"':]+[\\/])+[^\s()"':]+/g;

/** Trailing `file:line:column` of a V8 stack frame, with or without parentheses. */
const FRAME_LOCATION_PATTERN = /\(?([^\s()]+?):(\d+):(\d+)\)?\s*$/;

/**
 * Reduce a path to its final segment. `node:` specifiers are already opaque
 * and keep their full form so runtime frames stay readable.
 */
function basename(filePath: string): string {
  if (filePath.startsWith('node:')) return filePath;
  const withoutScheme = filePath.startsWith('file://') ? filePath.slice('file://'.length) : filePath;
  const segments = withoutScheme.split(/[\\/]/);
  return segments.at(-1) ?? withoutScheme;
}

/** Replace every absolute path in free text with its final segment. */
function redactPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH_PATTERN, (match) => basename(match));
}

function stripFrameDirectories(line: string): string {
  const match = FRAME_LOCATION_PATTERN.exec(line);
  const file = match?.[1];
  if (match === null || file === undefined) return redactPaths(line);
  const location = match[0];
  const base = basename(file);
  if (base === file) return line;
  return line.slice(0, line.length - location.length) + location.replace(file, () => base);
}

/**
 * Summarize a stack trace before it goes on the wire: keep the message line
 * plus at most `maxFrames` frames, and reduce every frame's file path to its
 * basename so host directories (user names, build roots, checkout paths) do
 * not leak. The `Error: …` message line and function names are preserved so
 * operators can still see where a failure originated.
 */
export function summarizeStack(stack: string, maxFrames: number = MAX_STACK_FRAMES): string {
  const headerLines: string[] = [];
  const frames: string[] = [];
  for (const rawLine of stack.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) continue;
    if (line.trimStart().startsWith('at ')) frames.push(line);
    else headerLines.push(redactPaths(line));
  }

  const kept = frames.slice(0, maxFrames).map(stripFrameDirectories);
  const omitted = frames.length - kept.length;
  const parts = [...headerLines, ...kept];
  if (omitted > 0) parts.push(`    ... ${String(omitted)} more frame(s) omitted`);
  return parts.join('\n');
}

/**
 * Build an error envelope. When `stack` is provided it is summarized first
 * (see {@link summarizeStack}) so internal paths never reach the wire; when
 * omitted, empty, or whitespace-only the field is absent and the wire shape
 * stays byte-identical to the original `{ code, msg, data: null, request_id }`
 * — `JSON.stringify` drops `undefined` properties, so callers that have no
 * stack are unaffected.
 */
export function errEnvelope(
  code: number,
  msg: string,
  requestId: string,
  stack?: string,
): Envelope<null> {
  const summary = stack === undefined ? '' : summarizeStack(stack);
  return {
    code,
    msg,
    data: null,
    request_id: requestId,
    stack: summary.length > 0 ? summary : undefined,
  };
}
