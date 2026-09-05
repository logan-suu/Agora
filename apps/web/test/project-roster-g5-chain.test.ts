import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RoleSpec } from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { HarnessExecutor } from '@agora/runtime-executor';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../src/server/channel-stream';
import { createMessageRuntime } from '../src/server/message-runtime';

// Mock 原因（R11）：只替代外部计费 LLM 的文本响应；本测试真实运行
// ProjectCollaborationStore、Leader Intent、角色投影、HarnessExecutor、WorkerRuntime、
// TaskStateStore 与 MessageService，目标 D12 执行链路不使用 test double。
class ScriptedAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Release plan ready.' };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Release plan ready.' },
    };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('D12 G5 collaboration-to-Harness chain', () => {
  it('loads a persisted custom role and executes it through the generic worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-roster-g5-'));
    roots.push(root);
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    const messages = createMessageRuntime(root, new ChannelStream());
    await messages.initialize(scope, 'Prepare release');
    const spec: RoleSpec = {
      role: 'RELEASE_MANAGER',
      executor: 'harness',
      systemPrompt: 'Prepare a release plan.',
      tools: [],
      projection: ['global.summary'],
      routeWhen: 'leaderAssignment',
    };
    await messages.roster.addRole(scope.projectId, spec);
    const assigned = await messages.commitLeaderMessage(scope, {
      msgId: 'assign-release',
      channelId: 'main',
      display: '@RELEASE_MANAGER prepare it',
      ts: 1,
    });

    const executors: HarnessExecutor[] = [];
    const worker = new WorkerRuntime({
      roster: [],
      loadRoster: () => messages.enabledRoleSpecs(scope.projectId),
      buildChannelContext: (state, role) => messages.channelContextFor(state, role),
      transition: async (_state, mutations) =>
        (await messages.commitMutations(scope, mutations)).state,
      buildExecutor: (loaded) => {
        const executor = new HarnessExecutor(loaded, {
          adapter: new ScriptedAdapter(),
          provider: 'agora',
        });
        executors.push(executor);
        return executor;
      },
    });
    try {
      const final = await worker.runOne(assigned.state, {
        workerId: 'worker:project-roster:release-manager',
        role: 'RELEASE_MANAGER',
      });
      expect(final.messages.at(-1)).toMatchObject({
        fromRole: 'RELEASE_MANAGER',
        display: 'Release plan ready.',
      });
      expect((await messages.collaboration.load(scope.projectId))?.roster.at(-1)).toMatchObject({
        spec: { role: 'RELEASE_MANAGER' },
        status: 'enabled',
      });
    } finally {
      await Promise.all(executors.map((executor) => executor.dispose()));
    }
  });
});
