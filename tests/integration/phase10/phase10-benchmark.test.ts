// Script only the external LLM: real Harness, MCP, Docker, Git, State and D16 remain in use.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Dockerode } from '@agora/runtime-sandbox';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { projectedInputText } from '../../evals/core/projected-input';
import type { EvalCleanup, EvalExecutionContext } from '../../evals/core/runner';
import { GOAL } from '../../evals/fixtures/phase9/contract';
import { HOLDOUTS } from '../../evals/fixtures/phase10/holdout';
import { WideFixtureAdapter } from '../../evals/phase9/scripted-adapter';
import { BudgetLedger } from '../../evals/phase10/final/accounting';
import { FormalGuard, GuardedFormalMeter } from '../../evals/phase10/final/formal-guard';
import { runMulti } from '../../evals/phase10/final/multi-driver';
import { PUBLIC_REVISION, publicFiles, sha256 } from '../../evals/phase10/final/public-adapter';
import { runSingle } from '../../evals/phase10/final/single-driver';
import { readPublicTaskSeed, taskDefinition } from '../../evals/phase10/final/tasks';

async function context() {
  const runRoot = await mkdtemp(join(tmpdir(), 'agora105-driver-'));
  const dataRoot = join(runRoot, 'data'),
    workspaceRoot = join(runRoot, 'workspace');
  await mkdir(dataRoot);
  await mkdir(workspaceRoot);
  const cleanups: EvalCleanup[] = [];
  const ctx: EvalExecutionContext = {
    runRoot,
    dataRoot,
    workspaceRoot,
    registerCleanup: (fn) => cleanups.push(fn),
  };
  return {
    ctx,
    cleanup: async () => {
      const errors: unknown[] = [];
      for (const fn of cleanups.reverse())
        try {
          await fn();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length) throw new AggregateError(errors, 'driver cleanup failed');
    },
  };
}
const docker = new Dockerode({
  socketPath: join(process.env.HOME ?? '', '.docker/run/docker.sock'),
});

it('benchmark multi driver binds actual parallel validation and resumes completion without reopening done workers', async () => {
  const { ctx, cleanup } = await context();
  try {
    const flow = await runMulti({
      context: ctx,
      docker,
      image: 'node:20-slim',
      goal: GOAL,
      seed: { 'README.md': 'Deterministic driver diagnostic; not a holdout.\n' },
      variant: 'parallel',
      adapter: new WideFixtureAdapter(3),
      background: [
        'Preserve cumulative tests.',
        'Use independent modules.',
        'Keep the fixed DAG.',
        'Use the formal completion gate.',
      ],
    });
    expect(flow.evidence.completed).toBe(true);
    expect(flow.evidence.completionBound).toBe(true);
    expect(flow.evidence.gateLeaseCount).toBe(0);
    expect(flow.evidence.resumeCompositions).toBe(1);
    expect(flow.evidence.plannedWorkerResumes).toBe(0);
    expect(flow.evidence.forks).toBe(0);
    expect(flow.evidence.waves).toEqual([['A', 'B', 'C', 'D'], ['E']]);
    expect(flow.evidence.projections.some((p) => p.resumed)).toBe(false);
  } finally {
    await cleanup();
  }
}, 180_000);

