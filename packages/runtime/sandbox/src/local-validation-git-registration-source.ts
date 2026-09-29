/** First-TESTER Git registration source. Only the unique dispatch slot can
 * identify the input; the original native/Git completion is re-proved before
 * any new worktree effects. Registered-stage replay is a separate protocol. */
import { type AppState, applyMutations, setMutation } from '@agora/core-domain';
import type { LocalBindingCoordinator, LocalBindingRequest } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import {
  isLocalBindingOperation,
  type LocalRegistryRecords,
  localRecordHash,
} from './local-registry-records';
import type { LocalValidationPreparationControl } from './local-validation-preparation-control';
import type { LocalValidationPreparationRecords } from './local-validation-preparation-records';
import type { LocalValidationPreparationSource } from './local-validation-preparation-source';
import type { ValidationGitRegistrationRequest } from './validation-dispatch-port';

const equal = (left: unknown, right: unknown) => localRecordHash(left) === localRecordHash(right);

export class LocalValidationGitRegistrationSource {
  constructor(
    private readonly options: {
      control: LocalBindingCoordinator;
      objects: LocalControlObjects;
      records: LocalValidationPreparationRecords;
      physical: LocalValidationPreparationSource;
      preparationControl: LocalValidationPreparationControl;
    },
  ) {}

  /** Cheap immutable-slot check for the pre-commit and post-commit boundaries.
   * It deliberately does not claim physical proof or executable admission. */
  async verifySlot(input: ValidationGitRegistrationRequest): Promise<void> {
    const request = structuredClone(input);
    const scope = {
      projectId: request.projectId,
      taskId: request.taskId,
      waveId: request.waveId,
      attempt: request.attempt,
      integrationId: request.integrationId,
    };
    const saved = await this.options.records.load(scope);
    if (
      !saved ||
      saved.planHash !== request.planHash ||
      saved.plan.actionId !== request.actionId ||
      saved.plan.dispatchId !== request.dispatchId ||
      saved.plan.validationWorkspaceId !== request.targets[0]?.workspaceId ||
      saved.plan.workerId !== request.targets[0]?.workerId ||
      ((await this.options.objects.get(saved.plan.callHash)) as { workspaceId?: string })
        .workspaceId !== request.sourceWorkspaceId ||
      !equal(await this.options.objects.get(saved.plan.versionHash), request.version)
    )
      throw Error('workspace_validation_source_mismatch');
  }

  async verifyBefore(input: ValidationGitRegistrationRequest, state: AppState): Promise<void> {
    const request = structuredClone(input);
    const reference = {
      scope: {
        projectId: request.projectId,
        taskId: request.taskId,
        waveId: request.waveId,
        attempt: request.attempt,
        integrationId: request.integrationId,
      },
      planHash: request.planHash,
    };
    await this.verifySlot(request);
    const current = await this.options.control.assertClosed(reference.scope);
    const registry = await this.options.control.snapshot();
    if (!equal(current, state) || registry.revision !== request.expectedRevision)
      throw Error('workspace_validation_source_mismatch');
    const physical = await this.options.physical.read(reference);
    if (
      physical.stage !== 'dispatched' ||
      physical.call.workspaceId !== request.sourceWorkspaceId ||
      !equal(physical.version, request.version) ||
      current.integration?.resultCommit !==
        (request.version.kind === 'git' ? request.version.commit : undefined) ||
      !equal(await this.options.control.assertClosed(reference.scope), current) ||
      !equal(await this.options.control.snapshot(), registry) ||
      (await this.options.records.load(reference.scope))?.planHash !== request.planHash
    )
      throw Error('workspace_validation_source_mismatch');
  }

