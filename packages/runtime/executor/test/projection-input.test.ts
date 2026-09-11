// Only model responses are scripted. The official Harness loop/compaction and file reads are real.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';
import { project } from '../src/project';

const spec = PHASE0_ROSTER.find((role) => role.role === 'CODER');
if (!spec) throw new Error('Missing CODER fixture');

function assignedView(taskId: string, title: string) {
  return project(
    {
      ...createInitialAppState(taskId, title),
      subtasks: [
        { id: 'assigned', title, ownerRole: 'CODER', dependsOn: [], status: 'in_progress' },
      ],
    },
    'CODER',
    PHASE0_ROSTER,
  );
}

class ToolReader extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  summaries = 0;
  constructor(
    private readonly reads: number,
    private readonly contextWindow = 65536,
  ) {
    super();
  }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: this.contextWindow } };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const summary = JSON.stringify(options.messages).includes(
      'You are now acting as a compaction engine',
    );
    if (summary) this.summaries++;
    else this.calls.push(structuredClone(options));
    if (!summary && this.calls.length <= this.reads) {
      const id = CallId(`read-${this.calls.length}`);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'read_probe', argumentsDelta: '{}' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'read_probe', arguments: '{}' },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const text = summary ? 'Earlier file reads succeeded. Continue the remaining work.' : 'Done';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function fixture(reads: number, content = 'Observed file result.', contextWindow = 65536) {
  if (!spec) throw new Error('Missing CODER fixture');
  const root = await mkdtemp(join(tmpdir(), 'agora-projection-input-'));
  const file = join(root, 'probe.txt');
  await writeFile(file, content);
  const adapter = new ToolReader(reads, contextWindow);
  const executor = new HarnessExecutor(spec, {
    adapter,
    allowTools: ['read_probe'],
    tools: [
      {
        name: 'read_probe',
        description: 'Read the fixture file.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        execute: () => readFile(file, 'utf8'),
      },
    ],
  });
  return {
    adapter,
    executor,
    async dispose() {
      await executor.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('keeps the current projection in system context without reissuing user instructions after tools', async () => {
  const f = await fixture(3);
  const goal = 'Preserve literal {{unregistered_variable}} in the current assignment';
  const view = assignedView('projection-wire', goal);
  expect(JSON.stringify(view)).toContain(goal);
  try {
    await f.executor.step({ sessionId: 'projection-wire', view });
    expect(f.adapter.calls).toHaveLength(4);
    for (let index = 0; index < f.adapter.calls.length; index++) {
      const call = f.adapter.calls[index];
      expect(call?.system).toContain(JSON.stringify(view));
      expect(call?.system?.split(JSON.stringify(view))).toHaveLength(2);
      expect(JSON.stringify(call?.messages)).not.toContain(goal);
      const inputs = call?.messages.filter(
        (message) =>
          message.role === 'user' && message.content.some((block) => block.type === 'text'),
      );
      expect(inputs).toHaveLength(1);
      const results = call?.messages
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'tool-result');
      expect(results?.map((result) => result.toolCallId)).toEqual(
        Array.from({ length: index }, (_, n) => `read-${n + 1}`),
      );
      for (const result of results ?? [])
        expect(result.content).toEqual([{ type: 'text', text: 'Observed file result.' }]);
    }
  } finally {
    await f.dispose();
  }
});

it('replaces the authoritative system projection on the next turn after injectInbox', async () => {
  const f = await fixture(0);
  const first = assignedView('projection-update', 'old assignment');
  const latest = assignedView('projection-update', 'latest assignment');
  try {
    await f.executor.step({ sessionId: 'projection-update', view: first });
    f.executor.injectInbox(latest);
    await f.executor.step({ sessionId: 'projection-update', view: first });
    expect(f.adapter.calls[0]?.system).toContain(JSON.stringify(first));
    expect(f.adapter.calls[1]?.system).toContain(JSON.stringify(latest));
    expect(f.adapter.calls[1]?.system).not.toContain('old assignment');
  } finally {
    await f.dispose();
  }
});

it('preserves the full current projection after official automatic pressure compaction', async () => {
  const f = await fixture(4, 'Large tool evidence line.\n'.repeat(900), 16000);
  const view = assignedView('projection-pressure', 'authoritative goal after compaction');
  try {
    const result = await f.executor.step({ sessionId: 'projection-pressure', view });
    expect(result.output).toEqual({ text: 'Done' });
    expect(f.adapter.summaries).toBeGreaterThan(0);
    expect(f.adapter.calls).toHaveLength(5);
    for (const call of f.adapter.calls) expect(call.system).toContain(JSON.stringify(view));
    expect(JSON.stringify(f.adapter.calls.at(-1)?.messages)).toContain(
      'Earlier file reads succeeded.',
    );
  } finally {
    await f.dispose();
  }
});
