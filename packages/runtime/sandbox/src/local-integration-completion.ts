/** Complete one proven wave under the caller's serial task control. */
import {
  type AppState,
  applyMutations,
  type Mutation,
  planIntegrationCompletion,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import { LocalGitVersionStore } from './local-git-version-store';
import type { LocalGitWorkspaceOptions } from './local-git-workspaces';
import type {
  LocalIntegrationAuthority,
  LocalIntegrationCall,
} from './local-integration-authority';
import type { LocalIntegrationCandidates } from './local-integration-candidates';
import {
  completionApplications,
  completionKey,
  completionReceipt,
  type IntegrationCompletionPlan,
  readIntegrationCompletionPlan,
} from './local-integration-completion-records';
import { localRecordHash } from './local-registry-records';
import type {
  ValidationPreparationProofReader,
  ValidationPreparationReference,
} from './local-validation-preparation-control';
import type { LocalVersionStore } from './local-version-store';
import { serializeWorkspaceOperation } from './local-workspace-operation';

const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
export class LocalIntegrationCompletion {
  private readonly git: LocalGitWorkspaceOptions;
  constructor(
    private readonly options: {
      control: LocalBindingCoordinator;
      objects: LocalControlObjects;
      versions: LocalVersionStore;
      authority: LocalIntegrationAuthority;
      candidates: LocalIntegrationCandidates;
      gitOptions: LocalGitWorkspaceOptions;
      state: {
        compareAndCommit(
          scope: { projectId: string; taskId: string },
          expected: AppState,
          mutations: readonly Mutation[],
        ): Promise<{ state: AppState; changed: boolean }>;
      };
    },
  ) {
    this.git = structuredClone(options.gitOptions);
  }

  async complete(input: LocalIntegrationCall, expected: AppState): Promise<AppState> {
    const call = structuredClone(input),
      before = structuredClone(expected);
    return serializeWorkspaceOperation(
      { ...call, workspaceId: `application:${call.integrationId}` },
      async () => {
        const { objects, control, state } = this.options;
        if (await objects.getReference(completionKey(call, 'invalid')))
          throw Error('integration_completion_recovery_required');
        const live = await control.assertClosed(call);
        if (!equal(live, before)) throw Error('integration_completion_state_changed');
        if (!(await objects.getReference(completionKey(call, 'plan')))) {
          const mutations = planIntegrationCompletion(live, live);
          const verified = await this.history(call, false);
          if (!equal(verified.checkpoint.state, live))
            throw Error('integration_completion_state_changed');
          const after = applyMutations(live, mutations);
          if ((await objects.references()).length > 4093) throw Error('control_reference_limit');
          const plan: IntegrationCompletionPlan = {
            schemaVersion: 'local-integration-completion-plan-v1',
            call,
            beforeHash: await objects.put(live),
            afterHash: localRecordHash(after),
            registryRevision: verified.checkpoint.snapshot.revision,
            applications: completionApplications(verified.prefix),
            version: verified.version,
          };
          await verified.checkpoint.authorize();
          await objects.bindReference(completionKey(call, 'plan'), await objects.put(plan));
        }
        const proof = await readIntegrationCompletionPlan(objects, call, live);
        if (proof.confirmed) return this.read(call);
        await this.history(call, true);
        // An exception here may follow a durable commit. Preserve the plan for retry.
        const committed = proof.mutations.length
          ? await state.compareAndCommit(call, proof.before, proof.mutations)
          : undefined;
        try {
          if (committed && (!committed.changed || !equal(committed.state, proof.after)))
            throw Error('integration_completion_state_changed');
          await this.history(call, true);
          const current = await control.assertClosed(call);
          const checked = await readIntegrationCompletionPlan(objects, call, current);
          if (checked.mutations.length) throw Error('integration_completion_state_changed');
          await objects.bindReference(
            completionKey(call, 'confirmed'),
            await objects.put(completionReceipt(proof.planHash, proof.plan)),
          );
          return await this.read(call);
        } catch (error) {
          await objects.bindReference(
            completionKey(call, 'invalid'),
            await objects.put({
              schemaVersion: 'local-integration-completion-invalid-v1',
              planHash: proof.planHash,
            }),
          );
          throw error;
        }
      },
    );
  }
  /** Exact completed checkpoint only; later validation handoff is a separate capability. */
  async read(input: LocalIntegrationCall): Promise<AppState> {
    const call = structuredClone(input),
      { control, objects } = this.options;
    const before = await control.assertClosed(call);
    const proof = await readIntegrationCompletionPlan(objects, call, before);
    if (!proof.confirmed || proof.mutations.length)
      throw Error('integration_completion_recovery_required');
    await this.history(call, true);
    const after = await control.assertClosed(call);
    const checked = await readIntegrationCompletionPlan(objects, call, after);
    if (!equal(before, after) || !equal(checked, proof))
      throw Error('integration_completion_state_changed');
    return after;
  }
  /** Internal historical verification; the handoff reader admits only exact closure states. */
  async readHandoff(call: LocalIntegrationCall) {
    return this.history(structuredClone(call), 'handoff');
  }
  /** Recheck the original physical completion under a fixed post-dispatch plan. */
  async verifyPreparation(
    call: LocalIntegrationCall,
    control: ValidationPreparationProofReader,
    reference: ValidationPreparationReference,
  ): Promise<WorkspaceVersionV1> {
    return (await this.history(structuredClone(call), 'preparation', { control, reference }))
      .version;
  }
  private async history(
    call: LocalIntegrationCall,
    completing: boolean | 'handoff' | 'preparation',
    preparation?: {
      control: ValidationPreparationProofReader;
      reference: ValidationPreparationReference;
    },
  ) {
    const authority =
      completing === 'preparation' && preparation
        ? this.options.authority.preparationReader(call, preparation.control, preparation.reference)
        : completing === 'handoff'
          ? this.options.authority.handoffReader(call)
          : completing
            ? this.options.authority.completionReader(call)
            : this.options.authority;
    const candidates =
      completing === 'preparation' && preparation
        ? this.options.candidates.preparationReader(
            call,
            preparation.control,
            preparation.reference,
          )
        : completing === 'handoff'
          ? this.options.candidates.handoffReader(call)
          : completing
            ? this.options.candidates.completionReader(call)
            : this.options.candidates;
    const checkpoint = await authority.readCheckpoint(call);
    const prefix = await candidates.readConfirmedPrefix(call);
    const latest = prefix[0];
    if (!latest || prefix.length !== checkpoint.integration.pendingBranches.length)
      throw Error('integration_completion_recovery_required');
    planIntegrationCompletion(checkpoint.state, checkpoint.state);
    const { root, grant, record, workspace, authorize } = checkpoint;
    const scope = {
      projectId: call.projectId,
      taskId: call.taskId,
      rootId: root.rootId,
      policyHash: grant.policyHash,
    };
    await new LocalGitVersionStore(this.options.objects, this.options.versions).verify(
      latest.result.version,
      scope,
      {
        ...this.git,
        ...scope,
        root: root.path,
        sourceRoot: root,
        workspace,
        record,
        expectedHead: latest.result.publication.commit,
        actionId: record.initialization.actionId,
        creationActionId: record.creation.actionId,
        bindingReceiptId: record.bindingReceiptId,
        authorize,
      },
    );
    await authorize();
    return { checkpoint, prefix, version: latest.result.version };
  }
}
