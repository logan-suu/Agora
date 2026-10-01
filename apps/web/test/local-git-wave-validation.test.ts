// A fixed native command double isolates business-receipt replay and tamper
// handling; Phase 12 integration tests exercise the real Git/native command.
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppState,
  appendMutation,
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
  validationReceipt,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { WorkspaceCommandResult, WorkspaceWorkerSession } from '@agora/runtime-sandbox';
import { afterEach, expect, it } from 'vitest';
import { LocalGitWaveValidationService } from '../src/server/local-git-wave-validation';
import { localGitValidationCommand } from '../src/server/local-validation-command';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function artifactRoot() {
  const root = await mkdtemp(join(tmpdir(), 'agora-git-wave-'));
  const identity = await lstat(root);
  cleanups.push(async () => {
    const current = await lstat(root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.uid !== identity.uid
    )
      throw Error('test_artifact_root_changed');
    const entries = await readdir(root);
    if (entries.some((entry) => entry !== 'validation')) throw Error('test_artifact_root_changed');
    if (entries.includes('validation')) {
      const directory = join(root, 'validation');
      if (!(await lstat(directory)).isDirectory()) throw Error('test_artifact_root_changed');
      const files = await readdir(directory);
      if (files.some((file) => file !== 'dispatch.json')) throw Error('test_artifact_root_changed');
      if (
        files.includes('dispatch.json') &&
        !(await lstat(join(directory, 'dispatch.json'))).isFile()
      )
        throw Error('test_artifact_root_changed');
    }
    await rm(root, { recursive: true });
  });
  return root;
}

