// Real native/Git sources are required to prove a committed validation binding
// survives a lost response. Only the new service instance is reconstructed.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IntegrationService } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { LocalInitialValidationPreparation } from '../../../apps/web/src/server/local-initial-validation';
import { createValidationDispatchVerifier } from '../../../packages/core/orchestration/src/validation-dispatch-plan';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalIntegrationCompletion } from '../../../packages/runtime/sandbox/src/local-integration-completion';
import { LocalIntegrationHandoff } from '../../../packages/runtime/sandbox/src/local-integration-handoff';
import { LocalIntegrationProgress } from '../../../packages/runtime/sandbox/src/local-integration-progress';
import { LocalIntegrationPublication } from '../../../packages/runtime/sandbox/src/local-integration-publication';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { LocalValidationGitRegistrationSource } from '../../../packages/runtime/sandbox/src/local-validation-git-registration-source';
import { LocalValidationPreparationConfirmation } from '../../../packages/runtime/sandbox/src/local-validation-preparation-confirmation';
import { LocalValidationPreparationControl } from '../../../packages/runtime/sandbox/src/local-validation-preparation-control';
import { LocalValidationPreparationPublication } from '../../../packages/runtime/sandbox/src/local-validation-preparation-publication';
import { LocalValidationPreparationRecords } from '../../../packages/runtime/sandbox/src/local-validation-preparation-records';
import { LocalValidationPreparationSource } from '../../../packages/runtime/sandbox/src/local-validation-preparation-source';
import { serializeWorkspaceOperation } from '../../../packages/runtime/sandbox/src/local-workspace-operation';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedIntegration } from './local-completed-integration-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it('confirms only the exact registered TESTER worktree after a lost response without new Git or binding effects', async () => {
  await fixture(async (f) =>
    registeredFixture(
      f,
      async (ctx) => {
        let batches: LocalIntegrationTreeBatch | undefined;
        const setup = await completedIntegration(ctx, {
          canonicalPlan: true,
          singleWorker: true,
          verifyClosure: async (claim) => {
            if (!batches) throw Error('missing native batches');
            return batches.closure(claim);
          },
        });
        const helper = resolve(
          'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
        );
        batches = await LocalIntegrationTreeBatch.open(
          ctx.owner,
          ctx.objects,
          ctx.versions,
          setup.authority,
          helper,
        );
        const candidates = new LocalIntegrationCandidates({
          ...ctx,
          ...setup,
          historyBatches: batches,
          candidates: await LocalMergeCandidates.open(ctx.owner, ctx.objects, ctx.versions, helper),
        });
        const state = { compareAndCommit: ctx.store.compareAndCommit.bind(ctx.store) };
        const completion = new LocalIntegrationCompletion({ ...ctx, ...setup, candidates, state });
        const service = IntegrationService.withProgress(
          new LocalIntegrationProgress({
            ...ctx,
            ...setup,
            completion,
            publication: new LocalIntegrationPublication({
              ...ctx,
              ...setup,
              candidates,
              batches,
              state,
            }),
          }),
        );
        const userHead = f.git(['rev-parse', 'HEAD']);
        const userIndex = readFileSync(join(f.root, '.git/index'));
        await service.integrateWave(await ctx.control.assertClosed(ctx.scope), {
          waveId: setup.wave.waveId,
          workerIds: setup.wave.coderWorkerIds,
          baseBranch: setup.wave.base.branch,
        });
        const handoff = new LocalIntegrationHandoff({
          ...ctx,
          ...setup,
          completion,
          batches,
        });
        const completed = await handoff.release(setup.call);
        const initialBase = completed.state.parallelExecution?.initialBase;
        if (!initialBase) throw Error('missing validation context');
        const context = { initialBase, controlFingerprint: 'f'.repeat(64) };
        const roster = [
          {
            role: 'TESTER' as const,
            executor: 'harness' as const,
            systemPrompt: '',
            tools: [],
            projection: [],
            routeWhen: 'always' as const,
          },
        ];
        const scope = {
          ...ctx.scope,
          waveId: setup.wave.waveId,
          attempt: setup.wave.attempt,
          integrationId: setup.call.integrationId,
        };
        const records = new LocalValidationPreparationRecords(ctx.objects);
        const publication = new LocalValidationPreparationPublication({
          control: ctx.control,
          objects: ctx.objects,
          records,
          handoff,
        });
        const preparationControl = new LocalValidationPreparationControl({
          control: ctx.control,
          objects: ctx.objects,
          records,
          verifier: createValidationDispatchVerifier(async () => ({ context, roster })),
        });
        const physical = new LocalValidationPreparationSource({
          control: preparationControl,
          completion,
        });
        const proof = new LocalValidationGitRegistrationSource({
          control: ctx.control,
          objects: ctx.objects,
          records,
          physical,
          preparationControl,
        });
        const options = {
          ...ctx,
          verifyValidationPreparation: proof.verifyBefore.bind(proof),
          verifyValidationSlot: proof.verifySlot.bind(proof),
          verifyValidationRegistered: proof.verifyRegistered.bind(proof),
        };
        const confirmation = new LocalValidationPreparationConfirmation({
          control: ctx.control,
          objects: ctx.objects,
          records,
          workspaces: new LocalGitWorkspaces(options),
        });
        const runTaskSerial = <T>(
          current: { projectId: string; taskId: string },
          operation: () => Promise<T>,
        ) =>
          serializeWorkspaceOperation(
            { ...current, workspaceId: 'validation-task-control' },
            operation,
          );
        let createdInputs = 0;
        const createInitialInput = async () => {
          createdInputs++;
          return {
            scope,
            call: setup.call,
            actionId: 'prepare-first-validation',
            validationWorkspaceId: 'validation-first',
            seed: {
              dispatchId: 'first-validation',
              dispatchTs: 40,
              ledgerId: 'validation-progress',
              ledgerTs: 41,
            },
          };
        };
        const common = {
          runTaskSerial,
          createInitialInput,
          dispatch: {
            source: physical,
            state: ctx.store,
            readControl: async () => ({ context, roster }),
            publication,
          },
          control: ctx.control,
          objects: ctx.objects,
          records,
          physical,
          confirmation,
        };
        let first: Awaited<ReturnType<LocalGitWorkspaces['registerValidation']>> | undefined;
        let registrationRequest:
          | Parameters<LocalGitWorkspaces['registerValidation']>[0]
          | undefined;
        const interrupted = new LocalInitialValidationPreparation({
          ...common,
          workspaces: {
            registerValidation: async (request) => {
              registrationRequest = request;
              await expect(confirmation.confirm(scope)).rejects.toThrow(
                'validation_registration_recovery_required',
              );
              first = await new LocalGitWorkspaces(options).registerValidation(request);
              throw Error('validation_registration_response_lost');
            },
          },
        });
        await expect(interrupted.prepare(completed.state)).rejects.toThrow(
          'validation_registration_response_lost',
        );
        const saved = await records.load(scope);
        if (!saved || !first || !registrationRequest) throw Error('missing validation preparation');
        expect(createdInputs).toBe(1);
        expect(registrationRequest).toMatchObject({
          sourceWorkspaceId: setup.call.workspaceId,
          version: completed.version,
          targets: [{ workspaceId: 'validation-first', workerId: 'worker:first-validation:0' }],
        });
        expect(first).toHaveLength(1);
        const registeredState = await ctx.control.assertClosed(ctx.scope);
        const registeredRegistry = await ctx.control.snapshot();
        const references = await ctx.objects.references();
        const recovered = new LocalInitialValidationPreparation({
          ...common,
          workspaces: new LocalGitWorkspaces(options),
        });
        expect(await recovered.prepare(completed.state)).toEqual(registeredState);
        const confirmed = await confirmation.read(scope);
        expect(createdInputs).toBe(1);
        expect(confirmed.planHash).toBe(saved.planHash);
        expect(confirmed.workerId).toBe(saved.plan.workerId);
        expect(confirmed.workspaceId).toBe(first[0]?.workspaceId);
        expect(await recovered.admit(registeredState, saved.plan.workerId)).toEqual(
          registeredState,
        );
        await expect(
          recovered.admit({ ...registeredState, phase: 'review' }, saved.plan.workerId),
        ).rejects.toThrow('validation_preparation_admission_denied');
        expect(await ctx.control.assertClosed(ctx.scope)).toEqual(registeredState);
        expect(await ctx.control.snapshot()).toEqual(registeredRegistry);
        expect((await ctx.objects.references()).length).toBe(references.length + 1);
        expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
      },
      true,
    ),
  );
}, 2_700_000);
