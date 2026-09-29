// Real native snapshots and private immutable objects. The fixture supplies the
// still-unwired canonical source port; this does not prove product G5 delivery.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';
import { LocalDeliveryCandidates } from '../../../packages/runtime/sandbox/src/local-delivery-candidates';
import { LocalDeliveryComparisonStore } from '../../../packages/runtime/sandbox/src/local-delivery-comparison-record';
import { inspectLocalRoot } from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { LocalRegistryFile } from '../../../packages/runtime/sandbox/src/local-registry-file';
import { parseLocalRegistry } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalVersionStore } from '../../../packages/runtime/sandbox/src/local-version-store';
import { fileEffectsFixture } from './local-file-effects-fixture';

it('keeps a fixed B/A/U/C comparison while rejecting stale current-source reuse', async () => {
  await fileEffectsFixture(async ({ base, root, helper, evidence }) => {
    const owner = await acquireState(join(base, 'state'));
    try {
      await LocalRegistryFile.open(owner, parseLocalRegistry, true);
      const objects = await LocalControlObjects.open(owner);
      const versions = new LocalVersionStore(objects, helper);
      const scope = {
        projectId: 'project',
        taskId: 'task',
        rootId: 'root',
        policyHash: 'a'.repeat(64),
      };
      const baselineRoot = join(base, 'baseline');
      const artifactRoot = join(base, 'artifact');
      for (const path of [baselineRoot, artifactRoot]) {
        mkdirSync(path);
        mkdirSync(join(path, '.agora-operations'), { mode: 0o700 });
      }
      for (const path of [baselineRoot, root]) writeFileSync(join(path, 'code.txt'), 'before');
      writeFileSync(join(artifactRoot, 'code.txt'), 'after');
      mkdirSync(join(artifactRoot, 'empty/nested'), { recursive: true });
      writeFileSync(join(artifactRoot, 'run.sh'), 'exit 0\n', { mode: 0o700 });
      const capture = async (path: string) => {
        const version = await versions.capture(scope, inspectLocalRoot(path), async () => true);
        if (version.kind !== 'files') throw Error('expected_file_manifest');
        return version;
      };
      const source = {
        scope,
        baseline: await capture(baselineRoot),
        artifact: await capture(artifactRoot),
        current: await capture(root),
        grantId: 'grant',
        grantRevision: 4,
        goal: 'apply_to_directory' as const,
        sourceReceipts: {
          baseline: 'baseline-receipt',
          artifact: 'validation-receipt',
          current: 'user-capture-receipt',
        },
        targetIndexHash: null,
        controlFingerprint: 'c'.repeat(64),
      };
      const store = new LocalDeliveryComparisonStore(objects, versions, async () =>
        structuredClone(source),
      );
      const prepared = await store.prepare({ projectId: 'project', taskId: 'task' });
      evidence.deliveryComparison = prepared;
      expect(prepared.comparison.status).toBe('matches_artifact');
      expect(prepared.candidateTreeHash).toMatch(/^[a-f0-9]{64}$/);
      expect((await store.readHistorical(prepared.deliveryComparisonId)).inputHash).toBe(
        prepared.inputHash,
      );
      await expect(store.verifyCurrent(prepared.deliveryComparisonId)).resolves.toEqual(prepared);
      const replay = await store.prepare({ projectId: 'project', taskId: 'task' });
      expect(replay.deliveryComparisonId).toBe(prepared.deliveryComparisonId);
      writeFileSync(join(root, 'user.txt'), 'late edit');
      source.current = await capture(root);
      await expect(store.verifyCurrent(prepared.deliveryComparisonId)).rejects.toThrow(
        'delivery_stale',
      );
      expect((await store.readHistorical(prepared.deliveryComparisonId)).inputHash).toBe(
        prepared.inputHash,
      );
      const combined = await store.prepare({ projectId: 'project', taskId: 'task' });
      expect(combined.comparison.status).toBe('requires_validation');
      expect(combined.deliveryComparisonId).not.toBe(prepared.deliveryComparisonId);
      await expect(store.verifyCurrent(combined.deliveryComparisonId)).resolves.toEqual(combined);
      const candidates = await LocalDeliveryCandidates.open(owner, objects, versions, store);
      await expect(candidates.materialize(prepared.deliveryComparisonId)).rejects.toThrow(
        'delivery_candidate_not_required',
      );
      const candidate = await candidates.materialize(combined.deliveryComparisonId);
      expect(candidate.version.kind).toBe('files');
      expect(candidate.version).not.toEqual(source.artifact);
      expect(readFileSync(join(candidate.binding.root, 'code.txt'), 'utf8')).toBe('after');
      expect(readFileSync(join(candidate.binding.root, 'user.txt'), 'utf8')).toBe('late edit');
      expect(statSync(join(candidate.binding.root, 'empty/nested')).isDirectory()).toBe(true);
      expect(statSync(join(candidate.binding.root, 'run.sh')).mode & 0o111).toBe(0o100);
      expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('before');
      expect(await candidates.materialize(combined.deliveryComparisonId)).toEqual(candidate);
      const reopened = await LocalDeliveryCandidates.open(owner, objects, versions, store);
      expect(await reopened.read(combined.deliveryComparisonId)).toEqual(candidate);
      source.grantRevision += 1;
      await expect(store.verifyCurrent(combined.deliveryComparisonId)).rejects.toThrow(
        'delivery_stale',
      );
      writeFileSync(join(root, 'code.txt'), 'user conflict');
      source.current = await capture(root);
      const conflicted = await store.prepare({ projectId: 'project', taskId: 'task' });
      expect(conflicted.comparison).toMatchObject({
        status: 'conflict',
        conflicts: ['code.txt'],
        candidate: null,
      });
      await expect(store.verifyCurrent(conflicted.deliveryComparisonId)).rejects.toThrow(
        'delivery_conflict',
      );
      await expect(candidates.materialize(conflicted.deliveryComparisonId)).rejects.toThrow(
        'delivery_conflict',
      );
      writeFileSync(join(candidate.binding.root, 'code.txt'), 'tampered');
      await expect(candidates.read(combined.deliveryComparisonId)).rejects.toThrow();
      evidence.candidate = {
        receiptId: candidate.receiptId,
        version: candidate.version,
        userRootUnchanged: true,
        tamperRejected: true,
      };
      evidence.oldComparisonPreserved = true;
    } finally {
      await owner.release();
    }
  });
}, 60_000);
