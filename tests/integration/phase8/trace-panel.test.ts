// Mock reason (R11): only the paid external LLM response and the tool's business
// implementation are scripted. This test exercises the real Harness AgentLoop,
// ToolRuntime event emission, official JSONL persistence, TraceReader, HTTP handler,
// TaskStateStore authorization check, and strict client DTO parser. React rendering
// remains in apps/web/test/chat-ui.test.ts so React stays an app-local dependency.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { HarnessExecutor, HarnessTraceReader, project } from '@agora/runtime-executor';
import { JsonTaskStateStore } from '@agora/runtime-state';
import {
  CallId,
  type ContentBlock,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchTraceSnapshot } from '../../../apps/web/src/app/chat-model';
import { createGetTrace } from '../../../apps/web/src/server/trace-handlers';

class TraceScriptAdapter extends LlmAdapter {
  private calls = 0;

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1;
    if (this.calls === 1) {
      const callId = CallId('trace-call-1');
      const argumentsJson = JSON.stringify({ command: 'TOOL_ARGUMENT_SECRET' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: 'sandbox_run',
        argumentsDelta: argumentsJson,
      };
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: callId,
          name: 'sandbox_run',
          arguments: argumentsJson,
        },
      };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'trace complete' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'trace complete' },
      };
    }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 8 Trace panel', () => {
  it('renders sanitized role/turn/step/tool facts from the real durable Harness log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-phase8-trace-'));
    roots.push(root);
    const scope = { projectId: 'phase8-project', taskId: 'phase8-trace-task' };
    const state = {
      ...createInitialAppState(scope.taskId, 'PROJECTION_SECRET', scope.projectId),
      phase: 'coding' as const,
      iterationCount: 1,
    };
    const store = new JsonTaskStateStore(root);
    await store.initialize(scope, state);
    const handler = createGetTrace(store, new HarnessTraceReader(root));
    const url = `http://localhost/api/traces?projectId=${scope.projectId}&taskId=${scope.taskId}`;
    await expect(
      fetchTraceSnapshot(url, async (input) => handler(new Request(String(input)))),
    ).resolves.toEqual({
      projectId: scope.projectId,
      taskId: scope.taskId,
      sessions: [],
      omittedEventCount: 0,
    });

    const coder = PHASE0_ROSTER.find((entry) => entry.role === 'CODER');
    if (coder === undefined) throw new Error('CODER role is missing');
    const tool: ToolDefinition = {
      name: 'sandbox_run',
      description: 'scripted trace fixture',
      parameters: {},
      output: {
        schema: {},
        render: () => [{ type: 'text', text: 'TOOL_RESULT_SECRET' }] as ContentBlock[],
      },
      execute: async () => ({ stdout: 'TOOL_RESULT_SECRET' }),
    };
    const executor = new HarnessExecutor(coder, {
      adapter: new TraceScriptAdapter(),
      provider: 'agora',
      tools: [tool],
      allowTools: ['sandbox_run'],
      sessionPersistence: {
        root: join(root, 'projects', scope.projectId, 'tasks', scope.taskId, 'harness-sessions'),
        cwd: root,
        ...scope,
      },
    });
    try {
      await executor.step({
        sessionId: 'trace-source-coder',
        view: project(state, 'CODER', PHASE0_ROSTER),
      });
      await executor.saveSafePoint();
    } finally {
      await executor.dispose();
    }

    const fetcher: typeof fetch = async (input) =>
      handler(
        new Request(typeof input === 'string' ? input : input instanceof URL ? input : input.url),
      );
    const trace = await fetchTraceSnapshot(url, fetcher);
    const serialized = JSON.stringify(trace);

    expect(trace.sessions).toHaveLength(1);
    expect(trace.sessions[0]).toMatchObject({
      sessionId: 'trace-source-coder',
      role: 'CODER',
    });
    expect(trace.sessions[0]?.turns).toHaveLength(1);
    expect(trace.sessions[0]?.turns[0]).toMatchObject({ status: 'completed' });
    expect(trace.sessions[0]?.turns[0]?.steps).toHaveLength(2);
    expect(trace.sessions[0]?.turns[0]?.steps[0]).toMatchObject({
      step: 1,
      status: 'completed',
      tools: [{ name: 'sandbox_run', status: 'succeeded' }],
    });
    expect(serialized).not.toMatch(/PROJECTION_SECRET|TOOL_ARGUMENT_SECRET|TOOL_RESULT_SECRET/);
  });
});
