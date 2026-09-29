// Real immutable files and desktop ownership locks. Synthetic referenced objects
// exercise storage integrity only, not Coordinator or native provenance authority.
// The lost-response wrapper delegates the real durable bind before throwing.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { acquireState } from '../../../../apps/desktop/src/storage';
import type { LocalBindingCoordinator } from '../src/local-binding-coordinator';
import { LocalControlObjects } from '../src/local-control-objects';
import type { LocalGitWorkspaces } from '../src/local-git-workspaces';
import { LocalRegistryFile } from '../src/local-registry-file';
import { localRecordHash, parseLocalRegistry } from '../src/local-registry-records';
import { LocalValidationPreparationConfirmation } from '../src/local-validation-preparation-confirmation';
import {
  LocalValidationPreparationRecords,
  type ValidationPreparationPlan,
  validationPreparationSlot,
} from '../src/local-validation-preparation-records';

const scope = {
  projectId: 'project',
  taskId: 'task',
  waveId: 'wave',
  attempt: 0,
  integrationId: 'integration',
};
const referenceNames = [
  'callHash',
  'handoffPlanHash',
  'handoffConfirmedHash',
  'versionHash',
  'beforeStateHash',
  'registryHash',
  'dispatchPlanHash',
] as const;
const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex');

