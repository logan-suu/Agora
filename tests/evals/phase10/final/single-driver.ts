import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessExecutor, HarnessTraceReader } from '@agora/runtime-executor';
import { type Dockerode, DockerSandbox, WorkspaceAdapter } from '@agora/runtime-sandbox';
import { SecureFiles } from '@agora/runtime-sandbox/secure-files';
import { createToolCatalog } from '@agora/tools-bridge';
import { encodeGitIsolationKey, WorktreeGitService } from '@agora/tools-git';
import type { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { EvalExecutionContext } from '../../core/runner';
import { fixedRoster, type MeteredAdapter } from './model-adapter';
import { seedRepository } from './workspace';

export async function runSingle(options: {
  context: EvalExecutionContext;
  docker: Dockerode;
  image: string;
  goal: string;
  seed: Readonly<Record<string, string>>;
  adapter: LlmAdapter;
  meter?: MeteredAdapter;
}) {
  const { context } = options;
  const execution = new DockerSandbox({
    docker: options.docker,
    image: options.image,
    baseDir: context.dataRoot,
  });
  const taskRoot = join(context.dataRoot, 'projects/agora/tasks/single');
  const { registry, commit } = await seedRepository(join(taskRoot, 'repository'), options.seed);
  const git = new WorktreeGitService(
    registry,
    join(taskRoot, 'repository'),
    join(taskRoot, 'worktrees'),
    { withWorktree: (path, operation) => execution.withStableFiles(path, operation) },
  );
  const sandbox = new WorkspaceAdapter({
    projectId: 'agora',
    taskId: 'single',
    taskRoot,
    git,
    execution,
    encodeIsolationKey: encodeGitIsolationKey,
  });
  context.registerCleanup(async () => {
    await sandbox.teardown('single');
    return { invariants: { 'safety.cleanup': true } };
  });
  const worktree = await sandbox.createWorktree('single', 'solver');
  const catalog = await createToolCatalog({
    sandbox,
    registry,
    gitService: git,
    getWorktree: async () => worktree,
  });
  context.registerCleanup(async () => {
    await catalog.dispose();
    return undefined;
  });
  const spec = fixedRoster('single').find((r) => r.role === 'CODER');
  if (!spec) throw new Error('missing single solver spec');
  const tools = catalog.resolve(spec.tools);
  const executor = new HarnessExecutor(
    {
      ...spec,
      systemPrompt:
        'You are the sole coding agent for this task. Read the structured goal and allowed file references. Implement the requested code and your own tests using the available tools. Verify the result in the sandbox. Finish when complete; no other agents or human completion protocol are available in this evaluation.',
    },
    {
      adapter: options.adapter,
      deepseek: false,
      provider: 'phase10-eval',
      tools: tools.definitions,
      allowTools: tools.allowNames,
      sessionPersistence: {
        root: join(context.dataRoot, 'projects/agora/tasks/single/harness-sessions'),
        cwd: worktree.path,
        projectId: 'agora',
        taskId: 'single',
      },
      ...(options.meter
        ? {
            approval: () =>
              options.meter?.approveTool() ??
              Promise.resolve({ kind: 'deny' as const, reason: 'missing meter' }),
          }
        : {}),
    },
  );
  context.registerCleanup(async () => {
    await executor.dispose();
    return undefined;
  });
  const failures: unknown[] = [];
  try {
    const result = await executor.step({
      sessionId: 'single',
      view: {
        role: 'CODER',
        slices: {
          goal: options.goal,
          fileRefs: Object.keys(options.seed).map((path) => ({ path })),
        },
      },
    });
    if (!result.reachedSafeBoundary) throw new Error('single solver did not reach a safe boundary');
  } catch (error) {
    failures.push(error);
  }
  // step has settled; flush the official closed turn before cleanup disposes the executor.
  try {
    await executor.saveSafePoint();
    const trace = await new HarnessTraceReader(context.dataRoot).read(
      { projectId: 'agora', taskId: 'single' },
      { maxEvents: 2000 },
    );
    await writeFile(join(context.runRoot, 'trace.json'), JSON.stringify(trace, null, 2));
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'single execution and trace capture failed');
  const artifact = join(context.runRoot, 'single-artifact');
  await execution.withStableFiles(worktree.path, async () => {
    new SecureFiles(worktree.path).snapshotTo(artifact);
  });
  return { artifact, baseCommit: commit, completed: true, iterations: 1 };
}
