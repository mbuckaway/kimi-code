/**
 * Covers: BackgroundManager.capacity, BackgroundManager.markTasksDeliveredViaWait.
 */

import { describe, expect, it, vi } from 'vitest';

import { agentTask, createBackgroundManager } from './helpers';

describe('BackgroundManager.capacity', () => {
  it('reports running count and the configured max', () => {
    const { manager } = createBackgroundManager({ maxRunningTasks: 3 });

    expect(manager.capacity()).toEqual({ running: 0, max: 3 });

    manager.registerTask(agentTask(new Promise(() => {}), 'one'));
    manager.registerTask(agentTask(new Promise(() => {}), 'two'));

    expect(manager.capacity()).toEqual({ running: 2, max: 3 });
  });

  it('reports max as undefined when no cap is configured', () => {
    const { manager } = createBackgroundManager();

    expect(manager.capacity()).toEqual({ running: 0, max: undefined });
  });

  it('excludes terminal tasks from the running count', async () => {
    const { manager } = createBackgroundManager();
    const doneId = manager.registerTask(agentTask(Promise.resolve({ result: 'done' }), 'done'));
    manager.registerTask(agentTask(new Promise(() => {}), 'pending'));

    // Settlement is async, so both tasks are still running immediately.
    expect(manager.capacity().running).toBe(2);

    await manager.wait(doneId);

    expect(manager.capacity()).toEqual({ running: 1, max: undefined });
  });
});

describe('BackgroundManager.markTasksDeliveredViaWait', () => {
  it('forwards one delivered origin per entry', () => {
    const { manager } = createBackgroundManager();
    const spy = vi.spyOn(manager, 'markDeliveredNotification');

    manager.markTasksDeliveredViaWait([
      { taskId: 't-1', status: 'completed' },
      { taskId: 't-2', status: 'failed' },
    ]);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, {
      kind: 'background_task',
      taskId: 't-1',
      status: 'completed',
      notificationId: 'task:t-1:completed',
    });
    expect(spy).toHaveBeenNthCalledWith(2, {
      kind: 'background_task',
      taskId: 't-2',
      status: 'failed',
      notificationId: 'task:t-2:failed',
    });
  });

  it('suppresses the completion notification for a matched task', async () => {
    const { agent, manager } = createBackgroundManager();
    let resolveCompletion!: (value: { result: string }) => void;
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const taskId = manager.registerTask(agentTask(completion, 'delivered'));

    manager.markTasksDeliveredViaWait([{ taskId, status: 'completed' }]);
    resolveCompletion({ result: 'done' });

    await manager.wait(taskId);
    await new Promise((resolve) => setImmediate(resolve));

    expect(agent.turn.steer).not.toHaveBeenCalled();
    expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
  });

  it('does not suppress the notification when the status differs', async () => {
    const { agent, manager } = createBackgroundManager();
    let resolveCompletion!: (value: { result: string }) => void;
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const taskId = manager.registerTask(agentTask(completion, 'delivered'));

    manager.markTasksDeliveredViaWait([{ taskId, status: 'failed' }]);
    resolveCompletion({ result: 'done' });

    await manager.wait(taskId);
    await new Promise((resolve) => setImmediate(resolve));

    expect(agent.turn.steer).toHaveBeenCalled();
  });
});
