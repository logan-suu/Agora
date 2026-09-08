import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type AppState,
  activeRequirements,
  appendMutation,
  canonicalCompletionDecisionIds,
  canonicalJson,
  executionPlanFromArchitecture,
  isStrictTestResults,
  isWaveValidationReceipt,
  type Mutation,
  setMutation,
  type TestResults,
  validationReceipt,
  validationSourceReceipt,
  validationSubtaskIds,
  type WaveValidationReceipt,
  type WorktreeRef,
} from '@agora/core-domain';
import type { RunResult, SandboxManager } from '@agora/runtime-sandbox';
import type { WorktreeGitService } from '@agora/tools-git';
import { parseTap } from '@agora/tools-test';

const TEST_FILE = /\.(?:test|spec)\.(?:mjs|cjs|js)$/;
const TEST_FIXTURE = /^tests\/fixtures\/[A-Za-z0-9._/-]+$/;

export function controlFingerprint(state: AppState): string {
  const completionIds = canonicalCompletionDecisionIds(state);
  const superseded = new Set(
    state.decisionLedger.flatMap((decision) =>
      decision.supersedes === undefined ? [] : [decision.supersedes],
    ),
  );
  const withdrawn = new Set(
    state.decisionLedger.flatMap((decision) =>
      decision.objectionResolution?.outcome === 'accepted' &&
      decision.objectionResolution.target?.kind === 'decision'
        ? [decision.objectionResolution.target.id]
        : [],
    ),
  );
  const currentDecisions = state.decisionLedger
    .filter(
      (decision) =>
        !superseded.has(decision.id) &&
        !withdrawn.has(decision.id) &&
        !completionIds.has(decision.id),
    )
    .map(({ ts: _ts, ...decision }) => decision)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const requirements = activeRequirements(state)
    .map((requirement) => ({
      ...requirement,
      acceptance: [...requirement.acceptance].sort(),
      nonGoals: [...requirement.nonGoals].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const plan = executionPlanFromArchitecture(state.architecture).plan;
  const executionPlan = {
    version: plan.version,
    subtasks: plan.subtasks
      .map((node) => ({ ...node, dependsOn: [...node.dependsOn].sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return createHash('sha256')
    .update(
      canonicalJson({
        goal: state.goal,
        activeRequirements: requirements,
        currentDecisions,
        executionPlan,
      }),
    )
    .digest('hex');
}

interface ExecutionEvidence {
  worktree: WorktreeRef;
  command: string;
  run: RunResult;
  results: TestResults;
}

function assertCumulativeTests(removedPaths: readonly string[]): void {
  if (removedPaths.some((path) => TEST_FILE.test(path)))
    throw new Error('inherited cumulative test files must not be removed or renamed');
}

/** CODER caches are not part of Git input; inherited tests must survive each coding wave. */
export async function assertCoderWorktreeReady(
  git: WorktreeGitService,
  worktree: WorktreeRef,
): Promise<void> {
  const inspection = await git.inspectValidationWorktree(worktree.path, worktree.baseCommit);
  if (inspection.uncommittedChanges)
    throw new Error('CODER must finish with a clean committed worktree');
  assertCumulativeTests(inspection.removedPaths);
}

async function validationInput(git: WorktreeGitService, worktree: WorktreeRef) {
  const before = await git.inspectValidationWorktree(worktree.path, worktree.baseCommit);
  if (before.dirty)
    throw new Error('validation requires a clean committed worktree, including ignored files');
  assertCumulativeTests(before.removedPaths);
  if (before.changedPaths.some((path) => !TEST_FILE.test(path) && !TEST_FIXTURE.test(path)))
    throw new Error('validation TESTER changed business files');
  const tests = before.trackedFiles.filter((path) => TEST_FILE.test(path)).sort();
  if (tests.length === 0)
    throw new Error(
      'validation requires tracked Node test files (*.test.mjs, *.test.cjs or *.test.js)',
    );
  // Paths come from Git and are shell-quoted individually; the model cannot
  // substitute a command that merely prints a passing report.
  const command = `node --test --test-reporter=tap ${tests.some((path) => path.startsWith('-')) ? '-- ' : ''}${tests.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(' ')}`;
  return { before, command };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson(keys.sort());
}

function parseRunResults(value: unknown): { run: RunResult; results: TestResults } {
  if (
    !record(value) ||
    !exactKeys(value, ['exitCode', 'stdout', 'stderr', 'timedOut']) ||
    (value.exitCode !== null &&
      (!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0)) ||
    typeof value.stdout !== 'string' ||
    typeof value.stderr !== 'string' ||
    typeof value.timedOut !== 'boolean'
  )
    throw new Error('validation requires a complete execution result');
  const run = value as unknown as RunResult;
  if (run.timedOut || run.exitCode === null)
    throw new Error('validation timed out without a complete test report');
  const summary = parseTap(run.stdout);
  const results: TestResults = {
    passed: summary.failed === 0,
    total: summary.total,
    failed: summary.failed,
    failures: summary.failures,
    ...(summary.coverage === undefined ? {} : { coverage: summary.coverage }),
  };
  if (
    !isStrictTestResults(results) ||
    summary.passed + summary.failed !== summary.total ||
    (run.exitCode === 0) !== results.passed
  )
    throw new Error(
      'validation requires a complete test report consistent with the actual exit code',
    );
  return { run, results };
}

/** Execute the complete tracked Node test suite, independent of model-reported results. */
export async function executeValidation(
  sandbox: SandboxManager,
  git: WorktreeGitService,
  worktree: WorktreeRef,
): Promise<ExecutionEvidence> {
  const { before, command } = await validationInput(git, worktree);
  const run = await sandbox.run(worktree, command, 30_000);
  const after = await git.inspectValidationWorktree(worktree.path, worktree.baseCommit);
  if (
    after.dirty ||
    after.headCommit !== before.headCommit ||
    canonicalJson(after.trackedFiles) !== canonicalJson(before.trackedFiles)
  )
    throw new Error('validated HEAD or tree changed during test execution');
  const parsed = parseRunResults(run);
  return { worktree: { ...worktree, headCommit: before.headCommit }, command, ...parsed };
}

export class WaveValidationService {
  constructor(
    private readonly sandbox: SandboxManager,
    private readonly git: WorktreeGitService,
    private readonly artifactsRoot: string,
  ) {}

  async complete(
    state: AppState,
    workerId: string,
    worktree: WorktreeRef,
  ): Promise<readonly Mutation[]> {
    const execution = state.parallelExecution;
    const wave = execution?.activeWave;
    const validation = wave?.validation;
    if (
      execution === undefined ||
      wave === undefined ||
      validation?.workerId !== workerId ||
      state.phase !== 'testing'
    )
      throw new Error('validation completion is not the current assignment');
    if (validation.receiptId !== undefined) {
      await this.verifyReceiptHead(state, validation.receiptId);
      return [];
    }
    const integration = state.integration;
    const source = validationSourceReceipt(state, validation.dispatchId);
    if (
      integration?.status !== 'done' ||
      integration.resultCommit === undefined ||
      integration.integrationId !== validation.integrationId ||
      (source === undefined
        ? integration.resultCommit !== validation.inputCommit
        : source.receipt.worktree.headCommit !== validation.inputCommit) ||
      worktree.baseCommit !== validation.inputCommit ||
      worktree.path === integration.integrationWorktree.path
    )
      throw new Error(
        'validation requires an independent worktree from the frozen Integration result',
      );
    await this.assertExactHead(integration.integrationWorktree, integration.resultCommit);
    if (source !== undefined) await this.verifyReceiptHead(state, source.receiptId);
    const fingerprint = controlFingerprint(state);
    const relativePath = `validation/${validation.dispatchId}.json`;
    const path = join(this.artifactsRoot, relativePath);
    const identity = {
      projectId: state.projectId,
      taskId: state.taskId,
      dispatchId: validation.dispatchId,
      controlFingerprint: fingerprint,
    };
    let body: string | undefined;
    try {
      body = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let evidence: ExecutionEvidence;
    if (body === undefined) {
      evidence = await executeValidation(this.sandbox, this.git, worktree);
      body = `${canonicalJson({ version: 1, ...identity, ...evidence })}\n`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, { encoding: 'utf8', flag: 'wx' });
    } else {
      // A successful evidence write may precede a failed canonical State commit.
      // Reuse the first observation only after checking its exact current identity.
      evidence = await this.verifyExecutionEvidence(body, identity, worktree);
    }
    const receipt: WaveValidationReceipt = {
      kind: 'wave_validation',
      version: 1,
      planId: execution.planId,
      waveId: wave.waveId,
      attempt: wave.attempt,
      dispatchId: validation.dispatchId,
      workerId,
      integrationId: validation.integrationId,
      inputCommit: validation.inputCommit,
      worktree: evidence.worktree,
      subtaskIds: validationSubtaskIds(state, wave),
      controlFingerprint: fingerprint,
      results: evidence.results,
      evidence: {
        path: relativePath,
        sha256: createHash('sha256').update(body).digest('hex'),
        exitCode: evidence.run.exitCode as number,
        timedOut: evidence.run.timedOut,
      },
    };
    if (!isWaveValidationReceipt(receipt))
      throw new Error('trusted validation receipt failed its domain contract');
    const receiptId = `wave-validation:${validation.dispatchId}`;
    return [
      appendMutation('messages', {
        msgId: receiptId,
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        payload: receipt,
        display: `Cumulative validation: ${receipt.results.total - receipt.results.failed}/${receipt.results.total} passed`,
        ts: Date.now(),
      }),
      setMutation('testResults', receipt.results),
      setMutation('parallelExecution', {
        ...execution,
        activeWave: {
          ...wave,
          validation: { ...validation, worktree: evidence.worktree, receiptId },
        },
      }),
    ];
  }

  async verifyReceiptHead(state: AppState, receiptId: string): Promise<void> {
    const receipt = validationReceipt(state, receiptId);
    const contents = await readFile(join(this.artifactsRoot, receipt.evidence.path), 'utf8');
    if (createHash('sha256').update(contents).digest('hex') !== receipt.evidence.sha256)
      throw new Error('validation execution evidence hash drifted');
    const evidence = await this.verifyExecutionEvidence(
      contents,
      {
        projectId: state.projectId,
        taskId: state.taskId,
        dispatchId: receipt.dispatchId,
        controlFingerprint: receipt.controlFingerprint,
      },
      receipt.worktree,
    );
    if (
      canonicalJson(evidence.results) !== canonicalJson(receipt.results) ||
      evidence.run.exitCode !== receipt.evidence.exitCode ||
      evidence.run.timedOut !== receipt.evidence.timedOut
    )
      throw new Error('validation execution evidence identity drifted');
  }

  private async verifyExecutionEvidence(
    contents: string,
    identity: { projectId: string; taskId: string; dispatchId: string; controlFingerprint: string },
    worktree: WorktreeRef,
  ): Promise<ExecutionEvidence> {
    try {
      const evidence: unknown = JSON.parse(contents);
      if (
        !record(evidence) ||
        !exactKeys(evidence, [
          'version',
          'projectId',
          'taskId',
          'dispatchId',
          'controlFingerprint',
          'worktree',
          'command',
          'run',
          'results',
        ]) ||
        evidence.version !== 1 ||
        Object.entries(identity).some(([key, value]) => evidence[key] !== value)
      )
        throw new Error('identity drifted');
      const { before, command } = await validationInput(this.git, worktree);
      const current = { ...worktree, headCommit: before.headCommit };
      if (
        command !== evidence.command ||
        canonicalJson(current) !== canonicalJson(evidence.worktree) ||
        (worktree.headCommit !== undefined && before.headCommit !== worktree.headCommit)
      )
        throw new Error('HEAD, worktree or command drifted');
      const parsed = parseRunResults(evidence.run);
      if (canonicalJson(parsed.results) !== canonicalJson(evidence.results))
        throw new Error('report drifted');
      return { worktree: current, command, ...parsed };
    } catch (error) {
      throw new Error('invalid validation execution evidence', { cause: error });
    }
  }

  async assertExactHead(worktree: WorktreeRef, commit: string): Promise<void> {
    const actual = await this.git.inspectValidationWorktree(worktree.path, worktree.baseCommit);
    if (actual.dirty || actual.headCommit !== commit)
      throw new Error('validation evidence HEAD or clean tree drifted');
  }
}

export const PARALLEL_TESTER_HANDOFF =
  '\n\n[Wave validation rules]\n- You own the independent validation worktree in assignment, never a CODER branch. Write only *.test.mjs, *.test.cjs, *.test.js or tests/fixtures files; do not edit business code or configuration.\n- Use Node built-in node:test and node:assert/strict, with one test per acceptance behavior. Cover this wave and already completed work; test future dependent features only on the final wave.\n- You may use sandbox_run for exploratory tests. Commit all test changes using git_applyPatch with an empty patch after fs_write. Finish with a clean tree. The trusted service then reruns every tracked test on that exact committed HEAD and records the result. Do not create test-results.json or write build outputs in the worktree.\n- If the implementation fails a test, preserve the failing assertion and commit the test; report the defect rather than editing business code.';
