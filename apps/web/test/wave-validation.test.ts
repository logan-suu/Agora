import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppState,
  applyMutations,
  assertParallelState,
  createInitialAppState,
  type WorktreeRef,
} from '@agora/core-domain';
import { LocalTempSandbox, type Worktree } from '@agora/runtime-sandbox';
import { WorktreeRegistry } from '@agora/tools-fs';
import { initializeRegisteredWorktree, WorktreeGitService } from '@agora/tools-git';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCoderWorktreeReady,
  controlFingerprint,
  executeValidation,
  WaveValidationService,
} from '../src/server/wave-validation';

// Count real executions without replacing the sandbox or its process runner.
class ObservedSandbox extends LocalTempSandbox {
  runs = 0;
  override run(worktree: Worktree, command: string, timeout?: number) {
    this.runs++;
    return super.run(worktree, command, timeout);
  }
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agora-validation-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sandbox = new LocalTempSandbox();
  cleanups.push(() => sandbox.teardown('task'));
  const worktree = await sandbox.createWorktree('task', 'TESTER');
  const registry = new WorktreeRegistry();
  await initializeRegisteredWorktree(registry, worktree.path);
  const git = new WorktreeGitService(registry);
  cleanups.push(() => git.dispose());
  const inputCommit = await git.headOf(worktree.path);
  const ref: WorktreeRef = {
    path: worktree.path,
    branch: await git.branchOf(worktree.path),
    baseCommit: inputCommit,
    headCommit: inputCommit,
  };
  return { root, sandbox, git, ref };
}

