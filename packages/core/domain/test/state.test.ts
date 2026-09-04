import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/index';
import { createInitialAppState } from '../src/index';

describe('createInitialAppState', () => {
  it('seeds the Phase 0 slice with defaults and omits optional keys entirely', () => {
    const state = createInitialAppState('task-1', '实现带 TTL 的 LRU 缓存');
    expect(state.projectId).toBe('default');
    expect(state.taskId).toBe('task-1');
    expect(state.goal).toBe('实现带 TTL 的 LRU 缓存');
    expect(state.phase).toBe('clarifying');
    expect(state.iterationCount).toBe(0);
    expect(state.subtasks).toEqual([]);
    expect(state.messages).toEqual([]);
    expect('pendingPatch' in state).toBe(false);
    expect('conventions' in state).toBe(false);
    expect('testResults' in state).toBe(false);
    expect('nextRole' in state).toBe(false);
  });

  it('accepts a minimal valid AppState shaped for the Phase 0 slice', () => {
    const state: AppState = {
      projectId: 'project-a',
      taskId: 'task-2',
      goal: 'goal',
      phase: 'coding',
      iterationCount: 1,
      subtasks: [
        { id: 'st-1', title: 'lru', ownerRole: 'CODER', dependsOn: [], status: 'in_progress' },
      ],
      messages: [],
      objections: [],
      requirements: [],
      reviewComments: [],
      handoffPackets: [],
      decisionLedger: [],
      pendingPatch: { files: ['src/lru.ts'] },
      nextRole: 'TESTER',
    };
    expect(state.subtasks[0]?.ownerRole).toBe('CODER');
    expect(state.nextRole).toBe('TESTER');
  });

  it('accepts an explicit project scope', () => {
    expect(createInitialAppState('task-3', 'goal', 'project-b').projectId).toBe('project-b');
  });
});
