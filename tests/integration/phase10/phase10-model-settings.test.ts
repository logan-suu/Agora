// Only HTTP provider replies are scripted. Harness, HTTP/SSE, MCP, Docker, Git,
// roster CAS, encrypted storage, worker leases, TaskState and session Fork are real.
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { PHASE0_ROSTER } from '@agora/core-domain';
import { GlobalScheduler, WorkerRuntime } from '@agora/core-orchestration';
import { HarnessExecutor, HarnessTraceReader, project } from '@agora/runtime-executor';
import { Dockerode, DockerSandbox } from '@agora/runtime-sandbox';
import { JsonModelConfigStore } from '@agora/runtime-state';
import { createToolCatalog, type ToolCatalog } from '@agora/tools-bridge';
import { WorktreeRegistry } from '@agora/tools-fs';
import { initializeRegisteredWorktree, WorktreeGitService } from '@agora/tools-git';
import { expect, it } from 'vitest';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { ModelSettingsService } from '../../../apps/web/src/server/model-settings';

// Node 24 provides Zstandard; the repository retains @types/node 20 for its sandbox surface.
const { zstdDecompressSync } = zlib as typeof zlib & {
  zstdDecompressSync(data: Uint8Array): Buffer;
};

it('runs frozen per-Agent connections through real tools, canonical state and a fresh session Fork', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-model-g5-'));
  const key = randomBytes(32).toString('base64');
  const scope = { projectId: 'models', taskId: 'original' };
  const secret = 'test-model-private-key';
  const requests: {
    model: string;
    url: string | undefined;
    auth: string | undefined;
    maxTokens: number;
    tools: string[];
  }[] = [];
  let coderCalls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({
      model: body.model,
      url: req.url,
      auth: req.headers.authorization,
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
      tools: (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name),
    });
    const actions = [
      {
        name: 'fs_write',
        arguments: JSON.stringify({ path: 'proof.txt', content: 'model-configured' }),
      },
      { name: 'sandbox_run', arguments: JSON.stringify({ cmd: 'node -e "console.log(40+2)"' }) },
      { name: 'git_applyPatch', arguments: JSON.stringify({ patch: '' }) },
    ];
    const action = body.model === 'coder-original' ? actions[coderCalls++] : undefined;
    const delta = action
      ? {
          role: 'assistant',
          tool_calls: [{ index: 0, id: `tool-${coderCalls}`, type: 'function', function: action }],
        }
      : { role: 'assistant', content: 'Verified configured model.' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (value: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'g5', object: 'chat.completion.chunk', model: body.model, created: 1, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    res.end(`${chunk(delta, null)}${chunk({}, action ? 'tool_calls' : 'stop')}data: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const socket = join(process.env.HOME ?? '', '.docker/run/docker.sock');
  const docker = new Dockerode(existsSync(socket) ? { socketPath: socket } : {});
  const sandbox = new DockerSandbox({ docker });
  const registry = new WorktreeRegistry();
  const git = new WorktreeGitService(registry);
  const executors: HarnessExecutor[] = [];
  let catalog: ToolCatalog | undefined;
  try {
    await docker.ping();
    const messages = new MessageRuntime(root, new ChannelStream(), PHASE0_ROSTER);
    const settings = new ModelSettingsService(messages, new JsonModelConfigStore(root, () => key));
    let view = await settings.get(scope.projectId);
    const command = {
      action: 'save' as const,
      projectId: scope.projectId,
      target: 'all',
      model: 'coder-original',
      baseURL: `http://127.0.0.1:${port}/coder`,
      contextWindow: 32768,
      maxTokens: 4096,
      auth: 'replace' as const,
      apiKey: secret,
    };
    await settings.execute({ ...command, expectedRevision: view.revision });
    view = await settings.get(scope.projectId);
    await settings.execute({
      ...command,
      expectedRevision: view.revision,
      target: 'TESTER',
      baseURL: `http://127.0.0.1:${port}/tester`,
      model: 'tester-model',
      auth: 'none',
      apiKey: '',
    });
    const binding = await settings.freeze(scope, 'Verify model configuration');
    const routes = await settings.executorRoutes(binding);
    const worktree = await sandbox.createWorktree(scope.taskId, 'CODER');
    await initializeRegisteredWorktree(registry, worktree.path);
    const base = await git.headOf(worktree.path);
    catalog = await createToolCatalog({
      sandbox,
      registry,
      gitService: git,
      getWorktree: async () => worktree,
    });
    const persistence = {
      root: join(root, 'projects', scope.projectId, 'tasks', scope.taskId, 'harness-sessions'),
      cwd: worktree.path,
      ...scope,
    };
    const scheduler = new GlobalScheduler({ cap: 1 });
    const make = (role: string, resumeSessionId?: string) => {
      const spec = PHASE0_ROSTER.find((r) => r.role === role);
      const route = routes.get(role);
      if (!spec || !route?.compatible || !catalog) throw new Error('missing configured role');
      const tools = catalog.resolve(spec.tools);
      const executor = new HarnessExecutor(
        { ...spec, model: route.model },
        {
          compatible: route.compatible,
          tools: tools.definitions,
          allowTools: tools.allowNames,
          sessionPersistence: { ...persistence, ...(resumeSessionId ? { resumeSessionId } : {}) },
        },
      );
      executors.push(executor);
      return executor;
    };
    const initial = await messages.initialize(scope, 'Verify model configuration');
    const worker = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        loadState: () => messages.store.load(scope),
        transition: async (_, mutations) =>
          (await messages.commitMutations(scope, mutations)).state,
        buildExecutor: (spec) => make(spec.role),
      },
      scheduler,
    );
    let state = await worker.runOne(initial, { role: 'CODER', workerId: 'coder-1' });
    expect(await sandbox.read(worktree, 'proof.txt')).toBe('model-configured');
    expect(await git.headOf(worktree.path)).not.toBe(base);
    expect(requests[0]?.tools).toContain('fs_write');
    expect(
      requests
        .filter((r) => r.model === 'coder-original')
        .every(
          (r) =>
            r.auth === `Bearer ${secret}` &&
            r.maxTokens === 4096 &&
            r.url === '/coder/chat/completions',
        ),
    ).toBe(true);
    const original = executors[0];
    if (!original) throw new Error('missing original session');
    const checkpoint = await original.saveSafePoint();
    await original.dispose();
    executors.splice(0, 1);
    view = await settings.get(scope.projectId);
    await settings.execute({ ...command, expectedRevision: view.revision, model: 'new-model' });
    expect(await settings.freeze(scope, 'Verify model configuration')).toEqual(binding);
    expect(
      (await settings.freeze({ ...scope, taskId: 'next' }, 'Next')).roles.every(
        (r) => r.model === 'new-model',
      ),
    ).toBe(true);
    state = await worker.runOne(state, { role: 'TESTER', workerId: 'tester-1' });
    await executors.at(-1)?.saveSafePoint();
    expect(requests.at(-1)).toMatchObject({
      model: 'tester-model',
      url: '/tester/chat/completions',
      auth: undefined,
    });
    const child = make('CODER', 'configured-child');
    await child.loadSafePoint(checkpoint);
    await child.step({
      sessionId: 'configured-child',
      view: project(state, 'CODER', PHASE0_ROSTER),
    });
    await child.saveSafePoint();
    expect(requests.at(-1)?.model).toBe('coder-original');
    expect(scheduler.activeCount).toBe(0);
    const trace = await new HarnessTraceReader(root).read(scope);
    expect(trace.sessions).toHaveLength(3);
    expect(
      trace.sessions.find((s) => s.sessionId === 'configured-child')?.parentSessionId,
    ).toBeDefined();
    expect(JSON.stringify(trace)).not.toContain(secret);
    const logs = await readdir(persistence.root, { recursive: true });
    const raw = (
      await Promise.all(
        logs
          .filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd'))
          .map(async (f) => {
            const data = await readFile(join(persistence.root, f));
            return (f.endsWith('.zstd') ? zstdDecompressSync(data) : data).toString('utf8');
          }),
      )
    ).join('\n');
    expect(raw).toContain('configured-child');
    expect(raw).not.toContain(secret);
    expect(JSON.stringify(await messages.store.load(scope))).not.toContain(secret);
    const wrongRoute = { ...routes.get('CODER')?.compatible, model: 'wrong' };
    const spec = PHASE0_ROSTER.find((r) => r.role === 'CODER');
    if (
      !spec ||
      !wrongRoute.id ||
      !wrongRoute.baseURL ||
      !wrongRoute.contextWindow ||
      !wrongRoute.maxTokens ||
      !wrongRoute.resolveApiKey
    )
      throw new Error('missing route');
    const wrong = new HarnessExecutor(
      { ...spec, model: 'wrong' },
      {
        compatible: {
          id: wrongRoute.id,
          baseURL: wrongRoute.baseURL,
          model: 'wrong',
          contextWindow: wrongRoute.contextWindow,
          maxTokens: wrongRoute.maxTokens,
          resolveApiKey: wrongRoute.resolveApiKey,
        },
        sessionPersistence: { ...persistence, resumeSessionId: 'wrong-child' },
      },
    );
    executors.push(wrong);
    await expect(wrong.loadSafePoint(checkpoint)).rejects.toThrow('model configuration');
  } finally {
    await Promise.all(executors.map((e) => e.dispose()));
    await catalog?.dispose();
    await git.dispose();
    await sandbox.teardown(scope.taskId);
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
