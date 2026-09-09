// Only the provider stream is scripted to inject protocol failures deterministically.
// The Harness loop, retry plugin, JSONL persistence and safe-point lifecycle are real.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { Context } from '@deepseek-ai/cordis';
import {
  type GenerateOptions,
  LlmAdapter,
  resolveRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { describe, expect, it, vi } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';
import { project } from '../src/project';

class Failures extends LlmAdapter {
  calls: GenerateOptions[] = [];
  onFailure?: () => void;
  replies: (string | undefined)[] = [];
  constructor(
    readonly codes: (string | undefined)[],
    readonly retryAfter?: number,
  ) {
    super();
  }
  override providerRetryPolicy() {
    return resolveRetryPolicy(
      {
        mode: 'normal',
        maxRetries: 2,
        backoff: {
          initialDelayMs: 1,
          maxDelayMs: 10,
          jitterRatio: 0,
        },
      },
      'test',
    );
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    const code = this.codes[this.calls.length - 1];
    const text =
      code === undefined ? (this.replies[this.calls.length - 1] ?? 'recovered') : 'PARTIAL_SECRET';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    if (code !== undefined) {
      this.onFailure?.();
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code,
            message: 'PROVIDER_SECRET',
            ...(this.retryAfter === undefined ? {} : { providerRetryAfterMs: this.retryAfter }),
          },
        },
      };
    } else yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const coder = PHASE0_ROSTER.find((r) => r.role === 'CODER');
if (coder === undefined) throw new Error('missing CODER');
const spec = coder;
const context = {
  sessionId: 'retry-test',
  view: project(createInitialAppState('retry', 'goal'), 'CODER', PHASE0_ROSTER),
};

