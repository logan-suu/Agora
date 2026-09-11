import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PHASE0_ROSTER } from '@agora/core-domain';
import { HarnessExecutor } from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { expect, it } from 'vitest';
import { projectedInputText } from '../core/projected-input';
import { BudgetLedger } from './final/accounting';
import { CONFIG, MeteredAdapter, MODELS } from './final/model-adapter';

// This explicit diagnostic uses real model responses, Harness and sandbox reads.
// Large files are synthetic audit fixtures, never benchmark tasks or hidden tests.
it('phase10 authorized Go projection repair and compaction verification', async () => {
  if (process.env.AGORA_GO_REPAIR_DIAGNOSTIC !== 'authorized-2026-09-10')
    throw new Error('explicit diagnostic authorization is required');
  const root = resolve('.data/evals', `phase10-go-projection-repair-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const budgetPath = process.env.AGORA_GO_DIAGNOSTIC_BUDGET;
  if (!budgetPath || !existsSync(budgetPath))
    throw new Error('Reuse the existing USD0.50 diagnostic ledger');
  const ledger = new BudgetLedger(budgetPath, 0.51, 0.01);
  const priorRequests = JSON.parse(readFileSync(budgetPath, 'utf8')).requests.length as number;
  const priorRepairRequests = (
    JSON.parse(readFileSync(budgetPath, 'utf8')).requests as { trial: string }[]
  ).filter((r) =>
    [
      'go-projection-repair-20260910',
      'go-control-handoff-scope-20260910',
      'go-implementation-repair-handoff-20260910',
    ].includes(r.trial),
  ).length;
  const started = Date.now();
  const records: { model: string; purpose: string; inputTokenEstimate: number | undefined }[] = [];
  const results: { model: string; stage: string; pages: number; summaries: number }[] = [];
  let stopped = false;
  let failure: { name: string; message: string } | undefined;
  class DiagnosticMeter extends MeteredAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      for (const message of options.messages) {
        for (const block of message.content) {
          if (block.type === 'tool-result' && block.isError) {
            stopped = true;
            throw new Error('diagnostic tool failure before next model request');
          }
        }
      }
      if (
        stopped ||
        existsSync(resolve('.data/evals/go-projection-repair-stop-requested.json')) ||
        priorRepairRequests + records.length >= 16 ||
        Date.now() - started > 900_000
      )
        throw new Error('diagnostic stopped before next request');
      if (options.purpose !== 'compaction') {
        const projection = projectedInputText(options);
        if (
          options.messages.some((message) =>
            message.content.some((block) => block.type === 'text' && block.text === projection),
          )
        )
          throw new Error('Projection repeated as a conversation message');
      }
      const record = {
        model: options.model,
        purpose: 'purpose' in options ? String(options.purpose) : 'main',
        inputTokenEstimate: undefined as number | undefined,
      };
      records.push(record);
      try {
        let summaryText = false;
        for await (const chunk of super.stream(options)) {
          if (chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text.trim())
            summaryText = true;
          yield chunk;
        }
        const completed = this.calls.at(-1);
        if (
          options.purpose === 'compaction' &&
          (completed?.finishReason !== 'stop' || !summaryText)
        )
          throw new Error('Diagnostic requires a completed text summary');
        if (!['stop', 'tool-calls'].includes(completed?.finishReason ?? ''))
          throw new Error('Diagnostic request did not complete normally');
        if (this.calls.at(-1)?.costUsd === undefined)
          throw new Error('diagnostic missing usage; no further requests allowed');
      } catch (error) {
        stopped = true;
        throw error;
      } finally {
        record.inputTokenEstimate = this.calls.at(-1)?.inputTokenEstimate;
        save();
      }
    }
  }
  const meter = new DiagnosticMeter(ledger, 'go-projection-repair-20260910', 'diagnostic');
  function save() {
    writeFileSync(
      join(root, 'evidence.json'),
      JSON.stringify(
        {
          config: CONFIG,
          budgetPath,
          priorRequests,
          diagnosticBudget: 0.5,
          maxRequests: 16,
          priorRepairRequests,
          formalExecutionEnabled: false,
          started,
          elapsedMs: Date.now() - started,
          results,
          requests: records,
          calls: meter.calls,
          accountedQuotaUsd: ledger.spent,
          stopped,
          failure,
          complete: results.length === 2 && !stopped,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  console.log(JSON.stringify({ root, diagnosticQuotaLimit: 0.5, maxRequests: 16 }));
  save();
  try {
    for (const stage of ['pressure']) {
      for (const model of MODELS) {
        const sandbox = new LocalTempSandbox();
        const taskId = `go-repair-${stage}-${model}`;
        const workspace = await sandbox.createWorktree(taskId, 'CODER');
        const spec = PHASE0_ROSTER.find((role) => role.role === 'CODER');
        if (!spec) throw new Error('missing CODER');
        const pages = stage === 'pressure' ? 2 : 1;
        for (let page = 1; page <= pages; page++) {
          const inventory =
            stage === 'pressure'
              ? 'Module audit: immutable input; deterministic output; tests passed.\n'.repeat(1800)
              : 'Module audit: tests passed.\n';
          await sandbox.write(
            workspace,
            `audit-${page}.txt`,
            `Invariant: answer() must return 42. Preserve this across summaries.\n${inventory}\nPAGE_MARKER=PAGE_${page}_OK`,
          );
        }
        let page = 1;
        let reads = 0;
        const readTool: ToolDefinition = {
          name: 'read_audit',
          description: 'Read the current audit file from the isolated sandbox.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: { schema: {}, render: (_args, value) => [{ type: 'text', text: String(value) }] },
          execute: async () => {
            if (++reads !== 1) throw new Error('audit page may only be read once per turn');
            return sandbox.read(workspace, `audit-${page}.txt`);
          },
        };
        const executor = new HarnessExecutor(
          {
            ...spec,
            model,
            systemPrompt:
              'You are auditing a coding task. Read the current audit file exactly once with read_audit. Do not repeat its contents. Return only its PAGE_MARKER and the preserved answer() invariant in one short sentence. Each new turn audits the next page. No other work is required.',
          },
          {
            adapter: meter,
            tools: [readTool],
            allowTools: ['read_audit'],
            maxToolCallsPerTurn: 1,
            approval: () => meter.approveTool(),
            sessionPersistence: {
              root: join(root, taskId, 'harness-sessions'),
              cwd: workspace.path,
              projectId: 'go-diagnostic',
              taskId,
            },
          },
        );
        const before = records.filter((r) => r.purpose === 'compaction').length;
        try {
          for (page = 1; page <= pages; page++) {
            reads = 0;
            const step = await executor.step({
              sessionId: taskId,
              view: {
                role: 'CODER',
                slices: {
                  goal: `Audit page ${page}. Call read_audit once and report the marker and the preserved invariant.`,
                  fileRefs: [{ path: `audit-${page}.txt` }],
                },
              },
            });
            expect(reads).toBe(1);
            expect(step.reachedSafeBoundary).toBe(true);
            const text = (step.output as { text?: string }).text;
            expect(text).toContain(`PAGE_${page}_OK`);
            expect(text).toContain('42');
            console.log(
              JSON.stringify({
                stage,
                model,
                page,
                requests: records.length,
                quotaUsd: ledger.spent,
              }),
            );
          }
          await executor.saveSafePoint();
          const summaries = records.filter((r) => r.purpose === 'compaction').length - before;
          if (stage === 'pressure') expect(summaries).toBeGreaterThan(0);
          results.push({ stage, model, pages, summaries });
        } finally {
          try {
            await executor.saveSafePoint();
          } finally {
            try {
              await executor.dispose();
            } finally {
              await sandbox.teardown(taskId);
            }
          }
        }
        save();
      }
    }
  } catch (error) {
    stopped = true;
    failure = {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message.slice(0, 500) : 'unknown failure',
    };
    throw error;
  } finally {
    save();
  }
}, 1_800_000);
