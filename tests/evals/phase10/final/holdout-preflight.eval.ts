import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { evaluateComplexity } from '@agora/core-orchestration';
import { Dockerode } from '@agora/runtime-sandbox';
import { expect, it } from 'vitest';
import { HOLDOUTS, type HoldoutName } from '../../fixtures/phase10/holdout';
import { FRESH_HOLDOUT_NAMES } from './accounting';
import { inspectBenchmarkImage } from './benchmark-image';
import { verifyHoldout } from './holdout-verifier';
import { sha256 } from './public-adapter';
import { withExecutionEnvironment } from './task-environment';

it('phase10 holdout verifier preflight', async () => {
  const root = resolve('.data/evals/phase10-preflight');
  await mkdir(root, { recursive: true });
  const docker = new Dockerode({
    socketPath: join(process.env.HOME ?? '', '.docker/run/docker.sock'),
  });
  const image: string = (await inspectBenchmarkImage(docker)).Id;
  const results = [];
  for (const name of Object.keys(HOLDOUTS) as HoldoutName[]) {
    const task = HOLDOUTS[name];
    const positive = await verifyHoldout({ docker, image, root, name, files: task.reference });
    const negative = await verifyHoldout({
      docker,
      image,
      root,
      name,
      files: Object.fromEntries(task.files.map((f) => [f, 'export {};\n'])),
    });
    let semanticNegative: Awaited<ReturnType<typeof verifyHoldout>> | undefined;
    if (
      name === 'shipment-quotes' ||
      name === 'daily-availability' ||
      name === 'inventory-restock' ||
      name === 'thermal-inspection'
    ) {
      const files: Record<string, string> = { ...task.reference };
      const file =
        name === 'thermal-inspection'
          ? 'action.mjs'
          : name === 'shipment-quotes'
            ? 'quote.mjs'
            : name === 'inventory-restock'
              ? 'label.mjs'
              : 'union.mjs';
      const original = files[file];
      if (!original) throw new Error('missing semantic negative source');
      files[file] =
        name === 'thermal-inspection'
          ? original.replace('d>=400', 'd>=200')
          : name === 'shipment-quotes'
            ? original.replace('?500:0', '?450:0')
            : name === 'inventory-restock'
              ? original.replace('n>=20', 'n>=10')
              : original.replace('s<=last[1]', 's<last[1]');
      expect(files[file]).not.toBe(original);
      semanticNegative = await verifyHoldout({ docker, image, root, name, files });
      expect(semanticNegative.passed, `${name} semantic negative`).toBe(false);
    }
    const tier = evaluateComplexity({ goal: withExecutionEnvironment(task.goal) }).tier;
    if ((FRESH_HOLDOUT_NAMES as readonly string[]).includes(name))
      expect(tier, `${name} wide-plan entry`).toBe(2);
    results.push({
      name,
      tier,
      ...(semanticNegative ? { semanticNegative } : {}),
      fingerprint: sha256(JSON.stringify(task)),
      positive,
      negative,
    });
    await writeFile(
      join(root, 'holdout-preflight.json'),
      JSON.stringify({ image, results }, null, 2),
    );
    expect(positive.passed, name).toBe(true);
    expect(negative.passed, name).toBe(false);
  }
}, 90_000);
