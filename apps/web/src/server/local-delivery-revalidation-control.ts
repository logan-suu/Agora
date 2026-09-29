/** Explicit Leader revalidation launches exactly the newly registered round.
 * Replaying a durable action, including after launch failure, never bills again. */
import { type AppState, type Message, parseWorkspaceControl } from '@agora/core-domain';
import type { LocalDeliveryRevalidation } from './local-delivery-revalidation';
import type { WorkspaceControlPort } from './message-runtime';

type Scope = { projectId: string; taskId: string };
export class LocalDeliveryRevalidationControl implements WorkspaceControlPort {
  constructor(
    private readonly registration: Pick<LocalDeliveryRevalidation, 'commit'>,
    private readonly load: (scope: Scope) => Promise<AppState | undefined>,
    private readonly start: (registered: AppState) => Promise<void>,
    private readonly fallback: WorkspaceControlPort,
  ) {}
  async commit(scope: Scope, input: Message): Promise<AppState> {
    const message = structuredClone(input);
    if (parseWorkspaceControl(message.display)?.verb !== 'revalidate')
      return this.fallback.commit(scope, message);
    const before = await this.load(scope);
    if (!before || before.projectId !== scope.projectId || before.taskId !== scope.taskId)
      throw Error('delivery_revalidation_scope_changed');
    const replay = before.messages.some((m) => m.msgId === message.msgId);
    const registered = await this.registration.commit(scope, message);
    if (!replay) await this.start(registered);
    const current = await this.load(scope);
    if (!current || current.projectId !== scope.projectId || current.taskId !== scope.taskId)
      throw Error('delivery_revalidation_scope_changed');
    return current;
  }
}
