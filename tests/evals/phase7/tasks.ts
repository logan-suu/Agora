import type { AgoraEvalTask } from '../core/contracts';
import { PHASE6_EVAL_TASKS } from '../phase6/tasks';

const fixture = 'tests/evals/fixtures/phase7';
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
    id: `phase7/${id}`,
    version: '1.0.0',
    source: 'agora',
    profiles: ['deterministic'],
    goal,
    repository: { fixture, revision: 'phase7-fixture-v1' },
    leaderEvents,
    expectedOutcome: { assertions: [assertion] },
    expectedInvariants: invariants,
    limits,
  };
}

export const PHASE7_INCREMENT_TASKS: readonly AgoraEvalTask[] = [
  task(
    'role-registration',
    'Register an enabled custom role and atomically update main membership.',
    'roster.role-added',
    ['process.roster-channel-atomic'],
  ),
  task(
    'forced-handoff',
    'Drain an in-flight role, persist its safe point, and transfer responsibility exactly once.',
    'handoff.completed',
    [
      'process.departing-before-drain',
      'process.safe-point-before-handoff',
      'process.responsibility-before-departed',
      'process.action-replay-idempotent',
    ],
    [{ at: { kind: 'step', value: 0 }, display: '/role remove CODER to TESTER' }],
  ),
  task(
    'onboarding-recovery',
    'Rebuild a claimed handoff from persisted task state after restart.',
    'onboarding.recovered',
    ['process.onboarding-from-persisted-state', 'process.no-raw-log'],
    [{ at: { kind: 'phase', value: 'planning' }, display: '/role onboard TESTER' }],
  ),
  task(
    'orphan-escalation',
    'Keep unfinished work blocked until an enabled replacement is assigned.',
    'orphan.escalated',
    ['process.awaiting-replacement', 'process.leader-human-gate'],
    [{ at: { kind: 'phase', value: 'coding' }, display: '/role remove CODER' }],
  ),
  task(
    'coordinator-protection',
    'Reject removal of the permanent Coordinator while preserving collaboration state.',
    'coordinator.protected',
    ['process.coordinator-always-enabled'],
    [{ at: { kind: 'phase', value: 'planning' }, display: '/role remove COORDINATOR' }],
  ),
];

export const PHASE7_EVAL_TASKS: readonly AgoraEvalTask[] = [
  ...PHASE6_EVAL_TASKS,
  ...PHASE7_INCREMENT_TASKS,
];
