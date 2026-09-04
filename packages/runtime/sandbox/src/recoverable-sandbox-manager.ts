import type { SandboxManager } from './sandbox-manager';
import type { Worktree } from './types';

export interface RecoverableWorktreeBinding {
  role: string;
  worktree: Worktree;
}

/** D4 companion capability. The frozen SandboxManager interface remains unchanged. */
export interface RecoverableSandboxManager extends SandboxManager {
  suspend(taskId: string): Promise<void>;
  resume(taskId: string, bindings: readonly RecoverableWorktreeBinding[]): Promise<void>;
}

export function isRecoverableSandboxManager(
  sandbox: SandboxManager,
): sandbox is RecoverableSandboxManager {
  const candidate = sandbox as Partial<RecoverableSandboxManager>;
  return typeof candidate.suspend === 'function' && typeof candidate.resume === 'function';
}
