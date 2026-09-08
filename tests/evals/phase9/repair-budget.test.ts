// Real filesystem histories exercise restart accounting without paid model calls.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { repairBudget } from './repair-budget';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agora-repair-budget-'));
  roots.push(root);
  return join(root, 'evals');
}
it('starts with zero prior cost when no eval history exists', async () => {
  expect((await repairBudget(await fixture())).costUsd).toBe(0);
});
it('refuses ambiguous interrupted histories rather than assuming no charge', async () => {
  const root = await fixture();
  await mkdir(join(root, 'phase9-wide-pipeline-model-interrupted'), { recursive: true });
  await expect(repairBudget(root)).rejects.toThrow(/history.*incomplete/i);
});
it('restores settled repair costs while excluding identified comparison attempts', async () => {
  const root = await fixture();
  for (const [suffix, groupId, costUsd] of [
    ['repair', 'phase9-repair-verification-1', 0.2],
    ['comparison', 'phase9-comparison-1', 9],
  ] as const) {
    const dir = join(root, `phase9-wide-pipeline-model-${suffix}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ groupId }));
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify({ lifecycle: 'final', efficiency: { costUsd } }),
    );
  }
  expect((await repairBudget(root)).costUsd).toBe(0.2);
});
it.each(['unknown', -1, null])('refuses unreliable prior cost %s', async (costUsd) => {
  const root = await fixture(),
    dir = join(root, 'phase9-wide-pipeline-model-repair');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ groupId: 'phase9-repair-verification-1' }),
  );
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify({ lifecycle: 'final', efficiency: { costUsd } }),
  );
  await expect(repairBudget(root)).rejects.toThrow();
});
it('does not treat a non-directory eval root as empty history', async () => {
  const root = await fixture();
  await writeFile(root, 'invalid');
  await expect(repairBudget(root)).rejects.toThrow();
});
