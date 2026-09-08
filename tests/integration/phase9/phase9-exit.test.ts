// Only the external model is scripted. The independent exit chain uses production
// HTTP handlers, Harness, scheduler, Git, Docker, validation, Leader gate and archive.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runWideFlow } from '../../evals/phase9/scenario';
import { WideFixtureAdapter } from '../../evals/phase9/scripted-adapter';

it('executes the full four-wide batch at cap 3 and validates its dependent cumulative artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-phase9-exit-'));
  try {
    const result = await runWideFlow({ root, cap: 3, adapter: new WideFixtureAdapter(3) });
    expect(result.status).toBe('completed');
    expect(result.waves).toEqual([['A', 'B', 'C', 'D'], ['E']]);
    expect(result.leasePeak).toBe(3);
    expect(result.finalLeaseCount).toBe(0);
    expect(result.freshVerification.exitCode).toBe(0);
    expect(result.freshVerification.stdout).toContain('# tests 9');
    expect(result.validationTotals).toEqual([7, 16]);
    expect(result.traceCoderSessions).toBe(5);
    expect(result.completionBound).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
