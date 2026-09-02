// R11/G5: only the external LLM summary boundary is scripted for deterministic automation.
// HTTP/SSE, MessageRuntime, JsonTaskStateStore, JsonProjectChannelStore, Channel lifecycle,
// MessageService, role projection, summary reconciliation, filesystem persistence, and Eval runner
// use their real implementations. The full deterministic Eval command supplies Docker G5 evidence.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { ChannelSummary, Message, SubChannel } from '@agora/core-domain';
import type { ChannelSummaryGenerator, ChannelSummarySourceEntry } from '@agora/runtime-executor';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import {
  createGetChannels,
  createGetStream,
  createPostMessage,
} from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { fingerprintTask } from '../../evals/core/contracts';
import { runEvalTask } from '../../evals/core/runner';
import { executeDeterministicScenario, PHASE6_MODEL_CONFIG } from '../../evals/phase6/scenarios';
import { PHASE6_EVAL_TASKS } from '../../evals/phase6/tasks';

const decoder = new TextDecoder();
const roots: string[] = [];
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function messageRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/messages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function openStream(
  runtime: ReturnType<typeof createMessageRuntime>,
  projectId: string,
  taskId: string,
  channelId: string,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await createGetStream(runtime)(
    new Request(
      `http://localhost/api/stream?projectId=${projectId}&taskId=${taskId}&channelId=${channelId}`,
    ),
  );
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('expected Phase 6 SSE response body');
  readers.push(reader);
  expect(decoder.decode((await reader.read()).value)).toContain('event: connected');
  expect(decoder.decode((await reader.read()).value)).toContain('event: snapshot');
  return reader;
}

function workerMessage(msgId: string, channelId: string, fromRole: 'CODER' | 'TESTER'): Message {
  return {
    msgId,
    channelId,
    fromRole,
    type: 'feedback',
    payload: { reason: `${fromRole.toLowerCase()}-fact`, secret: `${fromRole}-secret` },
    display: `${fromRole} raw display`,
    ts: 10,
  };
}

class ScopedSummaryGenerator implements ChannelSummaryGenerator {
  readonly calls: Array<{ channelId: string; sourceMsgIds: string[] }> = [];

  async generate(input: {
    channel: SubChannel;
    entries: readonly ChannelSummarySourceEntry[];
  }): Promise<ChannelSummary> {
    const sourceMsgIds = input.entries.map((entry) => entry.ref.msgId);
    this.calls.push({ channelId: input.channel.channelId, sourceMsgIds });
    return {
      conclusion: `Closed ${input.channel.topic}`,
      keyDecisions: [],
      openQuestions: [],
      sourceMsgIds,
    };
  }
}

