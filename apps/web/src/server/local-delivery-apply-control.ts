/** Explicit Phase 12 host binding. MessageRuntime supplies the canonical Leader
 * message while holding the existing task queue; this does not expose a generic
 * filesystem or execution endpoint. */
import {
  type AppState,
  localDeliveryAwaitsApplication,
  type Message,
  parseWorkspaceControl,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalDeliveryAuthority } from '../../../../packages/runtime/sandbox/src/local-delivery-authority';
import type { LocalDeliveryTreeBatch } from '../../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import type { LocalDeliveryApplication } from './local-delivery-application';
import type { WorkspaceControlPort } from './message-runtime';

type Scope = { projectId: string; taskId: string };
type Options = {
  control: Pick<LocalBindingCoordinator, 'assertClosed'>;
  authority: Pick<LocalDeliveryAuthority, 'acquire' | 'assertCall'>;
  batch: Pick<LocalDeliveryTreeBatch, 'apply'>;
  application: Pick<LocalDeliveryApplication, 'complete'>;
  fallback: WorkspaceControlPort;
  /** Only new application completion may request the no-worker completion run. */
  startFinalization?: (state: AppState) => Promise<void>;
};
export class LocalDeliveryApplyControl implements WorkspaceControlPort {
  constructor(private readonly options: Options) {}

  async commit(scope: Scope, input: Message): Promise<AppState> {
    const message = structuredClone(input);
    if (parseWorkspaceControl(message.display)?.verb !== 'apply')
      return this.options.fallback.commit(scope, message);
    const { control, authority, batch, application } = this.options;
    const admitted = await authority.acquire(scope, message);
    // A replay acknowledges its original control fact, not current delivery
    // eligibility. It never fills an absent effect or restarts a model.
    if (admitted.replayed) return control.assertClosed(scope);
    const { proposal } = await authority.assertCall(admitted.call, 'edit');
    const source = proposal.source;
    const result = await batch.apply(admitted.call, message.msgId, {
      scope: source.scope,
      baseline: source.baseline,
      artifact: source.artifact,
      current: source.current,
    });
    if (result.stage !== 'applied') throw Error(`delivery_application_${result.stage}`);
    await application.complete(admitted.call);
    const state = await control.assertClosed(scope);
    if (localDeliveryAwaitsApplication(state)) await this.options.startFinalization?.(state);
    return control.assertClosed(scope);
  }
}
