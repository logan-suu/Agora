import type { AppState, RoleId, RoleSpec } from '@agora/core-domain';
import type { ProjectionView } from './base';

/**
 * Minimal Phase 0 projection placeholder (decision D1 / WO).
 *
 * Task 3.3 implements the precise three-rule projection (structured slices +
 * code-by-reference + rationale-follows-decision). Until then this builds the
 * `ProjectionView` shape the `agent/pre-step` overwrite needs, WITHOUT leaking
 * the raw chat log (R2): every slice the role subscribes to is present with a
 * stable Phase 0 stub. Unknown slices are present-but-empty.
 *
 * 0.6 enrichment for the LRU verification loop: `assignedSubtask` carries the
 * worktree path, `failingTests` feeds the Coder retry feedback, and
 * `acceptance` gives the Tester the goal plus any prior test results.
 */
export function project(
  state: AppState,
  role: RoleId,
  roster: readonly RoleSpec[],
): ProjectionView {
  const spec = roster.find((entry) => entry.role === role);
  const slices: Record<string, unknown> = {};
  if (spec !== undefined) {
    for (const slice of spec.projection) {
      slices[slice] = phase0Stub(state, role, slice);
    }
  }
  return { role: String(role), slices };
}

/** Stable Phase 0 stub per slice name; precise values land in task 3.3. */
function phase0Stub(state: AppState, role: RoleId, slice: string): unknown {
  switch (slice) {
    case 'global.summary':
      return {
        taskId: state.taskId,
        goal: state.goal,
        phase: state.phase,
        iterationCount: state.iterationCount,
      };
    case 'assignedSubtask':
      return state.subtasks
        .filter((s) => s.status !== 'done' && s.ownerRole === role)
        .map((s) => ({
          id: s.id,
          title: s.title,
          ownerRole: s.ownerRole,
          status: s.status,
          worktree: s.worktree,
        }));
    case 'failingTests':
      return state.testResults === undefined
        ? { passed: null, total: 0, failed: 0, failures: [] }
        : {
            passed: state.testResults.passed,
            total: state.testResults.total,
            failed: state.testResults.failed,
            failures: state.testResults.failures,
          };
    case 'acceptance':
      return {
        taskId: state.taskId,
        goal: state.goal,
        phase: state.phase,
        testResults: state.testResults ?? null,
      };
    default:
      // Present-but-empty: never a raw log dump (R2). Precise values in 3.3.
      return {};
  }
}