class SingleFixture extends LlmAdapter {
  calls = 0;
  sessions: (string | undefined)[] = [];
  constructor(private readonly readContract = false) {
    super();
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++;
    expect(options.tools?.find((t) => t.name === 'git_applyPatch')?.description).toContain(
      'Use {"patch":""}',
    );
    this.sessions.push(options.sessionId);
    const results = options.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool-result');
    const actions = [
      ...(this.readContract ? [{ name: 'fs_read', args: { path: 'answer.spec.txt' } }] : []),
      { name: 'fs_write', args: { path: 'answer.mjs', content: 'export const answer = 42;\n' } },
      {
        name: 'sandbox_run',
        args: {
          cmd: "node --input-type=module -e \"import('./answer.mjs').then(m=>{if(m.answer!==42)throw Error('bad');console.log(m.answer)})\"",
        },
      },
      { name: 'git_applyPatch', args: { patch: '' } },
    ];
    if (results.length) {
      const result = results.at(-1);
      const text = result?.content.find((b) => b.type === 'text');
      expect(text?.type).toBe('text');
      if (this.readContract && results.length === 1 && text?.type === 'text')
        expect(text.text).toContain('public-contract-marker');
      if (results.length === (this.readContract ? 3 : 2) && text?.type === 'text')
        expect(JSON.parse(text.text).exitCode).toBe(0);
    }
    const action = actions[results.length];
    if (action) {
      const args = JSON.stringify(action.args),
        id = CallId(`single-${this.calls}`);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: args };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: action.name, arguments: args },
      };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Verified 42.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Verified 42.' } };
    }
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
it('benchmark single driver runs one real tool-using Harness solver without a product gate', async () => {
  const { ctx, cleanup } = await context();
  const adapter = new SingleFixture();
  try {
    const flow = await runSingle({
      context: ctx,
      docker,
      image: 'node:20-slim',
      goal: 'Export answer = 42 from answer.mjs and verify it.',
      seed: { 'README.md': 'Independent solver diagnostic.\n' },
      adapter,
    });
    expect(flow.completed).toBe(true);
    expect(adapter.calls).toBe(4);
    expect(adapter.sessions.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  } finally {
    await cleanup();
  }
}, 60_000);

it('benchmark public test contracts are readable through the real solver filesystem tools', async () => {
  const { ctx, cleanup } = await context();
  const adapter = new SingleFixture(true);
  try {
    const flow = await runSingle({
      context: ctx,
      docker,
      image: 'node:20-slim',
      goal: 'Read answer.spec.txt, then implement answer.mjs and verify it.',
      seed: { 'answer.spec.txt': "test('public-contract-marker',()=>expect(answer).toBe(42));\n" },
      adapter,
    });
    expect(flow.completed).toBe(true);
    expect(adapter.calls).toBe(5);
  } finally {
    await cleanup();
  }
}, 60_000);

it('benchmark public Jest contracts survive real multi-role Node validation without being executed', async () => {
  const { ctx, cleanup } = await context();
  const sources = join(ctx.runRoot, 'synthetic-upstream');
  const contract = "xtest('public-contract-marker',()=>expect(answer()).toBe(42));\n";
  const files = [];
  for (const entry of publicFiles('wordy')) {
    const content = entry.path === 'wordy.spec.js' ? contract : 'Synthetic upstream metadata.\n';
    const file = join(sources, 'wordy', entry.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    files.push({ ...entry, sha256: sha256(content) });
  }
  await writeFile(
    join(sources, 'wordy/source-manifest.json'),
    JSON.stringify({ name: 'wordy', revision: PUBLIC_REVISION, files }),
  );
  const definition = await readPublicTaskSeed('wordy', sources);
  try {
    const flow = await runMulti({
      context: ctx,
      docker,
      image: 'node:20-slim',
      goal: GOAL,
      seed: definition.seed,
      variant: 'multi',
      adapter: new WideFixtureAdapter(1),
    });
    expect(flow.evidence.completed).toBe(true);
    expect(flow.evidence.completionBound).toBe(true);
    expect(await readFile(join(flow.artifact, 'wordy.spec.txt'), 'utf8')).toBe(
      contract.replace('xtest(', 'test('),
    );
    expect(await readFile(join(sources, 'wordy/wordy.spec.js'), 'utf8')).toBe(contract);
  } finally {
    await cleanup();
  }
}, 180_000);

it('benchmark sparse projection and a real coding-boundary requirement update preserve the canonical pipeline', async () => {
  const { ctx, cleanup } = await context();
  try {
    const flow = await runMulti({
      context: ctx,
      docker,
      image: 'node:20-slim',
      goal: GOAL,
      seed: { 'README.md': 'Control seam diagnostic, not a holdout.\n' },
      variant: 'sparse',
      adapter: new WideFixtureAdapter(1),
      background: [
        'Only assigned modules may be changed.',
        'Use Node built-in tests.',
        'Keep normalization immutable.',
        'Preserve cumulative tests.',
      ],
      requirementUpdate:
        '/requirement diagnostic ' +
        JSON.stringify({
          story: 'Preserve all input data while producing the documented pipeline output.',
          acceptance: ['Every public function must leave inputs unchanged.'],
          nonGoals: ['No API or DAG changes.'],
        }),
    });
    expect(flow.evidence.requirementSubmitted).toBe(true);
    expect(flow.evidence.requirementApplied).toBe(true);
    expect(flow.evidence.projections.some((p) => p.changed && p.afterChars < p.beforeChars)).toBe(
      true,
    );
    expect(flow.evidence.completed).toBe(true);
  } finally {
    await cleanup();
  }
}, 180_000);

class RoutedWideFixture extends WideFixtureAdapter {
  readonly routes = new Set<string>();
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const role: string = JSON.parse(projectedInputText(options)).role;
    const expected = ['PM', 'ARCHITECT', 'REVIEWER'].includes(role)
      ? 'deepseek-flash'
      : 'deepseek-v4-flash';
    expect(options.model).toBe(expected);
    this.routes.add(`${role}:${options.model}`);
    yield* super.stream(options);
  }
}
it('benchmark mixed roster routes the real production Harness requests by their projected role', async () => {
  const { ctx, cleanup } = await context();
  const adapter = new RoutedWideFixture(1);
  try {
    const flow = await runMulti({
      context: ctx,
      docker,
      image: 'node:20-slim',
      goal: GOAL,
      seed: { 'README.md': 'Role-routing diagnostic, not a holdout.\n' },
      variant: 'mixed',
      adapter,
    });
    expect(flow.evidence.completed).toBe(true);
    expect([...adapter.routes].sort()).toEqual([
      'ARCHITECT:deepseek-flash',
      'CODER:deepseek-v4-flash',
      'PM:deepseek-flash',
      'REVIEWER:deepseek-flash',
      'TESTER:deepseek-v4-flash',
    ]);
  } finally {
    await cleanup();
  }
}, 180_000);

// Only the external model response is scripted; the advisory is committed by the real worker runtime.
class AdvisoryFixture extends WideFixtureAdapter {
  advisorySent = false;
  reviewerWorkers = new Set<string>();
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const view = JSON.parse(projectedInputText(options));
    if (view.role === 'REVIEWER') {
      this.reviewerWorkers.add(view.slices.assignment.workerId);
      if (!this.advisorySent) {
        this.advisorySent = true;
        const text =
          '<agora-objection>{"claim":"concern","argument":"Consider naming improvements after this review."}</agora-objection>';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
    }
    if (view.role === 'REVIEWER' && this.advisorySent) {
      expect(view.slices.coordinationContext.instructionOrQuestion).toBe(
        'The advisory has been recorded. Continue the bound review and provide its required verdict.',
      );
    }
    yield* super.stream(options);
  }
}
it('continues a canonical advisory through real Harness, Docker, validation and the final Leader gate', async () => {
  const { ctx, cleanup } = await context();
  const adapter = new AdvisoryFixture(3);
  try {
    const flow = await runMulti({
      context: ctx,
      docker,
      image: 'node:20-slim',
      goal: GOAL,
      seed: { 'README.md': 'Advisory continuation diagnostic; not a holdout.\n' },
      variant: 'parallel',
      adapter,
    });
    expect(adapter.advisorySent).toBe(true);
    expect(adapter.reviewerWorkers.size).toBe(2);
    expect(flow.evidence.completed).toBe(true);
    expect(flow.evidence.completionBound).toBe(true);
    expect(flow.evidence.gateLeaseCount).toBe(0);
    expect(flow.evidence.plannedWorkerResumes).toBe(0);
    expect(flow.evidence.waves).toEqual([['A', 'B', 'C', 'D'], ['E']]);
  } finally {
    await cleanup();
  }
}, 180_000);

// Only the provider is scripted: malformed patches traverse real Harness/MCP/Git/Docker.
it('stops repeated real patch errors before the third provider request and retains a closed failure trace', async () => {
  const { ctx, cleanup } = await context();
  let requests = 0;
  class BadPatchProvider extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      requests++;
      const id = CallId(`bad-patch-${requests}`);
      const args = JSON.stringify({
        patch:
          'diff --git a/bad.txt b/bad.txt\n--- /dev/null\n+++ b/bad.txt\n@@ -0,0 +1,100 @@\n+only one line\n',
      });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'git_applyPatch', argumentsDelta: args };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'git_applyPatch', arguments: args },
      };
      yield {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
      } as StreamChunk;
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      if (requests > 2) throw new Error('unexpected third provider request');
    }
  }
  const budget = new BudgetLedger(join(ctx.runRoot, 'budget.json'), 5, 5);
  const meter = new GuardedFormalMeter(
    budget,
    'patch-failure',
    new FormalGuard(ctx.runRoot),
    new BadPatchProvider(),
  );
  try {
    await expect(
      runSingle({
        context: ctx,
        docker,
        image: 'node:20-slim',
        goal: 'Exercise invalid patch reporting.',
        seed: { 'README.md': 'No model network calls.\n' },
        adapter: meter,
        meter,
      }),
    ).rejects.toThrow();
    expect(requests).toBe(2);
    expect(meter.calls).toHaveLength(2);
    const charges = JSON.parse(await readFile(join(ctx.runRoot, 'budget.json'), 'utf8')).requests;
    expect(charges).toHaveLength(2);
    expect(charges.every((r: { status: string }) => r.status === 'settled')).toBe(true);
    expect(JSON.parse(await readFile(join(ctx.runRoot, 'stop-requested.json'), 'utf8')).trial).toBe(
      'patch-failure',
    );
    const trace = JSON.parse(await readFile(join(ctx.runRoot, 'trace.json'), 'utf8'));
    expect(trace.sessions).toHaveLength(1);
    expect(trace.sessions[0].role).toBe('CODER');
    expect(trace.sessions[0].turns).toHaveLength(1);
    expect(trace.sessions[0].turns[0].endedAt).toBeDefined();
    expect(budget.spent).not.toBe('unknown');
  } finally {
    await cleanup();
  }
}, 60_000);

