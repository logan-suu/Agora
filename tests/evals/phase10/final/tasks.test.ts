// Synthetic source documents exercise the real file/manifest boundary without copying a dataset.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { evaluateComplexity } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { HOLDOUTS } from '../../fixtures/phase10/holdout';
import { FRESH_HOLDOUT_NAMES } from './accounting';
import { PUBLIC_REVISION, publicFiles, sha256 } from './public-adapter';
import { withExecutionEnvironment } from './task-environment';
import { readPublicTaskSeed, taskDefinition } from './tasks';

it('provides every public assertion as a readable contract while withholding answers and verifier config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phase10-contract-'));
  const upstream =
    "xtest('syntax',()=>expect(()=>answer('What is?')).toThrow(new Error('Syntax error')));\n";
  try {
    const files = [];
    for (const entry of publicFiles('wordy')) {
      const content =
        entry.path === 'wordy.spec.js'
          ? upstream
          : entry.path === 'wordy.js'
            ? 'export function answer() {}\n'
            : entry.audience === 'agent'
              ? '# Reject invalid expressions.\n'
              : 'PRIVATE_VERIFIER_OR_REFERENCE_SENTINEL';
      const file = join(root, 'wordy', entry.path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
      files.push({ ...entry, sha256: sha256(content) });
    }
    await writeFile(
      join(root, 'wordy/source-manifest.json'),
      JSON.stringify({ name: 'wordy', revision: PUBLIC_REVISION, files }),
    );
    const input = await readPublicTaskSeed('wordy', root);
    expect(input.seed['wordy.spec.txt']).toBe(upstream.replace('xtest(', 'test('));
    expect(input.seed).not.toHaveProperty('wordy.spec.js');
    expect(JSON.stringify(input)).not.toContain('PRIVATE_VERIFIER_OR_REFERENCE_SENTINEL');
    // A self-consistent manifest cannot substitute synthetic files for the curated contract.
    await expect(
      taskDefinition(
        { id: 'wordy-multi-1', task: 'wordy', suite: 'public', variant: 'multi', attempt: 1 },
        root,
      ),
    ).rejects.toThrow('public contract source mismatch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['order-audit', 'shift-conflicts'] as const)(
  'adds only the shared environment prefix to the %s holdout input',
  async (name) => {
    const def = await taskDefinition(
      {
        id: `${name}-multi-1`,
        task: name,
        suite: 'holdout',
        variant: 'multi',
        attempt: 1,
      },
      'unused',
    );
    expect(Object.keys(def.seed)).toEqual(['TASK.md']);
    expect(def.task.goal).toContain('The shell has no Git executable');
    expect(def.task.version).toBe('2');
    expect(def.task.goal).toBe(withExecutionEnvironment(HOLDOUTS[name].goal));
    expect(def.seed['TASK.md']).toBe(`${withExecutionEnvironment(HOLDOUTS[name].goal)}\n`);
    expect(def.task.goal).not.toContain('reference implementation');
  },
);

it.each([
  'shipment-quotes',
  'inventory-restock',
  'thermal-inspection',
  'daily-availability',
] as const)(
  'exposes only the fresh %s contract and preserves its independent wide plan',
  async (name) => {
    const def = await taskDefinition(
      { id: `${name}-multi-1`, task: name, suite: 'holdout', variant: 'multi', attempt: 1 },
      'unused',
    );
    expect(Object.keys(def.seed)).toEqual(['TASK.md']);
    expect(def.task.goal).toContain('initial repository contains only TASK.md');
    expect(def.task.goal).toContain(JSON.stringify(HOLDOUTS[name].plan));
    expect(HOLDOUTS[name].plan.subtasks.slice(0, 4).every((s) => s.dependsOn.length === 0)).toBe(
      true,
    );
    expect(HOLDOUTS[name].plan.subtasks[4]?.dependsOn).toEqual(['A', 'B', 'C', 'D']);
    expect(JSON.stringify(def.seed)).not.toContain(HOLDOUTS[name].tests);
    for (const reference of Object.values(HOLDOUTS[name].reference))
      expect(def.task.goal).not.toContain(reference);
  },
);

it.each(FRESH_HOLDOUT_NAMES)(
  'routes the fresh %s goal through the production wide-plan tier before model I/O',
  async (name) => {
    const def = await taskDefinition(
      { id: `${name}-multi-1`, task: name, suite: 'holdout', variant: 'multi', attempt: 1 },
      'unused',
    );
    expect(evaluateComplexity({ goal: def.task.goal }).tier).toBe(2);
  },
);
