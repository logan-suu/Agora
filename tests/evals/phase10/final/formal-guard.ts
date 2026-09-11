import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GenerateOptions, LlmAdapter, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { BudgetLedger } from './accounting';
import { FlowToolPolicy } from './flow-tool-policy';
import { MeteredAdapter } from './model-adapter';
import { operatorStopRequested } from './protocol';

export const FORMAL_POLICY = {
  priorGroup: 'phase10-final-v13',
  sharedBudget: true,
  authorizedGroup: 'phase10-final-v14',
  authorization: 'phase10-final-v14-usd5',
  matrix: 'fresh-holdout',
  completedPublicGroup: 'phase10-final-v11',
  completedPublicFingerprint: 'b0007a118d785ca17c229ea646bc90bf473afcf5057e6b8cce5e8013bb97e2a6',
  totalUsd: 5,
  formalUsd: 5,
  diagnosticUsd: 0,
  groupMs: 28_800_000,
  stopPolicy:
    'request-failure-or-unknown-usage-or-systemic-or-repeated-tool-error; review-every-nonpass',
} as const;
export function assertFormalAuthorization(group: string, authorization: string | undefined) {
  if (group !== FORMAL_POLICY.authorizedGroup || authorization !== FORMAL_POLICY.authorization)
    throw new Error('explicit formal group and USD5 authorization required');
}
export class FormalGuard {
  constructor(private readonly root: string) {}
  check() {
    if (operatorStopRequested(this.root)) throw new Error('formal group stopped; review required');
  }
  stop(trial: string, reason: string) {
    try {
      writeFileSync(
        join(this.root, 'stop-requested.json'),
        JSON.stringify({ trial, reason, at: new Date().toISOString() }, null, 2),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
export class GuardedFormalMeter extends MeteredAdapter {
  private readonly toolPolicy = new FlowToolPolicy();
  constructor(
    ledger: BudgetLedger,
    private readonly trialId: string,
    private readonly guard: FormalGuard,
    provider?: LlmAdapter,
  ) {
    super(ledger, trialId, 'formal', provider);
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.guard.check();
    const before = this.calls.length;
    try {
      this.toolPolicy.inspect(options);
      // Do not cancel an in-flight stream; enforce the stop before its next request.
      let summaryText = false;
      for await (const chunk of super.stream(options)) {
        if (chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text.trim())
          summaryText = true;
        yield chunk;
      }
      const call = this.calls[before];
      if (options.purpose === 'compaction' && (call?.finishReason !== 'stop' || !summaryText))
        throw new Error('formal compaction requires a completed text summary');
      if (
        !call ||
        call.failed ||
        call.costUsd === undefined ||
        !['stop', 'tool-calls'].includes(call.finishReason ?? '')
      )
        throw new Error('formal request incomplete or usage unknown');
    } catch (error) {
      this.guard.stop(this.trialId, 'request-or-tool-policy-failure');
      throw error;
    }
  }
  override async approveTool() {
    try {
      this.guard.check();
    } catch {
      return { kind: 'deny' as const, reason: 'formal group stopped; review required' };
    }
    return super.approveTool();
  }
}
