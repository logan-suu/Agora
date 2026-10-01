// Real registry, claim, lease, native file effects and close receipts. The
// deterministic Executor isolates writer admission from external model behavior;
// this does not establish the later C2 validation/Harness completion chain.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deliveryReaderAssignment,
  deliveryRepairSource,
  deliveryValidationDispatch,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { expect } from 'vitest';
import { LocalDeliveryRepairCompletion } from '../../../apps/web/src/server/local-delivery-repair-completion';
import { LocalDeliveryRepairControl } from '../../../apps/web/src/server/local-delivery-repair-control';
import { LocalValidationService } from '../../../apps/web/src/server/local-validation';
import type { LocalDeliveryCandidates } from '../../../packages/runtime/sandbox/src/local-delivery-candidates';
import { LocalDeliveryRepairs } from '../../../packages/runtime/sandbox/src/local-delivery-repairs';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import type { exerciseDeliveryValidation } from './local-delivery-validation-fixture';

export async function exerciseDeliveryRepairWriter(
  input: Parameters<typeof exerciseDeliveryValidation>[0],
  candidates: LocalDeliveryCandidates,
  previous: LocalWorkspaceSessions,
) {
  const { options, runtime, scheduler } = input;
  const scope = { projectId: 'project', taskId: 'task' };
  const before = await options.control.assertClosed(scope);
  const source = deliveryRepairSource(before);
  if (!source) throw Error('missing_repair_source');
  const repairs = await LocalDeliveryRepairs.open(options.owner, options.objects, options.versions);
  const original = readFileSync(join(input.root, 'sentinel'), 'utf8');
  const proof = new LocalValidationService(previous, () => options.control.assertClosed(scope));
  const controller = new LocalDeliveryRepairControl(options.control, repairs, {
    assertReady: async (state) => {
      if (
        scheduler.activeCount ||
        state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
      )
        throw Error('fixture_run_not_closed');
    },
    verifySource: async (state, selected) => {
      await proof.verify(state, selected.validationReceiptId);
    },
    verifyGrant: options.verifyGrant,
    verifyClosedClaim: (s, claim) => previous.verifyClosedClaim(s, claim),
    loadState: (s) => runtime.store.load(s),
  });
  const registered = await controller.prepare(before, source);
  const worker = registered.workers.at(-1);
  if (worker?.role !== 'CODER') throw Error('missing_repair_worker');
  expect(registered.workers.slice(0, -1)).toEqual(before.workers);
  expect(registered.localExecution?.delivery).toEqual(before.localExecution?.delivery);
  expect(registered.iterationCount).toBe(before.iterationCount + 1);
  let validator: LocalValidationService;
  const local = await LocalWorkspaceSessions.create({
    ...options,
    deliveryCandidates: candidates,
    deliveryRepairs: repairs,
    versionForAssignment: async (admission) => {
      const selected = deliveryReaderAssignment(
        await options.control.assertClosed(scope),
        admission.workerId,
      );
      if (!selected) throw Error('missing_repair_reader');
      return selected.workspaceVersion;
    },
    verifyRepairSource: (state, workerId) => validator.verifyRepairSource(state, workerId),
  });
  validator = new LocalValidationService(local, () => options.control.assertClosed(scope));
  const action = (kind: string) =>
    `tool:${localRecordHash({ ...scope, workerId: worker.workerId, kind })}`;
  let repairedVersion: WorkspaceVersionV1 | undefined;
  let workspaceId: string | undefined;
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
      buildLocalExecutor: async (_spec, _assignment, session) => ({
        async step() {
          workspaceId = session.workspace.workspaceId;
          const read = await session.tools.read(action('repair-read'), 'sentinel');
          if (read.kind !== 'file') throw Error('missing_repair_file');
          expect(read.content.toString('utf8')).toBe(original);
          await session.tools.apply(
            action('repair-write'),
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
          const changed = await session.tools.read(action('repair-read-after'), 'sentinel');
          if (changed.kind !== 'file') throw Error('missing_repair_file');
          expect(changed.content.toString('utf8')).toBe('fixed user content');
          repairedVersion = (await session.tools.inspect(action('repair-inspect'))).version;
          expect(readFileSync(join(input.root, 'sentinel'), 'utf8')).toBe(original);
          return { kind: 'done' as const, output: {}, reachedSafeBoundary: true, mutations: [] };
        },
        async saveSafePoint() {
          throw Error('deterministic_fixture_has_no_harness_checkpoint');
        },
        async loadSafePoint() {
          throw Error('deterministic_fixture_has_no_harness_checkpoint');
        },
        injectInbox() {},
      }),
    },
    scheduler,
  );
  await workers.runOne(registered, { role: 'CODER', workerId: worker.workerId });
  const closed = await options.control.assertClosed(scope);
  expect(closed.workers.at(-1)?.status).toBe('done');
  expect(closed.workers.slice(0, -1)).toEqual(before.workers);
  expect(scheduler.activeCount).toBe(0);
  if (!workspaceId || !repairedVersion) throw Error('missing_repair_version');
  await local.verifyCurrentVersion({ ...scope, workspaceId }, repairedVersion);
  const claim = (await options.control.snapshot()).claims.find(
    (c) => c.workerId === worker.workerId,
  );
  if (!claim) throw Error('missing_repair_claim');
  const closureReceiptId = await local.verifyClosedClaim(scope, claim);
  expect(closureReceiptId).toMatch(/^closure:/);
  const snapshot = await options.control.snapshot();
  const grant = snapshot.grants.find(
    (g) => g.grantId === before.localExecution?.delivery?.rounds.at(-1)?.grantId,
  );
  if (!grant) throw Error('missing_repair_grant');
  let qualifiedState = closed;
  let qualifiedRevision = snapshot.revision;
  const authorize = async () => {
    await options.verifyGrant(scope, grant.grantId);
    return (
      localRecordHash(await options.control.assertClosed(scope)) ===
        localRecordHash(qualifiedState) &&
      (await options.control.snapshot()).revision === qualifiedRevision &&
      (await local.verifyClosedClaim(scope, claim)) === closureReceiptId
    );
  };
  await expect(
    repairs.seal(registered, worker.workerId, grant, closureReceiptId, authorize),
  ).rejects.toThrow('delivery_repair_not_closed');
  const candidate = await repairs.seal(closed, worker.workerId, grant, closureReceiptId, authorize);
  expect(candidate.workspaceVersion).toEqual(repairedVersion);
  expect(candidate.closureReceiptId).toBe(closureReceiptId);
  expect(await repairs.seal(closed, worker.workerId, grant, closureReceiptId, authorize)).toEqual(
    candidate,
  );
  await expect(
    repairs.seal(closed, worker.workerId, grant, `closure:${'0'.repeat(64)}`, authorize),
  ).rejects.toThrow('operation_conflict');
  await expect(
    repairs.readCandidate(closed, worker.workerId, grant, async () => false),
  ).rejects.toThrow('authorization_closed');

  expect(await controller.prepare(before, source)).toEqual(closed);
  expect(readFileSync(join(input.root, 'sentinel'), 'utf8')).toBe(original);
  let validationReceiptId: string | undefined;
  if (input.repairValidation) {
    const completion = new LocalDeliveryRepairCompletion(options.control, repairs, {
      assertReady: async (state) => {
        if (
          scheduler.activeCount ||
          state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
        )
          throw Error('fixture_run_not_closed');
      },
      verifySource: (state, workerId) => validator.verifyRepairSource(state, workerId),
      verifyGrant: options.verifyGrant,
      verifyClosedClaim: (s, claim) => local.verifyClosedClaim(s, claim),
      compareAndCommit: async (state, mutations) =>
        (await runtime.compareAndCommitControl(scope, state, mutations)).state,
    });
    const testing = await completion.complete(scope, worker.workerId);
    expect(testing.localExecution?.delivery).toEqual(before.localExecution?.delivery);
    expect(testing.testResults).toBeUndefined();
    const selected = deliveryValidationDispatch(testing);
    if (!selected) throw Error('missing_repair_test_dispatch');
    expect(selected.workspaceVersion).toEqual(candidate.workspaceVersion);
    const tester = new WorkerRuntime(
      {
        roster: DEFAULT_ROSTER,
        loadState: () => runtime.store.load(scope),
        transition: async (_old, mutations) =>
          (await runtime.commitMutations(scope, mutations)).state,
        localWorkspace: local,
        buildExecutor: () => {
          throw Error('unexpected_legacy_executor');
        },
        buildLocalExecutor: async (_spec, _assignment, session) => ({
          async step() {
            const read = await session.tools.read(action('C2-read'), 'sentinel');
            if (read.kind !== 'file') throw Error('missing_repair_file');
            expect(read.content.toString('utf8')).toBe('fixed user content');
            await expect(
              session.tools.apply(
                action('C2-write'),
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
            return { kind: 'done' as const, output: {}, reachedSafeBoundary: true, mutations: [] };
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
          validator.complete(state, assignment.workerId, session.workspace.workspaceId, session),
      },
      scheduler,
    );
    await tester.runOne(testing, { role: 'TESTER', workerId: selected.workerId });
    qualifiedState = await options.control.assertClosed(scope);
    qualifiedRevision = (await options.control.snapshot()).revision;
    const validated = await validator.verify(
      qualifiedState,
      `workspace-validation:${selected.message.msgId}`,
    );
    expect(validated.results).toMatchObject({
      passed: true,
      total: 2,
      failed: 0,
      workspaceVersion: candidate.workspaceVersion,
    });
    expect(await completion.complete(scope, worker.workerId)).toEqual(qualifiedState);
    expect(scheduler.activeCount).toBe(0);
    validationReceiptId = `workspace-validation:${selected.message.msgId}`;
  }
  const fixed = await repairs.workspaceBinding(qualifiedState, worker.workerId, grant, authorize);
  writeFileSync(join(fixed.root, 'sentinel'), 'external modification after sealing');
  await expect(
    repairs.readCandidate(qualifiedState, worker.workerId, grant, authorize),
  ).rejects.toThrow('file_version_conflict');
  await expect(
    repairs.seal(closed, worker.workerId, grant, closureReceiptId, authorize),
  ).rejects.toThrow('file_version_conflict');
  return {
    candidate,
    validationReceiptId,
    workerId: worker.workerId,
    workspaceId,
    repairedVersion,
    closureReceiptId,
    originalUnchanged: true,
  };
}
