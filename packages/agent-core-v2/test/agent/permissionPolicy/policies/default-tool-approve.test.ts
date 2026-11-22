import type { ToolCall } from '#/kosong/contract/message';
import { describe, expect, it } from 'vitest';

import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { DefaultToolApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/default-tool-approve';
import { ToolAccesses } from '#/tool/toolContract';

const signal = new AbortController().signal;

function policyContext(toolName: string, args: unknown): ResolvedToolExecutionHookContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args,
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    toolCalls: [
      {
        type: 'function',
        id: `call_${toolName}`,
        name: toolName,
        arguments: JSON.stringify(args),
      },
    ],
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as ResolvedToolExecutionHookContext;
}

describe('DefaultToolApprovePermissionPolicyService', () => {
  const policy = new DefaultToolApprovePermissionPolicyService();

  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['Grep', { pattern: 'TODO', path: '/workspace' }],
    ['Glob', { pattern: '**/*.ts', path: '/workspace' }],
    ['ReadMediaFile', { path: '/workspace/image.png' }],
    ['SetTodoList', { items: [] }],
    ['TodoList', {}],
    ['TaskList', {}],
    ['TaskOutput', { task_id: 'task_1' }],
    ['AgentResult', { agent_id: 'agent-1' }],
    ['AgentHealth', { agent_id: 'agent-1' }],
    ['WaitForAll', { timeout: 60 }],
    ['CronList', {}],
    ['WebSearch', { query: 'kimi code' }],
    ['FetchURL', { url: 'https://example.com' }],
    ['Agent', { prompt: 'review this' }],
    [
      'AgentSwarm',
      {
        description: 'Check files',
        prompt_template: 'Check {{item}}',
        items: ['a.ts', 'b.ts'],
      },
    ],
    ['AskUserQuestion', { questions: [] }],
    ['Skill', { name: 'test-skill' }],
    ['SendMessage', { to: 'main', message: 'status?' }],
    ['ListAgents', {}],
    ['ListMessages', { from: 'scout', limit: 10 }],
    ['ReplyMessage', { message_id: 'message-1', message: 'status?' }],
    ['BroadcastMessage', { message: 'all hands' }],
    ['EnterPlanMode', {}],
    ['ExitPlanMode', {}],
    ['CreateGoal', { title: 'ship it' }],
    ['GetGoal', {}],
    ['SetGoalBudget', { tokenBudget: 1000 }],
    ['UpdateGoal', { status: 'complete' }],
  ] as const)('approves %s', (toolName, args) => {
    expect(policy.evaluate(policyContext(toolName, args))).toEqual({ kind: 'approve' });
  });

  it.each([
    ['Bash', { command: 'printf first', timeout: 60 }],
    ['Write', { path: '/workspace/a.ts', content: 'x' }],
    ['Edit', { path: '/workspace/a.ts', old_string: 'a', new_string: 'b' }],
    ['Custom', { value: 1 }],
    ['CronCreate', { cron: '*/5 * * * *', prompt: 'ping' }],
    ['CronDelete', { id: 'job_1' }],
    ['StopAgent', { agent_id: 'agent-2' }],
    ['StopAgents', { task_ids: ['task-1'] }],
    ['DismissAgents', { ids: ['agent-2'] }],
    ['TagAgent', { agent_id: 'agent-2', tags: ['a'] }],
    ['RenameAgent', { agent_id: 'agent-2', name: 'scout' }],
    ['InterruptAgent', { agent_id: 'agent-2' }],
  ] as const)('does not approve %s', (toolName, args) => {
    expect(
      policy.evaluate(policyContext(toolName, args)),
    ).toBeUndefined();
  });
});
