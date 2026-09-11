import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Dockerode, DockerSandbox } from '@agora/runtime-sandbox';
import type { PublicName } from './accounting';
import {
  activateTests,
  readPublicFile,
  sha256,
  TEST_COUNTS,
  validateJestResult,
} from './public-adapter';

export async function verifyPublic(options: {
  docker: Dockerode;
  image: string;
  root: string;
  sources: string;
  name: PublicName;
  code: string;
}) {
  const sandbox = new DockerSandbox({
    docker: options.docker,
    image: options.image,
    baseDir: options.root,
  });
  const id = `verifier-${randomUUID()}`;
  const errors: unknown[] = [];
  let result:
    | {
        passed: boolean;
        tests: number;
        codeHash: string;
        reportHash: string;
        report: unknown;
        exitCode: number;
        durationMs: number;
      }
    | undefined;
  const started = Date.now();
  try {
    const worktree = await sandbox.createWorktree(id, 'verifier');
    for (const file of ['package.json', 'babel.config.js'])
      await sandbox.write(
        worktree,
        file,
        await readPublicFile(options.sources, options.name, file),
      );
    const tests = activateTests(
      await readPublicFile(options.sources, options.name, `${options.name}.spec.js`),
    );
    await sandbox.write(worktree, `${options.name}.spec.js`, tests);
    await sandbox.write(worktree, `${options.name}.js`, options.code);
    const run = await sandbox.run(
      worktree,
      '/opt/benchmark/node_modules/.bin/jest --runInBand --no-cache --json --outputFile=verifier-result.json',
      30_000,
    );
    await mkdir(join(options.root, 'verifier-reports'), { recursive: true });
    await writeFile(
      join(options.root, 'verifier-reports', `${id}-execution.json`),
      JSON.stringify(run, null, 2),
    );
    if (run.timedOut || run.exitCode === null) throw new Error('verifier did not exit normally');
    const raw = await sandbox.read(worktree, 'verifier-result.json');
    if (
      (await sandbox.read(worktree, `${options.name}.spec.js`)) !== tests ||
      (await sandbox.read(worktree, `${options.name}.js`)) !== options.code
    )
      throw new Error('verifier input changed during execution');
    for (const file of ['package.json', 'babel.config.js'])
      if (
        (await sandbox.read(worktree, file)) !==
        (await readPublicFile(options.sources, options.name, file))
      )
        throw new Error('verifier configuration changed during execution');
    const report = JSON.parse(raw);
    const passed = validateJestResult(report, TEST_COUNTS[options.name], run.exitCode);
    result = {
      passed,
      tests: TEST_COUNTS[options.name],
      codeHash: sha256(options.code),
      reportHash: sha256(raw),
      report,
      exitCode: run.exitCode,
      durationMs: Date.now() - started,
    };
    await mkdir(join(options.root, 'verifier-reports'), { recursive: true });
    await writeFile(
      join(options.root, 'verifier-reports', `${id}.json`),
      JSON.stringify({ ...result, testsHash: sha256(tests) }, null, 2),
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    await sandbox.teardown(id);
    const containers = await options.docker.listContainers({ all: true });
    if (containers.some((c) => c.Mounts.some((m) => m.Source.includes(id))))
      throw new Error('verifier container survived cleanup');
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, 'public verifier failed');
  if (!result) throw new Error('missing verifier result');
  return result;
}
