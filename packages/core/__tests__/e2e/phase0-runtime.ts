import {
  type AppState,
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  PHASE0_ROSTER,
  type RoleSpec,
  type TestResults,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
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
import type { LlmAdapter } from '@deepseek-ai/dsh-llm';

/** Phase 0 TESTER handoff file (written by the TESTER into the worktree root). */
const TEST_RESULTS_FILE = 'test-results.json';

/** Phase 0 CODER completion signal (written by the CODER into the worktree root). */
const SUBTASK_STATUS_FILE = 'subtask-status.json';

/**
 * Phase 0 working conventions appended to each role's system prompt by the
 * composition root. They teach the model the worktree-relative path rule and
 * the structured handoff files the executor reads back after the turn
 * (`test-results.json` for TESTER, `subtask-status.json` for CODER).
 */
const PHASE0_HANDOFF: Readonly<Partial<Record<string, string>>> = {
  CODER:
    '\n\n[Phase 0 working rules]\n- All file paths are relative to the worktree root (the `path` argument of fs_read/fs_write).\n- Use fs_write for implementation files (e.g. lru-cache.ts), fs_read to inspect, and sandbox_run to verify quickly.\n- After implementing and verifying, use fs_write to store {"status":"done"} at the worktree root in `subtask-status.json`.',
  TESTER:
    '\n\n[Phase 0 working rules]\n- All file paths are relative to the worktree root (the `path` argument of fs_read/fs_write).\n- Use fs_write to create test files, then sandbox_run to execute them (e.g. `node --test <file>` or `node <file>`).\n- After running, use fs_write to store the structured result at the worktree root in `test-results.json` with this exact JSON shape: {"passed": true, "total": 2, "failed": 0, "failures": []}',
};

/**
 * Phase 0 tool surface (spec §9 "工具只接 fs + sandbox.run"): LocalTempSandbox
 * (R7) has no git worktrees/main repo, so the `git` group, `sandbox.applyPatch`
 * (a Phase 1 git-worktree patch) and `lint` (DEF-005) are phase-gated out here;
 * the catalog still resolves the full §2 matrix for Phase 1+.
 */
const PHASE0_TOOL_SURFACE: readonly string[] = ['fs.read', 'fs.write', 'sandbox.run'];

export interface Phase0RuntimeOptions {
  taskId: string;
  goal: string;
  deepseek?: HarnessExecutorOptions['deepseek'];
  model?: string;
  /**
   * Scripted LLM adapter for deterministic tests (R11: mock only the external
   * LLM dependency; the agent loop, tools, and sandbox stay real). Registered
   * under `provider` (defaults to `agora`). Mutually exclusive intent with
   * `deepseek` — pass one or the other, never both.
   */
  adapter?: LlmAdapter;
  /** Provider key the adapter is registered under (default `agora`). */
  provider?: string;
  /**
   * Sandbox selector (task 1.6, decision D5 advance). Defaults to
   * `{ kind: 'local' }` — the factory's local branch IS the LocalTempSandbox,
   * so Phase 0 behavior is unchanged (R9: phase degradation swaps the body).
   * Phase 1 callers pass `{ kind: 'docker', ... }` for the Docker sandbox.
   */
  sandboxConfig?: SandboxConfig;
  /**
   * RoleSpec.tools whitelist filter applied on top of the §2 matrix
   * (task 1.6). Defaults to the Phase 0 surface (fs.read/fs.write/sandbox.run);
   * Phase 1 callers pass the full surface including fs.list/test.run.
   */
  toolSurface?: readonly string[];
  /**
   * Git main repo path for the bridged git server (Phase 1+). When omitted the
   * git service lazily creates a temp main repo; the git group is phase-gated
   * out of the loop surface either way (spec §9 pattern).
   */
  mainRepoPath?: string;
  /**
   * Role → system-prompt working rules appended by the composition root
   * (task 1.6). Defaults to the Phase 0 rules; Phase 1 passes its own wording.
   */
  handoff?: Readonly<Partial<Record<string, string>>>;
}

export interface Phase0Runtime {
  initialState: AppState;
  workerRuntime: WorkerRuntime;
  sandbox: SandboxManager;
  worktree: Worktree;
  dispose(): Promise<void>;
}

/**
 * Phase 0 composition root (test-side assembly, keeps R8 layering intact:
 * orchestration only ever touches L3 ports, this module wires the L4
 * implementations — HarnessExecutor + LocalTempSandbox — for the verification
 * loop). One shared worktree per task: the Coder writes code and the Tester
 * must run tests in the same directory (single-worker degenerate slice, spec §9).
 */
export async function createPhase0Runtime(options: Phase0RuntimeOptions): Promise<Phase0Runtime> {
  // `adapter` and `deepseek` are mutually exclusive (see the options JSDoc):
  // passing both would register the fake adapter under the `deepseek-official`
  // provider name and silently shadow the real DeepSeek route. Fail fast before
  // any worktree/sandbox resource is created.
  if (
    options.adapter !== undefined &&
    options.deepseek !== undefined &&
    options.deepseek !== false
  ) {
    throw new Error(
      'createPhase0Runtime: adapter and deepseek are mutually exclusive — pass one or the other',
    );
  }
  const sandbox = createSandbox(options.sandboxConfig);
  const worktree = await sandbox.createWorktree(options.taskId, 'shared');
  const registry = new WorktreeRegistry();
  registry.register(worktree.path);
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
  const readSubtaskStatus = async (): Promise<{ id: string; status: string } | undefined> => {
    try {
      const content = await sandbox.read(worktree, SUBTASK_STATUS_FILE);
      const parsed = JSON.parse(content) as { status?: unknown };
      if (parsed.status !== 'done') return undefined;
      return { id: subtaskId, status: 'done' };
    } catch {
      return undefined;
    }
  };
  const executors: HarnessExecutor[] = [];
  const workerRuntime = new WorkerRuntime({
    roster: PHASE0_ROSTER,
    buildExecutor: (spec, _assign): Executor => {
      // Task 1.5: RoleSpec.tools → catalog (spec §2 matrix) intersected with the
      // Phase 0 surface; register all catalog tools and let the agent-level
      // restrict scope each role (toolFilter equivalent).
      const surface = options.toolSurface ?? PHASE0_TOOL_SURFACE;
      const resolved = catalog.resolve(spec.tools.filter((tool) => surface.includes(tool)));
      const handoff = (options.handoff ?? PHASE0_HANDOFF)[spec.role] ?? '';
      const executorSpec: RoleSpec = {
        ...spec,
        ...(options.model === undefined ? {} : { model: options.model }),
        systemPrompt: spec.systemPrompt + handoff,
      };
      const executor = new HarnessExecutor(executorSpec, {
        ...(options.deepseek === undefined ? {} : { deepseek: options.deepseek }),
        ...(options.adapter === undefined
          ? {}
          : { adapter: options.adapter, provider: options.provider ?? 'agora' }),
        tools: catalog.all(),
        allowTools: resolved.allowNames,
        ...(spec.role === 'TESTER' ? { readTestResults } : {}),
        ...(spec.role === 'CODER' ? { readSubtaskStatus } : {}),
      });
      executors.push(executor);
      return executor;
    },
  });
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
    sandbox,
    worktree,
    dispose: async () => {
      // Exception-safe teardown: every resource still closes even when an
      // earlier close operation rejects (aggregate the errors, then rethrow).
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
      if (errors.length > 0) {
        throw new Error(`createPhase0Runtime dispose failed: ${errors.map(String).join('; ')}`);
      }
    },
  };
}
