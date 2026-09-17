// Real desktop ownership, registry files and TaskStateStore. Fault adapters wrap
// the actual commit and throw immediately before/after it to model interruption.
// These fixed data references exercise transaction recovery, not OS authorization.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  createInitialAppState,
  type LocalExecutionV1,
  type Message,
  type Mutation,
} from '@agora/core-domain';
import { JsonTaskStateStore } from '@agora/runtime-state';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import {
  LocalBindingCoordinator,
  type LocalBindingRequest,
} from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';

const scope = { projectId: 'project', taskId: 'task' };
const empty = (): LocalExecutionV1 => ({
  schemaVersion: 'local-execution-v1',
  rootIds: [],
  workspaces: [],
  bindings: [],
  receipts: [],
});
const request = (): LocalBindingRequest => ({
  ...scope,
  actionId: 'bind',
  sourceMessageId: 'leader-message',
  expectedRevision: 0,
  nextLocalExecution: empty(),
  records: { roots: [], grants: [], workspaces: [], claims: [] },
});
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

async function fixture(
  name: string,
  run: (ctx: {
    owner: Awaited<ReturnType<typeof acquireState>>;
    store: JsonTaskStateStore;
    control: LocalBindingCoordinator;
    base: string;
  }) => Promise<void>,
) {
  const base = await mkdtemp('/private/tmp/agora-task123-validation-');
  const initialIdentity = await lstat(base);
  const owner = await acquireState(join(base, 'state'));
  const store = new JsonTaskStateStore(join(owner.root, 'tasks'));
  const initial = createInitialAppState(scope.taskId, 'fixed binding task', scope.projectId);
  initial.messages.push({
    msgId: 'leader-message',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    payload: {},
    display: 'Fixed control test',
    ts: 1,
  });
  await store.initialize(scope, initial);
  const control = await LocalBindingCoordinator.open(owner, store, true);
  const evidence: Record<string, unknown> = {
    name,
    base,
    identity: { dev: initialIdentity.dev, ino: initialIdentity.ino },
    node: process.version,
    startedAt: new Date().toISOString(),
  };
  let failure: unknown;
  try {
    await run({ owner, store, control, base });
    evidence.passed = true;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    failure = error;
  }
  {
    await owner.release();
    const files: { path: string; sha256: string }[] = [];
    const capture = async (path: string, prefix = ''): Promise<void> => {
      for (const name of await readdir(path)) {
        const full = join(path, name),
          stat = await lstat(full);
        if (stat.isDirectory() && !stat.isSymbolicLink()) await capture(full, join(prefix, name));
        else if (stat.isFile())
          files.push({ path: join(prefix, name), sha256: digest(await readFile(full)) });
        else throw new Error('unexpected binding fixture object');
      }
    };
    await capture(base);
    evidence.files = files;
    evidence.sources = Object.fromEntries(
      await Promise.all(
        [
          'packages/runtime/sandbox/src/local-binding-coordinator.ts',
          'packages/runtime/sandbox/src/local-registry-records.ts',
          'packages/runtime/sandbox/src/local-registry-file.ts',
          'packages/core/domain/src/local-execution.ts',
          'tests/integration/phase12/phase12-3-state-binding.test.ts',
        ].map(async (p) => [p, digest(await readFile(p))]),
      ),
    );
    const folder = resolve('docs/reviews/task123-state-evidence');
    await mkdir(folder, { recursive: true });
    const target = join(folder, `${name}-${basename(base)}.json`);
    await writeFile(target, JSON.stringify(evidence, null, 2));
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' });
    const mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' });
    const current = await lstat(base);
    const space = await statfs(base);
    if (
      current.dev !== initialIdentity.dev ||
      current.ino !== initialIdentity.ino ||
      current.isSymbolicLink() ||
      handles.status !== 1 ||
      handles.stdout ||
      handles.stderr ||
      mounts.status !== 0 ||
      mounts.stdout.includes(base)
    )
      throw new Error('binding_fixture_cleanup_unproven');
    await rm(base, { recursive: true });
    const after = await statfs('/private/tmp');
    evidence.cleanup = {
      deleted: true,
      ownerReleased: true,
      noOpenHandles: true,
      noMounts: true,
      availableBytesDelta: after.bavail * after.bsize - space.bavail * space.bsize,
      completedAt: new Date().toISOString(),
    };
    await writeFile(target, JSON.stringify(evidence, null, 2));
  }
  if (failure !== undefined) throw failure;
}