async function fixture(adapter: Failures) {
  const root = await mkdtemp(join(tmpdir(), 'agora-retry-'));
  const reader = vi.fn(() => []);
  const executor = new HarnessExecutor(spec, {
    adapter,
    readTurnMutations: reader,
    sessionPersistence: { root, cwd: root, projectId: 'project', taskId: 'retry' },
  });
  return {
    executor,
    reader,
    async events() {
      await executor.saveSafePoint();
      const ctx = new Context();
      const fibers = [ctx.plugin(SessionStore), ctx.plugin(JsonlSessionPersistence, { root })];
      try {
        await Promise.all(fibers);
        return (await ctx.sessionPersistence.inspect(SessionId(context.sessionId))).events;
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose();
      }
    },
    async close() {
      await executor.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('official finite request recovery', () => {
  it('recovers twice within one Step and commits only the final response', async () => {
    const adapter = new Failures(['RATE_LIMIT', 'TRANSPORT']);
    const f = await fixture(adapter);
    try {
      const result = await f.executor.step(context);
      expect(result.output).toEqual({ text: 'recovered' });
      expect(f.reader).toHaveBeenCalledExactlyOnceWith({ text: 'recovered' });
      expect(JSON.stringify(result)).not.toContain('PARTIAL_SECRET');
      expect(adapter.calls).toHaveLength(3);
      const events = await f.events();
      expect(events.filter((e) => e.type === 'turn/start')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'step/start')).toHaveLength(1);
      const retries = events.filter((e) => e.type === 'llm/retry').map((e) => e.data);
      expect(retries).toEqual([
        expect.objectContaining({ turn: 1, step: 1, retry: 1, maxRetries: 2 }),
        expect.objectContaining({ turn: 1, step: 1, retry: 2, maxRetries: 2 }),
      ]);
      expect(new Set(retries.map((r) => (r as { retryId: string }).retryId)).size).toBe(1);
      expect(events.filter((e) => e.type === 'llm/retry-started')).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
  it.each([
    ['AUTHENTICATION', 1],
    ['QUOTA', 1],
    ['UNKNOWN', 1],
    ['SERVER', 3],
  ] as const)('propagates terminal %s without publishing partial output', async (code, calls) => {
    const adapter = new Failures([code, code, code]);
    const f = await fixture(adapter);
    try {
      await expect(f.executor.step(context)).rejects.toMatchObject({
        name: 'ExecutorRequestError',
        code,
        cause: expect.anything(),
      });
      expect(adapter.calls).toHaveLength(calls);
      expect(f.reader).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
  it('honors bounded Retry-After and stops when it exceeds the provider policy', async () => {
    for (const delay of [3, 11]) {
      const adapter = new Failures(['RATE_LIMIT'], delay);
      const f = await fixture(adapter);
      try {
        if (delay === 3) {
          await f.executor.step(context);
          expect((await f.events()).find((e) => e.type === 'llm/retry')?.data).toMatchObject({
            delayMs: 3,
          });
        } else {
          await expect(f.executor.step(context)).rejects.toThrow();
          expect(adapter.calls).toHaveLength(1);
        }
      } finally {
        await f.close();
      }
    }
  });
  it('does not abort the provider when pause arrives during recovery', async () => {
    const adapter = new Failures(['TIMEOUT']);
    const f = await fixture(adapter);
    adapter.onFailure = () => f.executor.requestSafePoint();
    try {
      await f.executor.step(context);
      expect(adapter.calls).toHaveLength(2);
      expect(adapter.calls.every((call) => !call.signal?.aborted)).toBe(true);
      const events = await f.events();
      expect(events.at(-1)?.type).toBe('turn/end');
    } finally {
      await f.close();
    }
  });
});

it('keeps official overflow compaction separate from normal request retries', async () => {
  const adapter = new Failures([
    undefined,
    'CONTEXT_WINDOW_EXCEEDED',
    undefined,
    'RATE_LIMIT',
    undefined,
  ]);
  adapter.replies = ['Prior result. '.repeat(500), undefined, 'Short prior summary.'];
  const f = await fixture(adapter);
  try {
    await f.executor.step(context);
    const result = await f.executor.step(context);
    expect(result.output).toEqual({ text: 'recovered' });
    const events = await f.events();
    expect(events.filter((e) => e.type === 'compaction/end')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'llm/retry')).toHaveLength(1);
    expect(adapter.calls).toHaveLength(5);
  } finally {
    await f.close();
  }
});

it('does not reset the official overflow budget after a normal retry', async () => {
  const adapter = new Failures([
    undefined,
    'CONTEXT_WINDOW_EXCEEDED',
    undefined,
    'RATE_LIMIT',
    'CONTEXT_WINDOW_EXCEEDED',
  ]);
  adapter.replies = ['Prior result. '.repeat(500), undefined, 'Short prior summary.'];
  const f = await fixture(adapter);
  try {
    await f.executor.step(context);
    await expect(f.executor.step(context)).rejects.toMatchObject({
      name: 'ExecutorRequestError',
      code: 'CONTEXT_WINDOW_EXCEEDED',
    });
    const events = await f.events();
    expect(events.filter((e) => e.type === 'compaction/end')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'llm/retry')).toHaveLength(1);
    expect(adapter.calls).toHaveLength(5);
  } finally {
    await f.close();
  }
});

it('keeps format repair separate and never republishes malformed output after recovery', async () => {
  const adapter = new Failures(['TRANSPORT', undefined, undefined]);
  adapter.replies = [undefined, 'malformed', '{"ok":true}'];
  const reader = vi.fn(() => []);
  const executor = new HarnessExecutor(spec, {
    adapter,
    validateTurnOutput: ({ text }) => {
      JSON.parse(text ?? '');
    },
    readTurnMutations: reader,
  });
  try {
    const result = await executor.step(context);
    expect(result.output).toEqual({ text: '{"ok":true}' });
    expect(reader).toHaveBeenCalledExactlyOnceWith({ text: '{"ok":true}' });
    expect(adapter.calls).toHaveLength(3);
    expect(adapter.calls[2]?.tools ?? []).toEqual([]);
    expect(JSON.stringify(adapter.calls[2]?.messages)).toContain('output-format-repair');
  } finally {
    await executor.dispose();
  }
});
