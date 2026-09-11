import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Dockerode, DockerSandbox } from '@agora/runtime-sandbox';
import { parseTap } from '../../../../packages/tools/test/src/tap';
import { HOLDOUTS, type HoldoutName } from '../../fixtures/phase10/holdout';
import { sha256 } from './public-adapter';

export async function verifyHoldout(options: {
  docker: Dockerode;
  image: string;
  root: string;
  name: HoldoutName;
  files: Record<string, string>;
}) {
  const task = HOLDOUTS[options.name],
    id = `holdout-verifier-${randomUUID()}`;
  const sandbox = new DockerSandbox({
    docker: options.docker,
    image: options.image,
    baseDir: options.root,
  });
  const errors: unknown[] = [];
  let result:
    | {
        passed: boolean;
        tests: number;
        observedTests: number;
        durationMs: number;
        reportHash: string;
        codeHashes: Record<string, string>;
      }
    | undefined;
  const started = Date.now();
  try {
    const worktree = await sandbox.createWorktree(id, 'verify');
    const hashes: Record<string, string> = {};
    for (const file of task.files) {
      const code = options.files[file];
      if (code === undefined) throw new Error(`missing candidate module: ${file}`);
      await sandbox.write(worktree, file, code);
      hashes[file] = sha256(code);
    }
    await sandbox.write(worktree, 'independent.test.mjs', task.tests);
    const run = await sandbox.run(
      worktree,
      'node --test --test-reporter=tap independent.test.mjs',
      30_000,
    );
    if ((await sandbox.read(worktree, 'independent.test.mjs')) !== task.tests)
      throw new Error('holdout tests changed during execution');
    for (const file of task.files)
      if (sha256(await sandbox.read(worktree, file)) !== hashes[file])
        throw new Error('holdout candidate changed during execution');
    await mkdir(join(options.root, 'verifier-reports'), { recursive: true });
    await writeFile(
      join(options.root, 'verifier-reports', `${id}.json`),
      JSON.stringify({ run, codeHashes: hashes, testsHash: sha256(task.tests) }, null, 2),
    );
    if (run.timedOut || run.exitCode === null)
      throw new Error('holdout verifier did not exit normally');
    const tap = parseTap(run.stdout),
      expected = (task.tests.match(/\btest\('/g) ?? []).length;
    const counts = (label: string) => {
      const m = run.stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
      return m ? Number(m[1]) : undefined;
    };
    const complete = tap.total === expected && counts('skipped') === 0 && counts('todo') === 0;
    // Syntax/import errors are real failed outcomes, never a zero-test pass.
    const passed = complete && tap.passed === expected && tap.failed === 0 && run.exitCode === 0;
    if (run.exitCode === 0 && !passed)
      throw new Error('invalid successful holdout verifier report');
    result = {
      passed,
      tests: expected,
      observedTests: tap.total,
      durationMs: Date.now() - started,
      reportHash: sha256(JSON.stringify(run)),
      codeHashes: hashes,
    };
  } catch (error) {
    errors.push(error);
  }
  try {
    await sandbox.teardown(id);
    const containers = await options.docker.listContainers({ all: true });
    if (containers.some((c) => c.Mounts.some((m) => m.Source.includes(id))))
      throw new Error('holdout verifier container survived cleanup');
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, 'holdout verifier failed');
  if (!result) throw new Error('missing holdout result');
  return result;
}
