// Explicit live G5 probe, excluded from default tests and benchmark metrics.
// Every dependency, including the model, production composition and Docker tools, is real.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessTraceReader } from '@agora/runtime-executor';
import { Dockerode } from '@agora/runtime-sandbox';
import { JsonModelConfigStore } from '@agora/runtime-state';
import { expect, it } from 'vitest';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { ModelSettingsService } from '../../../apps/web/src/server/model-settings';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import type { TaskComposition } from '../../../apps/web/src/server/task-orchestration-runtime';

it('phase10 compatible model live G5 uses encrypted configuration in the production composition', async () => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for the explicit live probe');
  const root = await mkdtemp(join(tmpdir(), 'agora-compatible-live-'));
  const key = randomBytes(32).toString('base64');
  const scope = { projectId: 'compatible-live', taskId: 'probe' };
  const goal =
    'Use fs_write to write model-connection.txt with exactly compatible-ok. Then use sandbox_run to run node -e "console.log(40+2)". Verify stdout is 42, then reply briefly. Do both tool calls.';
  let composition: TaskComposition | undefined;
  try {
    const messages = new MessageRuntime(root, new ChannelStream(), DEFAULT_ROSTER);
    const settings = new ModelSettingsService(messages, new JsonModelConfigStore(root, () => key));
    await settings.get(scope.projectId);
    await messages.roster.addRole(scope.projectId, {
      role: 'CONNECTION_PROBE',
      executor: 'harness',
      systemPrompt:
        'Execute the precise tool verification in the projected goal. Use the available tools. Do not merely describe the steps.',
      tools: ['fs.write', 'sandbox.run'],
      projection: ['global.summary'],
      routeWhen: 'leaderAssignment',
    });
    const view = await settings.get(scope.projectId);
    await settings.execute({
      action: 'save',
      projectId: scope.projectId,
      expectedRevision: view.revision,
      target: 'CONNECTION_PROBE',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      auth: 'replace',
      apiKey,
      contextWindow: 32768,
      maxTokens: 4096,
    });
    const initial = await messages.initialize(scope, goal);
    const socket = join(process.env.HOME ?? '', '.docker/run/docker.sock');
    const docker = new Dockerode(existsSync(socket) ? { socketPath: socket } : {});
    await docker.ping();
    composition = await createWebTaskCompositionFactory({
      dataRoot: root,
      sandboxConfig: { kind: 'docker', docker },
      modelSettings: settings,
    })({
      scope,
      goal,
      loadState: () => messages.store.load(scope),
      transition: async (_, mutations) => (await messages.commitMutations(scope, mutations)).state,
      handleOutput: async () => {},
      buildChannelContext: (state, role) => messages.channelContextFor(state, role),
      loadRoster: () => messages.enabledRoleSpecs(scope.projectId),
    });
    const state = await composition.workerRuntime.runOne(initial, {
      role: 'CONNECTION_PROBE',
      workerId: 'live-probe',
    });
    const worker = state.workers.find((w) => w.workerId === 'live-probe');
    expect(worker?.status).toBe('done');
    const worktree = worker?.worktree;
    if (!worktree || typeof worktree === 'string') throw new Error('missing real worktree');
    expect(await readFile(join(worktree.path, 'model-connection.txt'), 'utf8')).toBe(
      'compatible-ok',
    );
    await composition.saveSafePoints();
    const trace = await new HarnessTraceReader(root).read(scope);
    const tools = trace.sessions.flatMap((s) =>
      s.turns.flatMap((t) => t.steps.flatMap((step) => step.tools)),
    );
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'fs_write', status: 'succeeded' }),
        expect.objectContaining({ name: 'sandbox_run', status: 'succeeded' }),
      ]),
    );
    expect(JSON.stringify(trace)).not.toContain(apiKey);
    expect(JSON.stringify(state)).not.toContain(apiKey);
    expect(
      (await settings.store.loadTask(scope))?.roles.find((r) => r.role === 'CONNECTION_PROBE'),
    ).toMatchObject({ model: 'deepseek-v4-flash', connectionId: expect.any(String) });
  } finally {
    await composition?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
