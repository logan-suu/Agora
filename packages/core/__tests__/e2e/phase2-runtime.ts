import {
  type AppState,
  appendMutation,
  applyMutations,
  createInitialAppState,
  type Mutation,
  mergeByIdMutation,
  type RoleSpec,
  setMutation,
  type TestResults,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import {
  type Executor,
  HarnessExecutor,
  type HarnessExecutorOptions,
} from '@agora/runtime-executor';
import {
  createSandbox,
  type SandboxConfig,
  type SandboxManager,
  type Worktree,
} from '@agora/runtime-sandbox';
import { createToolCatalog, type ToolCatalog } from '@agora/tools-bridge';
import { WorktreeRegistry } from '@agora/tools-fs';
import { WorktreeGitService } from '@agora/tools-git';
import type { LlmAdapter } from '@deepseek-ai/dsh-llm';

/**
 * Phase 2 composition root (task 2.5 exit-test assembly, test-side so R8
 * layering stays intact: orchestration only touches L3 ports, this module
 * wires the L4 implementations). Differences from the Phase 0/1 roots:
 *
 * - Six-role roster: the single DEFAULT_ROSTER constant is injected into BOTH
 *   the WorkerRuntime (execution) and the routing deps (assertRosterBinding,
 *   DEF-008 resolution — a mismatch would otherwise surface only as a late
 *   UnknownRoleError at dispatch time).
 * - Tool surface (DEF-006 resolution): the `git` logical group is
 *   worktree-scoped (git_applyPatch + git_diff) and `git.readonly` is the
 *   diff-only surface for ARCHITECT/REVIEWER; the main-repo mutations
 *   git_createWorktree/git_merge are granted to no model role. `lint` resolves
 *   the biome-backed lint-server since task 2.5 (DEF-005 resolved).
 * - Structured handoffs: TESTER keeps the Phase 0 file protocol
 *   (test-results.json read back through the executor callback). Task 4.2
 *   retired the CODER `subtask-status.json` signal — subtask lifecycle is
 *   coordinator-owned. PM/ARCHITECT/REVIEWER have no fs.write grant (PM is
 *   tool-free
 *   per §2, ARCHITECT/REVIEWER are read-only), so their structured output is
 *   their turn's final assistant message, interpreted into State mutations by
 *   {@link pmTurnMutations} / {@link architectTurnMutations} /
 *   {@link reviewerTurnMutations} through the executor's readTurnMutations
 *   seam (R1: the mutations still flow through applyMutations).
 */

/** Phase 2 tool surface: the full §2 matrix incl. git groups + lint (biome-backed). */
export const PHASE2_TOOL_SURFACE: readonly string[] = [
  'fs.read',
  'fs.write',
  'fs.list',
  'test.run',
  'sandbox.run',
  'git',
  'git.readonly',
  'lint',
];

/** Phase 0 handoff file reused verbatim (TESTER file protocol). */
const TEST_RESULTS_FILE = 'test-results.json';

/** Working rules appended per role; teach the structured-output protocol. */
const PHASE2_HANDOFF: Readonly<Partial<Record<string, string>>> = {
  PM: '\n\n[Phase 2 working rules]\n- You have no tools: reason from the projected slices only.\n- End your turn with a single JSON array as your final message, one requirement per item, each shaped {"id":"req-1","story":"...","acceptance":["..."],"nonGoals":["..."]}.',
  ARCHITECT:
    '\n\n[Phase 2 working rules]\n- Your §2 grant is read-only (fs.read + git.readonly).\n- End your turn with a single JSON object as your final message shaped {"architecture":{...},"conventions":{...}}; both values must be plain JSON objects.',
  CODER:
    '\n\n[Phase 2 working rules]\n- All file paths are relative to the worktree root (the `path` argument of fs_read/fs_write).\n- Use fs_write for implementation files, fs_read to inspect, and sandbox_run to verify quickly.\n- Submit your work with git_applyPatch (the worktree argument is injected): it stages and commits the worktree (add -A), so fs-written files land in the commit.',
  TESTER:
    '\n\n[Phase 2 working rules]\n- All file paths are relative to the worktree root (the `path` argument of fs_read/fs_write).\n- Use fs_write to create test files, then sandbox_run to execute them (e.g. `node --test <file>`).\n- After running, use fs_write to store the structured result at the worktree root in `test-results.json` with this exact JSON shape: {"passed": true, "total": 2, "failed": 0, "failures": []}',
  REVIEWER:
    '\n\n[Phase 2 working rules]\n- Your §2 grant is read-only: fs_read to inspect files, git_diff to see the committed change, and lint_check to run Biome over worktree-relative paths (the worktree argument is injected).\n- End your turn with a single JSON array containing exactly one verdict entry shaped {"id":"rv-...","kind":"verdict","verdict":"approved"|"changes_requested","issueScope":"implementation"|"architecture","summary":"..."}; other entries are optional comments. The verdict id must be a stable non-empty string. issueScope is optional for backward compatibility and defaults to implementation; use architecture only with changes_requested. A test_failure_root_cause review must return changes_requested.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseTurnJson(text: string | null, role: string): unknown {
  if (text === null) {
    throw new Error(`${role} turn produced no final message to interpret`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`${role} final message is not valid JSON: ${String(err)}`);
  }
}

/**
 * PM structured output → `mergeById('requirements')` mutations. PM is
 * tool-free (§2 「工具：无（纯推理）」), so its final JSON array IS the
 * requirements payload. Malformed shapes throw loudly (no silent skip, §12).
 */
export function pmTurnMutations(text: string | null): Mutation[] {
  const parsed = parseTurnJson(text, 'PM');
  if (!Array.isArray(parsed)) {
    throw new Error('PM final message must be a JSON array of requirements');
  }
  return parsed.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('PM requirement entries must be JSON objects');
    }
    const { id, story, acceptance, nonGoals } = entry;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('PM requirement needs a non-empty string "id"');
    }
    if (typeof story !== 'string') {
      throw new Error(`PM requirement "${id}" needs a string "story"`);
    }
    if (!isStringArray(acceptance) || !isStringArray(nonGoals)) {
      throw new Error(`PM requirement "${id}" needs string arrays "acceptance"/"nonGoals"`);
    }
    return mergeByIdMutation('requirements', id, { story, acceptance, nonGoals });
  });
}