function setup() {
  const base = 'a'.repeat(40);
  const input = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const ref = {
    path: '/private/tmp/validation',
    branch: 'test',
    baseCommit: input,
    headCommit: head,
  };
  const coderRef = {
    path: '/private/tmp/coder',
    branch: 'coder',
    baseCommit: base,
    headCommit: input,
  };
  const integrationRef = {
    path: '/private/tmp/integration',
    branch: 'integration',
    baseCommit: base,
    headCommit: input,
  };
  const workspace = {
    schemaVersion: 'workspace-v1' as const,
    projectId: 'project',
    taskId: 'task',
    workspaceId: 'validation',
    rootId: 'root',
    grantId: 'grant',
    purpose: 'validation' as const,
    mode: 'linked-worktree' as const,
    commonDirId: `common:${'d'.repeat(64)}`,
    branch: ref.branch,
    baseCommit: ref.baseCommit,
  };
  const initialWorkspace = {
    ...workspace,
    workspaceId: 'initial',
    purpose: 'integration' as const,
    branch: 'base',
    baseCommit: base,
  };
  const coderWorkspace = {
    ...workspace,
    workspaceId: 'coder',
    purpose: 'coding' as const,
    branch: coderRef.branch,
    baseCommit: base,
  };
  const integrationWorkspace = {
    ...initialWorkspace,
    workspaceId: 'integration',
    branch: integrationRef.branch,
  };
  const receipt = (receiptId: string) => ({
    receiptId,
    actionId: receiptId,
    inputHash: 'f'.repeat(64),
    registryRevision: 1,
  });
  const version: WorkspaceVersionV1 = {
    kind: 'git',
    commit: head,
    manifestId: `manifest:${'e'.repeat(64)}`,
    manifestHash: 'e'.repeat(64),
  };
  const inspection = {
    version,
    files: [
      {
        path: 'one.test.cjs',
        version: { kind: 'absent' as const, parentIdentity: '0:0', name: 'one.test.cjs' },
      },
    ],
    excludedPaths: [],
  };
  const request = localGitValidationCommand(inspection, head);
  const run = {
    workerId: 'worker:dispatch:0',
    workspaceId: workspace.workspaceId,
    inputVersion: version,
    inputHash: '1'.repeat(64),
    policyHash: '2'.repeat(64),
    receiptId: `run:${'3'.repeat(64)}`,
    stage: 'exited',
    quiescent: true,
    timedOut: false,
    reason: 'none',
    exitCode: 0,
    stdout: 'TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n',
    stderr: '',
  } as WorkspaceCommandResult;
  const message = (msgId: string, payload: Record<string, unknown>) => ({
    msgId,
    payload,
    fromRole: 'COORDINATOR' as const,
    type: 'announce' as const,
    channelId: 'main',
    display: msgId,
    ts: 1,
  });
  const plan = { version: 1 as const, subtasks: [{ id: 'A', title: 'Answer', dependsOn: [] }] };
  const state: AppState = {
    ...createInitialAppState('task', 'Verify answer', 'project'),
    phase: 'testing',
    architecture: { executionPlan: plan },
    subtasks: [
      {
        id: 'A',
        title: 'Answer',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'in_progress',
        worktree: coderRef,
      },
    ],
    workers: [
      {
        workerId: 'worker:wave:0',
        role: 'CODER',
        subtaskId: 'A',
        executor: 'harness',
        status: 'done',
        startedTs: 1,
        worktree: coderRef,
      },
      {
        workerId: run.workerId,
        role: 'TESTER',
        executor: 'harness',
        status: 'running',
        startedTs: 1,
        worktree: ref,
      },
    ],
    messages: [
      message('plan', { kind: 'execution_plan', plan }),
      message('wave', { kind: 'coding_wave' }),
      message('dispatch', {
        kind: 'wave_validation_dispatch',
        planId: 'plan',
        waveId: 'wave',
        attempt: 1,
        integrationId: 'integration',
        inputCommit: input,
        subtaskIds: ['A'],
      }),
    ],
    parallelExecution: {
      version: 1,
      planId: 'plan',
      initialBase: { branch: 'base', commit: base },
      activeWave: {
        waveId: 'wave',
        attempt: 1,
        base: { branch: 'base', commit: base },
        subtaskIds: ['A'],
        coderWorkerIds: ['worker:wave:0'],
        validation: {
          dispatchId: 'dispatch',
          workerId: run.workerId,
          integrationId: 'integration',
          inputCommit: input,
          worktree: { ...ref, headCommit: input },
        },
      },
    },
    integration: {
      integrationId: 'integration',
      waveId: 'wave',
      base: { branch: 'base', commit: base },
      integrationWorktree: integrationRef,
      pendingBranches: [
        { workerId: 'worker:wave:0', subtaskId: 'A', topologicalRank: 0, worktree: coderRef },
      ],
      mergedBranches: [
        {
          workerId: 'worker:wave:0',
          subtaskId: 'A',
          branch: coderRef.branch,
          headCommit: input,
          mergeCommit: input,
        },
      ],
      conflicts: [],
      status: 'done',
      resultCommit: input,
    },
    localExecution: {
      schemaVersion: 'local-execution-v1',
      rootIds: ['root'],
      workspaces: [initialWorkspace, coderWorkspace, integrationWorkspace, workspace],
      bindings: [
        {
          workerId: 'worker:wave:0',
          subtaskId: 'A',
          workspaceId: 'coder',
          receiptId: 'coder-binding',
        },
        { workerId: run.workerId, workspaceId: workspace.workspaceId, receiptId: 'binding' },
      ],
      receipts: [
        receipt('initial-binding'),
        receipt('coder-binding'),
        receipt('integration-binding'),
        receipt('binding'),
      ],
      git: {
        version: 1,
        initialWorkspaceId: 'initial',
        worktrees: [
          { workspaceId: 'initial', path: '/private/tmp/initial', receiptId: 'initial-binding' },
          { workspaceId: 'coder', path: coderRef.path, receiptId: 'coder-binding' },
          {
            workspaceId: 'integration',
            path: integrationRef.path,
            receiptId: 'integration-binding',
          },
          { workspaceId: workspace.workspaceId, path: ref.path, receiptId: 'binding' },
        ],
      },
    },
  };
  let executions = 0;
  const session = {
    workspace,
    inspectCommittedGit: async () => inspection,
    runFixedGitValidation: async () => {
      executions++;
      return run;
    },
  } as unknown as WorkspaceWorkerSession;
  const evidence = {
    verifyCommand: async () => ({
      command: run,
      request,
      toolchainHash: '4'.repeat(64),
      dependenciesHash: '5'.repeat(64),
    }),
    readCompletedWorktree: async () => ({ workspaceId: workspace.workspaceId, worktree: ref }),
  };
  return {
    state,
    ref,
    version,
    session,
    evidence,
    get executions() {
      return executions;
    },
  };
}

