// Real native workspaces, claims, command validation and production orchestration.
// Scripted external responses isolate routing; official Harness loops, JSONL
// and checkpoint flush are real. Live-provider/Leader resume
// acceptance is separate and this fixture stops at the new completion gate.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendMutation,
  currentLocalCompletionEvidence,
  deliveryReaderAssignment,
  deliveryValidationDispatch,
} from '@agora/core-domain';
import { runOrchestration, WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { expect } from 'vitest';
import { createLocalDeliveryRepairServices } from '../../../apps/web/src/server/local-delivery-repair-services';
import { LocalValidationService } from '../../../apps/web/src/server/local-validation';
import type { LocalDeliveryCandidates } from '../../../packages/runtime/sandbox/src/local-delivery-candidates';
import { LocalDeliveryRepairs } from '../../../packages/runtime/sandbox/src/local-delivery-repairs';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import type { exerciseDeliveryValidation } from './local-delivery-validation-fixture';
import { createScriptedLocalHarness } from './local-scripted-harness-fixture';

export async function exerciseDeliveryRepairOrchestration(
  input: Parameters<typeof exerciseDeliveryValidation>[0],
  candidates: LocalDeliveryCandidates,
) {
  const { options, runtime, scheduler } = input;
  const scope = { projectId: 'project', taskId: 'task' };
  const before = await options.control.assertClosed(scope);
  const original = readFileSync(join(input.root, 'sentinel'), 'utf8');
  const repairs = await LocalDeliveryRepairs.open(options.owner, options.objects, options.versions);
  let services: ReturnType<typeof createLocalDeliveryRepairServices>;
  const local = await LocalWorkspaceSessions.create({
    ...options,
    deliveryCandidates: candidates,
    deliveryRepairs: repairs,
    verifyRepairSource: (state, workerId) => services.verifySource(state, workerId),
    versionForAssignment: async (admission) => {
      const selected = deliveryReaderAssignment(
        await options.control.assertClosed(scope),
        admission.workerId,
      );
      if (!selected) throw Error('missing_repair_reader');
      return selected.workspaceVersion;
    },
  });
  services = createLocalDeliveryRepairServices({
    control: options.control,
    repairs,
    local,
    loadState: (s) => runtime.store.load(s),
    verifyGrant: options.verifyGrant,
    assertReady: async (state) => {
      if (
        scheduler.activeCount ||
        state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
      )
        throw Error('fixture_run_not_closed');
    },
    compareAndCommit: async (state, mutations) =>
      (await runtime.compareAndCommitControl(scope, state, mutations)).state,
  });
  const validator = new LocalValidationService(local, () => options.control.assertClosed(scope));
  const roles: string[] = [];
  let repairCount = 0;
  let reviewCount = 0;
  const workers = new WorkerRuntime(
    {
      roster: DEFAULT_ROSTER,
      loadState: () => runtime.store.load(scope),
      transition: async (_old, mutations) =>
        (await runtime.commitMutations(scope, mutations)).state,
      localWorkspace: local,
      buildExecutor: () => {
        throw Error('unexpected_legacy_executor');
      },
      buildLocalExecutor: async (spec, assignment, session) =>
        createScriptedLocalHarness(
          spec,
          {
            root: join(
              options.owner.root,
              'projects',
              scope.projectId,
              'tasks',
              scope.taskId,
              'harness-sessions',
            ),
            cwd: input.root,
            ...scope,
          },
          async () => {
            roles.push(assignment.role);
            const action = (kind: string) =>
              `tool:${localRecordHash({ ...scope, workerId: assignment.workerId, kind })}`;
            const read = await session.tools.read(action('read'), 'sentinel');
            if (read.kind !== 'file') throw Error('missing_repair_file');
            if (assignment.role === 'CODER') {
              repairCount++;
              expect(read.content.toString('utf8')).toBe(
                repairCount === 1 ? original : 'fixed user content',
              );
              await session.tools.apply(
                action('write'),
                [
                  {
                    path: 'sentinel',
                    expected: read.version,
                    readReceiptId: read.readReceiptId,
                    content: 'fixed user content',
                    encoding: 'utf8',
                  },
                ],
                [],
              );
              if (repairCount === 2) {
                const note = await session.tools.read(action('read-note'), 'repair-note.txt');
                await session.tools.apply(
                  action('write-note'),
                  [
                    {
                      path: 'repair-note.txt',
                      expected: note.version,
                      readReceiptId: note.readReceiptId,
                      content: 'Second repair proof',
                      encoding: 'utf8',
                    },
                  ],
                  [],
                );
              }
            } else {
              expect(read.content.toString('utf8')).toBe('fixed user content');
              if (repairCount === 2) {
                const note = await session.tools.read(action('verify-note'), 'repair-note.txt');
                if (note.kind !== 'file') throw Error('missing_second_repair_note');
                expect(note.content.toString('utf8')).toBe('Second repair proof');
              }
              await expect(
                session.tools.apply(
                  action('write'),
                  [
                    {
                      path: 'sentinel',
                      expected: read.version,
                      readReceiptId: read.readReceiptId,
                      content: 'forbidden',
                      encoding: 'utf8',
                    },
                  ],
                  [],
                ),
              ).rejects.toThrow('authorization_closed');
            }
            if (assignment.role === 'REVIEWER') reviewCount++;
            return {
              kind: 'done' as const,
              output: {},
              reachedSafeBoundary: true,
              mutations:
                assignment.role === 'REVIEWER'
                  ? [
                      appendMutation('reviewComments', {
                        id: reviewCount === 1 ? 'repair-needs-note' : 'repair-reviewed',
                        kind: 'verdict',
                        verdict: reviewCount === 1 ? 'changes_requested' : 'approved',
                      }),
                    ]
                  : [],
            };
          },
        ),
      completeLocalAssignment: async (state, assignment, session) => {
        if (assignment.role !== 'TESTER') return [];
        return validator.complete(state, assignment.workerId, session.workspace.workspaceId, {
          ...session,
          tools: {
            ...session.tools,
            run: async (...args) => {
              const result = await session.tools.run(...args);
              mkdirSync('test-outputs/task126-repair-chain', { recursive: true });
              writeFileSync(
                `test-outputs/task126-repair-chain/command-${Date.now()}.json`,
                JSON.stringify(result, null, 2),
              );
              return result;
            },
          },
        });
      },
    },
    scheduler,
  );
  const after = await runOrchestration(before, {
    workerRuntime: workers,
    roster: DEFAULT_ROSTER,
    transition: async (_old, mutations) => (await runtime.commitMutations(scope, mutations)).state,
    prepareLocalDeliveryRepair: services.prepare,
    completeLocalDeliveryRepair: services.complete,
  }).catch(async (error: unknown) => {
    const describe = (value: unknown): unknown =>
      value instanceof Error
        ? {
            message: value.message,
            stack: value.stack,
            ...(value instanceof AggregateError ? { errors: value.errors.map(describe) } : {}),
            ...(value.cause ? { cause: describe(value.cause) } : {}),
          }
        : String(value);
    mkdirSync('test-outputs/task126-repair-chain', { recursive: true });
    writeFileSync(
      `test-outputs/task126-repair-chain/failure-${Date.now()}.json`,
      JSON.stringify(
        { error: describe(error), roles, workers: (await runtime.store.load(scope))?.workers },
        null,
        2,
      ),
    );
    throw error;
  });
  expect(roles).toEqual(['CODER', 'TESTER', 'REVIEWER', 'CODER', 'TESTER', 'REVIEWER']);
  expect(repairCount).toBe(2);
  expect(after.humanGate?.reason).toBe('completion_confirmation:repair-reviewed');
  await validator.verifyCompletion(after);
  expect(after.testResults).toMatchObject({ passed: true, total: 2, failed: 0 });
  expect(after.workers.slice(0, before.workers.length)).toEqual(before.workers);
  expect(after.localExecution?.delivery).toEqual(before.localExecution?.delivery);
  expect(after.iterationCount).toBe(before.iterationCount + 2);
  expect(scheduler.activeCount).toBe(0);
  const selected = deliveryValidationDispatch(after);
  const binding = currentLocalCompletionEvidence(after);
  expect(binding.workspaceVersion).toEqual(selected?.workspaceVersion);
  expect(binding.workspaceVersion).not.toEqual(selected?.round.candidateVersion);
  expect(readFileSync(join(input.root, 'sentinel'), 'utf8')).toBe(original);
  return {
    roles,
    binding,
    gateId: after.humanGate?.gateId,
    originalUnchanged: true,
    oldWorkersPreserved: true,
  };
}
