import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import {
  CallId,
  type ContentBlock,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';
import { project } from '../src/project';

// Mock 原因（R11）：注入脚本化 FakeLlmAdapter 隔离真实 LLM，验证任务 1.5 的
// 工具治理（超时/审批/限流/restrict）在真实 Harness agent loop + 真实
// ToolRuntime + 真实 timeout-policy 插件上的组合行为。工具本体为桩（无 I/O），
// 治理机制本身即被测对象。
class ScriptedToolAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  private seq = 0;

  constructor(
    private readonly script: readonly { tool: string; args: Record<string, unknown> }[],
    private readonly finalText = 'done',
  ) {
    super();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    const action = this.script[this.calls.length - 1];
    if (action === undefined) {
      yield* textChunks(this.finalText);
      return;
    }
    yield* toolCallChunks(action, CallId(`call-${this.seq++}`));
  }
}

function usageChunk(): StreamChunk {
  return { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } };
}

function* toolCallChunks(
  action: { tool: string; args: Record<string, unknown> },
  callId: CallId,
): Iterable<StreamChunk> {
  const argumentsJson = JSON.stringify(action.args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield {
    type: 'tool-call-delta',
    index: 0,
    id: callId,
    name: action.tool,
    argumentsDelta: argumentsJson,
  };
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: callId, name: action.tool, arguments: argumentsJson },
  };
  yield usageChunk();
  yield { type: 'finish', reason: { kind: 'stop' } };
}

function* textChunks(text: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield usageChunk();
  yield { type: 'finish', reason: { kind: 'stop' } };
}

function stubTool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: {},
    output: { schema: {}, render: () => [] as ContentBlock[] },
    execute: async () => ({ ok: true }),
  };
}

/** Hangs until the cooperative timeout aborts its signal (task 1.5 timeout policy). */
function hangingTool(name: string, timeoutMs: number): ToolDefinition {
  return {
    name,
    description: name,
    parameters: {},
    timeoutMs,
    output: { schema: {}, render: () => [] as ContentBlock[] },
    execute: async (_args, exec) =>
      new Promise((resolve) => {
        exec.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
      }),
  };
}

/** All tool-result block texts recorded across every adapter call. */
function toolResultTexts(calls: readonly GenerateOptions[]): string[] {
  const texts: string[] = [];
  for (const call of calls) {
    for (const message of call.messages) {
      for (const block of message.content) {
        if (block.type !== 'tool-result') continue;
        for (const content of block.content) {
          if (content.type === 'text') texts.push(content.text);
        }
      }
    }
  }
  return texts;
}

const CODER_SPEC = PHASE0_ROSTER.find((r) => r.role === 'CODER');
if (CODER_SPEC === undefined) throw new Error('CODER spec missing from PHASE0_ROSTER');

function codingView() {
  return project(
    { ...createInitialAppState('g-1', 'governance'), phase: 'coding' as const, iterationCount: 1 },
    'CODER',
    PHASE0_ROSTER,
  );
}

describe('HarnessExecutor tool governance (task 1.5)', () => {
  it('arms the cooperative timeout policy: a slow tool yields a TOOL_TIMEOUT result the model sees', async () => {
    const fake = new ScriptedToolAdapter([{ tool: 'slow_tool', args: {} }]);
    const executor = new HarnessExecutor(CODER_SPEC, {
      adapter: fake,
      provider: 'agora',
      tools: [hangingTool('slow_tool', 50)],
    });
    try {
      const result = await executor.step({ sessionId: 'g-timeout', view: codingView() });
      expect(result.kind).toBe('done');
      const texts = toolResultTexts(fake.calls);
      expect(texts.some((text) => text.includes('timed out after 50ms'))).toBe(true);
    } finally {
      await executor.dispose();
    }
  });

  it('runs the approval gate on tools/pre-execute: a denied call surfaces its reason to the model', async () => {
    const fake = new ScriptedToolAdapter([{ tool: 'echo_tool', args: { x: 1 } }]);
    const executor = new HarnessExecutor(CODER_SPEC, {
      adapter: fake,
      provider: 'agora',
      tools: [stubTool('echo_tool')],
      approval: async () => ({ kind: 'deny', reason: 'blocked by approval gate' }),
    });
    try {
      const result = await executor.step({ sessionId: 'g-approval', view: codingView() });
      expect(result.kind).toBe('done');
      expect(
        toolResultTexts(fake.calls).some((text) => text.includes('blocked by approval gate')),
      ).toBe(true);
    } finally {
      await executor.dispose();
    }
  });

  it('enforces the per-turn tool-call budget via a monotonic guard', async () => {
    const fake = new ScriptedToolAdapter([
      { tool: 'echo_tool', args: {} },
      { tool: 'echo_tool', args: {} },
    ]);
    const executor = new HarnessExecutor(CODER_SPEC, {
      adapter: fake,
      provider: 'agora',
      tools: [stubTool('echo_tool')],
      maxToolCallsPerTurn: 1,
    });
    try {
      const result = await executor.step({ sessionId: 'g-budget', view: codingView() });
      expect(result.kind).toBe('done');
      const texts = toolResultTexts(fake.calls);
      // First call ran; the second was denied by the guard.
      expect(texts.some((text) => text.includes('budget exceeded'))).toBe(true);
    } finally {
      await executor.dispose();
    }
  });

  it('scopes tools per agent via restrict: a non-whitelisted tool is unreachable (UNKNOWN_TOOL)', async () => {
    const fake = new ScriptedToolAdapter([{ tool: 'secret_tool', args: {} }]);
    const executor = new HarnessExecutor(CODER_SPEC, {
      adapter: fake,
      provider: 'agora',
      tools: [stubTool('echo_tool'), stubTool('secret_tool')],
      allowTools: ['echo_tool'],
    });
    try {
      const result = await executor.step({ sessionId: 'g-scope', view: codingView() });
      expect(result.kind).toBe('done');
      const texts = toolResultTexts(fake.calls);
      expect(texts.some((text) => text.includes('unknown tool'))).toBe(true);
    } finally {
      await executor.dispose();
    }
  });
});
