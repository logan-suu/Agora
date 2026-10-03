// Private objects, native admission and official JSONL answers are unit doubles
// for saga failure ordering. Real Harness/lease/MCP restoration is tested in G5.
import {
  applyMutations,
  createInitialAppState,
  type Message,
  mergeByIdMutation,
  parseWorkspaceControl,
  workspaceRangeResumes,
} from '@agora/core-domain';
import { expect, it } from 'vitest';
import { parseLocalRangeHold } from '../src/local-range-records';
import {
  type LocalRangeForkPlan,
  LocalRangeResumeController,
} from '../src/local-range-resume-controller';
import { localRangeAssignmentHash } from '../src/local-range-targets';
import { localRecordHash } from '../src/local-registry-records';
import { fixture } from './local-range-control-fixture';

async function setup(second = false) {
  const f = fixture();
  const display =
    '/workspace return ' +
    JSON.stringify({
      ...f.scope,
      actionId: 'return',
      expectedRevision: 2,
      takeoverReceiptId: f.hold.plan.takeoverId,
    });
  const returned: Message = {
    msgId: 'return',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    ts: 2,
    display,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  let state = applyMutations(createInitialAppState('task', 'unit', 'project'), [
    mergeByIdMutation('workers', 'worker', {
      workerId: 'worker',
      role: 'CODER',
      executor: 'harness',
      status: 'paused',
      sessionId: 'session',
      safePoint: 'safe:parent',
      startedTs: 1,
    }),
  ]);
  if (second)
    state = applyMutations(state, [
      mergeByIdMutation('workers', 'second', {
        workerId: 'second',
        role: 'CODER',
        executor: 'harness',
        status: 'paused',
        sessionId: 'second-session',
        safePoint: 'safe:second',
        startedTs: 1,
      }),
    ]);
  state.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['root'],
    bindings: [],
    receipts: [],
    workspaces: [
      {
        schemaVersion: 'workspace-v1',
        ...f.scope,
        workspaceId: 'workspace',
        rootId: 'root',
        grantId: 'grant',
        purpose: 'coding',
        mode: 'direct',
        baselineManifestId: 'manifest:unit',
      },
    ],
  };
  state = applyMutations(state, [
    { op: 'append', field: 'messages', value: f.message },
    { op: 'append', field: 'messages', value: returned },
    {
      op: 'append',
      field: 'messages',
      value: {
        msgId: `workspace-change:${'c'.repeat(64)}`,
        fromRole: 'COORDINATOR',
        channelId: 'main',
        type: 'announce',
        ts: 2,
        display: 'unit',
        payload: {
          kind: 'workspace_version_change',
          version: 1,
          ...f.scope,
          changeId: `workspace-change:${'c'.repeat(64)}`,
          takeoverId: f.hold.plan.takeoverId,
          returnActionId: 'return',
          source: {
            ...f.scope,
            msgId: 'return',
            workspaceId: 'workspace',
            rootId: 'root',
            grantId: 'grant',
            grantRevision: 0,
          },
          workspaceIds: ['workspace'],
          affectedWorkerIds: second ? ['worker', 'second'] : ['worker'],
          heldVersion: f.hold.plan.startVersion,
          returnedVersion: f.hold.plan.startVersion,
          privateProofHash: 'd'.repeat(64),
          invalidatedValidationIds: [],
        },
      },
    },
  ]);
  const assignment = f.hold.plan.cohort[0];
  if (!assignment) throw Error('missing unit assignment');
  const plan = {
    ...f.hold.plan,
    cohort: [
      { ...assignment, assignmentHash: localRangeAssignmentHash(state, 'worker') },
      ...(second
        ? [
            {
              ...f.scope,
              workerId: 'second',
              sessionId: 'second-session',
              assignmentHash: localRangeAssignmentHash(state, 'second'),
            },
          ]
        : []),
    ],
  };
  const phases = [
    'canonical',
    'worker_closed',
    'held',
    'return_requested',
    'captured',
    'invalidated',
    'released',
  ] as const;
  const refs = await Promise.all(
    phases.map((phase) =>
      f.objects.put(
        phase === 'worker_closed'
          ? {
              schemaVersion: 'local-range-worker-closed-v1',
              planHash: localRecordHash(plan),
              ...f.scope,
              workerId: 'worker',
              sessionId: 'session',
              status: 'paused',
              safePointRef: 'safe:parent',
            }
          : { phase },
      ),
    ),
  );
  const secondRef = second
    ? await f.objects.put({
        schemaVersion: 'local-range-worker-closed-v1',
        planHash: localRecordHash(plan),
        ...f.scope,
        workerId: 'second',
        sessionId: 'second-session',
        status: 'paused',
        safePointRef: 'safe:second',
      })
    : undefined;
  const hold = parseLocalRangeHold({
    ...f.hold,
    plan,
    planHash: localRecordHash(plan),
    stage: 'released',
    controlStage: 'committed',
    returnMessage: returned,
    evidence: phases.flatMap((phase, i) => [
      {
        phase,
        workerKey: phase === 'worker_closed' ? 'project/task/worker' : null,
        ref: refs[i],
      },
      ...(phase === 'worker_closed' && second
        ? [{ phase, workerKey: 'project/task/second', ref: secondRef }]
        : []),
    ]),
  });
  await f.control.updateRangeHold(0, hold);
  const calls: string[] = [];
  let forkFailure = false;
  let executionVerifier: (() => Promise<void>) | undefined;
  const earlyErrors: string[] = [];
  const tasks = {
    load: async () => structuredClone(state),
    compareAndCommit: async (
      _scope: unknown,
      before: typeof state,
      mutations: Parameters<typeof applyMutations>[1],
    ) => {
      if (localRecordHash(before) !== localRecordHash(state)) throw Error('stale');
      state = applyMutations(state, mutations);
      calls.push('canonical');
      return { state: structuredClone(state), changed: true };
    },
  };
  const evidence = {
    verifyReleased: async () => {},
    verifyResumeAdmission: async (_h: unknown, scope: { workerId: string }) => {
      calls.push('admission');
      if (scope.workerId === 'second') throw Error('second_worker_not_eligible');
    },
  };
  const readFork = async (p: LocalRangeForkPlan) => ({
    ...f.scope,
    role: 'CODER',
    cwd: '/fixture',
    sourceSessionId: p.sourceSessionId,
    childSessionId: p.resumeSessionId,
    boundary: 1,
    seedLength: 2,
    seedHash: 'a'.repeat(64),
  });
  const options = {
    ...f,
    tasks,
    evidence,
    readFork,
    prepareFork: async () => {
      calls.push('fork');
      if (forkFailure) throw Error('fork_response_lost');
    },
    register: async (
      _request: unknown,
      verify: (id: string, phase: 'register' | 'execute') => Promise<void>,
    ) => {
      calls.push('register');
      await verify('worker', 'register');
      executionVerifier = () => verify('worker', 'execute');
      await executionVerifier().catch((e) => earlyErrors.push(e.message));
    },
  };
  return {
    ...f,
    hold,
    tasks,
    options,
    calls,
    earlyErrors,
    execute: () => executionVerifier?.(),
    controller: new LocalRangeResumeController(options),
    failFork: () => {
      forkFailure = true;
    },
    setState: (s: typeof state) => {
      state = s;
    },
  };
}
it('durably registers a single official child before host admission and reads terminal history without repeating the Fork', async () => {
  const f = await setup();
  await f.controller.prepare(f.hold);
  const state = await f.tasks.load(),
    fact = workspaceRangeResumes(state)[0];
  expect(fact?.sourceSessionId).toBe('session');
  expect(state.workers[0]?.status).toBe('paused');
  expect(f.calls.filter((x) => x === 'fork')).toHaveLength(1);
  expect(f.calls.indexOf('canonical')).toBeLessThan(f.calls.indexOf('register'));
  expect(f.earlyErrors).toEqual(['range_resume_registration_incomplete']);
  await f.execute();
  await f.controller.prepare(f.hold);
  expect(f.calls.filter((x) => x === 'fork')).toHaveLength(1);
  const registered = (await f.control.snapshot()).rangeHolds?.[0];
  if (!registered || !fact) throw Error('missing fixture result');
  f.setState(
    applyMutations(state, [
      mergeByIdMutation('workers', 'worker', { status: 'done', sessionId: fact.resumeSessionId }),
    ]),
  );
  const before = f.calls.length,
    cold = new LocalRangeResumeController(f.options);
  expect((await cold.read(registered, fact.privateProofHash)).resumeSessionId).toBe(
    fact.resumeSessionId,
  );
  expect(f.calls).toHaveLength(before);
});
it('preserves uncertain Fork start evidence and refuses repeat construction in a cold instance', async () => {
  const f = await setup();
  f.failFork();
  await expect(f.controller.prepare(f.hold)).rejects.toThrow('fork_response_lost');
  const stopped = (await f.control.snapshot()).rangeHolds?.[0];
  expect(stopped?.evidence.at(-1)?.phase).toBe('needs_attention');
  expect(workspaceRangeResumes(await f.tasks.load())).toEqual([]);
  const cold = new LocalRangeResumeController(f.options);
  await expect(cold.prepare(f.hold)).rejects.toThrow('range_resume_not_live');
  expect(f.calls.filter((x) => x === 'fork')).toHaveLength(1);
  expect(f.calls).not.toContain('register');
});
it('does not reopen done or failed workers and refuses paused recovery while a real human gate is unresolved', async () => {
  for (const status of ['done', 'failed'] as const) {
    const f = await setup();
    f.setState(
      applyMutations(await f.tasks.load(), [mergeByIdMutation('workers', 'worker', { status })]),
    );
    await f.controller.prepare(f.hold);
    expect(f.calls).not.toContain('fork');
    expect(f.calls).not.toContain('register');
  }
  const f = await setup();
  f.setState(
    applyMutations(await f.tasks.load(), [
      {
        op: 'set',
        field: 'humanGate',
        value: {
          gateId: 'gate',
          reason: 'iteration_limit',
          options: ['continue'],
          phase: 'coding',
          openedTs: 3,
          safePointRefs: ['safe:parent'],
        },
      },
    ]),
  );
  await expect(f.controller.prepare(f.hold)).rejects.toThrow('range_resume_not_admissible');
  expect(f.calls).not.toContain('fork');
});
it('fails closed for canonical registration corruption instead of trusting a phase label or private hash', async () => {
  const f = await setup();
  await f.controller.prepare(f.hold);
  const state = await f.tasks.load(),
    fact = workspaceRangeResumes(state)[0],
    registered = (await f.control.snapshot()).rangeHolds?.[0];
  if (!fact || !registered) throw Error('missing fixture result');
  f.setState({
    ...state,
    messages: state.messages.map((m) =>
      m.msgId === fact.resumeId ? { ...m, display: 'altered' } : m,
    ),
  });
  await expect(f.controller.read(registered, fact.privateProofHash)).rejects.toThrow(
    'range_resume_evidence_invalid',
  );
});
it('preflights the entire selected cohort before constructing the first external child', async () => {
  const f = await setup(true);
  await expect(f.controller.prepare(f.hold)).rejects.toThrow('second_worker_not_eligible');
  expect(f.calls).not.toContain('fork');
  expect(f.calls).not.toContain('canonical');
  expect(f.calls).not.toContain('register');
  expect(workspaceRangeResumes(await f.tasks.load())).toEqual([]);
});
