// Only external LLM output is scripted; every tool result comes from the real runtime.
import assert from 'node:assert/strict';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { acceptanceSource, GOAL, IMPLEMENTATIONS, PLAN } from '../fixtures/phase9/contract';

type Action = { name: string; args: Record<string, unknown> };
export class WideFixtureAdapter extends LlmAdapter {
  private sequence = 0;
  private first = new Set<string>();
  private release!: () => void;
  private overlap = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  constructor(private readonly cap: number) {
    super();
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const block = options.messages[0]?.content.find((entry) => entry.type === 'text');
    assert(block?.type === 'text');
    const view = JSON.parse(block.text);
    if (view.role === 'PM') {
      yield* text(JSON.stringify([{ id: 'R', story: GOAL, acceptance: [GOAL], nonGoals: [] }]));
      return;
    }
    if (view.role === 'ARCHITECT') {
      yield* text(JSON.stringify({ architecture: { executionPlan: PLAN }, conventions: {} }));
      return;
    }
    const assignment = view.slices.assignment;
    assert(assignment, 'missing canonical assignment');
    const results = options.messages
      .flatMap((message) => message.content)
      .filter((entry) => entry.type === 'tool-result');
    const completed = results.length;
    const actions: Action[] = [];
    if (view.role === 'CODER') {
      const implementation = IMPLEMENTATIONS[assignment.subtaskId];
      assert(implementation);
      if (completed === 0 && assignment.subtaskId !== 'E') {
        this.first.add(assignment.subtaskId);
        if (this.first.size >= this.cap) this.release();
        await this.overlap;
      }
      actions.push(
        {
          name: 'fs_write',
          args: { path: implementation.file, content: `${implementation.source}\n` },
        },
        {
          name: 'sandbox_run',
          args: {
            cmd: `node --input-type=module -e "import('./${implementation.file}').then(()=>console.log('module loaded'))"`,
          },
        },
        { name: 'git_applyPatch', args: { patch: '' } },
      );
    } else if (view.role === 'TESTER') {
      const path = `acceptance-${assignment.validationDispatchId}.test.mjs`;
      actions.push(
        {
          name: 'fs_write',
          args: {
            path,
            content: acceptanceSource([
              ...assignment.subtaskIds,
              ...assignment.completedSubtaskIds,
            ]),
          },
        },
        { name: 'sandbox_run', args: { cmd: `node --test --test-reporter=tap '${path}'` } },
        { name: 'git_applyPatch', args: { patch: '' } },
      );
    } else if (view.role === 'REVIEWER')
      actions.push({ name: 'fs_read', args: { path: 'pipeline.mjs' } });
    else throw new Error(`unexpected role ${view.role}`);
    if (completed > 0) {
      const previous = actions[completed - 1];
      assert(previous);
      const result = results[completed - 1];
      assert(result?.type === 'tool-result');
      const block = result.content.find((entry) => entry.type === 'text');
      assert(block?.type === 'text');
      const value = JSON.parse(block.text);
      if (previous.name === 'sandbox_run') {
        assert.equal(value.exitCode, 0);
        assert.equal(value.timedOut, false);
        assert(value.stdout.length > 0);
      } else if (previous.name === 'git_applyPatch')
        assert.match(JSON.stringify(value), /[a-f0-9]{40}/);
      else if (previous.name === 'fs_read') assert.match(JSON.stringify(value), /processRecords/);
      else assert.equal(value.ok, true);
    }
    const action = actions[completed];
    if (action) {
      yield* tool(action, CallId(`wide-${++this.sequence}`));
      return;
    }
    yield* text(
      view.role === 'REVIEWER'
        ? JSON.stringify([
            {
              id: `wide-review-${++this.sequence}`,
              kind: 'verdict',
              verdict: 'approved',
              summary: 'Reviewed the cumulative tested pipeline.',
            },
          ])
        : 'Completed using the observed tool results.',
    );
  }
}
function* text(value: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: value };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
function* tool(action: Action, id: CallId): Iterable<StreamChunk> {
  const args = JSON.stringify(action.args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: args };
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id, name: action.name, arguments: args },
  };
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
