import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendMutation, createInitialAppState, type Message } from '@agora/core-domain';
import { afterEach, describe, expect, it } from 'vitest';

import { JsonTaskStateStore, type TaskScope } from '../src/index';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agora-state-test-'));
  roots.push(root);
  return root;
}

function scope(overrides: Partial<TaskScope> = {}): TaskScope {
  return { projectId: 'project-a', taskId: 'task-a', ...overrides };
}

function message(id: string): Message {
  return {
    msgId: id,
    channelId: 'main',
    fromRole: 'CODER',
    type: 'chat',
    payload: { secret: `payload-${id}` },
    display: `display-${id}`,
    ts: Number(id.replace(/\D/g, '')) || 1,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('JsonTaskStateStore', () => {
  it('initializes once and loads the persisted task snapshot', async () => {
    const root = await temporaryRoot();
    const store = new JsonTaskStateStore(root);
    const initial = createInitialAppState('task-a', 'first goal', 'project-a');

    await expect(store.initialize(scope(), initial)).resolves.toEqual(initial);
    await expect(
      store.initialize(scope(), createInitialAppState('task-a', 'ignored goal', 'project-a')),
    ).resolves.toEqual(initial);
    await expect(store.load(scope())).resolves.toEqual(initial);

    const persisted = JSON.parse(
      await readFile(join(root, 'projects/project-a/tasks/task-a/state.json'), 'utf8'),
    );
    expect(persisted).toEqual(initial);
  });

  it('commits through the reducer and reports idempotent replays as unchanged', async () => {
    const root = await temporaryRoot();
    const store = new JsonTaskStateStore(root);
    await store.initialize(scope(), createInitialAppState('task-a', 'goal', 'project-a'));

    const mutation = appendMutation('messages', message('message-1'));
    const first = await store.commit(scope(), [mutation]);
    const replay = await store.commit(scope(), [mutation]);

    expect(first.changed).toBe(true);
    expect(replay.changed).toBe(false);
    expect(replay.state.messages.map((item) => item.msgId)).toEqual(['message-1']);
  });

  it('serializes concurrent commits for the same task without losing messages', async () => {
    const root = await temporaryRoot();
    const store = new JsonTaskStateStore(root);
    await store.initialize(scope(), createInitialAppState('task-a', 'goal', 'project-a'));

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.commit(scope(), [appendMutation('messages', message(`message-${index + 1}`))]),
      ),
    );

    const state = await store.load(scope());
    expect(state?.messages).toHaveLength(12);
    expect(new Set(state?.messages.map((item) => item.msgId)).size).toBe(12);
  });

  it('rejects unsafe scope segments and scope/state mismatches', async () => {
    const root = await temporaryRoot();
    const store = new JsonTaskStateStore(root);

    await expect(
      store.initialize(scope({ projectId: '../escape' }), createInitialAppState('task-a', 'goal')),
    ).rejects.toThrow('projectId');
    await expect(
      store.initialize(scope(), createInitialAppState('different-task', 'goal', 'project-a')),
    ).rejects.toThrow('does not match');
  });

  it('fails explicitly when a persisted snapshot is corrupt', async () => {
    const root = await temporaryRoot();
    const store = new JsonTaskStateStore(root);
    await store.initialize(scope(), createInitialAppState('task-a', 'goal', 'project-a'));
    await writeFile(join(root, 'projects/project-a/tasks/task-a/state.json'), '{broken', 'utf8');

    await expect(store.load(scope())).rejects.toThrow('invalid task state JSON');
  });

  it('normalizes a pre-D14 snapshot without objections at the persistence boundary', async () => {
    const root = await temporaryRoot();
    const store = new JsonTaskStateStore(root);
    const legacy = createInitialAppState('task-a', 'legacy goal', 'project-a');
    const snapshot = { ...legacy } as Partial<typeof legacy>;
    delete snapshot.objections;
    const path = join(root, 'projects/project-a/tasks/task-a/state.json');
    await store.initialize(scope(), legacy);
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

    await expect(store.load(scope())).resolves.toEqual({ ...legacy, objections: [] });

    await writeFile(path, `${JSON.stringify({ ...legacy, objections: null }, null, 2)}\n`, 'utf8');
    await expect(store.load(scope())).rejects.toThrow('objections must be an array');
  });

  it('normalizes a pre-D17 snapshot without workers and rejects a malformed workers slice', async () => {
    const root = await temporaryRoot();
    const store = new JsonTaskStateStore(root);
    const current = createInitialAppState('task-a', 'legacy goal', 'project-a');
    const snapshot = { ...current } as Partial<typeof current>;
    delete snapshot.workers;
    const path = join(root, 'projects/project-a/tasks/task-a/state.json');
    await store.initialize(scope(), current);
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

    await expect(store.load(scope())).resolves.toEqual({ ...current, workers: [] });

    await writeFile(path, `${JSON.stringify({ ...current, workers: null }, null, 2)}\n`, 'utf8');
    await expect(store.load(scope())).rejects.toThrow('workers must be an array');
  });
});