it('closes both real stores and replays without a second receipt', () =>
  fixture('closed', async ({ control, store, owner }) => {
    const op = await control.commitBinding(request());
    expect(op.stage).toBe('committed');
    expect((await control.snapshot()).revision).toBe(2);
    expect((await control.assertClosed(scope)).localExecution?.receipts).toHaveLength(1);
    expect(await control.commitBinding(request())).toEqual(op);
    const reopened = await LocalBindingCoordinator.open(owner, store);
    expect(await reopened.recover(op.actionId, op.inputHash)).toEqual(op);
    expect((await reopened.snapshot()).revision).toBe(2);
    await expect(
      reopened.commitBinding({ ...request(), sourceMessageId: 'other' }),
    ).rejects.toThrow('operation_conflict');
  }));

it.each(['before', 'after'] as const)(
  'recovers interruption %s the canonical TaskState commit',
  (point) =>
    fixture(`interrupt-${point}`, async ({ owner, store, control }) => {
      let injected = false;
      const interrupted = await LocalBindingCoordinator.open(owner, {
        load: (s) => store.load(s),
        commit: async (s, mutations) => {
          if (!injected && point === 'before') {
            injected = true;
            throw new Error('fixed interruption');
          }
          const result = await store.commit(s, mutations);
          if (!injected && point === 'after') {
            injected = true;
            throw new Error('fixed interruption');
          }
          return result;
        },
      });
      await expect(interrupted.commitBinding(request())).rejects.toThrow('fixed interruption');
      const snapshot = await control.snapshot(),
        op = snapshot.operations[0];
      if (!op) throw new Error('missing prepared operation');
      expect(op.stage).toBe('prepared');
      await expect(control.assertClosed(scope)).rejects.toThrow('registry_recovery_required');
      expect((await store.load(scope))?.localExecution !== undefined).toBe(point === 'after');
      await expect(control.recover(op.actionId, 'f'.repeat(64))).rejects.toThrow(
        'operation_conflict',
      );
      expect((await control.recover(op.actionId, op.inputHash)).stage).toBe('committed');
      expect((await control.assertClosed(scope)).localExecution?.receipts).toHaveLength(1);
    }),
);

it('rejects a non-Leader source before preparing any authority', () =>
  fixture('bad-source', async ({ control, store }) => {
    await store.commit(scope, [
      {
        op: 'append',
        field: 'messages',
        value: {
          msgId: 'model',
          channelId: 'main',
          fromRole: 'CODER',
          type: 'chat',
          payload: {},
          display: 'Fixed fake control',
          ts: 2,
        },
      },
    ]);
    await expect(control.commitBinding({ ...request(), sourceMessageId: 'model' })).rejects.toThrow(
      'workspace_control_source_invalid',
    );
    expect((await control.snapshot()).revision).toBe(0);
    expect((await store.load(scope))?.localExecution).toBeUndefined();
  }));

it('rejects canonical workspace references absent from the committed registry action', () =>
  fixture('forged-reference', async ({ control, store }) => {
    await control.commitBinding(request());
    const state = await store.load(scope);
    if (!state?.localExecution) throw new Error('missing binding');
    const extra = {
      ...state.localExecution,
      rootIds: ['unregistered'],
      workspaces: [
        {
          schemaVersion: 'workspace-v1',
          projectId: 'project',
          taskId: 'task',
          workspaceId: 'forged',
          rootId: 'unregistered',
          grantId: 'unregistered',
          purpose: 'coding',
          mode: 'direct',
          baselineManifestId: 'manifest',
        },
      ],
    };
    await store.commit(scope, [{ op: 'set', field: 'localExecution', value: extra } as Mutation]);
    await expect(control.assertClosed(scope)).rejects.toThrow('workspace_binding_incomplete');
  }));

