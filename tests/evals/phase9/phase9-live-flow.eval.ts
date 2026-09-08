// Explicit, paid G5 execution evidence. Excluded from the default test suite;
// this is a production-chain check, not a comparative benchmark or speed claim.
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type AppState, validationReceipt } from '@agora/core-domain';
import { HarnessTraceReader } from '@agora/runtime-executor';
import { Dockerode, DockerSandbox } from '@agora/runtime-sandbox';
import { WorktreeRegistry } from '@agora/tools-fs';
import { WorktreeGitService } from '@agora/tools-git';
import { expect, it } from 'vitest';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import { createPostTask } from '../../../apps/web/src/server/task-handlers';
import { TaskOrchestrationRuntime } from '../../../apps/web/src/server/task-orchestration-runtime';

it('phase9 live production G5: parallel dependency waves through Leader approval', async () => {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required');
  const socket = join(process.env.HOME ?? '', '.docker/run/docker.sock');
  const docker = new Dockerode(existsSync(socket) ? { socketPath: socket } : {});
  await docker.ping();
  const resumeRoot = process.env.AGORA_G5_RESUME_ROOT;
  const root =
    resumeRoot === undefined
      ? resolve('.data/g5', `task94-live-${Date.now()}`)
      : resolve(resumeRoot);
  if (!root.startsWith(`${resolve('.data/g5')}/task94-live-`) || !/task94-live-\d+$/.test(root))
    throw new Error('live G5 resume root must be one of its own recorded task directories');
  await mkdir(root, { recursive: true });
  const scope = { projectId: 'agora', taskId: 'live-parallel' };
  // Prove the task owns an empty repository before any external model request.
  const repository = join(root, 'projects/agora/tasks/live-parallel/repository');
  const seed = new WorktreeGitService(new WorktreeRegistry(), repository);
  await seed.canonicalHead();
  expect((await stat(join(repository, '.git'))).isDirectory()).toBe(true);
  if (resumeRoot === undefined) expect(await readdir(repository)).toEqual(['.git']);
  await seed.dispose();
  const messages = createMessageRuntime(root, new ChannelStream());
  const cleanups: (() => Promise<unknown>)[] = [];
  const factory = createWebTaskCompositionFactory({
    dataRoot: root,
    sandboxConfig: { kind: 'docker', docker },
    executorOptions: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
  });
  const runtime = new TaskOrchestrationRuntime(messages, async (input) => {
    const composition = await factory(input);
    cleanups.push(() => composition.suspend());
    return composition;
  });
  const goal =
    'Build a modular API system with three small ES modules, no dependencies or package.json. Explicit executionPlan: A exports a = 2 from a.mjs; B exports b = 3 from b.mjs; A and B are independent. C depends on A and B, imports them and exports sum = a + b from c.mjs. Keep those exact subtask ids A, B, C. Use Node built-in tests in root *.test.mjs files: verify A and B after the first wave and add C acceptance only after C exists. Keep test files from earlier waves byte-for-byte and add new test files for new coverage. The Leader explicitly allows additional cumulative root test files including final.test.mjs; there is no six-file limit. Do not invent additional requirements. No extra features or documentation files. Each Coder implements only its assigned module and commits it. The final Reviewer checks all three modules and all current requirements.';
  let passed = false;
  const evidencePrefix = resumeRoot === undefined ? '' : 'resume-';
  try {
    if (resumeRoot === undefined) {
      const response = await createPostTask(runtime)(
        new Request('http://localhost/api/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...scope, requestId: 'start-live', goal }),
        }),
      );
      expect(response.status).toBe(202);
    } else {
      const paused = await messages.store.load(scope);
      const display = process.env.AGORA_G5_LEADER_DISPLAY;
      if (
        paused?.humanGate === undefined ||
        display === undefined ||
        !display.startsWith(`/resolve-gate ${paused.humanGate.gateId} `)
      )
        throw new Error(
          'resuming live G5 requires the human-approved command for its current gate',
        );
      const response = await createPostMessage(messages)(
        new Request('http://localhost/api/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...scope,
            channelId: 'main',
            msgId: 'leader-g5-objection-resolution',
            display,
          }),
        }),
      );
      expect(response.status, await response.clone().text()).toBe(202);
      expect(await response.json()).toMatchObject({ action: { status: 'applied' } });
    }
    await runtime.waitForIdle(scope);
    let state = (await messages.store.load(scope)) as AppState;
    const summary = await runtime.summary(scope);
    await writeFile(
      join(root, `${evidencePrefix}runtime-status.json`),
      JSON.stringify(summary, null, 2),
    );
    if (state.humanGate === undefined)
      throw new Error(`Live flow stopped before completion gate: ${JSON.stringify(summary)}`);
    expect(state.humanGate?.reason, JSON.stringify(await runtime.summary(scope))).toMatch(
      /^completion_confirmation:/,
    );
    expect(state.subtasks.map((node) => [node.id, node.status]).sort()).toEqual([
      ['A', 'done'],
      ['B', 'done'],
      ['C', 'done'],
    ]);
    const waves = state.messages.filter((message) => message.payload.kind === 'coding_wave');
    expect(waves[0]?.payload.subtaskIds).toEqual(['A', 'B']);
    expect(waves.some((message) => JSON.stringify(message.payload.subtaskIds) === '["C"]')).toBe(
      true,
    );
    const receipt = validationReceipt(state, state.parallelExecution?.acceptedReceiptId as string);
    expect(receipt.results).toMatchObject({ passed: true, failed: 0 });
    expect(receipt.results.total).toBeGreaterThanOrEqual(3);
    const validations = state.messages
      .filter((message) => message.payload.kind === 'wave_validation')
      .map((message) => validationReceipt(state, message.msgId));
    for (const earlier of validations.slice(0, -1))
      for (const path of (await readdir(earlier.worktree.path)).filter((path) =>
        path.endsWith('.test.mjs'),
      ))
        expect(await readFile(join(receipt.worktree.path, path), 'utf8')).toBe(
          await readFile(join(earlier.worktree.path, path), 'utf8'),
        );
    const trace = await new HarnessTraceReader(root).read(scope);
    const coders = trace.sessions.filter((session) => session.role === 'CODER');
    expect(coders.length).toBeGreaterThanOrEqual(3);
    const firstTurns = coders.slice(0, 2).map((session) => session.turns[0]);
    const overlapMs =
      Math.min(...firstTurns.map((turn) => turn?.endedAt ?? 0)) -
      Math.max(...firstTurns.map((turn) => turn?.startedAt ?? Infinity));
    expect(overlapMs).toBeGreaterThan(0);
    const approval = await createPostMessage(messages)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          channelId: 'main',
          msgId: 'approve-live',
          display: `/resolve-gate ${state.humanGate?.gateId} approve_completion`,
        }),
      }),
    );
    expect(approval.status, await approval.clone().text()).toBe(202);
    expect(await approval.json()).toMatchObject({ action: { status: 'applied' } });
    await runtime.waitForIdle(scope);
    state = (await messages.store.load(scope)) as AppState;
    expect(await runtime.summary(scope)).toMatchObject({ runStatus: 'completed', phase: 'done' });
    const artifact = join(root, 'projects/agora/tasks/live-parallel/artifacts/worktree');
    const fresh = new DockerSandbox({ docker, baseDir: root });
    cleanups.push(() => fresh.teardown('fresh-artifact'));
    const worktree = await fresh.createWorktree('fresh-artifact', 'verify');
    await cp(artifact, worktree.path, { recursive: true });
    const tests = (await readdir(artifact)).filter((file) =>
      /^[A-Za-z0-9._-]+\.test\.mjs$/.test(file),
    );
    expect(tests.length).toBeGreaterThan(0);
    const run = await fresh.run(
      worktree,
      `node --test --test-reporter=tap ${tests.map((file) => `'${file}'`).join(' ')}`,
    );
    expect(run).toMatchObject({ exitCode: 0, timedOut: false });
    expect(run.stdout).toContain('# fail 0');
    await writeFile(
      join(root, `${evidencePrefix}observations.json`),
      JSON.stringify(
        {
          scope,
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          waves: waves.map((wave) => wave.payload.subtaskIds),
          sessionCount: trace.sessions.length,
          firstCoderOverlapMs: overlapMs,
          receipt,
          artifactRerun: run,
        },
        null,
        2,
      ),
    );
    passed = true;
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await writeFile(
      join(root, `${evidencePrefix}result.json`),
      JSON.stringify(
        { passed, cleanupCompleted: true, scope, completedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    console.info(`Task 9.4 live G5 evidence: ${root}`);
  }
}, 600_000);
