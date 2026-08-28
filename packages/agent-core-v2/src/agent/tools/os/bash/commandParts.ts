import type { BashSyntaxNode, IBashParserService } from '#/app/bashParser/bashParser';
import { escapeRuleSubjectLiteral, matchesGlobRuleSubject } from '#/tool/rule-match';
import type { RuleMatchDecision } from '#/tool/toolContract';

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
  parser: IBashParserService,
  command: string,
): () => readonly string[] | null {
  let cached: readonly string[] | null | undefined;
  return () => {
    if (cached === undefined) cached = computeCommandParts(parser, command);
    return cached;
  };
}

function computeCommandParts(parser: IBashParserService, command: string): readonly string[] | null {
  const parsed = parser.parse(command, BASH_RULE_PARSE_OPTIONS);
  if (!parsed.ok || parsed.hasError) return null;
  return extractCommandParts(parsed.root);
}

export function extractCommandParts(root: BashSyntaxNode): string[] {
  const parts: string[] = [];
  const stack: Array<readonly [BashSyntaxNode, boolean]> = [[root, false]];
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

function executableText(node: BashSyntaxNode): string {
  const assignments = leadingAssignments(node);
  if (assignments.length === 0) return node.text;
  return node.text.slice(assignments[assignments.length - 1]!.endIndex).trim();
}

function leadingAssignments(node: BashSyntaxNode): BashSyntaxNode[] {
  const assignments: BashSyntaxNode[] = [];
  for (const child of node.children) {
    if (child.type === 'variable_assignment') assignments.push(child);
    else break;
  }
  return assignments;
}