/**
 * ARCHITECT structured output → `set('architecture')` (+ optional
 * `set('conventions')`). Read-only role: the final JSON object carries the
 * design; mirrors the applySet guards (non-array objects, explicit throw).
 */
export function architectTurnMutations(text: string | null): Mutation[] {
  const parsed = parseTurnJson(text, 'ARCHITECT');
  if (!isRecord(parsed)) {
    throw new Error('ARCHITECT final message must be a JSON object');
  }
  const { architecture, conventions } = parsed;
  if (!isRecord(architecture)) {
    throw new Error('ARCHITECT payload needs a non-array object "architecture"');
  }
  const mutations: Mutation[] = [setMutation('architecture', architecture)];
  if (conventions !== undefined) {
    if (!isRecord(conventions)) {
      throw new Error('ARCHITECT "conventions" must be a non-array object when present');
    }
    mutations.push(setMutation('conventions', conventions));
  }
  return mutations;
}

/**
 * REVIEWER structured output → `append('reviewComments')` mutations. Verdict
 * entries are validated against the coordinator's accepted values so a
 * malformed verdict fails at the seam instead of inside routing.
 */
export function reviewerTurnMutations(text: string | null): Mutation[] {
  const parsed = parseTurnJson(text, 'REVIEWER');
  if (!Array.isArray(parsed)) {
    throw new Error('REVIEWER final message must be a JSON array of review entries');
  }
  const entries = parsed.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('REVIEWER review entries must be JSON objects');
    }
    if (typeof entry.kind !== 'string') {
      throw new Error('REVIEWER review entries need a string "kind"');
    }
    if (entry.kind === 'verdict') {
      if (typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new Error('REVIEWER verdict needs a non-empty string id');
      }
      if (entry.verdict !== 'approved' && entry.verdict !== 'changes_requested') {
        throw new Error('REVIEWER verdict must be "approved" or "changes_requested"');
      }
      if (
        entry.issueScope !== undefined &&
        entry.issueScope !== 'implementation' &&
        entry.issueScope !== 'architecture'
      ) {
        throw new Error('REVIEWER verdict issueScope must be "implementation" or "architecture"');
      }
      if (entry.verdict === 'approved' && entry.issueScope === 'architecture') {
        throw new Error('REVIEWER approved verdict cannot use architecture issueScope');
      }
    }
    return entry;
  });
  const verdictCount = entries.filter((entry) => entry.kind === 'verdict').length;
  if (verdictCount !== 1) {
    throw new Error(`REVIEWER final message must contain exactly one verdict; got ${verdictCount}`);
  }
  return entries.map((entry) => appendMutation('reviewComments', entry));
}