afterEach(async () => {
  await Promise.all(readers.splice(0).map((reader) => reader.cancel().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 6 multi-channel communication exit chain', () => {
  it('isolates concurrent sub-channel traffic, bubbles each conclusion, and recovers idempotently', async () => {
    const root = await temporaryRoot('agora-phase6-channel-exit-');
    const projectId = 'phase6-project';
    const taskId = 'phase6-task';
    const scope = { projectId, taskId };
    const generator = new ScopedSummaryGenerator();
    const runtime = createMessageRuntime(root, new ChannelStream(), undefined, generator);
    await runtime.initialize(scope, 'Coordinate two private investigations');
    const post = createPostMessage(runtime);

    const [coderOpen, testerOpen] = await Promise.all([
      post(
        messageRequest({
          ...scope,
          channelId: 'main',
          msgId: 'open-coder',
          display: '/channel open CODER Cache correctness',
        }),
      ),
      post(
        messageRequest({
          ...scope,
          channelId: 'main',
          msgId: 'open-tester',
          display: '/channel open TESTER Regression coverage',
        }),
      ),
    ]);
    expect([coderOpen.status, testerOpen.status]).toEqual([202, 202]);
    await expect(coderOpen.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'applied' },
      published: true,
    });
    await expect(testerOpen.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'applied' },
      published: true,
    });

    const channelsResponse = await createGetChannels(runtime)(
      new Request(`http://localhost/api/channels?projectId=${projectId}&taskId=${taskId}`),
    );
    expect(channelsResponse.status).toBe(200);
    const channelBody = (await channelsResponse.json()) as {
      channels: Array<Record<string, unknown>>;
    };
    const subChannels = channelBody.channels.filter(
      (channel): channel is Record<string, unknown> & { channelId: string; topic: string } =>
        channel.kind === 'sub' &&
        typeof channel.channelId === 'string' &&
        typeof channel.topic === 'string',
    );
    expect(subChannels).toHaveLength(2);
    expect(JSON.stringify(channelBody)).not.toContain('bubbledSummaryRef');
    const coderChannel = subChannels.find((channel) => channel.topic === 'Cache correctness');
    const testerChannel = subChannels.find((channel) => channel.topic === 'Regression coverage');
    if (coderChannel === undefined || testerChannel === undefined) {
      throw new Error('expected both Phase 6 sub-channels');
    }

    const [coderReader, testerReader] = await Promise.all([
      openStream(runtime, projectId, taskId, coderChannel.channelId),
      openStream(runtime, projectId, taskId, testerChannel.channelId),
    ]);
    await Promise.all([
      runtime.commitMessage(scope, workerMessage('coder-fact', coderChannel.channelId, 'CODER')),
      runtime.commitMessage(scope, workerMessage('tester-fact', testerChannel.channelId, 'TESTER')),
    ]);

    const [coderEvent, testerEvent] = await Promise.all([coderReader.read(), testerReader.read()]);
    const coderFrame = decoder.decode(coderEvent.value);
    const testerFrame = decoder.decode(testerEvent.value);
    expect(coderFrame).toContain('"msgId":"coder-fact"');
    expect(coderFrame).not.toContain('tester-fact');
    expect(testerFrame).toContain('"msgId":"tester-fact"');
    expect(testerFrame).not.toContain('coder-fact');
    expect(`${coderFrame}${testerFrame}`).not.toContain('payload');
    expect(`${coderFrame}${testerFrame}`).not.toContain('secret');

    const stateBeforeClose = await runtime.store.load(scope);
    if (stateBeforeClose === undefined) throw new Error('expected persisted Phase 6 state');
    const coderContext = await runtime.channelContextFor(stateBeforeClose, 'CODER');
    const testerContext = await runtime.channelContextFor(stateBeforeClose, 'TESTER');
    expect(coderContext.map((channel) => channel.channelId)).toContain(coderChannel.channelId);
    expect(coderContext.map((channel) => channel.channelId)).not.toContain(testerChannel.channelId);
    expect(testerContext.map((channel) => channel.channelId)).toContain(testerChannel.channelId);
    expect(testerContext.map((channel) => channel.channelId)).not.toContain(coderChannel.channelId);
    expect(JSON.stringify([...coderContext, ...testerContext])).not.toContain('raw display');
    expect(JSON.stringify([...coderContext, ...testerContext])).not.toContain('secret');

    const [coderClose, testerClose] = await Promise.all([
      post(
        messageRequest({
          ...scope,
          channelId: 'main',
          msgId: 'close-coder',
          display: `/channel close ${coderChannel.channelId}`,
        }),
      ),
      post(
        messageRequest({
          ...scope,
          channelId: 'main',
          msgId: 'close-tester',
          display: `/channel close ${testerChannel.channelId}`,
        }),
      ),
    ]);
    expect([coderClose.status, testerClose.status]).toEqual([202, 202]);
    await expect(coderClose.json()).resolves.toMatchObject({ action: { status: 'applied' } });
    await expect(testerClose.json()).resolves.toMatchObject({ action: { status: 'applied' } });

    const finalState = await runtime.store.load(scope);
    const finalChannels = await runtime.channels.load(projectId);
    if (finalState === undefined || finalChannels === undefined) {
      throw new Error('expected persisted Phase 6 facts');
    }
    const summaryMessages = finalState.messages.filter(
      (message) => message.type === 'announce' && message.payload.kind === 'channel_summary',
    );
    expect(summaryMessages).toHaveLength(2);
    expect(
      summaryMessages.map((message) => ({
        channelId: message.payload.channelId,
        fromRole: message.fromRole,
        target: message.channelId,
        sourceMsgIds: (message.payload.summary as ChannelSummary).sourceMsgIds,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          channelId: coderChannel.channelId,
          fromRole: 'COORDINATOR',
          target: 'main',
          sourceMsgIds: ['coder-fact'],
        },
        {
          channelId: testerChannel.channelId,
          fromRole: 'COORDINATOR',
          target: 'main',
          sourceMsgIds: ['tester-fact'],
        },
      ]),
    );
    for (const channel of finalChannels.channels) {
      if (channel.kind !== 'sub') continue;
      expect(channel.closed).toBe(true);
      expect(channel.bubbledSummaryRef).toEqual({
        taskId,
        msgId: `channel-bubble:${channel.channelId}`,
      });
    }
    expect(generator.calls).toEqual(
      expect.arrayContaining([
        { channelId: coderChannel.channelId, sourceMsgIds: ['coder-fact'] },
        { channelId: testerChannel.channelId, sourceMsgIds: ['tester-fact'] },
      ]),
    );

    const restartGenerator = new ScopedSummaryGenerator();
    const restarted = createMessageRuntime(root, new ChannelStream(), undefined, restartGenerator);
    await restarted.reconcileChannels(scope);
    expect(restartGenerator.calls).toHaveLength(0);
    expect(await restarted.store.load(scope)).toEqual(finalState);
    expect(await restarted.channels.load(projectId)).toEqual(finalChannels);
  });
});

