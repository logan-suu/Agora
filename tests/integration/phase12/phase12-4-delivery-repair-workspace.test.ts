// Real private files, APFS native snapshots and owned-state receipts. The
// authorization callback isolates this preparation primitive from host admission;
// it does not stand in for the later registered Coder/Harness acceptance.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialAppState } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';
import { LocalDeliveryRepairs } from '../../../packages/runtime/sandbox/src/local-delivery-repairs';
import { inspectLocalRoot } from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { LocalRegistryFile } from '../../../packages/runtime/sandbox/src/local-registry-file';
import { parseLocalRegistry } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalVersionStore } from '../../../packages/runtime/sandbox/src/local-version-store';
import { fileEffectsFixture } from './local-file-effects-fixture';

it('prepares a separate repair tree from exact C and never overwrites partial or changed input', async () => {
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
      mkdirSync(join(root, 'empty'));
      writeFileSync(join(root, 'run.cjs'), 'console.log(2 + 2)\n', { mode: 0o700 });
      const version = await versions.capture(scope, inspectLocalRoot(root), async () => true);
      if (version.kind !== 'files') throw Error('expected files');
      const source = {
        roundId: 'round',
        validationReceiptId: 'validation',
        sourceWorkspaceId: 'source',
        workspaceVersion: version,
        controlFingerprint: 'b'.repeat(64),
        reason: 'tests_failed' as const,
        triggerId: 'validation',
        reviewId: null,
      };
      const store = await LocalDeliveryRepairs.open(owner, objects, versions);
      const request = { scope, dispatchId: 'repair', source };
      const prepared = await store.prepare(request, async () => true);
      expect(prepared.binding.root).not.toBe(root);
      const state = createInitialAppState(
        scope.taskId,
        'Repair current candidate',
        scope.projectId,
      );
      state.phase = 'coding';
      state.nextRole = 'CODER';
      state.workers.push({
        workerId: 'worker:repair:0',
        role: 'CODER',
        status: 'running',
        executor: 'harness',
        startedTs: 1,
      });
      state.messages.push({
        msgId: 'repair',
        fromRole: 'COORDINATOR',
        channelId: 'main',
        type: 'announce',
        ts: 1,
        display: 'Repair C',
        payload: {
          kind: 'delivery_repair_dispatch',
          nextRole: 'CODER',
          source,
          workerIds: ['worker:repair:0'],
        },
      });
      state.localExecution = {
        schemaVersion: 'local-execution-v1',
        rootIds: ['root'],
        workspaces: [
          {
            schemaVersion: 'workspace-v1',
            projectId: scope.projectId,
            taskId: scope.taskId,
            workspaceId: 'repair-workspace',
            rootId: 'root',
            grantId: 'grant',
            mode: 'direct',
            purpose: 'coding',
            baselineManifestId: version.manifestId,
          },
        ],
        bindings: [
          {
            workerId: 'worker:repair:0',
            workspaceId: 'repair-workspace',
            receiptId: 'binding:repair',
          },
        ],
        receipts: [
          {
            actionId: 'repair',
            receiptId: 'binding:repair',
            inputHash: 'a'.repeat(64),
            registryRevision: 1,
          },
        ],
        delivery: {
          schemaVersion: 'local-delivery-v1',
          goal: 'artifact_only',
          rootId: 'root',
          currentRoundId: 'round',
          rounds: [
            {
              roundId: 'round',
              actionId: 'revalidate',
              deliveryComparisonId: 'comparison',
              inputHash: 'c'.repeat(64),
              grantId: 'grant',
              grantRevision: 4,
              sourceReceiptId: 'source',
              sourceVersion: version,
              candidateVersion: version,
              targetVersion: version,
              targetIndexHash: null,
              controlFingerprint: source.controlFingerprint,
            },
          ],
        },
      };
      const grant = { rootId: 'root', grantId: 'grant', revision: 4, policyHash: scope.policyHash };
      expect(
        await store.workspaceBinding(state, 'worker:repair:0', grant, async () => true),
      ).toEqual(prepared.binding);
      await expect(store.workspaceBinding(state, 'other', grant, async () => true)).rejects.toThrow(
        'delivery_repair_assignment_changed',
      );
      await expect(
        store.workspaceBinding(
          state,
          'worker:repair:0',
          { ...grant, revision: 5 },
          async () => true,
        ),
      ).rejects.toThrow('delivery_repair_assignment_changed');
      await expect(
        store.workspaceBinding(state, 'worker:repair:0', grant, async () => false),
      ).rejects.toThrow('authorization_closed');

      expect(readFileSync(join(prepared.binding.root, 'run.cjs'), 'utf8')).toBe(
        'console.log(2 + 2)\n',
      );
      expect(statSync(join(prepared.binding.root, 'empty')).isDirectory()).toBe(true);
      expect(statSync(join(prepared.binding.root, 'run.cjs')).mode & 0o111).not.toBe(0);
      expect(await store.prepare(request, async () => true)).toEqual(prepared);
      await expect(store.prepare(request, async () => false)).rejects.toThrow(
        'authorization_closed',
      );
      await expect(
        store.prepare(
          { ...request, source: { ...source, controlFingerprint: 'c'.repeat(64) } },
          async () => true,
        ),
      ).rejects.toThrow('operation_conflict');
      // Simulate a subsequent authorized edit; preparation replay must not reset it.
      writeFileSync(join(prepared.binding.root, 'run.cjs'), 'console.log(5)\n');
      await expect(store.prepare(request, async () => true)).rejects.toThrow();
      expect((await store.read(request, async () => true)).binding).toEqual(prepared.binding);
      expect(readFileSync(join(root, 'run.cjs'), 'utf8')).toBe('console.log(2 + 2)\n');
      let admissions = 0;
      const interrupted = { ...request, dispatchId: 'interrupted' };
      await expect(store.prepare(interrupted, async () => ++admissions < 3)).rejects.toThrow(
        'authorization_closed',
      );
      await expect(store.prepare(interrupted, async () => true)).rejects.toThrow(
        'delivery_repair_recovery_required',
      );
      evidence.repair = {
        prepared,
        sourceUnchanged: true,
        replayDoesNotOverwrite: true,
        partialPreserved: true,
      };
    } finally {
      await owner.release();
    }
  });
}, 120000);
