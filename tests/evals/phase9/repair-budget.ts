import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalResult } from '../core/contracts';
import { ExperimentBudget } from './metrics';

export async function repairBudget(evalRoot: string) {
  const budget = new ExperimentBudget(2);
  let spent = 0;
  const entries = await readdir(evalRoot).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.startsWith('phase9-wide-pipeline-model-')) continue;
    const manifest = JSON.parse(
      await readFile(join(evalRoot, entry, 'manifest.json'), 'utf8').catch((cause: unknown) => {
        throw new Error(
          `Model evaluation history is incomplete: ${entry}; reconcile its manifest and cost before retrying`,
          { cause },
        );
      }),
    );
    if (!manifest.groupId?.startsWith('phase9-repair-verification-')) continue;
    const result = JSON.parse(
      await readFile(join(evalRoot, entry, 'result.json'), 'utf8'),
    ) as EvalResult;
    if (
      result.lifecycle !== 'final' ||
      typeof result.efficiency.costUsd !== 'number' ||
      !Number.isFinite(result.efficiency.costUsd) ||
      result.efficiency.costUsd < 0
    )
      throw new Error('Previous repair verification is unfinished or has unknown cost');
    spent += result.efficiency.costUsd;
  }
  const prior = budget.reserve(spent);
  budget.finish(prior, spent);
  return budget;
}
