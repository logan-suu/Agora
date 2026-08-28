import type { HarnessExecutorOptions } from '@agora/runtime-executor';
import type { SandboxConfig } from '@agora/runtime-sandbox';
import type { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createPhase0Runtime, type Phase0Runtime } from './phase0-runtime';

/**
 * Phase 1 tool surface (task 1.6): the §2 matrix minus the git group and lint.
 *
 * `git` stays phase-gated out of the loop for the same reason it was in Phase 0
 * (spec §9 pattern): an in-loop git flow needs the composition root to follow
 * the worktree created by `git_createWorktree` (getWorktree pointer switch),
 * which is Phase 2 composition-root machinery (DEF-006 also defers the git
 * grant-granularity ruling). `lint` is phase-gated too: the loop surface of
 * Phase 0/1 roles never needs it (the catalog resolves it since task 2.5, so
 * exit tests may assert it via direct catalog chains).
 */
export const PHASE1_TOOL_SURFACE: readonly string[] = [
  'fs.read',
  'fs.write',
  'fs.list',
  'test.run',
  'sandbox.run',
];

/** Phase 1 working rules appended to each role's system prompt. */
const PHASE1_HANDOFF: Readonly<Partial<Record<string, string>>> = {
  CODER:
    '\n\n[Phase 1 working rules]\n- All file paths are relative to the worktree root (the `path` argument of fs_read/fs_write/fs_list).\n- Use fs_write for implementation files, fs_read/fs_list to inspect, and sandbox_run to verify quickly.\n- After implementing and verifying, use fs_write to store {"status":"done"} at the worktree root in `subtask-status.json`.',
  TESTER:
    '\n\n[Phase 1 working rules]\n- All file paths are relative to the worktree root (the `path` argument of fs_read/fs_write/fs_list).\n- Use fs_write to create test files, then sandbox_run to execute them (e.g. `node --test <file>`).\n- After running, use fs_write to store the structured result at the worktree root in `test-results.json` with this exact JSON shape: {"passed": true, "total": 2, "failed": 0, "failures": []}',
};

export interface Phase1RuntimeOptions {
  taskId: string;
  goal: string;
  deepseek?: HarnessExecutorOptions['deepseek'];
  model?: string;
  /**
   * Scripted LLM adapter for deterministic tests (R11: mock only the external
   * LLM dependency; the agent loop, tools, and sandbox stay real). Mutually
   * exclusive intent with `deepseek` — pass one or the other, never both.
   */
  adapter?: LlmAdapter;
  /** Provider key the adapter is registered under (default `agora`). */
  provider?: string;
  /**
   * Sandbox selector (decision D5 advance). Defaults to `{ kind: 'local' }`;
   * pass `{ kind: 'docker', ... }` to run the whole loop inside a container
   * (the Phase 1 exit test's dual-mode switch verification).
   */
  sandboxConfig?: SandboxConfig;
  /** Git main repo path for the bridged git server (lazy temp main repo when omitted). */
  mainRepoPath?: string;
}

export type { Phase0Runtime as Phase1Runtime };

/**
 * Phase 1 composition root (task 1.6 exit-test assembly): the same core as
 * Phase 0 but with the full Phase 1 tool surface (fs/test MCP + sandbox.run)
 * and a config-switchable sandbox. Test-side assembly keeps R8 layering intact
 * (orchestration only touches L3 ports; this module wires the L4
 * implementations — HarnessExecutor + createSandbox factory).
 */
export async function createPhase1Runtime(options: Phase1RuntimeOptions): Promise<Phase0Runtime> {
  return createPhase0Runtime({
    taskId: options.taskId,
    goal: options.goal,
    ...(options.deepseek === undefined ? {} : { deepseek: options.deepseek }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.sandboxConfig === undefined ? {} : { sandboxConfig: options.sandboxConfig }),
    ...(options.mainRepoPath === undefined ? {} : { mainRepoPath: options.mainRepoPath }),
    toolSurface: PHASE1_TOOL_SURFACE,
    handoff: PHASE1_HANDOFF,
  });
}
