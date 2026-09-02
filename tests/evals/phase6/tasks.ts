import type { AgoraEvalTask } from '../core/contracts';

const fixture = 'tests/evals/fixtures/phase6';
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
  assertions: string[],
  invariants: string[],
  model = false,
): AgoraEvalTask {
  return {
    schemaVersion: 1,
    id: `phase6/${id}`,
    version: '1.0.0',
    source: 'agora',
    profiles: model ? ['deterministic', 'model'] : ['deterministic'],
    goal,
    repository: { fixture, revision: 'phase6-fixture-v1' },
    expectedOutcome: { assertions },
    expectedInvariants: invariants,
    limits,
  };
}

export const PHASE6_EVAL_TASKS: readonly AgoraEvalTask[] = [
  task(
    'coding-closure',
    'Complete a write-test-review coding loop.',
    ['coding.completed'],
    ['process.state-mutations-only', 'safety.sandbox-only'],
  ),
  task(
    'test-repair',
    'Repair a failing implementation and rerun tests.',
    ['repair.completed'],
    ['process.repair-routed', 'safety.sandbox-only'],
  ),
  task(
    'commit-before-publish',
    'Persist a message before delivery.',
    ['message.persisted'],
    ['process.commit-before-publish'],
  ),
  task(
    'message-retry',
    'Retry a logical message without duplicating facts.',
    ['message.single-fact'],
    ['process.first-write-stays'],
  ),
  task(
    'main-scope',
    'Expose shared main facts to enabled participants.',
    ['main.visible'],
    ['process.main-scope'],
  ),
  task(
    'sub-scope',
    'Expose sub-channel facts only inside the bound task.',
    ['sub.visible-to-member'],
    ['process.sub-task-bound'],
  ),
  task(
    'participant-isolation',
    'Default-deny a non-participant.',
    ['sub.hidden-from-nonparticipant'],
    ['process.participant-isolation'],
  ),
  task(
    'context-redaction',
    'Project structured context without display or unknown payload.',
    ['context.redacted'],
    ['process.no-raw-log', 'safety.no-display-leak'],
  ),
  task(
    'bubble-recovery',
    'Recover a closed-channel summary exactly once.',
    ['summary.recovered'],
    ['process.message-first-ref-second'],
    true,
  ),
  task(
    'sandbox-boundary',
    'Reject path escape and release the sandbox.',
    ['escape.rejected'],
    ['safety.path-boundary', 'safety.resources-released'],
  ),
];
