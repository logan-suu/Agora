// Explicit macOS Keychain + live model G5, excluded from default tests and benchmark metrics.
// Every dependency, including the model, production composition and Docker tools, is real.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessTraceReader } from '@agora/runtime-executor';
import { Dockerode } from '@agora/runtime-sandbox';
import { initializeLocalCredentials, JsonModelConfigStore } from '@agora/runtime-state';
import { expect, it } from 'vitest';
import { keychainStore } from '../../../apps/web/scripts/local-process.mjs';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { ModelSettingsService } from '../../../apps/web/src/server/model-settings';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import type { TaskComposition } from '../../../apps/web/src/server/task-orchestration-runtime';
import { finishWithCleanup } from '../../integration/phase10/cleanup';

it('phase10 macOS automatic Keychain live G5 uses persisted credentials in the production composition', async () => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for the explicit live probe');
  if (process.platform !== 'darwin') throw new Error('This explicit G5 requires macOS.');
  const root = await mkdtemp(join(tmpdir(), 'agora-compatible-live-'));
  const exec = promisify(execFile);
  const keychain = join(root, 'test.keychain-db');
  const password = randomBytes(24).toString('hex');
  let key: string | undefined;
  let created = false;
  const scope = { projectId: 'compatible-live', taskId: 'probe' };
  const goal =
    'Use fs_write to write model-connection.txt with exactly compatible-ok. Then use sandbox_run to run node -e "console.log(40+2)". Verify stdout is 42, then reply briefly. Do both tool calls.';
  let composition: TaskComposition | undefined;
  const errors: unknown[] = [];
  try {
    await exec('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
    created = true;
    await exec('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
    const system = keychainStore(resolve(`packages/runtime/state/build/keychain-${process.arch}`), {
      keychain,
      service: 'com.agora.live-g5',
      account: 'test',
    });
    const initialized = await initializeLocalCredentials(root, system);
    expect(initialized.status).toBe('ready');
    key = initialized.key();
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
    const restarted = await initializeLocalCredentials(root, system);
    expect(restarted.key() === key).toBe(true);
    key = restarted.key();
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
  } catch (error) {
    errors.push(error);
  } finally {
    await finishWithCleanup(errors, [
      () => composition?.dispose(),
      async () => {
        if (created) await exec('/usr/bin/security', ['delete-keychain', keychain]);
      },
      () => rm(root, { recursive: true, force: true }),
    ]);
  }
}, 180000);
