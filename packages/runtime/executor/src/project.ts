import type { AppState, RoleId, RoleSpec } from '@agora/core-domain';
import type { ProjectionView } from './base';

/**
 * Role projection implementing the spec §7 slice table (task 2.4; D1/WO).
 *
 * Every roster-declared slice is built here from structured State only — never
 * the raw chat log (iron rule 1), and code travels as path+line refs only
 * (iron rule 2). Slices whose State sources land in later phases return
 * explicit empty defaults (R9), annotated with the upgrade task. Iron rule 3
 * (rationale-follows-decision) needs the decision ledger (task 3.1) and is out
 * of scope here.
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
      slices[slice] = sliceOf(state, role, slice);
    }
  }
  return { role: String(role), slices };
}

function sliceOf(state: AppState, role: RoleId, slice: string): unknown {
  switch (slice) {
    case 'global.summary':
      return {
        taskId: state.taskId,
        goal: state.goal,
        phase: state.phase,
        iterationCount: state.iterationCount,
        complexity: null, // Phase 4 complexity tiers
        workers: [], // Phase 9 worker registry
        testSummary:
          state.testResults === undefined
            ? null
            : {
                passed: state.testResults.passed,
                total: state.testResults.total,
                failed: state.testResults.failed,
              },
      };
    case 'goal':
      return { goal: state.goal };
    case 'requirements':
      return state.requirements.map((requirement) => ({ ...requirement }));
    case 'leaderDecisions':
      return []; // task 3.1 decisionLedger upgrade point
    case 'repoStructure':
      return {}; // Phase 1 repoSnapshot upgrade point
    case 'conventions':
      return state.conventions === undefined ? {} : { ...state.conventions };
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
    case 'architecture':
      return state.architecture === undefined ? {} : { ...state.architecture };
    case 'failingTests':
      return state.testResults === undefined
        ? { passed: null, total: 0, failed: 0, failures: [] }
        : {
            passed: state.testResults.passed,
            total: state.testResults.total,
            failed: state.testResults.failed,
            failures: [...state.testResults.failures],
          };
    case 'fileRefs': {
      // Iron rule 2: path+line refs only — the truth lives in the worktree.
      const byFile = new Map<string, number[]>();
      for (const failure of state.testResults?.failures ?? []) {
        const lines = byFile.get(failure.file);
        if (lines === undefined) {
          byFile.set(failure.file, [failure.line]);
        } else if (!lines.includes(failure.line)) {
          lines.push(failure.line);
        }
      }
      return [...byFile.entries()].map(([file, lines]) => ({ file, lines }));
    }
    case 'acceptance':
      return {
        requirements: state.requirements.map((requirement) => ({
          id: requirement.id,
          acceptance: [...requirement.acceptance],
        })),
      };
    case 'branchOrPatch':
      return {
        worktrees: state.subtasks
          .filter((s) => s.status !== 'done' && s.worktree !== undefined)
          .map((s) => s.worktree),
        patch: state.pendingPatch === undefined ? null : { ...state.pendingPatch },
      };
    case 'interfaceContracts': {
      const declared = state.architecture?.interfaces;
      if (Array.isArray(declared)) return [...declared];
      if (typeof declared === 'object' && declared !== null) return { ...declared };
      return {}; // ARCHITECT has not declared interfaces yet
    }
    case 'pendingPatch':
      return state.pendingPatch === undefined ? null : { ...state.pendingPatch };
    default:
      // All roster-declared slices are implemented above (drift-guarded by
      // project.test); an unknown name is roster/implementation drift.
      throw new Error(`unknown projection slice "${slice}" declared for role "${String(role)}"`);
  }
}
