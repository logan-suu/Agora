// Mock reason (R11): only external model responses are scripted. Native actions
// run inside a real Harness step; its loop, JSONL and checkpoint flush are real.
// This terminal-only fixture does not establish live-provider or D4 resume G5.
import type { RoleSpec } from '@agora/core-domain';
import {
  HarnessExecutor,
  type HarnessExecutorOptions,
  type StepContext,
  type StepResult,
} from '@agora/runtime-executor';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';

export function createScriptedLocalHarness(
  spec: RoleSpec,
  persistence: NonNullable<HarnessExecutorOptions['sessionPersistence']>,
  exercise: () => Promise<StepResult>,
): HarnessExecutor {
  let result: StepResult | undefined;
  let exercised = false;
  class ScriptedResponse extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      if (exercised) throw Error('terminal_fixture_model_replayed');
      exercised = true;
      result = await exercise();
      if (result.kind !== 'done' || !result.reachedSafeBoundary)
        throw Error('terminal_fixture_step_not_completed');
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  class TerminalHarness extends HarnessExecutor {
    private checkpoint: Promise<string> | undefined;
    override async step(context: StepContext): Promise<StepResult> {
      try {
        return await super.step(context);
      } catch (error) {
        await this.dispose();
        throw error;
      }
    }
    override saveSafePoint(): Promise<string> {
      // WorkerRuntime requests this after trusted completion. Flush before
      // disposing the actual Context, and preserve the exact official cursor.
      this.checkpoint ??= super.saveSafePoint().finally(() => this.dispose());
      return this.checkpoint;
    }
  }
  return new TerminalHarness(spec, {
    adapter: new ScriptedResponse(),
    provider: 'agora',
    allowTools: [],
    sessionPersistence: persistence,
    readTurnMutations: () => {
      if (!result) throw Error('terminal_fixture_step_missing');
      return result.mutations;
    },
  });
}