async function receiptFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agora-validation-replay-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const registry = new WorktreeRegistry();
  const git = new WorktreeGitService(registry, join(root, 'repository'), join(root, 'worktrees'));
  cleanups.push(() => git.dispose());
  const sandbox = new ObservedSandbox();
  const base = await git.canonicalHead();
  const coder = await git.createWorktreeFrom('task', 'coder', base);
  sandbox.bindFiles(coder, registry.filesFor(coder.path));
  await sandbox.write(coder, 'answer.mjs', 'export const answer = 42;\n');
  const codeHead = await git.applyPatch(coder.path, '');
  const integration = await git.createWorktreeFrom('task', 'integration', codeHead);
  const testing = await git.createWorktreeFrom('task', 'testing', codeHead);
  sandbox.bindFiles(testing, registry.filesFor(testing.path));
  await sandbox.write(
    testing,
    'answer.test.mjs',
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {answer} from './answer.mjs'; test('answer', () => assert.equal(answer, 42));\n",
  );
  const testHead = await git.applyPatch(testing.path, '');
  const coderRef: WorktreeRef = { ...coder, baseCommit: base, headCommit: codeHead };
  const integrationRef: WorktreeRef = { ...integration, baseCommit: base, headCommit: codeHead };
  const ref: WorktreeRef = { ...testing, baseCommit: codeHead, headCommit: testHead };
  const plan = { version: 1 as const, subtasks: [{ id: 'A', title: 'Answer', dependsOn: [] }] };
  const control = (msgId: string, payload: Record<string, unknown>) => ({
    msgId,
    payload,
    fromRole: 'COORDINATOR' as const,
    type: 'announce' as const,
    channelId: 'main',
    display: 'Validation fixture',
    ts: 1,
  });
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
        workerId: 'worker:validation:0',
        role: 'TESTER',
        executor: 'harness',
        status: 'running',
        startedTs: 1,
        worktree: ref,
      },
    ],
    messages: [
      control('plan', { kind: 'execution_plan', plan }),
      control('wave', { kind: 'coding_wave' }),
      control('validation', {
        kind: 'wave_validation_dispatch',
        planId: 'plan',
        waveId: 'wave',
        attempt: 1,
        integrationId: 'integration',
        inputCommit: codeHead,
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
          dispatchId: 'validation',
          workerId: 'worker:validation:0',
          integrationId: 'integration',
          inputCommit: codeHead,
          worktree: ref,
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
          branch: coder.branch,
          headCommit: codeHead,
          mergeCommit: codeHead,
        },
      ],
      conflicts: [],
      status: 'done',
      resultCommit: codeHead,
    },
  };
  assertParallelState(state);
  return {
    state,
    ref,
    git,
    sandbox,
    service: new WaveValidationService(sandbox, git, join(root, 'artifacts')),
    evidencePath: join(root, 'artifacts/validation/validation.json'),
  };
}
// Replay cases perform many real Git inspections; their test budget includes
// setup and tampering checks, independently of the 30s sandbox command deadline.
describe('trusted wave validation', () => {
  it('reuses immutable execution evidence when its canonical receipt commit was lost', async () => {
    const { state, ref, sandbox, service, evidencePath } = await receiptFixture();
    const mutations = await service.complete(state, 'worker:validation:0', ref);
    const original = await readFile(evidencePath, 'utf8');
    // Omit the canonical transition to model evidence persisted before State commit failure.
    expect(state.parallelExecution?.activeWave?.validation?.receiptId).toBeUndefined();
    const replay = await service.complete(state, 'worker:validation:0', ref);
    const first = applyMutations(state, mutations);
    const recovered = applyMutations(state, replay);
    expect(recovered.testResults).toEqual({ passed: true, total: 1, failed: 0, failures: [] });
    expect(recovered.messages.at(-1)?.payload).toEqual(first.messages.at(-1)?.payload);
    expect(await readFile(evidencePath, 'utf8')).toBe(original);
    expect(sandbox.runs).toBe(1);
    await expect(service.complete(recovered, 'worker:validation:0', ref)).resolves.toEqual([]);
    expect(sandbox.runs).toBe(1);
  }, 30_000);

  it('rejects damaged, mismatched or changed replay evidence without executing or overwriting it', async () => {
    const { state, ref, sandbox, service, evidencePath, git } = await receiptFixture();
    await service.complete(state, 'worker:validation:0', ref);
    const original = await readFile(evidencePath, 'utf8');
    const evidence = JSON.parse(original);
    for (const patch of [
      { projectId: 'other' },
      { taskId: 'other' },
      { dispatchId: 'other' },
      { controlFingerprint: '0'.repeat(64) },
      { command: "printf '1..1\\nok 1 - fake\\n'" },
      { results: { ...evidence.results, total: 99 } },
      { worktree: { ...evidence.worktree, headCommit: '0'.repeat(40) } },
      { run: { ...evidence.run, exitCode: 1 } },
      { run: { ...evidence.run, stdout: 'truncated' } },
    ]) {
      const changed = JSON.stringify({ ...evidence, ...patch });
      await writeFile(evidencePath, changed);
      await expect(service.complete(state, 'worker:validation:0', ref)).rejects.toThrow(/evidence/);
      expect(await readFile(evidencePath, 'utf8')).toBe(changed);
    }
    await writeFile(evidencePath, '{broken');
    await expect(service.complete(state, 'worker:validation:0', ref)).rejects.toThrow(/evidence/);
    await writeFile(evidencePath, original);
    await sandbox.write(
      ref,
      'extra.test.mjs',
      "import {test} from 'node:test'; test('extra',()=>{});",
    );
    await git.applyPatch(ref.path, '');
    await expect(service.complete(state, 'worker:validation:0', ref)).rejects.toThrow(/evidence/);
    expect(await readFile(evidencePath, 'utf8')).toBe(original);
    expect(sandbox.runs).toBe(1);
  }, 30_000);

  it('executes tracked tests with Unicode, spaces, quotes and leading hyphens instead of skipping them', async () => {
    const { sandbox, git, ref } = await fixture();
    for (const path of ['中文 目录/失败 用例.test.mjs', "it's fine.spec.mjs", '-leading.test.mjs'])
      await sandbox.write(
        ref,
        path,
        "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('included',()=>assert.equal(1,2));",
      );
    await git.applyPatch(ref.path, '');
    const result = await executeValidation(sandbox, git, ref);
    expect(result.results).toMatchObject({ passed: false, total: 3, failed: 3 });
    expect(result.run.exitCode).toBe(1);
    expect(result.run.stdout).toContain('# tests 3');
  });

  it('records a failing test nested in a real Node suite as a business test failure', async () => {
    const { sandbox, git, ref } = await fixture();
    await sandbox.write(
      ref,
      'nested.test.mjs',
      "import {describe,it} from 'node:test'; import assert from 'node:assert/strict'; describe('suite',()=>{it('nested failure',()=>assert.equal(1,2));});",
    );
    await git.applyPatch(ref.path, '');
    const result = await executeValidation(sandbox, git, ref);
    expect(result.results).toMatchObject({ passed: false, total: 1, failed: 1 });
    expect(result.results.failures).toHaveLength(1);
    expect(result.run.exitCode).toBe(1);
    expect(result.run.stdout).toContain("type: 'suite'");
  });

  it('ignores old result files and requires tests on a clean committed HEAD', async () => {
    const { sandbox, git, ref } = await fixture();
    await writeFile(
      join(ref.path, 'test-results.json'),
      JSON.stringify({ passed: true, total: 99, failed: 0, failures: [] }),
    );
    await expect(executeValidation(sandbox, git, ref)).rejects.toThrow(/clean/);
    await rm(join(ref.path, 'test-results.json'));
    await expect(executeValidation(sandbox, git, ref)).rejects.toThrow(/test files/);
    await sandbox.write(
      ref,
      'answer.test.mjs',
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('actual answer',()=>assert.equal(6*7,42));",
    );
    await git.applyPatch(ref.path, '');
    const result = await executeValidation(sandbox, git, ref);
    expect(result.results).toEqual({ passed: true, total: 1, failed: 0, failures: [] });
    expect(result.run.exitCode).toBe(0);
    expect(result.worktree.headCommit).not.toBe(ref.baseCommit);
    expect(result.run.stdout).toContain('actual answer');
  });
  it('rejects business edits and tests that mutate the validated tree', async () => {
    const { sandbox, git, ref } = await fixture();
    await sandbox.write(ref, 'business.mjs', 'export const answer = 42;');
    await git.applyPatch(ref.path, '');
    await expect(executeValidation(sandbox, git, ref)).rejects.toThrow(/business/);
    const baseCommit = await git.headOf(ref.path);
    await sandbox.write(
      ref,
      'mutation.test.mjs',
      "import {test} from 'node:test'; import {writeFileSync} from 'node:fs'; test('mutating test',()=>writeFileSync('business.mjs','changed')); ",
    );
    await git.applyPatch(ref.path, '');
    await expect(executeValidation(sandbox, git, { ...ref, baseCommit })).rejects.toThrow(
      /changed|clean/,
    );
  });
  it('hashes control semantics deterministically while priority does not invalidate evidence', () => {
    const state = createInitialAppState('task', 'goal');
    state.architecture = {
      executionPlan: { version: 1, subtasks: [{ id: 'A', title: 'A', dependsOn: [] }] },
    };
    const first = controlFingerprint(state);
    expect(
      controlFingerprint({
        ...state,
        iterationCount: 3,
        subtasks: [
          { id: 'A', title: 'A', ownerRole: 'CODER', status: 'todo', dependsOn: [], priority: 99 },
        ],
      }),
    ).toBe(first);
    expect(controlFingerprint({ ...state, goal: 'new goal' })).not.toBe(first);
    expect(
      controlFingerprint({
        ...state,
        requirements: [
          { id: 'R', story: 'new requirement', acceptance: ['must pass'], nonGoals: [] },
        ],
      }),
    ).not.toBe(first);
  });
});