/** Per-role final-text interpreters wired into the executor's readTurnMutations seam. */
const TURN_MUTATION_READERS: Readonly<
  Partial<Record<string, (text: string | null) => Mutation[]>>
> = {
  PM: pmTurnMutations,
  ARCHITECT: architectTurnMutations,
  REVIEWER: reviewerTurnMutations,
};

export interface Phase2RuntimeOptions {
  taskId: string;
  goal: string;
  /** Scripted LLM adapter (R11: mock only the external LLM; tools/sandbox real). */
  adapter?: LlmAdapter;
  /** Provider key the adapter is registered under (default `agora`). */
  provider?: string;
  deepseek?: HarnessExecutorOptions['deepseek'];
  /** Sandbox selector; defaults to `{ kind: 'local' }` (LocalTempSandbox, R7). */
  sandboxConfig?: SandboxConfig;
  /** Git main repo path for the bridged git server (lazy temp repo when omitted). */
  mainRepoPath?: string;
}

export interface Phase2Runtime {
  initialState: AppState;
  workerRuntime: WorkerRuntime;
  /** The single roster constant shared by routing and execution (DEF-008). */
  roster: readonly RoleSpec[];
  sandbox: SandboxManager;
  worktree: Worktree;
  dispose(): Promise<void>;
}

/**
 * Composition-root invariant (DEF-008, task 2.5): every role the routing
 * roster can dispatch must exist in the worker runtime's roster, otherwise
 * decide() would route to a specOf() UnknownRoleError. Checked eagerly at
 * assembly instead of late at dispatch time.
 */
export function assertRosterBinding(
  routingRoster: readonly RoleSpec[],
  workerRuntime: WorkerRuntime,
): void {
  for (const spec of routingRoster) {
    if (!workerRuntime.roster.some((entry) => entry.role === spec.role)) {
      throw new Error(
        `roster binding mismatch: routing roster declares "${spec.role}" but the worker runtime roster does not (would throw UnknownRoleError at dispatch time)`,
      );
    }
  }
}

/**
 * Six-role composition root: one shared worktree per task (CODER writes,
 * TESTER tests, REVIEWER diffs — single-worker degenerate slice, spec §9
 * pattern carried into Phase 2).
 */
