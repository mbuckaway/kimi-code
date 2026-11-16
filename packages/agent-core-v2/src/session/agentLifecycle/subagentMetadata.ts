import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';

export function subagentLabels(
  parentAgentId: string,
  options: { readonly swarmItem?: string; readonly name?: string } = {},
): Readonly<Record<string, string>> {
  const labels: Record<string, string> = { parentAgentId };
  if (options.swarmItem !== undefined) {
    labels['swarmItem'] = options.swarmItem;
  }
  if (options.name !== undefined) {
    labels['name'] = options.name;
  }
  return labels;
}

export function labelsFromAgentMeta(
  meta: AgentMeta,
): Readonly<Record<string, string>> | undefined {
  const labels: Record<string, string> = { ...meta.labels };
  const parentAgentId = subagentParentAgentId(meta);
  if (parentAgentId !== undefined) {
    labels['parentAgentId'] = parentAgentId;
  }
  const swarmItem = subagentSwarmItem(meta);
  if (swarmItem !== undefined) {
    labels['swarmItem'] = swarmItem;
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

export function isSubagentMeta(meta: AgentMeta | undefined): boolean {
  if (meta === undefined) return false;
  if (subagentParentAgentId(meta) !== undefined) return true;
  return meta.type === 'sub';
}

export function subagentParentAgentId(meta: AgentMeta | undefined): string | undefined {
  if (meta === undefined) return undefined;
  return firstNonEmpty(meta.labels?.['parentAgentId'], meta.parentAgentId ?? undefined);
}

export function subagentSwarmItem(meta: AgentMeta | undefined): string | undefined {
  if (meta === undefined) return undefined;
  return firstNonEmpty(meta.labels?.['swarmItem'], meta.swarmItem);
}

export function subagentChildrenIndex(
  agents: Readonly<Record<string, AgentMeta>>,
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const agentId of Object.keys(agents)) {
    const parentAgentId = subagentParentAgentId(ownMeta(agents, agentId));
    if (parentAgentId === undefined || parentAgentId === agentId) continue;
    const children = index.get(parentAgentId);
    if (children === undefined) index.set(parentAgentId, [agentId]);
    else children.push(agentId);
  }
  for (const children of index.values()) {
    children.sort((left, right) => left.localeCompare(right));
  }
  return index;
}

export function subagentDescendantsChildFirst(
  agentId: string,
  children: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const descendants: string[] = [];
  const seen = new Set<string>([agentId]);
  const visit = (id: string): void => {
    for (const childId of children.get(id) ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      visit(childId);
      descendants.push(childId);
    }
  };
  visit(agentId);
  return descendants;
}

export function subagentAncestorIds(
  agentId: string,
  agents: Readonly<Record<string, AgentMeta>>,
): readonly string[] {
  const ancestors: string[] = [];
  const seen = new Set<string>([agentId]);
  let current = subagentParentAgentId(ownMeta(agents, agentId));
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    ancestors.push(current);
    current = subagentParentAgentId(ownMeta(agents, current));
  }
  return ancestors;
}

export function tagsOf(meta: AgentMeta): readonly string[] {
  const raw = meta.labels?.['tags'];
  if (raw === undefined) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    ),
  ];
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

export function ownMeta(
  agents: Readonly<Record<string, AgentMeta>>,
  agentId: string,
): AgentMeta | undefined {
  return Object.hasOwn(agents, agentId) ? agents[agentId] : undefined;
}
