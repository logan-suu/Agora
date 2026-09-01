import {
  type AppState,
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  type RoleSpec,
  type TestResults,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import {
  DEFAULT_ROSTER,
  SIX_ROLE_HANDOFF,
  SIX_ROLE_TOOL_SURFACE,
  SIX_ROLE_TURN_MUTATION_READERS,
} from '@agora/roles-definitions';
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

/** Phase 0 handoff file reused verbatim (TESTER file protocol). */
const TEST_RESULTS_FILE = 'test-results.json';

/** Backward-compatible Phase 2 test exports; production owns the contracts. */
export const PHASE2_TOOL_SURFACE = SIX_ROLE_TOOL_SURFACE;
export { reviewerTurnMutations } from '@agora/roles-definitions';

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
        spec.tools.filter((tool) => SIX_ROLE_TOOL_SURFACE.includes(tool)),
      );
      const handoff = SIX_ROLE_HANDOFF[spec.role] ?? '';
      const executorSpec: RoleSpec = {
        ...spec,
        ...(handoff === '' ? {} : { systemPrompt: spec.systemPrompt + handoff }),
      };
      const turnMutations = SIX_ROLE_TURN_MUTATION_READERS[spec.role];
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
