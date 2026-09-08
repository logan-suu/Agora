// Mock reason (R11): inject an infrastructure error through the composition port;
// retain the real runtime registry, orchestration, WorkerRuntime and JSON store.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendMutation,
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { expect, it } from 'vitest';
import { ChannelStream } from '../src/server/channel-stream';
import { createMessageRuntime } from '../src/server/message-runtime';
import {
  type TaskCompositionFactory,
  TaskOrchestrationRuntime,
} from '../src/server/task-orchestration-runtime';

it.each([false, true])(
  'suspends failed parallel resources and retries cleanup without archiving (initial failure: %s)',
  async (failSuspend) => {
    const root = await mkdtemp(join(tmpdir(), 'agora-review-capacity-'));
    const lifecycle = { suspended: 0, disposed: 0, contexts: 0, archived: 0 };
    let remainingFailures = failSuspend ? 1 : 0;
    try {
      const messages = createMessageRuntime(root, new ChannelStream());
      const factory: TaskCompositionFactory = async ({ scope, goal, transition }) => {
        const plan = { version: 1, subtasks: [{ id: 'A', title: 'A', dependsOn: [] }] };
        const initialState = applyMutations(
          createInitialAppState(scope.taskId, goal, scope.projectId),
          [
            setMutation('architecture', { executionPlan: plan }),
            appendMutation('messages', {
              msgId: 'plan',
              channelId: 'main',
              fromRole: 'COORDINATOR',
              type: 'announce',
              payload: { kind: 'execution_plan', plan },
              display: 'Plan',
              ts: 1,
            }),
            mergeByIdMutation('subtasks', 'A', {
              title: 'A',
              dependsOn: [],
              ownerRole: 'CODER',
              status: 'todo',
            }),
            setMutation('parallelExecution', {
              version: 1,
              planId: 'plan',
              initialBase: { branch: 'base', commit: 'a'.repeat(40) },
            }),
            setMutation('phase', 'coding'),
          ],
        );
        return {
          initialState,
          roster: DEFAULT_ROSTER,
          artifactPath: root,
          workerRuntime: new WorkerRuntime({
            roster: DEFAULT_ROSTER,
            transition,
            buildExecutor: () => {
              throw new Error('unused');
            },
          }),
          parallelContext: async () => {
            lifecycle.contexts++;
            throw new Error('temporary evidence read failure');
          },
          saveSafePoints: async () => [],
          suspend: async () => {
            lifecycle.suspended++;
            if (remainingFailures-- > 0) throw new Error('temporary suspend failure');
          },
          dispose: async () => {
            lifecycle.disposed++;
          },
          archiveArtifact: async () => {
            lifecycle.archived++;
            return { path: root, worktrees: [] };
          },
        };
      };
      const runtime = new TaskOrchestrationRuntime(messages, factory, { maxActiveCompositions: 1 });
      const input = { projectId: 'project', taskId: 'first', goal: 'goal', requestId: 'start' };
      await runtime.start(input);
      await runtime.waitForIdle(input);
      expect(await runtime.summary(input)).toMatchObject({ runStatus: 'needs_attention' });
      expect(lifecycle.suspended).toBe(1);
      if (failSuspend) {
        await expect(
          runtime.start({ ...input, taskId: 'blocked', requestId: 'blocked' }),
        ).rejects.toThrow(/capacity/);
        const retry = await runtime.start({ ...input, requestId: 'retry-cleanup' });
        expect(retry.startOutcome).toBe('started');
        await runtime.waitForIdle(input);
        expect(lifecycle.suspended).toBe(2);
      }
      const retry = await runtime.start({ ...input, requestId: 'after-cleanup' });
      expect(retry.startOutcome).toBe('needs_attention');
      expect(lifecycle.contexts).toBe(1);
      expect(lifecycle.archived).toBe(0);
      expect(lifecycle.disposed).toBe(0);
      const persisted = await messages.store.load(input);
      expect(persisted).toMatchObject({ phase: 'coding', parallelExecution: { planId: 'plan' } });
      expect(persisted?.humanGate).toBeUndefined();
      await expect(
        runtime.start({ ...input, taskId: 'second', requestId: 'second' }),
      ).resolves.toMatchObject({ startOutcome: 'started' });
      await runtime.waitForIdle({ ...input, taskId: 'second' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
