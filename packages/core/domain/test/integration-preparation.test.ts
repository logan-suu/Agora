// Pure control checks; these tests do not claim physical workspace or claim validation.
import { expect, it } from 'vitest';
import { planIntegrationPreparation } from '../src/integration-preparation';
import { applyMutations } from '../src/reducer';
import { isWorktreeRef } from '../src/state';
import { base, fixture as originalFixture } from './integration-fixture';

function fixture() {
  const state = originalFixture();
  const renamed = new Map(state.workers.map((w, i) => [w.workerId, `worker:wave:${i}`]));
  for (const w of state.workers) w.workerId = renamed.get(w.workerId) ?? w.workerId;
  const wave = state.parallelExecution?.activeWave;
  if (wave) wave.coderWorkerIds = wave.coderWorkerIds.map((id) => renamed.get(id) ?? id);
  const message = state.messages.find((m) => m.msgId === 'wave');
  if (message) message.payload.workerIds = state.workers.map((w) => w.workerId);
  for (const b of state.integration?.pendingBranches ?? [])
    b.workerId = renamed.get(b.workerId) ?? b.workerId;
  return state;
}

function input() {
  const before = fixture();
  const integration = before.integration;
  if (!integration) throw Error('missing integration');
  const { integrationId, waveId, base, pendingBranches, integrationWorktree: target } = integration;
  delete before.integration;
  before.phase = 'coding';
  return { before, plan: { integrationId, waveId, base, pendingBranches }, target };
}

it('plans the first integration without mutating input and replays only its exact State', () => {
  const { before, plan, target } = input();
  const copy = structuredClone(before);
  const changes = planIntegrationPreparation(before, before, plan, target);
  const after = applyMutations(before, changes);
  expect(changes).toHaveLength(2);
  expect(after).toEqual(fixture());
  expect(planIntegrationPreparation(after, before, plan, target)).toEqual([]);
  expect(before).toEqual(copy);
  const changed = structuredClone(after);
  changed.iterationCount++;
  expect(() => planIntegrationPreparation(changed, before, plan, target)).toThrow();
});