it('rejects deletion of an inherited cumulative regression test', async () => {
  const { sandbox, git, ref } = await fixture();
  await sandbox.write(ref, 'answer.mjs', 'export const answer = 0;');
  await sandbox.write(
    ref,
    'regression.test.mjs',
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {answer} from './answer.mjs'; test('prior acceptance',()=>assert.equal(answer,42));",
  );
  await sandbox.write(
    ref,
    'smoke.test.mjs',
    "import {test} from 'node:test'; test('smoke',()=>{});",
  );
  const baseCommit = await git.applyPatch(ref.path, '');
  await rm(join(ref.path, 'regression.test.mjs'));
  const headCommit = await git.applyPatch(ref.path, '');
  await expect(
    executeValidation(sandbox, git, { ...ref, baseCommit, headCommit }),
  ).rejects.toThrow();
});

it('rejects renaming an inherited Unicode test outside the discovered test set', async () => {
  const { sandbox, git, ref } = await fixture();
  await sandbox.write(
    ref,
    '中文 用例.test.mjs',
    "import {test} from 'node:test';test('previous',()=>{});",
  );
  await sandbox.write(
    ref,
    'smoke.test.mjs',
    "import {test} from 'node:test';test('smoke',()=>{});",
  );
  const baseCommit = await git.applyPatch(ref.path, '');
  const body = await readFile(join(ref.path, '中文 用例.test.mjs'), 'utf8');
  await rm(join(ref.path, '中文 用例.test.mjs'));
  await sandbox.write(ref, 'tests/fixtures/renamed.mjs', body);
  const headCommit = await git.applyPatch(ref.path, '');
  await expect(executeValidation(sandbox, git, { ...ref, baseCommit, headCommit })).rejects.toThrow(
    /cumulative test/,
  );
});
it('accepts ignored CODER caches but rejects uncommitted source and lost cumulative tests', async () => {
  const { sandbox, git, ref } = await fixture();
  await sandbox.write(ref, '.gitignore', 'cache/\n');
  await sandbox.write(
    ref,
    'previous.test.mjs',
    "import {test} from 'node:test';test('previous',()=>{});",
  );
  const baseCommit = await git.applyPatch(ref.path, '');
  await sandbox.write(ref, 'answer.mjs', 'export const answer=42;');
  const headCommit = await git.applyPatch(ref.path, '');
  const coder = { ...ref, baseCommit, headCommit };
  await sandbox.write(ref, 'cache/output.txt', 'cached');
  await expect(assertCoderWorktreeReady(git, coder)).resolves.toBeUndefined();
  await expect(executeValidation(sandbox, git, coder)).rejects.toThrow(/clean/);
  await sandbox.write(ref, 'answer.mjs', 'export const answer=0;');
  await expect(assertCoderWorktreeReady(git, coder)).rejects.toThrow(/clean/);
  await git.applyPatch(ref.path, '');
  await rm(join(ref.path, 'previous.test.mjs'));
  await git.applyPatch(ref.path, '');
  await expect(assertCoderWorktreeReady(git, coder)).rejects.toThrow(/cumulative test/);
});
