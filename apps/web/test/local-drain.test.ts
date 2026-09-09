// No model is needed to prove admission closure; real task/drain lifecycle is covered by HTTP G5.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ChannelStream } from '../src/server/channel-stream';
import { createMessageRuntime } from '../src/server/message-runtime';
import { TaskOrchestrationRuntime } from '../src/server/task-orchestration-runtime';

it('closes task admission synchronously before draining and never creates a new composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-drain-'));
  try {
    let creations = 0;
    const runtime = new TaskOrchestrationRuntime(
      createMessageRuntime(root, new ChannelStream()),
      async () => {
        creations++;
        throw new Error('unexpected composition');
      },
    );
    const drain = runtime.drain();
    await expect(
      runtime.start({ projectId: 'p', taskId: 't', requestId: 'r', goal: 'goal' }),
    ).rejects.toThrow('stopping');
    await drain;
    expect(creations).toBe(0);
    await expect(runtime.drain()).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
