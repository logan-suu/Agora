/** Structural control companion consumed by the host message runtime. Long
 * native/session closure is explicitly separated from the canonical queue. */
import { type AppState, type Message, parseWorkspaceControl } from '@agora/core-domain';
import type { LocalRangeController } from './local-range-controller';
import type { LocalRangeReturnController } from './local-range-return-controller';

type Scope = { projectId: string; taskId: string };
interface Delegate {
  commit(scope: Scope, message: Message): Promise<AppState>;
  afterCommit?(scope: Scope, message: Message): Promise<AppState | undefined>;
}
export class LocalRangeMessageControl implements Delegate {
  constructor(
    private readonly take: LocalRangeController,
    private readonly returns: LocalRangeReturnController,
    private readonly tasks: { load(scope: Scope): Promise<AppState | undefined> },
    private readonly fallback: Delegate,
  ) {}
  commit(scope: Scope, message: Message): Promise<AppState> {
    const intent = parseWorkspaceControl(message.display);
    if (intent?.verb === 'takeover') return this.take.commit(scope, message);
    if (intent?.verb === 'return') return this.returns.commit(scope, message);
    return this.fallback.commit(scope, message);
  }
  async afterCommit(scope: Scope, message: Message): Promise<AppState | undefined> {
    const intent = parseWorkspaceControl(message.display);
    if (intent?.verb !== 'takeover' && intent?.verb !== 'return')
      return this.fallback.afterCommit?.(scope, message);
    if (intent.verb === 'takeover') await this.take.hold(`takeover:${intent.actionId}`);
    else await this.returns.release(intent.takeoverReceiptId);
    const state = await this.tasks.load(scope);
    if (!state || state.projectId !== scope.projectId || state.taskId !== scope.taskId)
      throw Error('workspace_task_scope_mismatch');
    return state;
  }
}