it('binds a native Git command to wave_validation/v1 and reuses it after a lost State commit', async () => {
  const root = await artifactRoot();
  const f = setup();
  const service = new LocalGitWaveValidationService(f.evidence, async () => f.state, root);
  const first = await service.complete(f.state, 'worker:dispatch:0', f.session);
  const replay = await service.complete(f.state, 'worker:dispatch:0', f.session);
  expect(f.executions).toBe(1);
  expect(applyMutations(f.state, first).messages.at(-1)?.payload).toEqual(
    applyMutations(f.state, replay).messages.at(-1)?.payload,
  );
  const committed = applyMutations(f.state, first);
  expect(committed.messages.at(-1)?.payload).toMatchObject({
    kind: 'wave_validation',
    version: 1,
    results: { passed: true, total: 1 },
    worktree: f.ref,
  });
  expect(committed.testResults?.workspaceVersion).toEqual(f.version);
  await expect(service.verifyReceiptHead(committed, 'wave-validation:dispatch')).resolves.toEqual(
    f.version,
  );
  const settled = applyMutations(committed, [
    mergeByIdMutation('workers', 'worker:dispatch:0', { status: 'done' }),
  ]);
  await expect(service.verifyReceiptHead(settled, 'wave-validation:dispatch')).resolves.toEqual(
    f.version,
  );
  const path = join(root, 'validation/dispatch.json');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace('"controlFingerprint":"', '"controlFingerprint":"0'));
  await expect(service.verifyReceiptHead(committed, 'wave-validation:dispatch')).rejects.toThrow();
});

it('rejects control drift after the native command without creating a business receipt', async () => {
  const root = await artifactRoot();
  const f = setup();
  const service = new LocalGitWaveValidationService(
    f.evidence,
    async () => ({
      ...f.state,
      goal: 'changed while validating',
    }),
    root,
  );
  await expect(service.complete(f.state, 'worker:dispatch:0', f.session)).rejects.toThrow(
    'local_git_wave_control_changed',
  );
  expect(f.executions).toBe(1);
  expect(f.state.messages.some((message) => message.payload.kind === 'wave_validation')).toBe(
    false,
  );
});

it('binds final REVIEWER to the current accepted receipt and verified Git version', async () => {
  const root = await artifactRoot();
  const f = setup();
  let current = f.state;
  const service = new LocalGitWaveValidationService(f.evidence, async () => current, root);
  const committed = applyMutations(
    f.state,
    await service.complete(f.state, 'worker:dispatch:0', f.session),
  );
  const settled = applyMutations(committed, [
    mergeByIdMutation('workers', 'worker:dispatch:0', { status: 'done' }),
    mergeByIdMutation('subtasks', 'A', { status: 'done' }),
    setMutation('parallelExecution', {
      version: 1,
      planId: 'plan',
      initialBase: { branch: 'base', commit: 'a'.repeat(40) },
      acceptedReceiptId: 'wave-validation:dispatch',
    }),
    setMutation('phase', 'review'),
    setMutation('nextRole', 'REVIEWER'),
    appendMutation('messages', {
      msgId: 'review',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      payload: {
        kind: 'parallel_review_dispatch',
        nextRole: 'REVIEWER',
        workerIds: ['worker:review:0'],
        reviewCommentCursor: 0,
        reviewBinding: {
          planId: 'plan',
          validationReceiptId: 'wave-validation:dispatch',
          commit: f.ref.headCommit,
          controlFingerprint: committed.messages.at(-1)?.payload.controlFingerprint,
        },
      },
      display: 'Review cumulative validation',
      ts: 2,
    }),
    mergeByIdMutation('workers', 'worker:review:0', {
      role: 'REVIEWER',
      executor: 'harness',
      status: 'pending',
      startedTs: 2,
    }),
  ]);
  current = settled;
  await expect(service.verifiedReviewVersion(settled, 'worker:review:0')).resolves.toEqual(
    f.version,
  );
  await expect(service.verifiedDeliveryVersion(settled)).resolves.toEqual(f.version);
  await expect(service.verifyCompletion(settled)).rejects.toThrow('local_delivery_goal_required');
  const nativeGoal = applyMutations(settled, [
    setMutation('localExecution', {
      ...requiredLocal(settled),
      delivery: {
        schemaVersion: 'local-delivery-v1',
        goal: 'artifact_only',
        rootId: 'root',
        rounds: [],
        currentRoundId: null,
      },
    }),
  ]);
  current = nativeGoal;
  await expect(service.verifyCompletion(nativeGoal)).resolves.toMatchObject({ version: f.version });
  current = settled;
  const completed = applyMutations(settled, [
    mergeByIdMutation('workers', 'worker:review:0', { status: 'done' }),
    setMutation('phase', 'done'),
  ]);
  current = completed;
  await expect(service.verifiedDeliveryVersion(completed)).resolves.toEqual(f.version);
  if (!completed.parallelExecution) throw Error('missing_execution');
  await expect(
    service.verifiedDeliveryVersion({
      ...completed,
      parallelExecution: { ...completed.parallelExecution, acceptedReceiptId: 'other' },
    }),
  ).rejects.toThrow('local_git_delivery_source_changed');
  await expect(
    service.verifiedDeliveryVersion({ ...completed, goal: 'changed goal' }),
  ).rejects.toThrow('local_git_delivery_source_changed');
  expect(f.executions).toBe(1);
  current = settled;
  const paused = applyMutations(settled, [
    mergeByIdMutation('workers', 'worker:review:0', { status: 'paused' }),
  ]);
  current = paused;
  await expect(service.verifiedReviewVersion(paused, 'worker:review:0')).resolves.toEqual(
    f.version,
  );
  current = settled;
  await expect(
    service.verifiedReviewVersion(
      {
        ...settled,
        testResults: {
          ...settled.testResults,
          workspaceVersion: { ...f.version, commit: 'd'.repeat(40) },
        },
      } as AppState,
      'worker:review:0',
    ),
  ).rejects.toThrow('local_git_review_binding_changed');
  const changed = {
    ...settled,
    parallelExecution: { ...settled.parallelExecution, acceptedReceiptId: 'other' },
  } as AppState;
  await expect(service.verifiedReviewVersion(changed, 'worker:review:0')).rejects.toThrow(
    'local_git_review_binding_changed',
  );
  await expect(service.verifiedReviewVersion(settled, 'worker:other:0')).rejects.toThrow(
    'local_git_review_binding_changed',
  );
  const drifted = new LocalGitWaveValidationService(
    {
      ...f.evidence,
      readCompletedWorktree: async () => {
        current = { ...settled, goal: 'changed during review proof' };
        return { workspaceId: 'validation', worktree: f.ref };
      },
    },
    async () => current,
    root,
  );
  await expect(drifted.verifiedReviewVersion(settled, 'worker:review:0')).rejects.toThrow(
    'local_git_review_binding_changed',
  );
});

