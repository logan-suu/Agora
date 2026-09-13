// Only external model replies and their timing are scripted. Production Harness,
// tools, projections, pause barriers, validation and persistence remain real.
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect } from 'vitest';
import { projectedInputText } from '../../evals/core/projected-input';

export function barrier() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, enter, release, released };
}

export const EXIT_GOAL =
  'Build three modules: A exports a price, B exports a fee, C combines A and B. Use an explicit parallel executionPlan.';
export const EXIT_FEEDBACK = 'Preserve inherited tests and add an independent sum regression.';
const plan = {
  version: 1,
  subtasks: [
    { id: 'A', title: 'Export a from a.mjs', dependsOn: [] },
    { id: 'B', title: 'Export b from b.mjs', dependsOn: [] },
    { id: 'C', title: 'Export sum from c.mjs', dependsOn: ['A', 'B'] },
  ],
};
export const requirements = [
  { id: 'price', story: 'A exports price 2.', acceptance: ['a equals 2.'], nonGoals: [] },
  {
    id: 'sum',
    story: 'B exports 3; C combines A and B.',
    acceptance: ['sum equals 5.'],
    nonGoals: [],
  },
];
export type ExitView = {
  role: string;
  slices: {
    leaderInput?: { text: string; requirements: typeof requirements };
    currentRequirements?: typeof requirements;
    completionFeedback?: { rationale: string; resumed: boolean };
    assignment?: {
      workerId: string;
      subtaskId?: string;
      subtaskIds: string[];
      completedSubtaskIds: string[];
      validationDispatchId?: string;
    };
    validationScope?: {
      currentSubtasks: { subtaskId: string }[];
      completedSubtasks: { subtaskId: string }[];
      deferredSubtasks: { subtaskId: string }[];
    };
    activeWave?: { subtaskIds: string[] };
  };
};
type Action = { tool: string; args: Record<string, unknown> };

export class ExitAdapter extends LlmAdapter {
  readonly coders = barrier();
  readonly validation = barrier();
  readonly review = barrier();
  readonly views: ExitView[] = [];
  readonly firstCoders = new Set<string>();
  interpretations = 0;
  reviews = 0;
  observedRuns = 0;
  private heldValidation = false;
  private heldReview = false;
  private calls = 0;

