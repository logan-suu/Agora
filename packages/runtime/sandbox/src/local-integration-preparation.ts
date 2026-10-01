/** Trusted first-wave preparation. Caller retains serial task control throughout. */
import { createHash } from 'node:crypto';
import {
  type AppState,
  applyMutations,
  type IntegrationWavePlan,
  integrationIdentityInput,
  type Mutation,
  planIntegrationPreparation,
  readCodingWorkerLineage,
  validationReceipt,
  type WorktreeRef,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalGitWorkspaces } from './local-git-workspaces';
import type {
  LocalIntegrationAuthority,
  LocalIntegrationCall,
} from './local-integration-authority';
import { isLocalBindingOperation, localRecordHash } from './local-registry-records';
import { serializeWorkspaceOperation } from './local-workspace-operation';

type InitialRegistration = Parameters<LocalGitWorkspaces['registerInitial']>[0];
type WaveRegistration = Parameters<LocalGitWorkspaces['registerIntegrationWave']>[0];
type Registration = InitialRegistration | WaveRegistration;
type Request = {
  projectId: string;
  taskId: string;
  actionId: string;
  workspaceId: string;
  registration: Registration;
};
type Plan = {
  schemaVersion: 'local-integration-preparation-v1';
  request: Request;
  wave: IntegrationWavePlan;
  target: WorktreeRef;
  beforeHash: string;
  afterHash: string;
  registryRevision: number;
  registryHash: string;
};
type Receipt = {
  schemaVersion: 'local-integration-prepared-v1';
  planHash: string;
  stateHash: string;
  registryHash: string;
  call: LocalIntegrationCall;
};
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
export const integrationPreparationKey = (
  scope: { projectId: string; taskId: string },
  actionId: string,
  stage: string,
) =>
  localRecordHash({
    kind: 'integration-preparation',
    projectId: scope.projectId,
    taskId: scope.taskId,
    actionId,
    stage,
  });

export class LocalIntegrationPreparation {
  private readonly request: Request;
  constructor(
    private readonly options: {
      request: Request;
      control: LocalBindingCoordinator;
      objects: LocalControlObjects;
      workspaces: LocalGitWorkspaces;
      authority: LocalIntegrationAuthority;
      assertControl(): Promise<void>;
      state: {
        compareAndCommit(
          scope: { projectId: string; taskId: string },
          expected: AppState,
          mutations: readonly Mutation[],
        ): Promise<{ state: AppState; changed: boolean }>;
      };
    },
  ) {
    this.request = structuredClone(options.request);
  }

