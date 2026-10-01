// Real native integration and closure. Only lost control responses are injected.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setMutation } from '@agora/core-domain';
import { IntegrationService } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { publishAndCommitInitialValidationDispatch } from '../../../packages/core/orchestration/src/initial-validation-dispatch-service';
import { createInitialValidationRegistrationRequest } from '../../../packages/core/orchestration/src/initial-validation-registration-plan';
import { createValidationDispatchVerifier } from '../../../packages/core/orchestration/src/validation-dispatch-plan';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { readConfirmedApplicationPrefix } from '../../../packages/runtime/sandbox/src/local-integration-application-records';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalIntegrationCompletion } from '../../../packages/runtime/sandbox/src/local-integration-completion';
import { LocalIntegrationHandoff } from '../../../packages/runtime/sandbox/src/local-integration-handoff';
import {
  handoffKey,
  readIntegrationHandoffPlan,
} from '../../../packages/runtime/sandbox/src/local-integration-handoff-records';
import { LocalIntegrationProgress } from '../../../packages/runtime/sandbox/src/local-integration-progress';
import { LocalIntegrationPublication } from '../../../packages/runtime/sandbox/src/local-integration-publication';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { LocalValidationGitRegistrationSource } from '../../../packages/runtime/sandbox/src/local-validation-git-registration-source';
import { LocalValidationPreparationControl } from '../../../packages/runtime/sandbox/src/local-validation-preparation-control';
import { LocalValidationPreparationPublication } from '../../../packages/runtime/sandbox/src/local-validation-preparation-publication';
import { LocalValidationPreparationRecords } from '../../../packages/runtime/sandbox/src/local-validation-preparation-records';
import { LocalValidationPreparationSource } from '../../../packages/runtime/sandbox/src/local-validation-preparation-source';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedIntegration } from './local-completed-integration-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it('preserves native completion through response loss and registers TESTER without execution admission', async () => {
  await fixture(async (f) =>
    registeredFixture(
      f,
      async (ctx) => {
        let batches: LocalIntegrationTreeBatch | undefined;
        let loseDrain = true;
        const setup = await completedIntegration(ctx, {
          canonicalPlan: true,
          verifyClosure: async (claim) => {
            if (!batches) throw Error('missing native batches');
            return batches.closure(claim);
          },
          assertControl: async () => {
            if (
              loseDrain &&
              (await ctx.control.snapshot()).claims.some(
                (c) => c.kind === 'integration' && c.status === 'draining',
              )
            ) {
              loseDrain = false;
              throw Error('fixture_lost_drain_response');
            }
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
        const head = f.git(['rev-parse', 'HEAD']),
          index = readFileSync(join(f.root, '.git/index'));
        const completed = (
          await service.integrateWave(await ctx.control.assertClosed(ctx.scope), {
            waveId: setup.wave.waveId,
            workerIds: setup.wave.coderWorkerIds,
            baseBranch: setup.wave.base.branch,
          })
        ).state;
        const originalRegistry = await ctx.control.snapshot();
        const originalRelease = setup.authority.release.bind(setup.authority);
        let loseRelease = true;
        setup.authority.release = async (call) => {
          await originalRelease(call);
          if (loseRelease) {
            loseRelease = false;
            throw Error('fixture_lost_release_response');
          }
        };
        const handoff = () =>
          new LocalIntegrationHandoff({
            ...ctx,
            ...setup,
            completion,
            batches: batches as LocalIntegrationTreeBatch,
          });
        await expect(handoff().read(setup.call)).rejects.toThrow(
          'integration_handoff_recovery_required',
        );
        await expect(handoff().release(setup.call)).rejects.toThrow('fixture_lost_drain_response');
        expect(
          (await ctx.control.snapshot()).claims.find((c) => c.claimId === setup.call.claimId)
            ?.status,
        ).toBe('draining');
        await expect(completion.read(setup.call)).rejects.toThrow();
        await expect(handoff().release(setup.call)).rejects.toThrow(
          'fixture_lost_release_response',
        );
        expect(
          (await ctx.control.snapshot()).claims.find((c) => c.claimId === setup.call.claimId)
            ?.status,
        ).toBe('released');
        await expect(handoff().read(setup.call)).rejects.toThrow(
          'integration_handoff_recovery_required',
        );
        const result = await handoff().release(setup.call);
        const registry = await ctx.control.snapshot();
        expect(registry.revision).toBe(originalRegistry.revision + 4);
        expect(registry.operations).toHaveLength(originalRegistry.operations.length + 2);
        expect(result.version.kind).toBe('git');
        expect(result.version.kind === 'git' && result.version.commit).toBe(
          completed.integration?.resultCommit,
        );
        expect(result.state).toEqual({ ...completed, localExecution: result.state.localExecution });
        expect(result.state.localExecution?.receipts).toHaveLength(
          (completed.localExecution?.receipts.length ?? 0) + 2,
        );
        const proof = await readIntegrationHandoffPlan(
          ctx.objects,
          setup.call,
          result.state,
          registry,
        );
        expect(proof.status).toBe('released');
        expect(proof.completed).toEqual(completed);
        expect(proof.registry).toEqual(originalRegistry);
        await expect(setup.authority.assertCall(setup.call, 'edit')).rejects.toThrow();
        const reader = setup.authority.handoffReader(setup.call);
        await expect(reader.assertCall(setup.call, 'edit')).rejects.toThrow(
          'integration_completion_read_only',
        );
        await expect(reader.release(setup.call)).rejects.toThrow(
          'integration_completion_read_only',
        );
        await expect(
          reader.acquire({
            ...ctx.scope,
            actionId: 'forbidden',
            workspaceId: setup.call.workspaceId,
            integrationId: setup.call.integrationId,
            expectedRevision: registry.revision,
          }),
        ).rejects.toThrow('integration_completion_read_only');
        await expect(
          reader.readPublishedCheckpoint({ call: setup.call, actionId: 'forbidden' }),
        ).rejects.toThrow('integration_completion_read_only');
        await expect(
          reader.readCheckpoint({ ...setup.call, writerEpoch: setup.call.writerEpoch + 1 }),
        ).rejects.toThrow();
        await ctx.store.commit(ctx.scope, [
          setMutation('iterationCount', result.state.iterationCount + 1),
        ]);
        await expect(handoff().read(setup.call)).rejects.toThrow(
          'integration_handoff_state_changed',
        );
        await ctx.store.commit(ctx.scope, [
          setMutation('iterationCount', result.state.iterationCount),
        ]);
        const path = join(
          ctx.owner.root,
          'local-workspaces/objects',
          `${handoffKey(setup.call, 'plan')}.ref`,
        );
        renameSync(path, `${path}.held`);
        try {
          await expect(handoff().read(setup.call)).rejects.toThrow(
            'integration_handoff_recovery_required',
          );
        } finally {
          renameSync(`${path}.held`, path);
        }
        const applications = await readConfirmedApplicationPrefix(
          ctx.objects,
          proof.completion.before,
          setup.call,
        );
        const item = applications[0]?.effects.applied.items[0];
        if (!item) throw Error('missing original native proof');
        const native = (await ctx.objects.get(item.recordHash)) as {
          native: { journalPath: string };
        };
        const journal = join(native.native.journalPath, 'result.json');
        renameSync(journal, `${journal}.held`);
        try {
          await expect(handoff().read(setup.call)).rejects.toThrow();
        } finally {
          renameSync(`${journal}.held`, journal);
        }
        expect(await ctx.control.snapshot()).toEqual(registry);
        expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
        writeFileSync(
          join(f.privateRoot, 'integration-handoff-proof.json'),
          JSON.stringify({
            completed,
            originalRegistry,
            result,
            registry,
            proof,
            userHead: head,
            userIndexUnchanged: true,
            lostDrainRecovered: true,
            lostReleaseRecovered: true,
            driftRejected: true,
            missingPlanRejected: true,
            missingNativeHistoryRejected: true,
            readonlyReplay: true,
            originalCompletionStillStrict: true,
          }),
        );
        const initialBase = result.state.parallelExecution?.initialBase;
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
        const seed = {
          dispatchId: 'first-validation',
          dispatchTs: 40,
          ledgerId: 'validation-progress',
          ledgerTs: 41,
        };
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
          handoff: handoff(),
        });
        // The preparation service must exercise the same real handoff reader.
        // Observe that read in place instead of repeating the full native/Git
        // proof immediately before the service performs it again.
        const readHandoff = publication.readHandoff.bind(publication);
        publication.readHandoff = async (call) => {
          const refs = await ctx.objects.references();
          const actual = await readHandoff(call);
          expect(actual.state).toEqual(result.state);
          expect(actual.version).toEqual(result.version);
          expect(await ctx.objects.references()).toEqual(refs);
          return actual;
        };
        const source = new LocalValidationPreparationControl({
          control: ctx.control,
          objects: ctx.objects,
          records,
          verifier: createValidationDispatchVerifier(async () => ({ context, roster })),
        });
        const physical = new LocalValidationPreparationSource({ control: source, completion });
        const dispatchControl = {
          source: physical,
          state: ctx.store,
          readControl: async () => ({ context, roster }),
          publication,
        };
        const committed = await publishAndCommitInitialValidationDispatch(
          {
            scope,
            call: setup.call,
            actionId: 'prepare-first-validation',
            validationWorkspaceId: 'validation-first',
            seed,
          },
          dispatchControl,
        );
        const reference = { scope, planHash: committed.planHash };
        expect((await records.load(scope))?.planHash).toBe(committed.planHash);
        expect(committed).toEqual({ stage: 'dispatched', planHash: committed.planHash });
        const storedPreparation = await records.load(scope);
        if (!storedPreparation) throw Error('missing validation preparation');
        // The dispatch service just re-proved the post-CAS native/Git source.
        // Registration independently re-proves it; use the fixed slot inputs
        // here rather than a third identical full read in this test controller.
        expect(await ctx.objects.get(storedPreparation.plan.callHash)).toEqual(setup.call);
        expect(await ctx.objects.get(storedPreparation.plan.versionHash)).toEqual(result.version);
        const fixedPlan = await ctx.objects.get(storedPreparation.plan.dispatchPlanHash);
        const registrationRequest = createInitialValidationRegistrationRequest(
          {
            scope,
            planHash: committed.planHash,
            actionId: storedPreparation.plan.actionId,
            validationWorkspaceId: storedPreparation.plan.validationWorkspaceId,
            call: setup.call,
            version: result.version,
            plan: fixedPlan as Parameters<
              typeof createInitialValidationRegistrationRequest
            >[0]['plan'],
            current: await ctx.control.assertClosed(ctx.scope),
            registry: await ctx.control.snapshot(),
          },
          context,
          roster,
        );
        expect(registrationRequest).toMatchObject({
          sourceWorkspaceId: setup.call.workspaceId,
          version: result.version,
          expectedRevision: registry.revision,
          targets: [
            {
              purpose: 'validation',
              workspaceId: 'validation-first',
              workerId: 'worker:first-validation:0',
            },
          ],
        });
        await expect(handoff().read(setup.call)).rejects.toThrow();
        const physicalRefs = await ctx.objects.references();
        expect(await ctx.objects.references()).toEqual(physicalRefs);
        const preparationReader = setup.authority.preparationReader(setup.call, source, reference);
        await expect(preparationReader.assertCall(setup.call, 'edit')).rejects.toThrow(
          'integration_completion_read_only',
        );
        await expect(
          preparationReader.readPublishedCheckpoint({ call: setup.call, actionId: 'forbidden' }),
        ).rejects.toThrow('integration_completion_read_only');
        renameSync(journal, `${journal}.held`);
        try {
          await expect(physical.read(reference)).rejects.toThrow();
        } finally {
          renameSync(`${journal}.held`, journal);
        }
        expect(await ctx.control.snapshot()).toEqual(registry);
        expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
        const registrationProof = new LocalValidationGitRegistrationSource({
          control: ctx.control,
          objects: ctx.objects,
          records,
          physical,
          preparationControl: source,
        });
        const workspaces = new LocalGitWorkspaces({
          ...ctx,
          verifyValidationPreparation: registrationProof.verifyBefore.bind(registrationProof),
          verifyValidationSlot: registrationProof.verifySlot.bind(registrationProof),
          verifyValidationRegistered: registrationProof.verifyRegistered.bind(registrationProof),
        });
        const dispatchedState = await ctx.control.assertClosed(ctx.scope);
        const [validationWorkspace] = await workspaces.registerValidation(registrationRequest);
        expect(validationWorkspace).toMatchObject({
          workspaceId: 'validation-first',
          purpose: 'validation',
          mode: 'linked-worktree',
          baseCommit: result.version.kind === 'git' ? result.version.commit : undefined,
        });
        const registeredState = await ctx.control.assertClosed(ctx.scope);
        const registeredRegistry = await ctx.control.snapshot();
        expect(registeredState.workers).toEqual(dispatchedState.workers);
        expect(
          registeredState.workers.find((w) => w.workerId === 'worker:first-validation:0'),
        ).toMatchObject({ status: 'pending', role: 'TESTER' });
        expect(registeredState.integration).toEqual(result.state.integration);
        expect(registeredState.localExecution?.git?.initialWorkspaceId).toBe(
          result.state.localExecution?.git?.initialWorkspaceId,
        );
        expect(registeredState.localExecution?.git?.worktrees).toHaveLength(
          (result.state.localExecution?.git?.worktrees.length ?? 0) + 1,
        );
        expect(registeredRegistry.revision).toBe(registry.revision + 2);
        expect(
          registeredRegistry.claims.find((c) => c.claimId === setup.call.claimId)?.status,
        ).toBe('released');
        expect(
          registeredRegistry.claims.find((c) => c.workspaceId === 'validation-first'),
        ).toMatchObject({ status: 'active', workerId: 'worker:first-validation:0' });
        await expect(
          workspaces.resolveAssignment({ ...ctx.scope, workerId: 'worker:first-validation:0' }),
        ).rejects.toThrow('validation_preparation_unconfirmed');
        expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
      },
      true,
    ),
  );
}, 2_700_000);
