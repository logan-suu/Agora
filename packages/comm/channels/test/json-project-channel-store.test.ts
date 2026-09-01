import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMainChannel, type RoleId, type SubChannel } from '@agora/core-domain';
import { afterEach, describe, expect, it } from 'vitest';

import { JsonProjectChannelStore } from '../src/index';

const ENABLED_ROLES = ['COORDINATOR', 'CODER', 'TESTER'] as const satisfies readonly RoleId[];
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agora-channel-store-test-'));
  roots.push(root);
  return root;
}

function subChannel(channelId = 'sub-task-a'): SubChannel {
  return {
    channelId,
    kind: 'sub',
    taskId: 'task-a',
    participants: ['leader', 'CODER'],
    localContext: [],
    closed: false,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('JsonProjectChannelStore', () => {
  it('initializes once, persists the project snapshot, and reloads after restart', async () => {
    const root = await temporaryRoot();
    const initial = [createMainChannel(ENABLED_ROLES)];
    const firstStore = new JsonProjectChannelStore(root, ENABLED_ROLES);

    const initialized = await firstStore.initialize('project-a', initial);
    await expect(
      firstStore.initialize('project-a', [createMainChannel(['COORDINATOR'])]),
    ).rejects.toThrow('main channel participants');

    expect(initialized).toEqual({ projectId: 'project-a', revision: 0, channels: initial });
    const persistedPath = join(root, 'projects/project-a/channels.json');
    expect(JSON.parse(await readFile(persistedPath, 'utf8'))).toEqual(initialized);
    await expect(
      new JsonProjectChannelStore(root, ENABLED_ROLES).load('project-a'),
    ).resolves.toEqual(initialized);
    expect(
      (await readdir(join(root, 'projects/project-a'))).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('commits with optimistic revision checks and does not advance on identical content', async () => {
    const root = await temporaryRoot();
    const store = new JsonProjectChannelStore(root, ENABLED_ROLES);
    const initial = await store.initialize('project-a', [createMainChannel(ENABLED_ROLES)]);
    const nextChannels = [...initial.channels, subChannel()];

    const changed = await store.commit('project-a', 0, nextChannels);
    const unchanged = await store.commit('project-a', 1, nextChannels);

    expect(changed).toEqual({
      changed: true,
      snapshot: { projectId: 'project-a', revision: 1, channels: nextChannels },
    });
    expect(unchanged).toEqual({ changed: false, snapshot: changed.snapshot });
    await expect(store.commit('project-a', 0, nextChannels)).rejects.toThrow(
      'expected revision 0 but found 1',
    );
  });

  it('does not advance revision when only ordinary object key insertion order differs', async () => {
    const root = await temporaryRoot();
    const store = new JsonProjectChannelStore(root, ENABLED_ROLES);
    const main = createMainChannel(ENABLED_ROLES);
    const initialized = await store.initialize('project-a', [
      { ...main, metadata: { alpha: 1, beta: 2 } } as typeof main,
    ]);

    const reordered = {
      ...main,
      metadata: Object.assign({}, { beta: 2 }, { alpha: 1 }),
    } as typeof main;
    const result = await store.commit('project-a', initialized.revision, [reordered]);

    expect(result.changed).toBe(false);
    expect(result.snapshot.revision).toBe(0);
  });

  it('serializes same-project commits so concurrent stale writers cannot overwrite each other', async () => {
    const root = await temporaryRoot();
    const store = new JsonProjectChannelStore(root, ENABLED_ROLES);
    await store.initialize('project-a', [createMainChannel(ENABLED_ROLES)]);

    const results = await Promise.allSettled([
      store.commit('project-a', 0, [createMainChannel(ENABLED_ROLES), subChannel('sub-a')]),
      store.commit('project-a', 0, [createMainChannel(ENABLED_ROLES), subChannel('sub-b')]),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await store.load('project-a'))?.revision).toBe(1);
    expect((await store.load('project-a'))?.channels).toHaveLength(2);
  });

  it('rejects unsafe identities, invalid registries, and corrupt snapshots', async () => {
    const root = await temporaryRoot();
    const store = new JsonProjectChannelStore(root, ENABLED_ROLES);

    await expect(store.initialize('../escape', [createMainChannel(ENABLED_ROLES)])).rejects.toThrow(
      'projectId',
    );
    await expect(store.initialize('project-a', [])).rejects.toThrow('exactly one main channel');

    await store.initialize('project-a', [createMainChannel(ENABLED_ROLES)]);
    await writeFile(join(root, 'projects/project-a/channels.json'), '{broken', 'utf8');
    await expect(store.load('project-a')).rejects.toThrow('invalid project channel JSON');
  });

  it('returns defensive copies instead of mutable persisted references', async () => {
    const root = await temporaryRoot();
    const store = new JsonProjectChannelStore(root, ENABLED_ROLES);
    const initialized = await store.initialize('project-a', [createMainChannel(ENABLED_ROLES)]);

    initialized.channels[0]?.participants.push('REVIEWER');
    initialized.channels.push(subChannel());

    const loaded = await store.load('project-a');
    expect(loaded?.channels).toEqual([createMainChannel(ENABLED_ROLES)]);
  });
});