  async prepare(expected: AppState, input: IntegrationWavePlan) {
    const request = this.request,
      wave = structuredClone(input),
      beforeCall = structuredClone(expected);
    const integrationId = `integration-${createHash('sha256')
      .update(
        integrationIdentityInput(
          beforeCall.taskId,
          wave.waveId,
          wave.base.commit,
          wave.pendingBranches,
        ),
      )
      .digest('hex')
      .slice(0, 24)}`;
    if (
      wave.integrationId !== integrationId ||
      Object.keys(request).sort().join(',') !==
        'actionId,projectId,registration,taskId,workspaceId' ||
      ![request.projectId, request.taskId, request.actionId, request.workspaceId].every((id) =>
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id),
      ) ||
      request.projectId !== beforeCall.projectId ||
      request.taskId !== beforeCall.taskId ||
      request.registration.projectId !== request.projectId ||
      request.registration.taskId !== request.taskId ||
      request.registration.targets.length !== 1 ||
      !equal(request.registration.targets[0], {
        workspaceId: request.workspaceId,
        purpose: 'integration',
      }) ||
      ('waveId' in request.registration &&
        (() => {
          const registration = request.registration as WaveRegistration;
          const lineage = readCodingWorkerLineage(beforeCall);
          const accepted = lineage.sourceReceiptId
            ? validationReceipt(beforeCall, lineage.sourceReceiptId)
            : undefined;
          const sourceWorkspaceId = accepted
            ? beforeCall.localExecution?.bindings.find(
                (binding) => binding.workerId === accepted.workerId,
              )?.workspaceId
            : lineage.conflictReworks.length
              ? beforeCall.localExecution?.git?.initialWorkspaceId
              : undefined;
          return (
            (!accepted && !lineage.conflictReworks.length) ||
            registration.waveId !== wave.waveId ||
            registration.attempt !== lineage.attempt ||
            registration.sourceWorkspaceId !== sourceWorkspaceId ||
            registration.version.kind !== 'git' ||
            registration.version.commit !== wave.base.commit
          );
        })())
    )
      throw Error('integration_preparation_mismatch');
    return serializeWorkspaceOperation(
      { ...request, workspaceId: `preparation:${request.taskId}` },
      async () => {
        const { control, objects, authority } = this.options;
        const key = (stage: string) => integrationPreparationKey(request, request.actionId, stage);
        const slot = integrationPreparationKey(request, wave.integrationId, 'slot');
        await this.options.assertControl();
        if (await objects.getReference(key('invalid')))
          throw Error('integration_preparation_recovery_required');
        if (!equal(await control.assertClosed(request), beforeCall))
          throw Error('integration_preparation_state_changed');
        let planHash = await objects.getReference(key('plan'));
        if (!planHash) {
          if (await objects.getReference(slot)) throw Error('operation_conflict');
          // A missing original registration must not turn preparation into workspace creation.
          const registrationKey = localRecordHash({
            kind: 'waveId' in request.registration ? 'integration-git-batch' : 'initial-git-batch',
            projectId: request.projectId,
            taskId: request.taskId,
            actionId: request.registration.actionId,
          });
          if (!(await objects.getReference(registrationKey)))
            throw Error('integration_preparation_registration_missing');
          const snapshot = await control.snapshot();
          await this.replayRegistration();
          await this.options.assertControl();
          if (
            !equal(await control.assertClosed(request), beforeCall) ||
            !equal(await control.snapshot(), snapshot)
          )
            throw Error('integration_preparation_state_changed');
          const workspace = snapshot.workspaces.find(
            (w) =>
              w.workspaceId === request.workspaceId &&
              w.projectId === request.projectId &&
              w.taskId === request.taskId,
          );
          const physical = snapshot.linkedRoots?.find((r) => r.workspaceId === request.workspaceId);
          if (
            workspace?.mode !== 'linked-worktree' ||
            workspace.purpose !== 'integration' ||
            !physical ||
            snapshot.claims.some(
              (c) => c.workspaceId === request.workspaceId && c.status !== 'released',
            )
          )
            throw Error('integration_preparation_mismatch');
          const target = {
            path: physical.path,
            branch: workspace.branch,
            baseCommit: workspace.baseCommit,
            headCommit: workspace.baseCommit,
          };
          const after = applyMutations(
            beforeCall,
            planIntegrationPreparation(beforeCall, beforeCall, wave, target),
          );
          const plan: Plan = {
            schemaVersion: 'local-integration-preparation-v1',
            request,
            wave,
            target,
            beforeHash: await objects.put(beforeCall),
            afterHash: localRecordHash(after),
            registryRevision: snapshot.revision,
            registryHash: await objects.put(snapshot),
          };
          if ((await objects.references()).length > 4092) throw Error('control_reference_limit');
          planHash = await objects.put(plan);
          await objects.bindReference(slot, planHash);
          await objects.bindReference(key('plan'), planHash);
        }
        const plan = (await objects.get(planHash)) as Plan;
        const before = (await objects.get(plan.beforeHash)) as AppState;
        const originalRegistry = (await objects.get(plan.registryHash)) as Awaited<
          ReturnType<LocalBindingCoordinator['snapshot']>
        >;
        const mutations = planIntegrationPreparation(before, before, wave, plan.target);
        const after = applyMutations(before, mutations);
        if (
          !Number.isSafeInteger(plan.registryRevision) ||
          plan.registryRevision < 0 ||
          originalRegistry.revision !== plan.registryRevision ||
          !equal(plan, {
            schemaVersion: 'local-integration-preparation-v1',
            request,
            wave,
            target: plan.target,
            beforeHash: localRecordHash(before),
            afterHash: localRecordHash(after),
            registryRevision: plan.registryRevision,
            registryHash: localRecordHash(originalRegistry),
          }) ||
          (await objects.getReference(slot)) !== planHash
        )
          throw Error('operation_conflict');
        const confirmed = await objects.getReference(key('confirmed'));
        const claimAction = `prepare-claim:${key('plan')}`;
        const assertBound = (
          state: AppState,
          snapshot: typeof originalRegistry,
          call: LocalIntegrationCall,
        ) => {
          const operation = snapshot.operations.at(-1),
            claim = snapshot.claims.at(-1);
          if (
            !operation ||
            !isLocalBindingOperation(operation) ||
            operation.actionId !== claimAction ||
            operation.stage !== 'committed' ||
            operation.preparedRevision !== plan.registryRevision + 1 ||
            claim?.claimId !== call.claimId ||
            claim.createdActionId !== claimAction ||
            !equal(operation.nextLocalExecution, state.localExecution) ||
            !equal({ ...state, localExecution: after.localExecution }, after) ||
            !equal(
              {
                ...snapshot,
                revision: plan.registryRevision,
                operations: snapshot.operations.slice(0, -1),
                claims: snapshot.claims.slice(0, -1),
              },
              originalRegistry,
            ) ||
            snapshot.revision !== plan.registryRevision + 2
          )
            throw Error('integration_preparation_state_changed');
        };
        if (confirmed) {
          const receipt = (await objects.get(confirmed)) as Receipt;
          const state = await control.assertClosed(request);
          const snapshot = await control.snapshot();
          assertBound(state, snapshot, receipt.call);
          const claim = snapshot.claims.find((c) => c.claimId === receipt.call.claimId);
          if (
            receipt.call.projectId !== request.projectId ||
            receipt.call.taskId !== request.taskId ||
            receipt.call.workspaceId !== request.workspaceId ||
            receipt.call.integrationId !== wave.integrationId ||
            claim?.createdActionId !== claimAction
          )
            throw Error('integration_preparation_mismatch');
          if (
            !equal(receipt, {
              schemaVersion: 'local-integration-prepared-v1',
              planHash,
              stateHash: localRecordHash(state),
              registryHash: localRecordHash(snapshot),
              call: receipt.call,
            }) ||
            !equal(await objects.get(receipt.stateHash), state)
          )
            throw Error('integration_preparation_state_changed');
          await authority.assertCall(receipt.call, 'read');
          await this.options.assertControl();
          if (
            !equal(await control.assertClosed(request), state) ||
            !equal(await control.snapshot(), snapshot)
          )
            throw Error('integration_preparation_state_changed');
          return { state, call: receipt.call };
        }
        const existingClaim = (await control.snapshot()).operations.find(
          (o) => o.actionId === claimAction,
        );
        if (existingClaim && !equal({ ...beforeCall, localExecution: after.localExecution }, after))
          throw Error('integration_preparation_state_changed');
        if (!existingClaim) {
          const current = await control.assertClosed(request);
          const changes = planIntegrationPreparation(current, before, wave, plan.target);
          if ((await control.snapshot()).revision !== plan.registryRevision)
            throw Error('registry_revision_conflict');
          await this.replayRegistration();
          await this.options.assertControl();
          if (
            !equal(await control.assertClosed(request), current) ||
            !equal(await control.snapshot(), originalRegistry)
          )
            throw Error('integration_preparation_state_changed');
          // An exception may follow a durable commit. Leave the original plan intact.
          if (changes.length) {
            const committed = await this.options.state.compareAndCommit(request, before, changes);
            if (!committed.changed || !equal(committed.state, after))
              throw Error('integration_preparation_state_changed');
          }
        }
        // acquire uses its own durable binding recovery and original registry revision.
        const call = await authority.acquire({
          projectId: request.projectId,
          taskId: request.taskId,
          actionId: claimAction,
          workspaceId: request.workspaceId,
          integrationId: wave.integrationId,
          expectedRevision: plan.registryRevision,
        });
        try {
          const state = await control.assertClosed(request);
          const snapshot = await control.snapshot();
          assertBound(state, snapshot, call);
          await authority.assertCall(call, 'read');
          await this.options.assertControl();
          if (
            !equal(await control.assertClosed(request), state) ||
            !equal(await control.snapshot(), snapshot)
          )
            throw Error('integration_preparation_state_changed');
          const receipt: Receipt = {
            schemaVersion: 'local-integration-prepared-v1',
            planHash,
            stateHash: await objects.put(state),
            registryHash: localRecordHash(snapshot),
            call,
          };
          await objects.bindReference(key('confirmed'), await objects.put(receipt));
          if (
            !equal(await control.assertClosed(request), state) ||
            !equal(await control.snapshot(), snapshot)
          )
            throw Error('integration_preparation_state_changed');
          return { state, call };
        } catch (error) {
          await objects.bindReference(
            key('invalid'),
            await objects.put({
              schemaVersion: 'local-integration-preparation-invalid-v1',
              planHash,
            }),
          );
          throw error;
        }
      },
    );
  }

  private replayRegistration() {
    const registration = this.request.registration;
    return 'waveId' in registration
      ? this.options.workspaces.registerIntegrationWave(registration)
      : this.options.workspaces.registerInitial(registration);
  }
}
