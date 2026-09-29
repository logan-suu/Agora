/** Restricted companion for an already registered, claimed native integration. */
import { type AppState, type Integration, selectIntegrationBranch } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import {
  type ApplicationPrepared,
  applicationPhase,
  applicationSlot,
  readCompletedApplication,
} from './local-integration-application-records';
import type {
  LocalIntegrationAuthority,
  LocalIntegrationCall,
} from './local-integration-authority';
import type { LocalIntegrationCompletion } from './local-integration-completion';
import type { LocalIntegrationPublication } from './local-integration-publication';
import { localRecordHash } from './local-registry-records';

const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
type IntegrationWavePlan = Pick<
  Integration,
  'integrationId' | 'waveId' | 'base' | 'pendingBranches'
>;
export class LocalIntegrationProgress {
  private readonly call: LocalIntegrationCall;
  constructor(
    private readonly options: {
      call: LocalIntegrationCall;
      control: LocalBindingCoordinator;
      objects: LocalControlObjects;
      authority: LocalIntegrationAuthority;
      publication: LocalIntegrationPublication;
      completion: LocalIntegrationCompletion;
    },
  ) {
    this.call = structuredClone(options.call);
  }

  private async current(expected: AppState) {
    const state = await this.options.control.assertClosed(this.call);
    if (!equal(state, expected) || state.integration?.integrationId !== this.call.integrationId)
      throw Error('integration_progress_state_changed');
    return state;
  }
  async prepare(expected: AppState, plan: IntegrationWavePlan) {
    const state = await this.current(expected),
      integration = state.integration;
    if (
      !integration ||
      !equal(
        {
          integrationId: integration.integrationId,
          waveId: integration.waveId,
          base: integration.base,
          pendingBranches: integration.pendingBranches,
        },
        plan,
      )
    )
      throw Error('integration_progress_plan_mismatch');
    if (integration.status === 'done') return state;
    if (integration.status !== 'merging') throw Error('integration_progress_not_ready');
    // A previous acknowledgement may have committed but lost its response or
    // confirmation marker. Recover that original slot, never the next source.
    if (integration.mergedBranches.length) {
      const wave = state.parallelExecution?.activeWave;
      if (!wave) throw Error('integration_progress_plan_mismatch');
      const key = applicationSlot(this.call, {
        waveId: wave.waveId,
        attempt: wave.attempt,
        position: integration.mergedBranches.length - 1,
      });
      if (!(await this.options.objects.getReference(applicationPhase(key, 'state-confirmed'))))
        await this.options.publication.acknowledgePublished(await this.original(key));
    }
    return this.current(state);
  }
  private async original(key: string) {
    const { objects } = this.options;
    const hash = await objects.getReference(applicationPhase(key, 'prepared'));
    if (!hash) throw Error('integration_application_recovery_required');
    const prepared = (await objects.get(hash)) as ApplicationPrepared;
    const proof = await readCompletedApplication(objects, prepared.request);
    if (proof.key !== key || !equal(prepared.request.call, this.call))
      throw Error('integration_application_recovery_required');
    return prepared.request;
  }
  async advance(expected: AppState) {
    const state = await this.current(expected);
    const selection = selectIntegrationBranch(state, this.call.integrationId);
    const key = applicationSlot(this.call, selection);
    const existing = await this.options.objects.getReference(applicationPhase(key, 'prepared'));
    const request = existing
      ? await this.original(key)
      : { call: this.call, actionId: `integrate:${key}` };
    if (!existing) await this.options.publication.applyNext(request);
    await this.options.publication.acknowledgePublished(request);
    return this.options.control.assertClosed(this.call);
  }
  async complete(expected: AppState) {
    await this.current(expected);
    return this.options.completion.complete(this.call, expected);
  }
  async verify(expected: AppState) {
    await this.current(expected);
    // A done State with an uncertain completion needs explicit completion retry.
    // complete reads the saved plan and never repeats file/Git effects.
    return this.options.completion.complete(this.call, expected);
  }
}
