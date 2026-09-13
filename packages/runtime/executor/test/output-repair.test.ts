// The scripted provider isolates malformed model output; the real Harness loop,
// projection hook, tool restrictions and turn boundaries remain under test.
import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import {
  architectTurnMutations,
  DEFAULT_ROSTER,
  SIX_ROLE_FORMAT_REPAIR,
} from '@agora/roles-definitions';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { describe, expect, it, vi } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';
import { project } from '../src/project';

class Replies extends LlmAdapter {
  calls: GenerateOptions[] = [];
  onFinish?: () => void;
  constructor(private readonly replies: string[]) {
    super();
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    const text = this.replies[this.calls.length - 1] ?? 'still invalid';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    this.onFinish?.();
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const spec = PHASE0_ROSTER.find((r) => r.role === 'CODER');
if (!spec) throw new Error('missing CODER');
const context = {
  sessionId: 'output-repair',
  view: project(createInitialAppState('repair', 'projected goal'), 'CODER', PHASE0_ROSTER),
};
const validate = ({ text }: { text: string | null }) => {
  JSON.parse(text ?? '');
};

describe('bounded structured output repair', () => {
  it('carries the role contract into repair of nested conventions without changing their values', async () => {
    const architect = DEFAULT_ROSTER.find((role) => role.role === 'ARCHITECT');
    if (!architect) throw new Error('missing ARCHITECT');
    const architecture = {
      modules: [{ id: 'A', file: 'answer.mjs' }],
      executionPlan: { version: 1, subtasks: [{ id: 'A', title: 'Answer', dependsOn: [] }] },
    };
    const conventions = { runtime: 'Node', rationale: 'Keep the existing decision.' };
    const bad = JSON.stringify({ architecture: { ...architecture, conventions } });
    const good = JSON.stringify({ architecture, conventions });
    const adapter = new Replies([bad, good]);
    const reader = vi.fn(({ text }: { text: string | null }) => architectTurnMutations(text));
    const executor = new HarnessExecutor(architect, {
      adapter,
      outputFormatHint: SIX_ROLE_FORMAT_REPAIR.ARCHITECT ?? '',
      validateTurnOutput: ({ text }) => {
        architectTurnMutations(text);
      },
      readTurnMutations: reader,
    });
    try {
      const result = await executor.step({ ...context, view: { role: 'ARCHITECT', slices: {} } });
      expect(adapter.calls).toHaveLength(2);
      const repair = JSON.stringify(adapter.calls[1]?.messages.at(-1));
      expect(repair).toContain('architecture.conventions');
      expect(repair).toContain('top-level');
      expect(adapter.calls[1]?.tools ?? []).toEqual([]);
      expect(reader).toHaveBeenCalledExactlyOnceWith({ text: good });
      expect(result.mutations).toContainEqual({
        op: 'set',
        field: 'conventions',
        value: conventions,
      });
      expect(result.mutations).toContainEqual({
        op: 'set',
        field: 'architecture',
        value: architecture,
      });
    } finally {
      await executor.dispose();
    }
  });
  it('repairs a misplaced architecture plan before publishing or reading mutations', async () => {
    const architect = DEFAULT_ROSTER.find((role) => role.role === 'ARCHITECT');
    if (!architect) throw new Error('missing ARCHITECT');
    const plan = { version: 1, subtasks: [{ id: 'A', title: 'Implement module', dependsOn: [] }] };
    const modules = [{ id: 'A', file: 'module.mjs' }];
    const bad = JSON.stringify({ architecture: { modules }, conventions: {}, executionPlan: plan });
    const architecture = { modules, executionPlan: plan };
    const good = JSON.stringify({ architecture, conventions: {} });
    const adapter = new Replies([bad, good]);
    const reader = vi.fn(({ text }: { text: string | null }) => architectTurnMutations(text));
    const executor = new HarnessExecutor(architect, {
      adapter,
      validateTurnOutput: ({ text }) => {
        architectTurnMutations(text);
      },
      readTurnMutations: reader,
      tools: [
        {
          name: 'inspect',
          description: 'inspect',
          parameters: {},
          output: { schema: {}, render: () => [] },
          execute: async () => ({ ok: true }),
        },
      ],
      allowTools: ['inspect'],
    });
    try {
      const result = await executor.step({
        sessionId: 'architecture-output-repair',
        view: project(
          createInitialAppState('repair-plan', 'Implement module'),
          'ARCHITECT',
          DEFAULT_ROSTER,
        ),
      });
      expect(adapter.calls).toHaveLength(2);
      expect(adapter.calls[0]?.tools?.map((tool) => tool.name)).toContain('inspect');
      expect(adapter.calls[1]?.tools ?? []).toEqual([]);
      expect(JSON.stringify(adapter.calls[1]?.messages)).toContain('output-format-repair');
      expect(reader).toHaveBeenCalledExactlyOnceWith({ text: good });
      expect(result.output).toEqual({ text: good });
      expect(result.mutations).toContainEqual({
        op: 'set',
        field: 'architecture',
        value: architecture,
      });
      expect(JSON.stringify(result.mutations)).not.toContain(bad);
    } finally {
      await executor.dispose();
    }
  });
  it.each(['Explanation before JSON {"ok":true}', '{"regex":"/\\s+/g"}'])(
    'regenerates invalid syntax in the official turn without publishing the rejected candidate: %s',
    async (bad) => {
      const adapter = new Replies([bad, '{"ok":true}']);
      const reader = vi.fn(() => []);
      const executor = new HarnessExecutor(spec, {
        adapter,
        validateTurnOutput: validate,
        readTurnMutations: reader,
      });
      try {
        const result = await executor.step(context);
        expect(adapter.calls).toHaveLength(2);
        expect(reader).toHaveBeenCalledExactlyOnceWith({ text: '{"ok":true}' });
        expect(result.output).toEqual({ text: '{"ok":true}' });
        expect(result.mutations).toHaveLength(1);
        const repairInput = JSON.stringify(adapter.calls[1]?.messages);
        expect(adapter.calls[1]?.system).toContain(JSON.stringify(context.view));
        expect(repairInput).not.toContain(JSON.stringify(context.view));
        expect(repairInput).toContain('output-format-repair');
        expect(JSON.stringify(result.mutations)).not.toContain(bad);
      } finally {
        await executor.dispose();
      }
    },
  );
  it('allows only two additional requests and leaves the final invalid output rejected', async () => {
    const adapter = new Replies(['bad1', 'bad2', 'bad3']);
    const reader = vi.fn(({ text }: { text: string | null }) => {
      validate({ text });
      return [];
    });
    const executor = new HarnessExecutor(spec, {
      adapter,
      validateTurnOutput: validate,
      readTurnMutations: reader,
    });
    try {
      await expect(executor.step(context)).rejects.toThrow();
      expect(adapter.calls).toHaveLength(3);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });
  it('does not replay side effects or rewrite objection controls as ordinary structured output', async () => {
    const adapter = new Replies([
      '<agora-objection>{"claim":"contradiction"</argument></agora-objection>',
      '{}',
    ]);
    const reader = vi.fn(() => []);
    const executor = new HarnessExecutor(spec, {
      adapter,
      validateTurnOutput: validate,
      readTurnMutations: reader,
    });
    try {
      await expect(executor.step(context)).rejects.toThrow('invalid agora objection');
      expect(adapter.calls).toHaveLength(1);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });
  it('removes tools for correction requests and restores the original grant on the next turn', async () => {
    const adapter = new Replies(['bad', '{}', '{}']);
    const executor = new HarnessExecutor(spec, {
      adapter,
      validateTurnOutput: validate,
      tools: [
        {
          name: 'inspect',
          description: 'inspect',
          parameters: {},
          output: { schema: {}, render: () => [] },
          execute: async () => ({ ok: true }),
        },
      ],
      allowTools: ['inspect'],
    });
    try {
      await executor.step(context);
      await executor.step(context);
      expect(adapter.calls[0]?.tools?.map((t) => t.name)).toContain('inspect');
      expect(adapter.calls[1]?.tools ?? []).toEqual([]);
      expect(adapter.calls[2]?.tools?.map((t) => t.name)).toContain('inspect');
    } finally {
      await executor.dispose();
    }
  });
  it('rejects an empty new turn instead of accepting the preceding successful message', async () => {
    const adapter = new Replies(['{}', '', '', '']);
    const executor = new HarnessExecutor(spec, { adapter, validateTurnOutput: validate });
    try {
      await executor.step(context);
      await expect(executor.step(context)).rejects.toThrow();
      expect(adapter.calls).toHaveLength(4);
    } finally {
      await executor.dispose();
    }
  });
  it('lets a requested safe point close the turn without starting a correction request', async () => {
    const adapter = new Replies(['bad', '{}']);
    const reader = vi.fn(() => []);
    const executor = new HarnessExecutor(spec, {
      adapter,
      validateTurnOutput: validate,
      readTurnMutations: reader,
    });
    adapter.onFinish = () => executor.requestSafePoint();
    try {
      const result = await executor.step(context);
      expect(result.kind).toBe('tool');
      expect(result.mutations).toEqual([]);
      expect(adapter.calls).toHaveLength(1);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });
});

it.each([
  [
    'objection',
    '<agora-objection>{"claim":"contradiction","target":{"kind":"requirement","id":"req-1"},"argument":"Conflicting requirements."}</agora-objection>',
  ],
  [
    'channelAction',
    '<agora-channel-action>{"kind":"close_sub_channel","channelId":"sub-a"}</agora-channel-action>',
  ],
])(
  'returns valid %s controls without ordinary validation or the handoff reader',
  async (key, reply) => {
    const adapter = new Replies([reply]);
    const validator = vi.fn(validate);
    const reader = vi.fn(({ text }: { text: string | null }) => {
      validate({ text });
      return [];
    });
    const testReader = vi.fn(async () => undefined);
    const executor = new HarnessExecutor(spec, {
      adapter,
      validateTurnOutput: validator,
      readTurnMutations: reader,
      readTestResults: testReader,
    });
    try {
      const result = await executor.step(context);
      expect(result.output[key]).toBeDefined();
      expect(result.mutations).toHaveLength(1);
      expect(result.mutations[0]).toMatchObject({
        op: 'append',
        field: 'messages',
        value: {
          payload: {
            [key]: JSON.parse(reply.slice(reply.indexOf('>') + 1, reply.lastIndexOf('<'))),
          },
        },
      });
      expect(adapter.calls).toHaveLength(1);
      expect(validator).not.toHaveBeenCalled();
      expect(reader).not.toHaveBeenCalled();
      expect(testReader).toHaveBeenCalledTimes(1);
    } finally {
      await executor.dispose();
    }
  },
);

it('preserves file-backed test evidence when TESTER also emits a valid advisory', async () => {
  const sandbox = new LocalTempSandbox(),
    worktree = await sandbox.createWorktree('control-test-evidence', 'TESTER');
  const evidence = {
    passed: false,
    total: 52,
    failed: 1,
    failures: [{ file: 'probe.test.ts', message: 'capacity invariant violated' }],
  };
  await sandbox.write(worktree, 'test-results.json', JSON.stringify(evidence));
  const tester = PHASE0_ROSTER.find((role) => role.role === 'TESTER');
  if (!tester) throw Error('missing TESTER');
  const adapter = new Replies([
    '<agora-objection>{"claim":"concern","argument":"The implementation fails a capacity probe."}</agora-objection>',
  ]);
  const executor = new HarnessExecutor(tester, {
    adapter,
    readTestResults: async () => JSON.parse(await sandbox.read(worktree, 'test-results.json')),
  });
  try {
    const result = await executor.step({ ...context, view: { role: 'TESTER', slices: {} } });
    expect(result.output.objection).toMatchObject({ claim: 'concern' });
    expect(result.mutations).toContainEqual({ op: 'set', field: 'testResults', value: evidence });
    expect(adapter.calls).toHaveLength(1);
  } finally {
    await executor.dispose();
    await sandbox.teardown('control-test-evidence');
  }
});
