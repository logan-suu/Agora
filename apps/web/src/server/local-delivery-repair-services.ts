/** Host-owned assembly of repair control ports. Callers retain the task queue,
 * engine eligibility and native capability ownership; no HTTP/model input here. */
import type { AppState, Mutation } from '@agora/core-domain';
import type { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalDeliveryRepairs } from '../../../../packages/runtime/sandbox/src/local-delivery-repairs';
import { localRecordHash } from '../../../../packages/runtime/sandbox/src/local-registry-records';
import type { LocalWorkspaceSessions } from '../../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { LocalDeliveryRepairCompletion } from './local-delivery-repair-completion';
import { LocalDeliveryRepairControl } from './local-delivery-repair-control';
import { LocalValidationService } from './local-validation';

type Scope = { projectId: string; taskId: string };
export function createLocalDeliveryRepairServices(options: {
  control: LocalBindingCoordinator;
  repairs: LocalDeliveryRepairs;
  local: LocalWorkspaceSessions;
  loadState(scope: Scope): Promise<AppState | undefined>;
  assertReady(state: AppState): Promise<void>;
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
  compareAndCommit(state: AppState, mutations: readonly Mutation[]): Promise<AppState>;
}) {
  const validator = (state: AppState) =>
    new LocalValidationService(options.local, () => options.control.assertClosed(state));
  const evidence = {
    assertReady: options.assertReady,
    verifyGrant: options.verifyGrant,
    loadState: options.loadState,
    verifyClosedClaim: options.local.verifyClosedClaim.bind(options.local),
  };
  const prepare = new LocalDeliveryRepairControl(options.control, options.repairs, {
    ...evidence,
    verifySource: async (state, source) => {
      await validator(state).verify(state, source.validationReceiptId);
    },
  });
  const complete = new LocalDeliveryRepairCompletion(options.control, options.repairs, {
    ...evidence,
    verifySource: (state, workerId) => validator(state).verifyRepairSource(state, workerId),
    compareAndCommit: options.compareAndCommit,
  });
  return {
    prepare: prepare.prepare.bind(prepare),
    complete: async (state: AppState, workerId: string) => {
      if (localRecordHash(await options.control.assertClosed(state)) !== localRecordHash(state))
        throw Error('delivery_transition_state_changed');
      return complete.complete(state, workerId);
    },
    verifySource: (state: AppState, workerId: string) =>
      validator(state).verifyRepairSource(state, workerId),
  };
}
