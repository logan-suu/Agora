import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RoleSpec } from '@agora/core-domain';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../src/server/channel-stream';
import { createMessageRuntime } from '../src/server/message-runtime';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agora-project-roster-runtime-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const RELEASE_MANAGER: RoleSpec = {
  role: 'release_manager',
  executor: 'harness',
  systemPrompt: 'Prepare a release from the assigned project context.',
  tools: ['fs.read'],
  projection: ['global.summary'],
  routeWhen: 'leaderAssignment',
};

describe('MessageRuntime dynamic project roster', () => {
  it('persists a custom role across restart and permits explicit Leader assignment', async () => {
    const root = await temporaryRoot();
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    const runtime = createMessageRuntime(root, new ChannelStream());
    await runtime.initialize(scope, 'Prepare a release');
    await runtime.roster.addRole(scope.projectId, RELEASE_MANAGER);

    const restarted = createMessageRuntime(root, new ChannelStream());
    const result = await restarted.commitLeaderMessage(scope, {
      msgId: 'assign-release',
      channelId: 'main',
      display: '@RELEASE_MANAGER prepare version 1.0',
      ts: 1,
    });

    expect(result.action).toEqual({ status: 'applied' });
    expect(result.state.nextRole).toBe('RELEASE_MANAGER');
    expect(
      (await restarted.collaboration.load(scope.projectId))?.channels[0]?.participants,
    ).toContain('RELEASE_MANAGER');
  });

  it('removes a disabled role from main and rejects its assignment and new messages', async () => {
    const root = await temporaryRoot();
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    const runtime = createMessageRuntime(root, new ChannelStream());
    await runtime.initialize(scope, 'Prepare a release');
    await runtime.roster.addRole(scope.projectId, RELEASE_MANAGER);
    await runtime.roster.disableRole(scope.projectId, 'RELEASE_MANAGER');

    const assignment = await runtime.commitLeaderMessage(scope, {
      msgId: 'assign-disabled',
      channelId: 'main',
      display: '@RELEASE_MANAGER prepare version 1.0',
      ts: 1,
    });
    expect(assignment.action.status).toBe('rejected');
    expect(
      (await runtime.collaboration.load(scope.projectId))?.channels[0]?.participants,
    ).not.toContain('RELEASE_MANAGER');

    await expect(
      runtime.commitMessage(scope, {
        msgId: 'disabled-message',
        channelId: 'main',
        fromRole: 'RELEASE_MANAGER',
        type: 'chat',
        payload: {},
        display: 'This must not be accepted.',
        ts: 2,
      }),
    ).rejects.toThrow(/not enabled/);
  });
});
