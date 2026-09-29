/** The caller owns the existing Leader task queue. This service proves actual
 * delivery immediately before committing completion facts, ledger and phase in
 * one complete-State CAS; archive must independently call verify again. */
import {
  type AppState,
  applyMutations,
  assertDeliveryCompletion,
  type Mutation,
} from '@agora/core-domain';
import { planDeliveryFinalization } from '@agora/core-orchestration';
import { localRecordHash } from '../../../../packages/runtime/sandbox/src/local-registry-records';
import type { LocalDeliveryApplication } from './local-delivery-application';

type Commit = (expected: AppState, mutations: readonly Mutation[]) => Promise<AppState>;
export class LocalDeliveryFinalization {
  constructor(
    private readonly application: Pick<LocalDeliveryApplication, 'verifyCurrent'>,
    private readonly commit: Commit,
  ) {}

  async finalize(expected: AppState): Promise<AppState> {
    if (expected.localExecution?.delivery?.goal !== 'apply_to_directory')
      throw Error('delivery_completion_goal_mismatch');
    const proof = await this.application.verifyCurrent(expected);
    if (!proof) return expected;
    const mutations = planDeliveryFinalization(expected, proof.message, Date.now());
    if (mutations.length === 0) return expected;
    const result = await this.commit(expected, mutations);
    if (localRecordHash(result) !== localRecordHash(applyMutations(expected, mutations)))
      throw Error('delivery_completion_commit_changed');
    assertDeliveryCompletion(result, proof.message);
    return result;
  }

  async verify(expected: AppState) {
    const proof = await this.application.verifyCurrent(expected);
    if (!proof) throw Error('delivery_completion_incomplete');
    assertDeliveryCompletion(expected, proof.message);
  }
}
