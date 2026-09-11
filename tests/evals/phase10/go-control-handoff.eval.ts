// Explicit synthetic real-model probe; it never sends benchmark tasks or hidden tests.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_ROSTER, reviewerTurnMutations, SIX_ROLE_HANDOFF } from '@agora/roles-definitions';
import { HarnessExecutor } from '@agora/runtime-executor';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { BudgetLedger } from './final/accounting';
import { MeteredAdapter, MODELS } from './final/model-adapter';

it('phase10 authorized Go control and ordinary handoff verification', async () => {
  if (process.env.AGORA_GO_CONTROL_DIAGNOSTIC !== 'authorized-2026-09-10')
    throw new Error('explicit repair diagnostic authorization required');
  const budgetPath = process.env.AGORA_GO_DIAGNOSTIC_BUDGET;
  if (!budgetPath || !existsSync(budgetPath))
    throw new Error('existing diagnostic ledger required');
  const ledger = new BudgetLedger(budgetPath, 0.51, 0.01);
  const trial = 'go-control-handoff-scope-20260910';
  const previous = (
    JSON.parse(readFileSync(budgetPath, 'utf8')).requests as { trial: string }[]
  ).filter((r) =>
    ['go-projection-repair-20260910', trial, 'go-implementation-repair-handoff-20260910'].includes(
      r.trial,
    ),
  ).length;
  const root = resolve('.data/evals', `phase10-go-control-handoff-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  let stopped = false;
  let requests = 0;
  const results: { model: string; concern: boolean; verdict: boolean }[] = [];
  const started = Date.now();
  class ProbeMeter extends MeteredAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (stopped || previous + requests >= 16 || Date.now() - started > 600_000)
        throw new Error('repair diagnostic stopped before request');
      requests++;
      try {
        yield* super.stream(options);
        const call = this.calls.at(-1);
        if (call?.costUsd === undefined || call.finishReason !== 'stop')
          throw new Error('control probe requires settled normal text completion');
      } catch (error) {
        stopped = true;
        throw error;
      } finally {
        save();
      }
    }
  }
  const meter = new ProbeMeter(ledger, trial, 'diagnostic');
  function save() {
    writeFileSync(
      join(root, 'evidence.json'),
      JSON.stringify(
        {
          root,
          results,
          calls: meter.calls,
          previousRepairRequests: previous,
          combinedRepairRequestCap: 16,
          diagnosticLimitUsd: 0.5,
          accountedQuotaUsd: ledger.spent,
          stopped,
          complete: results.length === 2 && !stopped,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  console.log(
    JSON.stringify({ root, previousRepairRequests: previous, remainingRequestCap: 16 - previous }),
  );
  try {
    for (const model of MODELS) {
      const spec = DEFAULT_ROSTER.find((r) => r.role === 'REVIEWER');
      if (!spec) throw new Error('missing reviewer');
      const executor = new HarnessExecutor(
        {
          ...spec,
          model,
          tools: [],
          systemPrompt: spec.systemPrompt + SIX_ROLE_HANDOFF.REVIEWER,
        },
        {
          adapter: meter,
          tools: [],
          allowTools: [],
          validateTurnOutput: ({ text }) => {
            reviewerTurnMutations(text);
          },
          readTurnMutations: ({ text }) => reviewerTurnMutations(text),
          sessionPersistence: {
            root: join(root, model, 'harness-sessions'),
            cwd: root,
            projectId: 'go-diagnostic',
            taskId: `control-${model}`,
          },
        },
      );
      try {
        const sessionId = `control-${model}`;
        const concern = await executor.step({
          sessionId,
          view: {
            role: 'REVIEWER',
            slices: {
              goal: 'Synthetic review: the validated function answer() returns 42. Its name might confuse readers because the domain is unspecified. Record this concrete naming concern as a non-blocking objection in this turn. No files or tools are needed.',
              testResults: { passed: true, total: 1, failed: 0, failures: [] },
            },
          },
        });
        expect(concern.output.objection).toMatchObject({ claim: 'concern' });
        expect(concern.mutations.some((m) => m.field === 'reviewComments')).toBe(false);
        const verdict = await executor.step({
          sessionId,
          view: {
            role: 'REVIEWER',
            slices: {
              goal: 'Continue the same synthetic review. The naming concern is already recorded. The existing name is within the specified API and needs no change. The validated function answer() returns 42; approve the bound review now. No files or tools are needed.',
              testResults: { passed: true, total: 1, failed: 0, failures: [] },
              coordinationContext: {
                instructionOrQuestion:
                  'The advisory has been recorded. Continue the bound review and provide its required verdict.',
              },
            },
          },
        });
        expect(verdict.output.objection).toBeUndefined();
        expect(verdict.mutations).toContainEqual(
          expect.objectContaining({
            field: 'reviewComments',
            value: expect.objectContaining({ kind: 'verdict', verdict: 'approved' }),
          }),
        );
        await executor.saveSafePoint();
        results.push({ model, concern: true, verdict: true });
      } finally {
        await executor.dispose();
      }
      save();
    }
  } catch (error) {
    stopped = true;
    throw error;
  } finally {
    save();
  }
}, 900_000);