describe('Phase 6 Eval exit contract', () => {
  it('keeps profiles and fingerprints auditable while a real run stays inside its eval root', async () => {
    const root = await temporaryRoot('agora-phase6-eval-exit-');
    const dataRoot = join(root, '.data');
    const productSentinel = join(dataRoot, 'projects', 'user-project', 'state.json');
    const kbSentinel = join(dataRoot, 'kb', 'sentinel.json');
    await mkdir(join(dataRoot, 'projects', 'user-project'), { recursive: true });
    await mkdir(join(dataRoot, 'kb'), { recursive: true });
    await writeFile(productSentinel, '{"owner":"user"}\n', 'utf8');
    await writeFile(kbSentinel, '{"writeBlocked":true}\n', 'utf8');

    const summary = JSON.parse(
      await readFile('tests/evals/phase6/baseline-summary.json', 'utf8'),
    ) as {
      runnerVersion: string;
      profiles: {
        deterministic: { attemptsPerTask: number; passedTasks: number; tasks: number };
        model: { attemptsPerTask: number; completedTasks: number; eligibleTasks: number };
      };
      taskFingerprints: Record<string, string>;
    };
    expect(PHASE6_EVAL_TASKS).toHaveLength(10);
    expect(summary.taskFingerprints).toEqual(
      Object.fromEntries(PHASE6_EVAL_TASKS.map((task) => [task.id, fingerprintTask(task)])),
    );
    expect(summary.profiles.deterministic).toMatchObject({
      attemptsPerTask: 1,
      passedTasks: 10,
      tasks: 10,
    });
    expect(summary.profiles.model).toMatchObject({
      attemptsPerTask: 1,
      completedTasks: 1,
      eligibleTasks: 1,
    });

    const task = PHASE6_EVAL_TASKS.find((candidate) => candidate.id === 'phase6/main-scope');
    if (task === undefined) throw new Error('expected Phase 6 main-scope Eval task');
    const result = await runEvalTask({
      task,
      profile: 'deterministic',
      attempt: 2,
      evalRoot: join(dataRoot, 'evals'),
      runnerVersion: summary.runnerVersion,
      systemVariant: 'multi-agent-role-projection',
      modelConfig: { provider: 'scripted', model: 'phase6-fixture-v1', parameters: {} },
      environment: {
        sandbox: 'isolated-node',
        imageOrRuntime: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      execute: (context) => executeDeterministicScenario(task, context),
    });

    expect(result).toMatchObject({
      lifecycle: 'final',
      overallStatus: 'pass',
      taskFingerprint: fingerprintTask(task),
      runnerVersion: summary.runnerVersion,
      attempt: 2,
      profile: 'deterministic',
      modelConfig: { provider: 'scripted', model: 'phase6-fixture-v1' },
    });
    expect(result.modelConfig).not.toEqual(PHASE6_MODEL_CONFIG);
    expect(result.checks.length).toBeGreaterThan(0);
    for (const check of result.checks) {
      expect(check.evidenceRefs.length).toBeGreaterThan(0);
      for (const evidence of check.evidenceRefs) {
        expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(isAbsolute(evidence.path)).toBe(false);
        expect(evidence.path.split('/')).not.toContain('..');
      }
    }
    expect(existsSync(join(dataRoot, 'evals', result.runId, 'result.json'))).toBe(true);
    expect(await readFile(productSentinel, 'utf8')).toBe('{"owner":"user"}\n');
    expect(await readFile(kbSentinel, 'utf8')).toBe('{"writeBlocked":true}\n');
  });
});
