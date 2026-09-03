import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createMainChannel,
  type RoleSpec,
  type RosterEntry,
  type SubChannel,
} from '@agora/core-domain';
import { afterEach, describe, expect, it } from 'vitest';

import { JsonProjectCollaborationStore } from '../src/index';

const roots: string[] = [];

function role(role: string): RoleSpec {
  return {
    role,
    executor: 'harness',
    systemPrompt: `Act as ${role}.`,
    tools: [],
    projection: ['global.summary'],
    routeWhen: 'always',
  };
}

const DEFAULT_ROSTER: readonly RosterEntry[] = [
  { spec: role('COORDINATOR'), status: 'enabled' },
  { spec: role('CODER'), status: 'enabled' },
  { spec: role('TESTER'), status: 'enabled' },
];

function historicalSub(): SubChannel {
  return {
    channelId: 'sub-task-a-action-a',
    kind: 'sub',
    taskId: 'task-a',
    threadId: 'thread-a',
    topic: 'Historical work',
    createdBy: 'CODER',
    participants: ['leader', 'CODER'],
    closed: true,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agora-collaboration-store-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('JsonProjectCollaborationStore', () => {
  it('persists one roster-and-channel snapshot and reloads it after restart', async () => {
    const root = await temporaryRoot();
    const store = new JsonProjectCollaborationStore(root);
    const channels = [createMainChannel(['COORDINATOR', 'CODER', 'TESTER'])];

    const initialized = await store.initialize('project-a', DEFAULT_ROSTER, channels);

    expect(initialized).toEqual({
      projectId: 'project-a',
      revision: 0,
      roster: DEFAULT_ROSTER,
      channels,
    });
    await expect(new JsonProjectCollaborationStore(root).load('project-a')).resolves.toEqual(
      initialized,
    );
    expect(
      JSON.parse(await readFile(join(root, 'projects/project-a/collaboration.json'), 'utf8')),
    ).toEqual(initialized);
  });

  it('commits roster and main membership atomically with CAS and semantic no-op detection', async () => {
    const root = await temporaryRoot();
    const store = new JsonProjectCollaborationStore(root);
    await store.initialize('project-a', DEFAULT_ROSTER, [
      createMainChannel(['COORDINATOR', 'CODER', 'TESTER']),
      historicalSub(),
    ]);
    const nextRoster: RosterEntry[] = DEFAULT_ROSTER.map((entry) =>
      entry.spec.role === 'CODER' ? { ...entry, status: 'disabled' } : entry,
    );
    const nextChannels = [createMainChannel(['COORDINATOR', 'TESTER']), historicalSub()];

    const changed = await store.commit('project-a', 0, {
      roster: nextRoster,
      channels: nextChannels,
    });
    expect(changed.changed).toBe(true);
    expect(changed.snapshot.revision).toBe(1);
    expect(changed.snapshot.channels[1]?.participants).toEqual(['leader', 'CODER']);

    const replay = await store.commit('project-a', 1, {
      roster: nextRoster,
      channels: nextChannels,
    });
    expect(replay.changed).toBe(false);
    await expect(
      store.commit('project-a', 0, { roster: nextRoster, channels: nextChannels }),
    ).rejects.toThrow('expected revision 0 but found 1');
  });

  it('rejects a roster change whose main participants were not updated in the same commit', async () => {
    const root = await temporaryRoot();
    const store = new JsonProjectCollaborationStore(root);
    const channels = [createMainChannel(['COORDINATOR', 'CODER', 'TESTER'])];
    await store.initialize('project-a', DEFAULT_ROSTER, channels);
    const nextRoster: RosterEntry[] = DEFAULT_ROSTER.map((entry) =>
      entry.spec.role === 'CODER' ? { ...entry, status: 'disabled' } : entry,
    );

    await expect(store.commit('project-a', 0, { roster: nextRoster, channels })).rejects.toThrow(
      'main channel participants',
    );
  });

  it('migrates legacy channels.json once using the supplied default roster', async () => {
    const root = await temporaryRoot();
    const directory = join(root, 'projects/project-a');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    const legacy = {
      projectId: 'project-a',
      revision: 3,
      channels: [createMainChannel(['COORDINATOR', 'CODER', 'TESTER'])],
    };
    await writeFile(join(directory, 'channels.json'), `${JSON.stringify(legacy)}\n`, 'utf8');

    const migrated = await new JsonProjectCollaborationStore(root).initialize(
      'project-a',
      DEFAULT_ROSTER,
      legacy.channels,
    );

    expect(migrated).toMatchObject({
      revision: 3,
      roster: DEFAULT_ROSTER,
      channels: legacy.channels,
    });
    await expect(access(join(directory, 'channels.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails fast when legacy and collaboration files coexist with different channels', async () => {
    const root = await temporaryRoot();
    const store = new JsonProjectCollaborationStore(root);
    await store.initialize('project-a', DEFAULT_ROSTER, [
      createMainChannel(['COORDINATOR', 'CODER', 'TESTER']),
    ]);
    await writeFile(
      join(root, 'projects/project-a/channels.json'),
      `${JSON.stringify({
        projectId: 'project-a',
        revision: 0,
        channels: [createMainChannel(['COORDINATOR', 'CODER'])],
      })}\n`,
      'utf8',
    );

    await expect(store.load('project-a')).rejects.toThrow(/conflicting.*channels\.json/i);
  });
});