  /** Only the exact closed post-binding pair is a registered stage. The saved
   * binding is checked against the unique plan, original control and every
   * resulting State/registry field before re-proving original native history. */
  async verifyRegistered(
    input: ValidationGitRegistrationRequest,
    state: AppState,
    registry: LocalRegistryRecords,
    binding: LocalBindingRequest,
  ): Promise<void> {
    const request = structuredClone(input);
    const reference = {
      scope: {
        projectId: request.projectId,
        taskId: request.taskId,
        waveId: request.waveId,
        attempt: request.attempt,
        integrationId: request.integrationId,
      },
      planHash: request.planHash,
    };
    await this.verifySlot(request);
    const read = async () => {
      const history = await this.options.preparationControl.readHistorical(reference);
      const original = history.releasedRegistry;
      const dispatched = history.dispatchedState;
      const prior = dispatched.localExecution;
      const targetId = request.targets[0]?.workspaceId;
      const workerId = request.targets[0]?.workerId;
      const target = binding.records.workspaces.at(-1);
      const linked = binding.records.linkedRoots?.at(-1);
      const claim = binding.records.claims.at(-1);
      const root = original.roots.find((r) => r.rootId === request.rootId);
      const grant = original.grants.find((g) => g.grantId === request.grantId);
      const mapping = binding.nextLocalExecution.git?.worktrees.at(-1);
      const workerBinding = binding.nextLocalExecution.bindings.at(-1);
      const key = localRecordHash({
        kind: 'validation-git-registration',
        projectId: request.projectId,
        taskId: request.taskId,
        actionId: request.actionId,
      });
      const receiptId = `binding:${request.actionId}`;
      const epoch = Math.max(0, ...original.claims.map((c) => c.writerEpoch)) + 1;
      if (
        !prior?.git ||
        !target ||
        !linked ||
        !claim ||
        !root ||
        !grant ||
        !mapping ||
        !workerBinding ||
        root.projectId !== request.projectId ||
        grant.projectId !== request.projectId ||
        request.expectedRevision !== original.revision ||
        request.sourceWorkspaceId !== history.call.workspaceId ||
        !equal(request.version, history.version) ||
        history.planHash !== request.planHash ||
        grant.rootId !== root.rootId ||
        grant.leaderMessageId !== binding.sourceMessageId ||
        binding.projectId !== request.projectId ||
        binding.taskId !== request.taskId ||
        binding.actionId !== request.actionId ||
        binding.expectedRevision !== original.revision ||
        Object.hasOwn(binding, 'sourceMessage') ||
        !equal(binding.records.roots, original.roots) ||
        !equal(binding.records.grants, original.grants) ||
        !equal(binding.records.workspaces.slice(0, -1), original.workspaces) ||
        !equal(binding.records.claims.slice(0, -1), original.claims) ||
        !equal((binding.records.linkedRoots ?? []).slice(0, -1), original.linkedRoots) ||
        target.workspaceId !== targetId ||
        target.projectId !== request.projectId ||
        target.taskId !== request.taskId ||
        target.rootId !== root.rootId ||
        target.grantId !== grant.grantId ||
        target.purpose !== 'validation' ||
        target.mode !== 'linked-worktree' ||
        target.baseCommit !== (request.version.kind === 'git' ? request.version.commit : '') ||
        linked.workspaceId !== targetId ||
        linked.bindingReceiptId !== receiptId ||
        mapping.workspaceId !== targetId ||
        mapping.path !== linked.path ||
        mapping.receiptId !== receiptId ||
        !equal(workerBinding, { workerId, workspaceId: targetId, receiptId }) ||
        !equal(claim, {
          claimId: `claim:${localRecordHash({ key, workerId })}`,
          projectId: request.projectId,
          taskId: request.taskId,
          workspaceId: targetId,
          workerId,
          writerEpoch: epoch,
          createdActionId: request.actionId,
          status: 'active',
          closureReceiptId: null,
        })
      )
        throw Error('workspace_validation_source_mismatch');
      const nextLocal = structuredClone(prior);
      nextLocal.workspaces.push(target);
      nextLocal.bindings.push(workerBinding);
      nextLocal.git?.worktrees.push(mapping);
      if (!equal(nextLocal, binding.nextLocalExecution))
        throw Error('workspace_validation_source_mismatch');
      const inputHash = localRecordHash(binding);
      const preparedRevision = original.revision + 1;
      const expectedLocal = structuredClone(nextLocal);
      expectedLocal.receipts.push({
        receiptId,
        actionId: request.actionId,
        inputHash,
        registryRevision: preparedRevision,
      });
      const expectedState = applyMutations(dispatched, [
        setMutation('localExecution', expectedLocal),
      ]);
      const operation = {
        actionId: request.actionId,
        inputHash,
        receiptId,
        projectId: request.projectId,
        taskId: request.taskId,
        preparedRevision,
        stage: 'committed' as const,
        previousLocalHash: localRecordHash(prior),
        nextLocalExecution: expectedLocal,
        sourceMessageId: grant.leaderMessageId,
      };
      const expectedRegistry = {
        ...original,
        ...binding.records,
        revision: original.revision + 2,
        operations: [...original.operations, operation],
      };
      const current = await this.options.control.assertClosed(reference.scope);
      const snapshot = await this.options.control.snapshot();
      const actualOperation = snapshot.operations.find((o) => o.actionId === request.actionId);
      if (
        !Number.isSafeInteger(preparedRevision) ||
        !Number.isSafeInteger(epoch) ||
        !actualOperation ||
        !isLocalBindingOperation(actualOperation) ||
        !equal(actualOperation, operation) ||
        !equal(current, expectedState) ||
        !equal(snapshot, expectedRegistry)
      )
        throw Error('workspace_validation_source_mismatch');
      return {
        stage: 'registered' as const,
        call: history.call,
        version: history.version,
        planHash: history.planHash,
        releasedState: history.before,
        releasedRegistry: history.releasedRegistry,
      };
    };
    const reader = {
      read: async (supplied: typeof reference) => {
        if (!equal(supplied, reference)) throw Error('workspace_validation_source_mismatch');
        const proof = await read();
        return {
          stage: proof.stage,
          call: proof.call,
          version: proof.version,
          planHash: proof.planHash,
        };
      },
      readFixedHandoff: async (supplied: typeof reference) => {
        if (!equal(supplied, reference)) throw Error('workspace_validation_source_mismatch');
        return read();
      },
    };
    const before = await reader.read(reference);
    if (
      !equal(await this.options.control.assertClosed(reference.scope), state) ||
      !equal(await this.options.control.snapshot(), registry)
    )
      throw Error('workspace_validation_source_mismatch');
    const physical = await this.options.physical.readRegistered(reference, reader);
    if (!equal(physical, before) || !equal(await reader.read(reference), before))
      throw Error('workspace_validation_source_mismatch');
    await this.verifySlot(request);
  }
}
