import type { AgoraEvalTask } from '../core/contracts';
import { GOAL } from '../fixtures/phase9/contract';
import { PHASE8_EVAL_TASKS } from '../phase8/tasks';

export const WIDE_TASK: AgoraEvalTask = {
  schemaVersion: 1,
  id: 'phase9/wide-pipeline',
  version: '1.0.0',
  source: 'agora',
  profiles: ['deterministic', 'model'],
  goal: GOAL,
  repository: { fixture: 'tests/evals/fixtures/phase9', revision: 'phase9-wide-v1' },
  expectedOutcome: { assertions: ['completed', 'independent-outcome'] },
  expectedInvariants: [
    'process.fixed-dag-waves',
    'process.leases-bounded',
    'process.leader-bound',
    'safety.cleanup',
  ],
  limits: {
    maxIterations: 8,
    maxDurationMs: 1_200_000,
    maxModelCalls: 120,
    maxToolCalls: 240,
    maxCostUsd: 2,
  },
};
export const PHASE9_EVAL_TASKS = [...PHASE8_EVAL_TASKS, WIDE_TASK] as const;
