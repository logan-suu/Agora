// Explicit product-launch G5: real Keychain, Next, HTTP, Harness, Docker, MCP and Git.
// The compatible provider is scripted to isolate infrastructure; a separate live probe uses DeepSeek.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessTraceReader } from '@agora/runtime-executor';
import { Dockerode } from '@agora/runtime-sandbox';
import { initializeLocalCredentials, JsonModelConfigStore } from '@agora/runtime-state';
import { expect, it } from 'vitest';
import { childEnvironment, keychainStore } from '../../../apps/web/scripts/local-process.mjs';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { ModelSettingsService } from '../../../apps/web/src/server/model-settings';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import type { TaskComposition } from '../../../apps/web/src/server/task-orchestration-runtime';
import { finishWithCleanup } from '../../integration/phase10/cleanup';

const exec = promisify(execFile);
const repo = resolve('.');
it('phase10 macOS launcher persists Keychain settings across real server restart and consumes them in production tools', async () => {
  if (process.platform !== 'darwin') throw new Error('This explicit product G5 requires macOS.');
  const root = await mkdtemp(join(tmpdir(), 'agora104-product-'));
  const dataRoot = join(root, 'data');
  const keychain = join(root, 'test.keychain-db');
  const service = `com.agora.product-test.${randomUUID()}`;
  const password = randomBytes(24).toString('hex');
  const system = keychainStore(resolve(`packages/runtime/state/build/keychain-${process.arch}`), {
    keychain,
    service,
    account: 'test',
  });
  let created = false;
  let child: ChildProcess | undefined;
  let composition: TaskComposition | undefined;
  let log = '';
  let toolCalls = 0;
  let holdRequest: Promise<void> | undefined;
  let requestArrived: (() => void) | undefined;
  const modelRequests: { auth?: string; model: string }[] = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requestArrived?.();
    await holdRequest;
    modelRequests.push({
      model: body.model,
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
    });
    const actions = [
      {
        name: 'fs_write',
        arguments: JSON.stringify({ path: 'startup-proof.txt', content: 'keychain-restart-ok' }),
      },
      {
        name: 'sandbox_run',
        arguments: JSON.stringify({
          cmd: 'node -e "if (process.env.AGORA_CREDENTIALS_KEY) process.exit(1); console.log(42)"',
        }),
      },
    ];
    const action = body.tools?.length ? actions[toolCalls++] : undefined;
    const delta = action
      ? {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: `startup-${toolCalls}`, type: 'function', function: action },
          ],
        }
      : { role: 'assistant', content: 'OK' };
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'startup', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`${chunk(delta, null)}${chunk({}, action ? 'tool_calls' : 'stop')}data: [DONE]\n\n`);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerPort = (provider.address() as { port: number }).port;
  const free = createServer();
  free.listen(0, '127.0.0.1');
  await once(free, 'listening');
  const port = (free.address() as { port: number }).port;
  await new Promise<void>((done) => free.close(() => done()));
  const url = `http://127.0.0.1:${port}`;
  const script = join(root, 'launch.mjs');
  const env = { ...childEnvironment(), AGORA_DATA_ROOT: dataRoot };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    await exec(process.execPath, ['apps/web/scripts/local.mjs', 'stop'], {
      cwd: repo,
      env,
      timeout: 30000,
    });
    await exited;
    child = undefined;
  };
  const start = async () => {
    child = spawn(process.execPath, [script, 'start', '--port', String(port)], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (bytes) => {
      log += bytes.toString();
    });
    child.stderr?.on('data', (bytes) => {
      log += bytes.toString();
    });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Product startup failed: ${log}`);
      try {
        const r = await fetch(`${url}/api/model-settings?projectId=p`);
        if (r.ok) return await r.json();
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Product startup timed out');
  };
  const post = async (body: unknown) => {
    const response = await fetch(`${url}/api/model-settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  const errors: unknown[] = [];
  try {
    await exec('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
    created = true;
    await exec('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
    await writeFile(
      script,
      `import { runLocal, reportStartupFailure } from ${JSON.stringify(`file://${repo}/apps/web/scripts/local.mjs`)};\nimport { keychainStore } from ${JSON.stringify(`file://${repo}/apps/web/scripts/local-process.mjs`)};\nrunLocal(keychainStore(${JSON.stringify(resolve(`packages/runtime/state/build/keychain-${process.arch}`))}, ${JSON.stringify({ keychain, service, account: 'test' })})).catch(reportStartupFailure);\n`,
    );
    const initial = await start();
    expect(initial.credentialsAvailable).toBe(true);
    const command = {
      action: 'save',
      projectId: 'p',
      expectedRevision: initial.revision,
      target: 'all',
      model: 'startup-model',
      baseURL: `http://127.0.0.1:${providerPort}/v1`,
      auth: 'replace',
      apiKey: 'startup-test-private-key',
      contextWindow: 32768,
      maxTokens: 4096,
    };
    const saved = await post(command);
    await expect(
      exec(process.execPath, [script, 'start', '--port', String(port + 1)], { cwd: repo, env }),
    ).rejects.toThrow();
    await stop();
    const restarted = await start();
    expect(restarted.credentialsAvailable).toBe(true);
    expect(restarted.roles).toEqual(saved.roles);
    await post({
      ...command,
      action: 'test',
      expectedRevision: restarted.revision,
      auth: 'keep',
      apiKey: '',
      connectionId: restarted.roles[0].connectionId,
    });
    expect(modelRequests.at(-1)?.auth === `Bearer ${command.apiKey}`).toBe(true);
    const forbidden = await fetch(`${url}/api/tasks`, {
      method: 'POST',
      headers: { origin: 'https://example.com', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(forbidden.status).toBe(403);
    let releaseRequest: () => void = () => {};
    holdRequest = new Promise<void>((done) => {
      releaseRequest = done;
    });
    const arrived = new Promise<void>((done) => {
      requestArrived = done;
    });
    const pendingRequest = post({
      ...command,
      action: 'test',
      expectedRevision: restarted.revision,
      auth: 'keep',
      apiKey: '',
      connectionId: restarted.roles[0].connectionId,
    });
    const requestResult = pendingRequest.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await arrived;
    let stopped = false;
    const stopResult = stop().then(
      () => {
        stopped = true;
      },
      (error: unknown) => {
        stopped = true;
        return error;
      },
    );
    try {
      await new Promise((done) => setTimeout(done, 500));
      expect(log).toContain('Stopping: waiting for active work');
      expect(stopped).toBe(false);
    } finally {
      releaseRequest();
      holdRequest = undefined;
      requestArrived = undefined;
      await Promise.all([requestResult, stopResult]);
    }
    expect(await requestResult).toEqual({ value: { ok: true } });
    expect(await stopResult).toBeUndefined();
    const credentials = await initializeLocalCredentials(dataRoot, system);
    const messages = new MessageRuntime(dataRoot, new ChannelStream(), DEFAULT_ROSTER);
    const settings = new ModelSettingsService(
      messages,
      new JsonModelConfigStore(dataRoot, credentials.key),
    );
    const scope = { projectId: 'p', taskId: 'startup-g5' };
    const goal = 'Write startup-proof.txt and execute the verification command.';
    const initialState = await messages.initialize(scope, goal);
    const socket = join(process.env.HOME ?? '', '.docker/run/docker.sock');
    const docker = new Dockerode(existsSync(socket) ? { socketPath: socket } : {});
    composition = await createWebTaskCompositionFactory({
      dataRoot,
      sandboxConfig: { kind: 'docker', docker },
      modelSettings: settings,
    })({
      scope,
      goal,
      loadState: () => messages.store.load(scope),
      transition: async (_, mutations) => (await messages.commitMutations(scope, mutations)).state,
      handleOutput: async () => {},
      buildChannelContext: (state, role) => messages.channelContextFor(state, role),
      loadRoster: () => messages.enabledRoleSpecs('p'),
    });
    const state = await composition.workerRuntime.runOne(initialState, {
      role: 'CODER',
      workerId: 'startup-coder',
    });
    const worktree = state.workers.find((w) => w.workerId === 'startup-coder')?.worktree;
    if (!worktree || typeof worktree === 'string') throw new Error('Production worktree missing');
    expect(await readFile(join(worktree.path, 'startup-proof.txt'), 'utf8')).toBe(
      'keychain-restart-ok',
    );
    await composition.saveSafePoints();
    const trace = await new HarnessTraceReader(dataRoot).read(scope);
    const tools = trace.sessions.flatMap((s) =>
      s.turns.flatMap((t) => t.steps.flatMap((s) => s.tools)),
    );
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'fs_write', status: 'succeeded' }),
        expect.objectContaining({ name: 'sandbox_run', status: 'succeeded' }),
      ]),
    );
    expect(log.includes(credentials.key() ?? 'no-key')).toBe(false);
    expect(JSON.stringify(trace).includes(command.apiKey)).toBe(false);
    expect(
      modelRequests.every(
        (r) => r.model === 'startup-model' && r.auth === `Bearer ${command.apiKey}`,
      ),
    ).toBe(true);
  } catch (error) {
    errors.push(error);
  } finally {
    await finishWithCleanup(errors, [
      () => composition?.dispose(),
      stop,
      () => new Promise<void>((done) => provider.close(() => done())),
      async () => {
        if (created) await exec('/usr/bin/security', ['delete-keychain', keychain]);
      },
      () => rm(root, { recursive: true, force: true }),
    ]);
  }
}, 180000);
