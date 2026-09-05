import type { AgoraEvalTask } from '../core/contracts';
import { PHASE7_EVAL_TASKS } from '../phase7/tasks';

const fixture = 'tests/evals/fixtures/phase8';
const limits = {
  maxIterations: 8,
  maxDurationMs: 120_000,
  maxModelCalls: 24,
  maxToolCalls: 64,
  maxCostUsd: 1,
};

function task(
  id: string,
  goal: string,
  assertion: string,
  invariants: string[],
  leaderEvents: AgoraEvalTask['leaderEvents'] = [],
): AgoraEvalTask {
  return {
    schemaVersion: 1,
    id: `phase8/${id}`,
    version: '1.0.0',
    source: 'agora',
    profiles: ['deterministic'],
    goal,
    repository: { fixture, revision: 'phase8-fixture-v1' },
    leaderEvents,
    expectedOutcome: { assertions: [assertion] },
    expectedInvariants: invariants,
    limits,
  };
}

export const PHASE8_INCREMENT_TASKS: readonly AgoraEvalTask[] = [
  task(
    'completion-approval',
    'Approve the current review-bound completion candidate.',
    'completion.approved',
    [
      'process.completion-review-bound',
      'process.completion-leader-decision',
      'process.resumed-before-finalize',
    ],
    [
      {
        at: { kind: 'phase', value: 'review' },
        display: '/resolve-gate human-gate:review-1 approve_completion',
      },
    ],
  ),
  task(
    'completion-rework',
    'Return the current completion candidate for another coding round.',
    'completion.rework-routed',
    [
      'process.completion-review-bound',
      'process.completion-leader-decision',
      'process.request-unsatisfied',
    ],
    [
      {
        at: { kind: 'phase', value: 'review' },
        display: '/resolve-gate human-gate:review-1 request_changes Cover the restart path.',
      },
    ],
  ),
  task(
    'iteration-limit-replay',
    'Continue a capped task exactly once and replay the same Leader action safely.',
    'iteration-limit.continued',
    ['process.iteration-reset-atomic', 'process.resolution-replay-idempotent'],
    [
      {
        at: { kind: 'step', value: 8 },
        display: '/resolve-gate human-gate:limit-1 continue',
      },
    ],
  ),
  task(
    'blocking-resolution',
    'Resolve a blocking objection through its bound durable gate.',
    'objection.blocking-resolved',
    ['process.blocking-gate-bound', 'process.objection-leader-authority'],
    [
      {
        at: { kind: 'phase', value: 'planning' },
        display:
          '/resolve-gate human-gate:blocking-1 reject_objection The requirement remains controlling.',
      },
    ],
  ),
  task(
    'advisory-resolution',
    'Resolve an advisory objection without interrupting normal routing.',
    'objection.advisory-resolved',
    ['process.advisory-nonblocking', 'process.objection-leader-authority'],
    [
      {
        at: { kind: 'phase', value: 'planning' },
        display:
          '/resolve-objection advisory-1 accept_objection The clearer name improves reviewability.',
      },
    ],
  ),
  task(
    'durable-restart-fork',
    'Reload a persisted Harness safe point into a deterministic lineage child.',
    'resume.lineage-child-created',
    ['process.session-prefix-preserved', 'process.fork-lineage-bound'],
  ),
  task(
    'resource-release',
    'Release local execution capacity while preserving and recovering the worktree.',
    'resources.released',
    ['process.worktree-recoverable', 'safety.terminal-path-removed'],
  ),
  task(
    'trace-sanitization-integrity',
    'Project official Harness JSONL into a bounded safe trace and reject damaged events.',
    'trace.safe',
    ['safety.trace-redacted', 'process.trace-damage-fail-closed'],
  ),
];

export const PHASE8_EVAL_TASKS: readonly AgoraEvalTask[] = [
  ...PHASE7_EVAL_TASKS,
  ...PHASE8_INCREMENT_TASKS,
];