async function fixture(
  run: (
    objects: LocalControlObjects,
    root: string,
    restart: () => Promise<LocalControlObjects>,
  ) => Promise<void>,
) {
  const base = await mkdtemp('/private/tmp/agora-task124-validation-records-');
  const identity = await lstat(base),
    root = join(base, 'state');
  let owner = await acquireState(root);
  const evidence: Record<string, unknown> = {
    base,
    identity: { uid: identity.uid, dev: identity.dev, ino: identity.ino },
    startedAt: new Date().toISOString(),
    node: process.version,
  };
  const output = resolve('test-outputs/task124/validation-records');
  await mkdir(output, { recursive: true });
  const save = () =>
    writeFile(
      join(output, `${base.split('/').at(-1)}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  try {
    await LocalRegistryFile.open(owner, parseLocalRegistry, true);
    await run(await LocalControlObjects.open(owner), root, async () => {
      await owner.release();
      owner = await acquireState(root);
      return LocalControlObjects.open(owner);
    });
    evidence.passed = true;
  } catch (error) {
    evidence.passed = false;
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await owner.release();
    const files: { path: string; bytes: number; sha256: string }[] = [];
    async function capture(directory: string) {
      for (const name of await readdir(directory)) {
        const p = join(directory, name),
          s = await lstat(p);
        if (s.isDirectory()) await capture(p);
        else {
          if (!s.isFile() || s.isSymbolicLink()) throw Error('unexpected fixture object');
          files.push({
            path: p.slice(base.length + 1),
            bytes: s.size,
            sha256: hash(await readFile(p)),
          });
        }
      }
    }
    await capture(base);
    evidence.files = files;
    evidence.sources = Object.fromEntries(
      await Promise.all(
        [
          'packages/runtime/sandbox/src/local-validation-preparation-records.ts',
          'packages/runtime/sandbox/src/local-control-objects.ts',
          'packages/runtime/sandbox/test/local-validation-preparation-records.test.ts',
          'apps/desktop/src/storage.ts',
        ].map(async (p) => [p, hash(await readFile(p))]),
      ),
    );
    await save();
    const current = await lstat(base);
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' });
    const mounts = execFileSync('/sbin/mount', [], { encoding: 'utf8' });
    const safe =
      current.uid === identity.uid &&
      current.dev === identity.dev &&
      current.ino === identity.ino &&
      !current.isSymbolicLink() &&
      (await realpath(base)) === base &&
      handles.status === 1 &&
      !handles.stdout &&
      !handles.stderr &&
      !mounts.includes(base);
    evidence.cleanup = {
      safe,
      removed: false,
      logicalBytes: files.reduce((n, f) => n + f.bytes, 0),
    };
    await save();
    if (safe) {
      await rm(base, { recursive: true });
      evidence.cleanup = { ...(evidence.cleanup as object), removed: true };
      await save();
    }
    expect(safe).toBe(true);
  }
}
async function plan(objects: LocalControlObjects): Promise<ValidationPreparationPlan> {
  const references = Object.fromEntries(
    await Promise.all(
      referenceNames.map(async (key) => [key, await objects.put({ fixture: key })]),
    ),
  );
  return {
    schemaVersion: 'local-validation-preparation-plan-v1',
    scope,
    actionId: 'prepare',
    dispatchId: 'dispatch',
    workerId: 'worker:dispatch:0',
    validationWorkspaceId: 'validation',
    ...references,
  } as ValidationPreparationPlan;
}

// The registration reader is substituted here to isolate immutable receipt
// behavior; the phase12 integration test exercises real native and Git proof.
async function confirmationFixture(objects: LocalControlObjects) {
  const records = new LocalValidationPreparationRecords(objects);
  const saved = await records.publish(await plan(objects));
  const request = {
    ...scope,
    planHash: saved.planHash,
    actionId: saved.plan.actionId,
    dispatchId: saved.plan.dispatchId,
    targets: [
      {
        purpose: 'validation',
        workspaceId: saved.plan.validationWorkspaceId,
        workerId: saved.plan.workerId,
      },
    ],
  };
  const key = localRecordHash({
    kind: 'validation-git-registration',
    projectId: scope.projectId,
    taskId: scope.taskId,
    actionId: saved.plan.actionId,
  });
  const requestHash = await objects.put({ request, gitOptions: {} });
  await objects.bindReference(key, requestHash);
  const bindingHash = await objects.put({ binding: true });
  await objects.bindReference(localRecordHash({ key, stage: 'binding' }), bindingHash);
  const state = { projectId: scope.projectId, taskId: scope.taskId, phase: 'testing' };
  const registry = {
    operations: [{ actionId: saved.plan.actionId, stage: 'committed', inputHash: bindingHash }],
  };
  let reads = 0;
  const confirmation = new LocalValidationPreparationConfirmation({
    objects,
    records,
    control: {
      assertClosed: async () => state,
      snapshot: async () => registry,
    } as unknown as LocalBindingCoordinator,
    workspaces: {
      registerValidation: async () => {
        reads++;
        return [{ workspaceId: saved.plan.validationWorkspaceId }];
      },
    } as unknown as Pick<LocalGitWorkspaces, 'registerValidation'>,
  });
  return { confirmation, saved, registry, state, reads: () => reads };
}

it('writes one confirmed receipt only after a closed registration and rechecks it after restart', () =>
  fixture(async (objects, _root, restart) => {
    const { confirmation, saved, reads } = await confirmationFixture(objects);
    const before = await objects.references();
    const first = await confirmation.confirm(scope);
    expect(first.planHash).toBe(saved.planHash);
    expect(first.workerId).toBe(saved.plan.workerId);
    expect(first.workspaceId).toBe(saved.plan.validationWorkspaceId);
    expect(reads()).toBe(1);
    expect((await objects.references()).length).toBe(before.length + 1);
    expect(await confirmation.confirm(scope)).toEqual(first);
    expect((await objects.references()).length).toBe(before.length + 1);
    const reopenedObjects = await restart();
    const reopened = await confirmationFixtureForRead(reopenedObjects);
    expect(await reopened.read(scope)).toEqual(first);
  }));

it('refuses confirmation without a committed binding and never invokes registration recovery', () =>
  fixture(async (objects) => {
    const { confirmation, registry, reads } = await confirmationFixture(objects);
    const operation = registry.operations[0];
    if (!operation) throw Error('missing registration operation');
    operation.stage = 'prepared';
    const before = await objects.references();
    await expect(confirmation.confirm(scope)).rejects.toThrow(
      'validation_registration_recovery_required',
    );
    expect(reads()).toBe(0);
    expect(await objects.references()).toEqual(before);
  }));

it('refuses a confirmed receipt after full current State changes', () =>
  fixture(async (objects) => {
    const { confirmation, state } = await confirmationFixture(objects);
    await confirmation.confirm(scope);
    state.phase = 'running';
    await expect(confirmation.read(scope)).rejects.toThrow(
      'validation_preparation_confirmation_changed',
    );
  }));

async function confirmationFixtureForRead(objects: LocalControlObjects) {
  const records = new LocalValidationPreparationRecords(objects);
  const saved = await records.load(scope);
  if (!saved) throw Error('missing preparation');
  return new LocalValidationPreparationConfirmation({
    objects,
    records,
    control: {
      assertClosed: async () => ({
        projectId: scope.projectId,
        taskId: scope.taskId,
        phase: 'testing',
      }),
      snapshot: async () => ({
        operations: [
          {
            actionId: saved.plan.actionId,
            stage: 'committed',
            inputHash: await objects.getReference(
              localRecordHash({
                key: localRecordHash({
                  kind: 'validation-git-registration',
                  projectId: scope.projectId,
                  taskId: scope.taskId,
                  actionId: saved.plan.actionId,
                }),
                stage: 'binding',
              }),
            ),
          },
        ],
      }),
    } as unknown as LocalBindingCoordinator,
    workspaces: {
      registerValidation: async () => [{ workspaceId: saved.plan.validationWorkspaceId }],
    } as unknown as Pick<LocalGitWorkspaces, 'registerValidation'>,
  });
}

it('publishes one slot and survives a real ownership restart without an action index', () =>
  fixture(async (objects, _root, restart) => {
    const input = await plan(objects),
      records = new LocalValidationPreparationRecords(objects);
    expect(await records.load(scope)).toBeUndefined();
    const saved = await records.publish(input);
    expect(saved.plan).toEqual(input);
    expect(await objects.references()).toEqual([
      { key: validationPreparationSlot(scope), valueHash: saved.planHash },
    ]);
    const reopened = new LocalValidationPreparationRecords(await restart());
    expect(await reopened.load(scope)).toEqual(saved);
    expect(await reopened.publish(input)).toEqual(saved);
  }));

it.each([
  'actionId',
  'dispatchId',
  'workerId',
  'validationWorkspaceId',
  'dispatchPlanHash',
] as const)('rejects a competing %s without replacing the slot', (key) =>
  fixture(async (objects) => {
    const input = await plan(objects),
      records = new LocalValidationPreparationRecords(objects);
    const saved = await records.publish(input);
    const changed = {
      ...input,
      [key]: key.endsWith('Hash') ? await objects.put({ competing: true }) : 'another',
    };
    await expect(records.publish(changed)).rejects.toThrow('operation_conflict');
    expect(await records.load(scope)).toEqual(saved);
  }),
);

it('does not discover orphan objects and refuses missing source objects before publication', () =>
  fixture(async (objects) => {
    const input = await plan(objects),
      records = new LocalValidationPreparationRecords(objects);
    await objects.put(input);
    expect(await records.load(scope)).toBeUndefined();
    await expect(records.publish({ ...input, versionHash: 'f'.repeat(64) })).rejects.toThrow();
    expect(await objects.references()).toEqual([]);
  }));

it.each(['reference', 'plan', 'source'] as const)(
  'preserves and rejects a corrupt %s across restart',
  (kind) =>
    fixture(async (objects, root, restart) => {
      const input = await plan(objects),
        records = new LocalValidationPreparationRecords(objects);
      const saved = await records.publish(input);
      const name =
        kind === 'reference'
          ? `${validationPreparationSlot(scope)}.ref`
          : `${kind === 'plan' ? saved.planHash : input.handoffConfirmedHash}.json`;
      const path = join(root, 'local-workspaces', 'objects', name);
      await chmod(path, 0o600);
      await writeFile(path, '{');
      await chmod(path, 0o400);
      const reopened = new LocalValidationPreparationRecords(await restart());
      await expect(reopened.load(scope)).rejects.toThrow();
      await expect(reopened.publish(input)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe('{');
    }),
);

it('rejects malformed identities and foreign plans stored under the requested slot', () =>
  fixture(async (objects) => {
    const input = await plan(objects),
      records = new LocalValidationPreparationRecords(objects);
    for (const attempt of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(records.publish({ ...input, scope: { ...scope, attempt } })).rejects.toThrow();
    await expect(
      records.publish({ ...input, extra: true } as ValidationPreparationPlan),
    ).rejects.toThrow();
    const foreign = { ...input, scope: { ...scope, taskId: 'other' } };
    await objects.bindReference(validationPreparationSlot(scope), await objects.put(foreign));
    await expect(records.load(scope)).rejects.toThrow();
    expect(localRecordHash(input)).not.toBe(localRecordHash(foreign));
  }));

it('recovers the original slot after a durable bind loses its response', () =>
  fixture(async (objects, _root, restart) => {
    const input = await plan(objects);
    const originalBind = objects.bindReference.bind(objects);
    objects.bindReference = async (key, valueHash) => {
      await originalBind(key, valueHash);
      throw Error('fixture_lost_response');
    };
    await expect(new LocalValidationPreparationRecords(objects).publish(input)).rejects.toThrow(
      'fixture_lost_response',
    );
    const reopenedObjects = await restart();
    const reopened = new LocalValidationPreparationRecords(reopenedObjects);
    const recovered = await reopened.load(scope);
    expect(recovered).toEqual({ plan: input, planHash: localRecordHash(input) });
    expect(await reopened.publish(input)).toEqual(recovered);
    expect((await reopenedObjects.references()).length).toBe(1);
  }));

it('serializes competing instances without publishing two preparations', () =>
  fixture(async (objects) => {
    const input = await plan(objects);
    const results = await Promise.allSettled([
      new LocalValidationPreparationRecords(objects).publish(input),
      new LocalValidationPreparationRecords(objects).publish({ ...input, actionId: 'competing' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(await new LocalValidationPreparationRecords(objects).load(scope)).toEqual({
      plan: input,
      planHash: localRecordHash(input),
    });
    expect((await objects.references()).length).toBe(1);
  }));
