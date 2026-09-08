import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PHASE0_ROSTER } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { HarnessExecutor } from '../../../packages/runtime/executor/src/harness-executor';
import { executionFingerprint } from './fingerprint';
import { ExperimentBudget } from './metrics';
import { MeteredFlashAdapter, MODEL_CONFIG } from './model-adapter';

it('phase9 format repair G5 recovers a deliberately invalid first reply through real Flash and the official Harness stopping hook', async () => {
  const runId = `phase9-format-hook-${randomUUID()}`,
    root = resolve('.data/g5', runId);
  await mkdir(root, { recursive: true });
  const base = PHASE0_ROSTER.find((r) => r.role === 'CODER');
  if (!base) throw Error('missing role');
  const adapter = new MeteredFlashAdapter(new ExperimentBudget(0.6));
  let rejected = 0,
    status = 'fail';
  let result: Awaited<ReturnType<HarnessExecutor['step']>> | undefined;
  const executor = new HarnessExecutor(
    {
      ...base,
      model: 'deepseek-v4-flash',
      systemPrompt:
        'This is an output protocol fault-injection test using the real provider. On your first response in this session, return exactly the non-JSON word draft. If a later message contains output-format-repair, return exactly {"ok":true}. No tools, objections or other text.',
    },
    {
      adapter,
      allowTools: [],
      sessionPersistence: {
        root: resolve(root, 'harness-sessions'),
        cwd: root,
        projectId: 'agora',
        taskId: 'format-g5',
      },
      validateTurnOutput: ({ text }) => {
        try {
          const x = JSON.parse(text ?? '');
          if (x.ok !== true) throw Error('wrong value');
        } catch (e) {
          rejected++;
          throw e;
        }
      },
    },
  );
  try {
    result = await executor.step({
      sessionId: 'format-g5',
      view: { role: 'CODER', slices: { test: 'output protocol' } },
    });
    expect(adapter.calls.length).toBeGreaterThan(1);
    expect(adapter.calls.length).toBeLessThanOrEqual(3);
    expect(rejected).toBeGreaterThan(0);
    expect(result.output).toEqual({ text: '{"ok":true}' });
    expect(result.mutations).toHaveLength(1);
    status = 'pass';
  } finally {
    await executor.dispose();
    await writeFile(
      resolve(root, 'result.json'),
      JSON.stringify(
        {
          runId,
          status,
          faultInjection:
            'Real provider instructed to return non-JSON on first response; no adapter replacement or host response rewriting',
          modelConfig: MODEL_CONFIG,
          sourceFingerprint: executionFingerprint(),
          rejected,
          requests: adapter.calls,
          costUsd: adapter.costUsd,
          result,
        },
        null,
        2,
      ),
    );
    console.info(
      JSON.stringify({
        runId,
        status,
        rejected,
        requests: adapter.calls.length,
        costUsd: adapter.costUsd,
      }),
    );
  }
});
