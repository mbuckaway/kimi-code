/**
 * Bash command decomposition for permission-rule matching (v1 mirror of the
 * `agent-core-v2` helper, duplicated per package because the two engines
 * share no code).
 *
 * Splits a parsed bash command into the executable unit texts — commands and
 * test commands (with their redirections attached, and leading env-prefix
 * assignments such as `DEBUG=1` stripped so the rule judges the command that
 * actually runs), standalone variable assignments, redirected groups, and the
 * payloads of command / process substitutions at any depth — so rule
 * evaluation can judge a compound command per unit instead of as one opaque
 * string. A `deny`/`ask` rule matches when the whole command or any unit
 * matches. An `allow` rule auto-matches only when the command parses cleanly
 * and every unit matches, or the pattern is the escaped literal of the whole
 * command (the session-approval shape, which re-approves a previously
 * approved compound command without letting a wildcard span operators) —
 * parse failure or budget exhaustion must not fall back to whole-string
 * globbing, since both are exactly the over-match being closed. An unknown
 * (undefined) decision never expands into per-part matching, since that
 * expansion is only sound once the allow/deny direction is known. Quoted
 * operators and heredoc bodies are data, not units — extraction trusts the
 * grammar, which only surfaces substitution nodes where bash would execute
 * them. The tree walk is iterative because in-budget trees can still be
 * thousands of levels deep.
 */

import type { ParseOptions, ParseResult, SyntaxNode } from '@moonshot-ai/tree-sitter-bash';

import { escapeRuleSubjectLiteral, matchesGlobRuleSubject } from '../../support/rule-match';
import type { RuleMatchDecision } from '../../../loop/types';

const BASH_RULE_PARSE_OPTIONS = { timeoutMs: 100, maxNodes: 50_000 } as const;

const COMMAND_LIKE_TYPES: ReadonlySet<string> = new Set([
  'command',
  'test_command',
  'declaration_command',
  'unset_command',
]);

const SUBSTITUTION_TYPES: ReadonlySet<string> = new Set([
  'command_substitution',
  'process_substitution',
]);

export type BashRuleParser = (source: string, options?: ParseOptions) => ParseResult;

export function matchesDecomposedCommandRule(
  ruleArgs: string,
  command: string,
  decision: RuleMatchDecision | undefined,
  parts: () => readonly string[] | null,
): boolean {
  if (decision === 'allow') {
    const resolved = parts();
    if (
      resolved !== null &&
      resolved.length > 0 &&
      resolved.every((part) => matchesGlobRuleSubject(ruleArgs, part))
    ) {
      return true;
    }
    return ruleArgs === escapeRuleSubjectLiteral(command);
  }
  if (matchesGlobRuleSubject(ruleArgs, command)) return true;
  if (decision === undefined) return false;
  const resolved = parts();
  return resolved !== null && resolved.some((part) => matchesGlobRuleSubject(ruleArgs, part));
}

export function createCommandPartsProvider(
  parser: BashRuleParser,
  command: string,
): () => readonly string[] | null {
  let cached: readonly string[] | null | undefined;
  return () => {
    if (cached === undefined) cached = computeCommandParts(parser, command);
    return cached;
  };
}

function computeCommandParts(parser: BashRuleParser, command: string): readonly string[] | null {
  const parsed = parser(command, BASH_RULE_PARSE_OPTIONS);
  if (!parsed.ok || parsed.hasError) return null;
  return extractCommandParts(parsed.rootNode);
}

export function extractCommandParts(root: SyntaxNode): string[] {
  const parts: string[] = [];
  const stack: Array<readonly [SyntaxNode, boolean]> = [[root, false]];
  while (stack.length > 0) {
    const [node, covered] = stack.pop()!;
    let childrenCovered = covered;
    if (SUBSTITUTION_TYPES.has(node.type)) {
      childrenCovered = false;
    } else if (COMMAND_LIKE_TYPES.has(node.type)) {
      if (!covered) parts.push(executableText(node));
      childrenCovered = true;
    } else if (node.type === 'variable_assignment') {
      if (!covered) parts.push(node.text);
      childrenCovered = true;
    } else if (node.type === 'redirected_statement') {
      if (!covered) parts.push(node.text);
      childrenCovered = node.children.some(
        (child) => child.isNamed && COMMAND_LIKE_TYPES.has(child.type),
      );
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i]!;
      if (child.isNamed) stack.push([child, childrenCovered]);
    }
  }
  return parts;
}

function executableText(node: SyntaxNode): string {
  const assignments = leadingAssignments(node);
  if (assignments.length === 0) return node.text;
  return node.text.slice(assignments[assignments.length - 1]!.endIndex).trim();
}

function leadingAssignments(node: SyntaxNode): SyntaxNode[] {
  const assignments: SyntaxNode[] = [];
  for (const child of node.children) {
    if (child.type === 'variable_assignment') assignments.push(child);
    else break;
  }
  return assignments;
}