it('serializes racing bindings and rejects an obsolete registry revision', () =>
  fixture('race', async ({ control }) => {
    const results = await Promise.allSettled([
      control.commitBinding(request()),
      control.commitBinding({ ...request(), actionId: 'other' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await control.snapshot()).operations).toHaveLength(1);
    expect((await control.assertClosed(scope)).localExecution?.receipts).toHaveLength(1);
  }));

it('keeps an interrupted binding blocked when canonical input changed', () =>
  fixture('changed-input', async ({ owner, store, control }) => {
    const interrupted = await LocalBindingCoordinator.open(owner, {
      load: (s) => store.load(s),
      commit: async () => {
        throw new Error('fixed interruption');
      },
    });
    await expect(interrupted.commitBinding(request())).rejects.toThrow('fixed interruption');
    const op = (await control.snapshot()).operations[0];
    if (!op) throw new Error('missing prepared operation');
    await store.commit(scope, [{ op: 'set', field: 'localExecution', value: empty() }]);
    await expect(control.recover(op.actionId, op.inputHash)).rejects.toThrow(
      'workspace_binding_conflict',
    );
    await expect(
      control.commitBinding({ ...request(), actionId: 'second', expectedRevision: 1 }),
    ).rejects.toThrow('registry_recovery_required');
    expect((await control.snapshot()).operations[0]?.stage).toBe('prepared');
  }));

it('rejects invalid root/grant data before changing either store', () =>
  fixture('invalid-records', async ({ control, store }) => {
    const bad = {
      ...request(),
      records: { ...request().records, roots: [{ rootId: 'fake' }] },
    } as LocalBindingRequest;
    await expect(control.commitBinding(bad)).rejects.toThrow('invalid_local_registry_records');
    expect((await control.snapshot()).revision).toBe(0);
    expect((await store.load(scope))?.localExecution).toBeUndefined();
  }));

it('closes a second operation and replays prior immutable evidence', () =>
  fixture('next-binding', async ({ control }) => {
    const first = await control.commitBinding(request());
    const current = await control.assertClosed(scope);
    if (!current.localExecution) throw new Error('missing binding');
    const second = await control.commitBinding({
      ...request(),
      actionId: 'next',
      expectedRevision: 2,
      nextLocalExecution: current.localExecution,
    });
    expect(second.preparedRevision).toBe(3);
    expect((await control.assertClosed(scope)).localExecution?.receipts).toHaveLength(2);
    expect(await control.recover(first.actionId, first.inputHash)).toEqual(first);
    expect((await control.snapshot()).revision).toBe(4);
  }));

function atomicRequest(): LocalBindingRequest {
  const intent = {
    kind: 'workspace_control',
    verb: 'revoke',
    ...scope,
    actionId: 'atomic',
    expectedRevision: 0,
    grantId: 'grant',
  };
  const { kind: _kind, verb, ...body } = intent;
  const sourceMessage: Message = {
    msgId: 'atomic',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    display: `/workspace ${verb} ${JSON.stringify(body)}`,
    payload: { kind: 'leader_intent', intent, action: { status: 'applied' } },
    ts: 2,
  };
  return { ...request(), actionId: 'atomic', sourceMessageId: 'atomic', sourceMessage };
}

it.each(['normal', 'before', 'after'] as const)(
  'atomically persists the Leader message and binding across %s interruption',
  (point) =>
    fixture(`atomic-${point}`, async ({ owner, store, control }) => {
      let injected = false;
      const observed: string[][] = [];
      const atomic = await LocalBindingCoordinator.open(owner, {
        load: (s) => store.load(s),
        commit: async (s, mutations) => {
          observed.push(mutations.map((m) => `${m.op}:${m.field}`));
          if (!injected && point === 'before') {
            injected = true;
            throw new Error('fixed interruption');
          }
          const result = await store.commit(s, mutations);
          if (!injected && point === 'after') {
            injected = true;
            throw new Error('fixed interruption');
          }
          return result;
        },
      });
      if (point === 'normal') await atomic.commitBinding(atomicRequest());
      else
        await expect(atomic.commitBinding(atomicRequest())).rejects.toThrow('fixed interruption');
      const interruptedState = await store.load(scope);
      expect(interruptedState?.messages.some((m) => m.msgId === 'atomic')).toBe(point !== 'before');
      expect(interruptedState?.localExecution !== undefined).toBe(point !== 'before');
      const operation = (await control.snapshot()).operations[0];
      if (!operation) throw new Error('missing prepared action');
      const closed = await control.recover(operation.actionId, operation.inputHash);
      expect(closed.stage).toBe('committed');
      expect(observed).toEqual([['append:messages', 'set:localExecution']]);
      const state = await control.assertClosed(scope);
      expect(state.messages.filter((m) => m.msgId === 'atomic')).toEqual([
        atomicRequest().sourceMessage,
      ]);
      expect(state.localExecution?.receipts).toHaveLength(1);
      expect(await control.commitBinding(atomicRequest())).toEqual(closed);
    }),
);

it.each(['role', 'payload', 'scope', 'revision', 'message-id'] as const)(
  'rejects inconsistent atomic control %s before registry preparation',
  (field) =>
    fixture(`atomic-invalid-${field}`, async ({ control }) => {
      const input = atomicRequest();
      const message = input.sourceMessage as Message;
      if (field === 'role') message.fromRole = 'CODER';
      if (field === 'payload') message.payload.action = { status: 'rejected' };
      if (field === 'scope') input.taskId = 'other';
      if (field === 'revision') input.expectedRevision = 1;
      if (field === 'message-id') message.msgId = 'other';
      await expect(control.commitBinding(input)).rejects.toThrow(
        'workspace_control_source_invalid',
      );
      expect((await control.snapshot()).revision).toBe(0);
    }),
);

it('refuses to adopt a separately persisted atomic Leader message', () =>
  fixture('atomic-split-message', async ({ control, store }) => {
    await store.commit(scope, [
      { op: 'append', field: 'messages', value: atomicRequest().sourceMessage as Message },
    ]);
    await expect(control.commitBinding(atomicRequest())).rejects.toThrow(
      'workspace_binding_conflict',
    );
    expect((await control.snapshot()).revision).toBe(0);
  }));

it('persists immutable control objects by content and verifies them after reopening', () =>
  fixture('control-objects', async ({ owner }) => {
    const objects = await LocalControlObjects.open(owner);
    const bytes = Buffer.from([0, 255, 128, 1]);
    const storedBytes = objects.putBytes(bytes);
    bytes.fill(7);
    const bytesHash = await storedBytes;
    expect(await objects.getBytes(bytesHash)).toEqual(Buffer.from([0, 255, 128, 1]));
    const value = { version: 1, configuration: { network: [], actions: ['read', 'edit'] } };
    const hash = await objects.put(value);
    const referenceKey = digest('fixed-action-reference');
    expect(await objects.getReference(referenceKey)).toBeUndefined();
    await objects.bindReference(referenceKey, hash);
    expect(await objects.getReference(referenceKey)).toBe(hash);
    await objects.bindReference(referenceKey, hash);
    const different = await objects.put({ version: 2 });
    await expect(objects.bindReference(referenceKey, different)).rejects.toThrow(
      'operation_conflict',
    );
    expect(await objects.put({ configuration: value.configuration, version: 1 })).toBe(hash);
    expect(await (await LocalControlObjects.open(owner)).get(hash)).toEqual(value);
    await expect(objects.get('../registry')).rejects.toThrow('invalid_control_object');
    await expect(objects.get('a'.repeat(64))).rejects.toThrow('invalid_control_object');
    const file = join(owner.root, 'local-workspaces', 'objects', `${hash}.json`);
    expect((await lstat(file)).mode & 0o777).toBe(0o400);
    // Trusted test actor corrupts private metadata; production scripts cannot access this directory.
    const { chmod } = await import('node:fs/promises');
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify({ version: 2 }));
    await chmod(file, 0o400);
    await expect(objects.get(hash)).rejects.toThrow('invalid_control_object');
    await expect(objects.put(value)).rejects.toThrow('invalid_control_object');
  }));
