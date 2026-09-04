// Mock reason (R11): only the paid external LLM response is replaced. The test uses
// the real JSONL Harness persistence, LocalTempSandbox, Web composition root,
// TaskStateStore, MessageService, WorkerRuntime, and humanGate lifecycle.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessExecutor, project } from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import { TaskOrchestrationRuntime } from '../../../apps/web/src/server/task-orchestration-runtime';

class DeterministicLlmAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    const reply =
      '[{"id":"phase8-approved","kind":"verdict","verdict":"approved","summary":"resume path verified"}]';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: reply };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 8 humanGate lifecycle', () => {
  it('flushes a source turn, rebuilds after disposal, resumes a lineage child, and completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-phase8-human-gate-'));
    roots.push(root);
    const scope = { projectId: 'phase8-project', taskId: 'phase8-task' };
    const sandbox = new LocalTempSandbox();
    const worktree = await sandbox.createWorktree(scope.taskId, 'shared');
    await sandbox.write(
      worktree,
      'test-results.json',
      JSON.stringify({ passed: true, total: 1, failed: 0, failures: [] }),
    );
    const state = applyMutations(
      createInitialAppState(scope.taskId, 'Verify durable resume', scope.projectId),
      [
        setMutation('phase', 'coding'),
        setMutation('iterationCount', 8),
        mergeByIdMutation('subtasks', 'phase8-work', {
          title: 'Verify durable resume',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
          worktree: worktree.path,
        }),
      ],
    );
    const coder = DEFAULT_ROSTER.find((entry) => entry.role === 'CODER');
    if (coder === undefined) throw new Error('CODER role is missing');
    const adapter = new DeterministicLlmAdapter();
    const sessionRoot = join(
      root,
      'projects',
      scope.projectId,
      'tasks',
      scope.taskId,
      'harness-sessions',
    );
    const source = new HarnessExecutor(coder, {
      adapter,
      provider: 'agora',
      sessionPersistence: {
        root: sessionRoot,
        cwd: worktree.path,
        projectId: scope.projectId,
        taskId: scope.taskId,
      },
    });
    await source.step({
      sessionId: 'phase8-source-coder',
      view: project(state, 'CODER', DEFAULT_ROSTER),
    });
    const safePointRef = await source.saveSafePoint();
    await source.dispose();
    await sandbox.suspend(scope.taskId);

    const gated = applyMutations(state, [
      setMutation('humanGate', {
        gateId: 'human-gate:phase8-iteration-limit',
        reason: 'iteration_limit',
        options: ['continue'],
        phase: state.phase,
        openedTs: 1,
        safePointRefs: [safePointRef],
      }),
    ]);
    const messages = createMessageRuntime(root, new ChannelStream());
    await messages.initializeState(scope, gated);
    const runtime = new TaskOrchestrationRuntime(
      messages,
      createWebTaskCompositionFactory({
        sandbox,
        dataRoot: root,
        executorOptions: { adapter, provider: 'agora', deepseek: false },
      }),
    );

    const response = await createPostMessage(messages)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          ...scope,
          channelId: 'main',
          msgId: 'phase8-continue',
          display: '/resolve-gate human-gate:phase8-iteration-limit continue',
        }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ action: { status: 'applied' } });
    await runtime.waitForIdle(scope);

    await expect(runtime.summary(scope)).resolves.toMatchObject({
      runStatus: 'completed',
      phase: 'done',
      artifactPath: join(
        root,
        'projects',
        scope.projectId,
        'tasks',
        scope.taskId,
        'artifacts',
        'worktree',
      ),
    });
    const finalState = await messages.store.load(scope);
    expect(finalState).not.toHaveProperty('humanGate');
    const ids = finalState?.messages.map((message) => message.msgId) ?? [];
    expect(ids).toContain('phase8-continue');
    expect(ids).toContain('human-gate-resumed:phase8-continue');
    expect(ids.indexOf('human-gate-resumed:phase8-continue')).toBeLessThan(
      ids.findIndex(
        (id) => id !== 'phase8-continue' && id !== 'human-gate-resumed:phase8-continue',
      ),
    );
  });
});