export async function createPhase2Runtime(options: Phase2RuntimeOptions): Promise<Phase2Runtime> {
  if (
    options.adapter !== undefined &&
    options.deepseek !== undefined &&
    options.deepseek !== false
  ) {
    throw new Error(
      'createPhase2Runtime: adapter and deepseek are mutually exclusive — pass one or the other',
    );
  }
  const sandbox = createSandbox(options.sandboxConfig);
  // Phase 2 composition-root machinery (the getWorktree pointer deferred from
  // task 1.6): the task worktree is a REAL git worktree so the in-loop git
  // surface is exercisable — the git service lazily inits the main repo and
  // auto-registers the worktree root on the registry shared with the catalog.
  const registry = new WorktreeRegistry();
  const gitService = new WorktreeGitService(registry, options.mainRepoPath);
  const worktree = await gitService.createWorktree(options.taskId, 'shared');
  let catalog: ToolCatalog;
  try {
    catalog = await createToolCatalog({
      registry,
      sandbox,
      getWorktree: async () => worktree,
      ...(options.mainRepoPath === undefined ? {} : { mainRepoPath: options.mainRepoPath }),
    });
  } catch (err) {
    // Exception-safe init: the worktree/sandbox must not leak if catalog setup fails.
    try {
      await gitService.dispose();
    } catch {
      // Best-effort: the catalog error below is the one that matters.
    }
    await sandbox.teardown(options.taskId);
    throw err;
  }
  const subtaskId = `${options.taskId}-sub-0`;
  const readTestResults = async (): Promise<TestResults | undefined> => {
    try {
      const content = await sandbox.read(worktree, TEST_RESULTS_FILE);
      const parsed = JSON.parse(content) as Partial<TestResults>;
      if (typeof parsed.passed !== 'boolean') return undefined;
      return {
        passed: parsed.passed,
        total: typeof parsed.total === 'number' ? parsed.total : 0,
        failed: typeof parsed.failed === 'number' ? parsed.failed : 0,
        failures: Array.isArray(parsed.failures)
          ? (parsed.failures as TestResults['failures'])
          : [],
      };
    } catch {
      return undefined;
    }
  };
  const executors: HarnessExecutor[] = [];
  const workerRuntime = new WorkerRuntime({
    roster: DEFAULT_ROSTER,
    buildExecutor: (spec, _assign): Executor => {
      // §2 matrix grant intersected with the Phase 2 surface; every whitelisted
      // entry resolves to a catalog implementation.
      const resolved = catalog.resolve(
        spec.tools.filter((tool) => PHASE2_TOOL_SURFACE.includes(tool)),
      );
      const handoff = PHASE2_HANDOFF[spec.role] ?? '';
      const executorSpec: RoleSpec = {
        ...spec,
        ...(handoff === '' ? {} : { systemPrompt: spec.systemPrompt + handoff }),
      };
      const turnMutations = TURN_MUTATION_READERS[spec.role];
      const executor = new HarnessExecutor(executorSpec, {
        ...(options.deepseek === undefined ? {} : { deepseek: options.deepseek }),
        ...(options.adapter === undefined
          ? {}
          : { adapter: options.adapter, provider: options.provider ?? 'agora' }),
        tools: catalog.all(),
        allowTools: resolved.allowNames,
        ...(spec.role === 'TESTER' ? { readTestResults } : {}),
        ...(turnMutations === undefined
          ? {}
          : { readTurnMutations: ({ text }) => turnMutations(text) }),
      });
      executors.push(executor);
      return executor;
    },
  });
  // DEF-008: fail at assembly when routing and execution rosters diverge.
  assertRosterBinding(DEFAULT_ROSTER, workerRuntime);
  const initialState = applyMutations(createInitialAppState(options.taskId, options.goal), [
    mergeByIdMutation('subtasks', subtaskId, {
      title: options.goal,
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'todo',
      worktree: worktree.path,
    }),
  ]);
  return {
    initialState,
    workerRuntime,
    roster: DEFAULT_ROSTER,
    sandbox,
    worktree,
    dispose: async () => {
      // Exception-safe teardown: aggregate errors, then rethrow.
      const errors: unknown[] = [];
      for (const executor of executors) {
        try {
          await executor.dispose();
        } catch (err) {
          errors.push(err);
        }
      }
      try {
        await catalog.dispose();
      } catch (err) {
        errors.push(err);
      }
      try {
        await sandbox.teardown(options.taskId);
      } catch (err) {
        errors.push(err);
      }
      try {
        await gitService.dispose();
      } catch (err) {
        errors.push(err);
      }
      if (errors.length > 0) {
        throw new Error(`createPhase2Runtime dispose failed: ${errors.map(String).join('; ')}`);
      }
    },
  };
}