// Only the model is scripted; real top-level workers share one formal meter.
it('recovers from batched missing-file probes independently across real sessions', async () => {
  const { ctx, cleanup } = await context();
  const probed = new Set<string>(),
    recovered = new Set<string>();
  class ProbeProvider extends WideFixtureAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const view = JSON.parse(projectedInputText(options));
      const session = options.sessionId as string;
      if (view.role === 'CODER' && view.slices.assignment.subtaskId !== 'E') {
        if (!probed.has(session)) {
          probed.add(session);
          for (const [index, path] of ['new-one.mjs', 'new-two.mjs'].entries()) {
            const id = CallId(`probe-${index}`),
              args = JSON.stringify({ path });
            yield { type: 'block-start', index, blockType: 'tool-call' };
            yield { type: 'tool-call-delta', index, id, name: 'fs_read', argumentsDelta: args };
            yield {
              type: 'block-end',
              index,
              block: { type: 'tool-call', id, name: 'fs_read', arguments: args },
            };
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
          } as StreamChunk;
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        const errors = options.messages
          .flatMap((m) => m.content)
          .filter((b) => b.type === 'tool-result' && b.toolCallId.startsWith('probe-'));
        expect(errors).toHaveLength(2);
        expect(errors.every((b) => b.type === 'tool-result' && b.isError)).toBe(true);
        recovered.add(session);
      }
      // The scripted provider excludes its probes only when selecting its next action.
      // The meter and official Harness receive the complete, unmodified tool history.
      const scriptInput = {
        ...options,
        messages: options.messages.map((m) => ({
          ...m,
          content: m.content.filter(
            (b) =>
              !(
                (b.type === 'tool-call' && b.id.startsWith('probe-')) ||
                (b.type === 'tool-result' && b.toolCallId.startsWith('probe-'))
              ),
          ),
        })),
      };
      yield* super.stream(scriptInput);
    }
  }
  const ledger = new BudgetLedger(join(ctx.runRoot, 'budget.json'), 5, 5);
  const meter = new GuardedFormalMeter(
    ledger,
    'independent-probes',
    new FormalGuard(ctx.runRoot),
    new ProbeProvider(3),
  );
  let evidence: { leasePeak: number } | undefined;
  try {
    const flow = await runMulti({
      context: ctx,
      docker,
      image: 'node:20-slim',
      goal: GOAL,
      seed: { 'TASK.md': 'Synthetic development fixture; no paid model calls.\n' },
      variant: 'parallel',
      adapter: meter,
      meter,
    });
    evidence = flow.evidence;
    expect(flow.evidence.completed).toBe(true);
    expect(flow.evidence.completionBound).toBe(true);
    expect(flow.evidence.waves).toEqual([['A', 'B', 'C', 'D'], ['E']]);
    expect(probed.size).toBe(4);
    expect(recovered).toEqual(probed);
    expect(meter.calls.every((call) => call.costUsd !== undefined)).toBe(true);
    await expect(readFile(join(ctx.runRoot, 'stop-requested.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await cleanup();
    if (evidence) expect(evidence.leasePeak).toBeGreaterThan(1);
  }
}, 180_000);

// Script planning and intentionally stop before coding; real routing/worker creation is inspected.
it.each(['inventory-restock', 'thermal-inspection', 'daily-availability'] as const)(
  'activates the real wide DAG for the fresh %s task input',
  async (name) => {
    const { ctx, cleanup } = await context();
    const definition = await taskDefinition(
      { id: `${name}-parallel-1`, task: name, suite: 'holdout', variant: 'parallel', attempt: 1 },
      'unused',
    );
    const seen = new Set<string>();
    class EntryProvider extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const view = JSON.parse(projectedInputText(options));
        if (view.role === 'CODER') {
          seen.add(view.slices.assignment?.subtaskId ?? 'missing');
          throw new Error('Intentional synthetic stop after observing the real assignment');
        }
        const value =
          view.role === 'PM'
            ? JSON.stringify([
                {
                  id: 'R',
                  story: definition.task.goal,
                  acceptance: [definition.task.goal],
                  nonGoals: [],
                },
              ])
            : JSON.stringify({
                architecture: { executionPlan: HOLDOUTS[name].plan },
                conventions: {},
              });
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: value };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    try {
      await expect(
        runMulti({
          context: ctx,
          docker,
          image: 'node:20-slim',
          goal: definition.task.goal,
          seed: definition.seed,
          variant: 'parallel',
          adapter: new EntryProvider(),
        }),
      ).rejects.toThrow();
      const state = JSON.parse(
        await readFile(join(ctx.dataRoot, 'projects/agora/tasks/benchmark/state.json'), 'utf8'),
      );
      expect(state.complexity.tier).toBe(2);
      expect(state.subtasks.map((s: { id: string }) => s.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(seen.size).toBeGreaterThan(1);
      expect([...seen].every((id) => ['A', 'B', 'C', 'D'].includes(id))).toBe(true);
    } finally {
      await cleanup();
    }
  },
  60_000,
);
