// Real native workspaces, claims, command validation and production orchestration.
// Deterministic role executors isolate routing; external Harness/Leader resume
// acceptance is separate and this fixture stops at the new completion gate.
import { readFileSync } from 'node:fs';
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
      buildLocalExecutor: async (_spec, assignment, session) => ({
        async step() {
          roles.push(assignment.role);
          const action = (kind: string) =>
            `tool:${localRecordHash({ ...scope, workerId: assignment.workerId, kind })}`;
          const read = await session.tools.read(action('read'), 'sentinel');
          if (read.kind !== 'file') throw Error('missing_repair_file');
          if (assignment.role === 'CODER') {
            expect(read.content.toString('utf8')).toBe(original);
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
          } else {
            expect(read.content.toString('utf8')).toBe('fixed user content');
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
          return {
            kind: 'done' as const,
            output: {},
            reachedSafeBoundary: true,
            mutations:
              assignment.role === 'REVIEWER'
                ? [
                    appendMutation('reviewComments', {
                      id: 'repair-reviewed',
                      kind: 'verdict',
                      verdict: 'approved',
                    }),
                  ]
                : [],
          };
        },
        async saveSafePoint() {
          throw Error('deterministic_fixture_has_no_harness_checkpoint');
        },
        async loadSafePoint() {
          throw Error('deterministic_fixture_has_no_harness_checkpoint');
        },
        injectInbox() {},
      }),
      completeLocalAssignment: async (state, assignment, session) =>
        assignment.role === 'TESTER'
          ? validator.complete(state, assignment.workerId, session.workspace.workspaceId, session)
          : [],
    },
    scheduler,
  );
  const after = await runOrchestration(before, {
    workerRuntime: workers,
    roster: DEFAULT_ROSTER,
    transition: async (_old, mutations) => (await runtime.commitMutations(scope, mutations)).state,
    prepareLocalDeliveryRepair: services.prepare,
    completeLocalDeliveryRepair: services.complete,
  });
  expect(roles).toEqual(['CODER', 'TESTER', 'REVIEWER']);
  expect(after.humanGate?.reason).toBe('completion_confirmation:repair-reviewed');
  await validator.verifyCompletion(after);
  expect(after.testResults).toMatchObject({ passed: true, total: 2, failed: 0 });
  expect(after.workers.slice(0, before.workers.length)).toEqual(before.workers);
  expect(after.localExecution?.delivery).toEqual(before.localExecution?.delivery);
  expect(after.iterationCount).toBe(before.iterationCount + 1);
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
