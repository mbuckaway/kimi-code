import type { ContextMessage } from '#/agent/contextMemory/types';
import { MessageStepRequest } from '#/agent/loop/stepRequest';

export class AgentMessageStepRequest extends MessageStepRequest {
  private released = false;

  constructor(
    message: ContextMessage,
    private readonly release: () => void,
  ) {
    super(message, {
      kind: 'agent_message',
      mergeable: true,
      turnScoped: false,
      admission: 'activeOrNewTurn',
    });
  }

  override onWillMaterialize(): void {
    this.releaseOnce();
  }

  override onTurnAbandoned(): readonly ContextMessage[] {
    return this.resolveContextMessages();
  }

  protected override onSettled(): void {
    this.releaseOnce();
  }

  private releaseOnce(): void {
    if (this.released) return;
    this.released = true;
    this.release();
  }
}