it('reproves the accepted native receipt and completed Git tree for the next coding wave', async () => {
  const root = await artifactRoot();
  const f = setup();
  const plan = {
    version: 1 as const,
    subtasks: [
      { id: 'A', title: 'Answer', dependsOn: [] },
      { id: 'B', title: 'Follow-up', dependsOn: ['A'] },
    ],
  };
  f.state.architecture = { executionPlan: plan };
  f.state.subtasks.push({
    id: 'B',
    title: 'Follow-up',
    ownerRole: 'CODER',
    dependsOn: ['A'],
    status: 'todo',
  });
  const planMessage = f.state.messages.find((message) => message.msgId === 'plan');
  if (!planMessage) throw Error('missing plan');
  planMessage.payload.plan = plan;
  let current = f.state;
  const service = new LocalGitWaveValidationService(f.evidence, async () => current, root);
  const committed = applyMutations(
    f.state,
    await service.complete(f.state, 'worker:dispatch:0', f.session),
  );
  const acceptedId = 'wave-validation:dispatch';
  const acceptedBase = { branch: f.ref.branch, commit: f.ref.headCommit };
  const next = applyMutations(committed, [
    mergeByIdMutation('workers', 'worker:dispatch:0', { status: 'done' }),
    mergeByIdMutation('subtasks', 'A', { status: 'done' }),
    mergeByIdMutation('subtasks', 'B', { status: 'in_progress' }),
    appendMutation('messages', {
      msgId: 'next-wave',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      display: 'Next wave',
      ts: 3,
      payload: {
        kind: 'coding_wave',
        planId: 'plan',
        nextRole: 'CODER',
        attempt: 1,
        base: acceptedBase,
        subtaskIds: ['B'],
        workerIds: ['worker:next-wave:0'],
      },
    }),
    mergeByIdMutation('workers', 'worker:next-wave:0', {
      role: 'CODER',
      executor: 'harness',
      status: 'pending',
      subtaskId: 'B',
      startedTs: 3,
    }),
    setMutation('parallelExecution', {
      version: 1,
      planId: 'plan',
      initialBase: { branch: 'base', commit: 'a'.repeat(40) },
      acceptedReceiptId: acceptedId,
      activeWave: {
        waveId: 'next-wave',
        attempt: 1,
        base: acceptedBase,
        subtaskIds: ['B'],
        coderWorkerIds: ['worker:next-wave:0'],
      },
    }),
    setMutation('phase', 'coding'),
    setMutation('nextRole', 'CODER'),
  ]);
  const receipt = validationReceipt(next, acceptedId);
  current = next;
  await expect(service.verifiedAcceptedVersion(next, receipt, f.version)).resolves.toBeUndefined();
  const integrating = { ...next, phase: 'integrating' as const };
  current = integrating;
  await expect(
    service.verifiedAcceptedVersion(integrating, receipt, f.version),
  ).resolves.toBeUndefined();
  current = next;
  await expect(
    service.verifiedAcceptedVersion({ ...next, phase: 'testing' }, receipt, f.version),
  ).rejects.toThrow('local_git_accepted_source_changed');
  const nextCommit = 'd'.repeat(40);
  const nextIntegration = next.integration;
  const nextExecution = next.parallelExecution;
  if (!nextIntegration || !nextExecution?.activeWave) throw Error('missing integration');
  const nextBranch = {
    workerId: 'worker:next-wave:0',
    subtaskId: 'B',
    topologicalRank: 0,
    worktree: {
      path: '/private/tmp/next-coder',
      branch: 'next-coder',
      baseCommit: acceptedBase.commit,
      headCommit: 'e'.repeat(40),
    },
  };
  const testing: AppState = {
    ...next,
    phase: 'testing',
    nextRole: 'TESTER',
    integration: {
      ...nextIntegration,
      integrationId: 'next-integration',
      waveId: 'next-wave',
      base: acceptedBase,
      integrationWorktree: {
        ...nextIntegration.integrationWorktree,
        baseCommit: acceptedBase.commit,
        headCommit: nextCommit,
      },
      pendingBranches: [nextBranch],
      mergedBranches: [
        {
          workerId: nextBranch.workerId,
          subtaskId: nextBranch.subtaskId,
          branch: nextBranch.worktree.branch,
          headCommit: nextBranch.worktree.headCommit,
          mergeCommit: nextCommit,
        },
      ],
      conflicts: [],
      status: 'done',
      resultCommit: nextCommit,
    },
    parallelExecution: {
      ...nextExecution,
      activeWave: {
        ...nextExecution.activeWave,
        validation: {
          dispatchId: 'validate-next',
          workerId: 'worker:validate-next:0',
          integrationId: 'next-integration',
          inputCommit: nextCommit,
        },
      },
    },
    workers: [
      ...next.workers,
      {
        workerId: 'worker:validate-next:0',
        role: 'TESTER',
        executor: 'harness',
        status: 'pending',
        startedTs: 4,
      },
    ],
    messages: [
      ...next.messages,
      {
        msgId: 'validate-next',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        display: 'Validate second wave',
        ts: 4,
        payload: {
          kind: 'wave_validation_dispatch',
          planId: 'plan',
          waveId: 'next-wave',
          attempt: 1,
          integrationId: 'next-integration',
          inputCommit: nextCommit,
          subtaskIds: ['B'],
        },
      },
    ],
  };
  current = testing;
  await expect(
    service.verifiedAcceptedVersion(testing, receipt, f.version),
  ).resolves.toBeUndefined();
  const driftedValidation = {
    ...testing,
    integration: { ...nextIntegration, resultCommit: 'e'.repeat(40) },
  };
  current = driftedValidation;
  await expect(
    service.verifiedAcceptedVersion(driftedValidation, receipt, f.version),
  ).rejects.toThrow('local_git_accepted_source_changed');
  current = next;
  await expect(
    service.verifiedAcceptedVersion(
      next,
      { ...receipt, worktree: { ...receipt.worktree, headCommit: 'f'.repeat(40) } },
      f.version,
    ),
  ).rejects.toThrow('local_git_accepted_source_changed');
  await expect(
    service.verifiedAcceptedVersion(next, receipt, { ...f.version, commit: 'f'.repeat(40) }),
  ).rejects.toThrow('local_git_accepted_source_changed');
  const drifted = new LocalGitWaveValidationService(
    {
      ...f.evidence,
      readCompletedWorktree: async () => {
        current = { ...next, goal: 'changed during accepted proof' };
        return { workspaceId: 'validation', worktree: f.ref };
      },
    },
    async () => current,
    root,
  );
  await expect(drifted.verifiedAcceptedVersion(next, receipt, f.version)).rejects.toThrow(
    'local_git_accepted_source_changed',
  );
});

function requiredLocal(state: AppState) {
  if (!state.localExecution) throw Error('missing_local');
  return state.localExecution;
}