  releaseAll() {
    this.coders.release();
    this.validation.release();
    this.review.release();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const view = JSON.parse(projectedInputText(options)) as ExitView;
    this.views.push(structuredClone(view));
    if (view.slices.leaderInput) {
      this.interpretations++;
      expect(options.tools ?? []).toHaveLength(0);
      const current = view.slices.leaderInput.requirements;
      const changePrice = view.slices.leaderInput.text.includes('4');
      yield* textChunks(
        JSON.stringify({
          kind: 'proposal',
          summary: 'Review both related requirements.',
          changes: current.map((r) => ({
            requirementId: r.id,
            requirement: {
              story: changePrice && r.id === 'price' ? 'A exports price 4.' : r.story,
              acceptance: changePrice
                ? [r.id === 'price' ? 'a equals 4.' : 'sum equals 7.']
                : [...r.acceptance, 'Retain the established module contract.'],
              nonGoals: r.nonGoals,
            },
          })),
        }),
      );
      return;
    }
    if (view.role === 'PM') {
      yield* textChunks(JSON.stringify(requirements));
      return;
    }
    if (view.role === 'ARCHITECT') {
      yield* textChunks(JSON.stringify({ architecture: { executionPlan: plan }, conventions: {} }));
      return;
    }
    const assignment = view.slices.assignment;
    if (!assignment) throw new Error('Missing production assignment');
    const completed = options.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool-result').length;
    if (view.role === 'CODER' && completed === 0 && this.firstCoders.size < 2) {
      this.firstCoders.add(assignment.workerId);
      if (this.firstCoders.size === 2) this.coders.enter();
      await this.coders.released;
    }
    if (view.role === 'TESTER' && completed === 0 && !this.heldValidation) {
      this.heldValidation = true;
      this.validation.enter();
      await this.validation.released;
    }
    if (view.role === 'REVIEWER' && !this.heldReview) {
      this.heldReview = true;
      this.review.enter();
      await this.review.released;
    }
    const price = view.slices.currentRequirements
      ?.find((r) => r.id === 'price')
      ?.acceptance.includes('a equals 4.')
      ? 4
      : 2;
    const actions: Action[] = [];
    if (view.role === 'CODER') {
      expect(assignment.subtaskIds).toEqual([assignment.subtaskId]);
      const id = assignment.subtaskId;
      const filename = `${id?.toLowerCase()}.mjs`;
      // The first natural Step permits a control update before any business write.
      actions.push({ tool: 'sandbox_run', args: { cmd: 'node -e "console.log(\'ready\')"' } });
      if (id === 'C')
        actions.push(
          { tool: 'fs_read', args: { path: 'a.mjs' } },
          { tool: 'fs_read', args: { path: 'b.mjs' } },
        );
      actions.push(
        {
          tool: 'fs_write',
          args: {
            path: filename,
            content:
              id === 'A'
                ? `export const a = ${price};\n`
                : id === 'B'
                  ? 'export const b = 3;\n'
                  : "import {a} from './a.mjs'; import {b} from './b.mjs'; export const sum = a + b;\n",
          },
        },
        {
          tool: 'sandbox_run',
          args: {
            cmd: `node --input-type=module -e "import('./${filename}').then(v=>console.log(JSON.stringify(v)))"`,
          },
        },
        { tool: 'git_applyPatch', args: { patch: '' } },
      );
    } else if (view.role === 'TESTER') {
      const ids = [...assignment.subtaskIds, ...assignment.completedSubtaskIds];
      const includesC = ids.includes('C');
      expect(view.slices.validationScope).toBeDefined();
      const path = `acceptance-${assignment.validationDispatchId}.test.mjs`;
      const source = `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {a} from './a.mjs'; import {b} from './b.mjs'; ${includesC ? "import {sum} from './c.mjs';" : ''}\ntest('price',()=>assert.equal(a,${price})); test('fee',()=>assert.equal(b,3)); ${includesC ? `test('sum',()=>assert.equal(sum,${price + 3}));` : ''}\n`;
      actions.push(
        { tool: 'fs_write', args: { path, content: source } },
        { tool: 'sandbox_run', args: { cmd: `node --test --test-reporter=tap '${path}'` } },
        { tool: 'git_applyPatch', args: { patch: '' } },
      );
    } else if (view.role === 'REVIEWER') actions.push({ tool: 'fs_read', args: { path: 'c.mjs' } });
    if (completed > 0) {
      const previous = actions[completed - 1];
      if (!previous) throw new Error('Unexpected tool result');
      const value = lastToolResult(options, previous.tool);
      if (previous.tool === 'sandbox_run') {
        expect(value).toMatchObject({ exitCode: 0, timedOut: false });
        expect((value as { stdout: string }).stdout).not.toBe('');
        this.observedRuns++;
      } else if (previous.tool === 'fs_read') expect(JSON.stringify(value)).toContain('export');
      else if (previous.tool === 'git_applyPatch')
        expect(JSON.stringify(value)).toMatch(/[a-f0-9]{40}/);
    }
    const action = actions[completed];
    if (action) {
      yield* toolChunks(action, CallId(`exit-call-${++this.calls}`));
      return;
    }
    yield* textChunks(
      view.role === 'REVIEWER'
        ? JSON.stringify([
            {
              id: `exit-review-${++this.reviews}`,
              kind: 'verdict',
              verdict: 'approved',
              summary: 'Reviewed the current cumulative artifact.',
            },
          ])
        : 'Completed the assignment using verified tool results.',
    );
  }
}

function lastToolResult(options: GenerateOptions, name: string): unknown {
  const blocks = options.messages.flatMap((m) => m.content);
  const call = blocks.filter((b) => b.type === 'tool-call' && b.name === name).at(-1);
  if (call?.type !== 'tool-call') throw new Error('Missing tool call');
  const result = blocks.find((b) => b.type === 'tool-result' && b.toolCallId === call.id);
  if (result?.type !== 'tool-result') throw new Error('Missing tool result');
  expect(result.isError).not.toBe(true);
  const text = result.content.find((b) => b.type === 'text');
  if (text?.type !== 'text') throw new Error('Missing result text');
  return JSON.parse(text.text);
}
function* textChunks(text: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
function* toolChunks(action: Action, id: CallId): Iterable<StreamChunk> {
  const args = JSON.stringify(action.args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name: action.tool, argumentsDelta: args };
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id, name: action.tool, arguments: args },
  };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