it('prepares an accepted wave only from its preceding validated branch and HEAD', () => {
  const { before, plan, target } = input();
  const acceptedBase = { branch: 'validated', commit: 'c'.repeat(40) };
  const current = before.subtasks[0];
  const worker = before.workers[0];
  const execution = before.parallelExecution;
  const wave = before.messages.find((message) => message.msgId === 'wave');
  const planMessage = before.messages.find((message) => message.msgId === 'plan');
  if (
    !current ||
    !worker ||
    !isWorktreeRef(current.worktree) ||
    !isWorktreeRef(worker.worktree) ||
    !execution?.activeWave ||
    !wave ||
    !planMessage
  )
    throw Error('missing accepted fixture');
  before.subtasks = [
    { id: 'prior', title: 'Prior', ownerRole: 'CODER', dependsOn: [], status: 'done' },
    {
      ...current,
      dependsOn: ['prior'],
      worktree: { ...current.worktree, baseCommit: acceptedBase.commit },
    },
  ];
  worker.workerId = 'worker:wave:0';
  worker.worktree = { ...worker.worktree, baseCommit: acceptedBase.commit };
  before.workers = [
    {
      workerId: 'worker:previous-dispatch:0',
      role: 'TESTER',
      executor: 'harness',
      status: 'done',
      startedTs: 1,
    },
    worker,
  ];
  if (planMessage.payload.kind !== 'execution_plan' || wave.payload.kind !== 'coding_wave')
    throw Error('missing canonical messages');
  planMessage.payload.plan = {
    version: 1,
    subtasks: [
      { id: 'prior', title: 'Prior', dependsOn: [] },
      { id: current.id, title: current.id, dependsOn: ['prior'] },
    ],
  };
  wave.payload.base = acceptedBase;
  wave.payload.subtaskIds = [current.id];
  wave.payload.workerIds = [worker.workerId];
  before.messages.splice(
    1,
    0,
    {
      msgId: 'previous-dispatch',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      ts: 2,
      display: 'Previous dispatch',
      payload: {
        kind: 'wave_validation_dispatch',
        planId: 'plan',
        waveId: 'previous-wave',
        attempt: 1,
        integrationId: 'previous-integration',
        inputCommit: base.commit,
        subtaskIds: ['prior'],
      },
    },
    {
      msgId: 'wave-validation:previous-dispatch',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      ts: 3,
      display: 'Accepted',
      payload: {
        kind: 'wave_validation',
        version: 1,
        planId: 'plan',
        waveId: 'previous-wave',
        attempt: 1,
        dispatchId: 'previous-dispatch',
        workerId: 'worker:previous-dispatch:0',
        integrationId: 'previous-integration',
        inputCommit: base.commit,
        worktree: {
          path: '/owned/validated',
          branch: acceptedBase.branch,
          baseCommit: base.commit,
          headCommit: acceptedBase.commit,
        },
        subtaskIds: ['prior'],
        controlFingerprint: 'e'.repeat(64),
        results: { passed: true, total: 1, failed: 0, failures: [] },
        evidence: {
          path: 'validation/previous-dispatch.json',
          sha256: 'f'.repeat(64),
          exitCode: 0,
          timedOut: false,
        },
      },
    },
  );
  execution.acceptedReceiptId = 'wave-validation:previous-dispatch';
  execution.activeWave.base = acceptedBase;
  execution.activeWave.subtaskIds = [current.id];
  execution.activeWave.coderWorkerIds = [worker.workerId];
  plan.base = acceptedBase;
  const pending = plan.pendingBranches[0];
  if (!pending) throw Error('missing branch');
  if (!isWorktreeRef(worker.worktree)) throw Error('missing worker worktree');
  plan.pendingBranches = [
    { ...pending, workerId: worker.workerId, worktree: worker.worktree, topologicalRank: 1 },
  ];
  target.baseCommit = acceptedBase.commit;
  target.headCommit = acceptedBase.commit;
  const after = applyMutations(before, planIntegrationPreparation(before, before, plan, target));
  expect(after.integration?.base).toEqual(acceptedBase);
  expect(after.integration?.integrationWorktree.headCommit).toBe(acceptedBase.commit);
  expect(planIntegrationPreparation(after, before, plan, target)).toEqual([]);
  const drifted = structuredClone(before);
  if (!drifted.parallelExecution?.activeWave) throw Error('missing wave');
  drifted.parallelExecution.activeWave.base.commit = base.commit;
  expect(() => planIntegrationPreparation(drifted, drifted, plan, target)).toThrow();
});

it.each([
  'phase',
  'accepted',
  'attempt',
  'worker',
  'dispatch',
  'order',
  'base',
  'target',
  'alias',
  'wave',
] as const)('rejects inadmissible preparation: %s', (kind) => {
  const { before, plan, target } = input();
  if (kind === 'phase') before.phase = 'testing';
  if (kind === 'accepted' && before.parallelExecution)
    before.parallelExecution.acceptedReceiptId = 'old';
  if (kind === 'attempt' && before.parallelExecution?.activeWave)
    before.parallelExecution.activeWave.attempt = 2;
  if (kind === 'worker' && before.workers[0]) before.workers[0].status = 'running';
  if (kind === 'dispatch') before.messages = [];
  if (kind === 'order') plan.pendingBranches.reverse();
  if (kind === 'base') plan.base = { ...plan.base, commit: 'e'.repeat(40) };
  if (kind === 'target') target.headCommit = 'f'.repeat(40);
  if (kind === 'alias') target.path = '/owned/A';
  if (kind === 'wave') plan.waveId = 'foreign';
  expect(() => planIntegrationPreparation(before, before, plan, target)).toThrow();
});
