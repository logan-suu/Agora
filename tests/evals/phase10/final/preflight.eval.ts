import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInitialAppState } from '@agora/core-domain';
import { project } from '@agora/runtime-executor';
import { Dockerode, DockerSandbox } from '@agora/runtime-sandbox';
import { expect, it } from 'vitest';
import { PUBLIC_NAMES } from './accounting';
import { inspectBenchmarkImage } from './benchmark-image';
import { fixedRoster } from './model-adapter';
import { downloadPublicTask, readPublicFile, sha256 } from './public-adapter';
import { publicContractText } from './public-contracts';
import { EXECUTION_ENVIRONMENT } from './task-environment';
import { taskDefinition } from './tasks';
import { verifyPublic } from './verifier';

it('phase10 public verifier preflight', async () => {
  const root = resolve('.data/evals/phase10-preflight');
  await mkdir(root, { recursive: true });
  const sources = join(root, 'sources');
  const docker = new Dockerode({
    socketPath: join(process.env.HOME ?? '', '.docker/run/docker.sock'),
  });
  const image: string = (await inspectBenchmarkImage(docker)).Id;
  const probe = new DockerSandbox({ docker, image, baseDir: root });
  const probeId = `environment-${Date.now()}`;
  try {
    const worktree = await probe.createWorktree(probeId, 'environment');
    const result = await probe.run(worktree, 'node --version && ! command -v git', 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toMatch(/^v20\./);
    await writeFile(
      join(root, 'environment-preflight.json'),
      JSON.stringify(
        {
          image,
          nodeVersion: result.stdout.trim(),
          gitCliAvailable: false,
          contractHash: sha256(EXECUTION_ENVIRONMENT),
        },
        null,
        2,
      ),
    );
  } finally {
    await probe.teardown(probeId);
  }
  const results = [];
  for (const name of PUBLIC_NAMES) {
    if (!existsSync(join(sources, name, 'source-manifest.json')))
      await downloadPublicTask(sources, name);
    const goals = new Set<string>();
    for (const variant of ['single', 'multi', 'mixed'] as const) {
      const def = await taskDefinition(
        { id: `${name}-${variant}-1`, task: name, suite: 'public', variant, attempt: 1 },
        sources,
      );
      const roster = fixedRoster(variant);
      const view = project(createInitialAppState('preflight', def.task.goal), 'PM', roster);
      expect(roster.find((r) => r.role === 'PM')?.tools).toEqual([]);
      expect((view.slices.goal as { goal: string }).goal).toBe(def.task.goal);
      expect(def.task.goal).toContain(publicContractText(name));
      expect(def.task.goal).toContain(EXECUTION_ENVIRONMENT);
      expect(def.seed['TASK.md']).toContain(EXECUTION_ENVIRONMENT);
      expect(def.seed['TASK.md']).toContain(publicContractText(name));
      expect(def.task.version).toBe('6');
      goals.add(def.task.goal);
    }
    expect(goals.size).toBe(1);
    const reference = await readPublicFile(sources, name, '.meta/proof.ci.js');
    const correct = await verifyPublic({ docker, image, root, sources, name, code: reference });
    const empty = await verifyPublic({
      docker,
      image,
      root,
      sources,
      name,
      code: await readPublicFile(sources, name, `${name}.js`),
    });
    results.push({
      name,
      positive: correct.passed,
      negative: empty.passed,
      tests: correct.tests,
      contractProjectedToPm: true,
      taskVersion: 6,
    });
    await writeFile(join(root, 'preflight.json'), JSON.stringify({ image, results }, null, 2));
    expect(correct.passed, name).toBe(true);
    expect(empty.passed, name).toBe(false);
  }
  expect(results.reduce((n, r) => n + r.tests, 0)).toBe(99);
  const check = JSON.parse(await readFile(join(root, 'preflight.json'), 'utf8'));
  expect(check.results).toHaveLength(4);
}, 180_000);
