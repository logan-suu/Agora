// Mock reason (R11): canonical State and private command read ports are fixed
// to test source selection; B/A/U manifests use the real native APFS helper.
// This is no substitute for product command execution or G5 delivery.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createInitialAppState,
  type LocalReviewBinding,
  type LocalValidationReceipt,
  type WorkspaceRefV1,
} from '@agora/core-domain';
import type { WorkspaceCommandResult } from '@agora/runtime-sandbox';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import { LocalDirectDeliverySources } from '../../../apps/web/src/server/local-direct-delivery-sources';
import { localControlFingerprint } from '../../../apps/web/src/server/local-validation';
import { localValidationCommand } from '../../../apps/web/src/server/local-validation-command';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';
import { LocalDeliveryComparisonStore } from '../../../packages/runtime/sandbox/src/local-delivery-comparison-record';
import { inspectLocalRoot } from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { LocalRegistryFile } from '../../../packages/runtime/sandbox/src/local-registry-file';
import { parseLocalRegistry } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalVersionStore } from '../../../packages/runtime/sandbox/src/local-version-store';
import { fileEffectsFixture } from './local-file-effects-fixture';

it('selects immutable B and tested A while capturing U separately', async () => {
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
        policyHash: 'c'.repeat(64),
      };
      const baselineRoot = join(base, 'baseline');
      const artifactRoot = join(base, 'artifact');
      for (const path of [baselineRoot, artifactRoot]) {
        mkdirSync(path);
        mkdirSync(join(path, '.agora-operations'), { mode: 0o700 });
      }
      for (const path of [baselineRoot, root]) writeFileSync(join(path, 'code.txt'), 'before');
      writeFileSync(join(artifactRoot, 'code.txt'), 'after');
      writeFileSync(join(artifactRoot, 'a.test.cjs'), 'test fixture');
      const capture = async (path: string) => {
        const version = await versions.capture(scope, inspectLocalRoot(path), async () => true);
        if (version.kind !== 'files') throw Error('expected_file_version');
        return version;
      };
      const baseline = await capture(baselineRoot);
      const artifact = await capture(artifactRoot);
      const coding: WorkspaceRefV1 = {
        schemaVersion: 'workspace-v1',
        projectId: 'project',
        taskId: 'task',
        workspaceId: 'coding',
        rootId: 'root',
        grantId: 'grant',
        purpose: 'coding',
        mode: 'direct',
        baselineManifestId: baseline.manifestId,
      };
      const validation: WorkspaceRefV1 = {
        ...coding,
        workspaceId: 'validation',
        purpose: 'validation',
        baselineManifestId: artifact.manifestId,
      };
      const state = createInitialAppState('task', 'fixed goal', 'project');
      state.subtasks = [
        { id: 'work', title: 'code', ownerRole: 'CODER', dependsOn: [], status: 'done' },
      ];
      state.workers = [
        {
          workerId: 'coder',
          role: 'CODER',
          executor: 'harness',
          status: 'done',
          subtaskId: 'work',
          startedTs: 1,
        },
        { workerId: 'tester', role: 'TESTER', executor: 'harness', status: 'done', startedTs: 2 },
      ];
      state.localExecution = {
        schemaVersion: 'local-execution-v1',
        rootIds: ['root'],
        workspaces: [coding, validation],
        bindings: [
          {
            workerId: 'coder',
            subtaskId: 'work',
            workspaceId: 'coding',
            receiptId: 'binding:coder',
          },
          { workerId: 'tester', workspaceId: 'validation', receiptId: 'binding:tester' },
        ],
        receipts: [
          {
            receiptId: 'binding:coder',
            actionId: 'coder-action',
            inputHash: '1'.repeat(64),
            registryRevision: 1,
          },
          {
            receiptId: 'binding:tester',
            actionId: 'tester-action',
            inputHash: '2'.repeat(64),
            registryRevision: 2,
          },
        ],
        delivery: {
          schemaVersion: 'local-delivery-v1',
          goal: 'apply_to_directory',
          rootId: 'root',
          currentRoundId: null,
          rounds: [],
        },
      };
      const fingerprint = localControlFingerprint(state);
      const run: WorkspaceCommandResult = {
        schemaVersion: 'workspace-command-receipt-v1',
        projectId: 'project',
        taskId: 'task',
        workspaceId: 'validation',
        workerId: 'tester',
        actionId: 'validate',
        grantRevision: 1,
        writerEpoch: 0,
        receiptId: `run:${'f'.repeat(64)}`,
        commandId: 'command:1',
        inputHash: 'd'.repeat(64),
        canonicalSourceRef: 'binding:tester',
        inputVersion: artifact,
        policyHash: 'e'.repeat(64),
        toolVersion: '24.20.0',
        stage: 'exited',
        createdAt: 2,
        startedAt: 1,
        finishedAt: 2,
        exitCode: 0,
        timedOut: false,
        quiescent: true,
        assurance: 'bounded',
        reason: 'none',
        stdoutRef: 'f'.repeat(64),
        stderrRef: 'a'.repeat(64),
        nativeRecordHash: 'b'.repeat(64),
        fixedInputHash: 'c'.repeat(64),
        stderr: '',
        stdout: 'TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n',
      };
      const result = {
        passed: true,
        total: 1,
        failed: 0,
        failures: [],
        workspaceVersion: artifact,
      };
      const receipt: LocalValidationReceipt = {
        kind: 'workspace_validation',
        version: 1,
        projectId: 'project',
        taskId: 'task',
        dispatchId: 'test-dispatch',
        workerId: 'tester',
        sourceWorkspaceId: 'coding',
        validationWorkspaceId: 'validation',
        workspaceVersion: artifact,
        controlFingerprint: fingerprint,
        toolchainHash: '3'.repeat(64),
        policyHash: run.policyHash,
        dependenciesHash: '4'.repeat(64),
        commandReceiptId: run.receiptId,
        commandInputHash: run.inputHash,
        testPaths: ['a.test.cjs'],
        results: result,
        execution: { exitCode: 0, timedOut: false, quiescent: true },
      };
      const binding: LocalReviewBinding = {
        kind: 'workspace_review',
        version: 1,
        validationReceiptId: 'workspace-validation:test-dispatch',
        sourceWorkspaceId: 'coding',
        workspaceVersion: artifact,
        controlFingerprint: fingerprint,
      };
      state.testResults = result;
      state.messages.push(
        {
          msgId: 'test-dispatch',
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          payload: { nextRole: 'TESTER' },
          display: 'test',
          ts: 1,
        },
        {
          msgId: 'workspace-validation:test-dispatch',
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          payload: { ...receipt },
          display: 'passed',
          ts: 2,
        },
        {
          msgId: 'review-dispatch',
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          payload: { nextRole: 'REVIEWER', workspaceReviewBinding: binding },
          display: 'review',
          ts: 3,
        },
      );
      const current = {
        capture: async () => {
          const version = await capture(root);
          return {
            scope,
            grantId: 'grant',
            grantRevision: 1,
            goal: 'apply_to_directory' as const,
            version,
            sourceReceiptId: version.manifestId,
          };
        },
      };
      const manifest = await versions.read(artifact, scope);
      const request = localValidationCommand({
        version: artifact,
        files: manifest.files.map(({ path, version }) => ({ path, version })),
        excludedPaths: manifest.excludedPaths,
      });
      let corrupt = false;
      const historical = new LocalDirectDeliverySources(
        { assertClosed: async () => structuredClone(state) },
        current,
        versions,
        {
          verifyCommand: async () => ({
            command: corrupt ? { ...run, inputHash: '0'.repeat(64) } : run,
            request,
            toolchainHash: receipt.toolchainHash,
            dependenciesHash: receipt.dependenciesHash,
          }),
        },
      );
      const selected = await historical.read({ projectId: 'project', taskId: 'task' });
      expect(selected).toMatchObject({
        baseline,
        artifact,
        current: { kind: 'files' },
        sourceReceipts: { baseline: 'binding:coder', artifact: binding.validationReceiptId },
      });
      const comparisons = new LocalDeliveryComparisonStore(objects, versions, (key) =>
        historical.read(key),
      );
      const prepared = await comparisons.prepare({ projectId: 'project', taskId: 'task' });
      expect(prepared.comparison.status).toBe('matches_artifact');
      writeFileSync(join(root, 'user.txt'), 'outside edit');
      await expect(comparisons.verifyCurrent(prepared.deliveryComparisonId)).rejects.toThrow(
        'delivery_stale',
      );
      const successor: WorkspaceRefV1 = {
        ...coding,
        workspaceId: 'coding-next',
        baselineManifestId: artifact.manifestId,
      };
      state.localExecution.workspaces.push(successor);
      state.workers.push({
        workerId: 'coder-next',
        role: 'CODER',
        executor: 'harness',
        status: 'done',
        subtaskId: 'work',
        startedTs: 4,
      });
      state.localExecution.bindings.push({
        workerId: 'coder-next',
        subtaskId: 'work',
        workspaceId: successor.workspaceId,
        receiptId: 'binding:coder-next',
      });
      state.localExecution.receipts.push({
        receiptId: 'binding:coder-next',
        actionId: 'coder-next-action',
        inputHash: '5'.repeat(64),
        registryRevision: 3,
      });
      const canonicalReceipt = state.messages.find(
        (message) => message.msgId === binding.validationReceiptId,
      );
      const canonicalReview = state.messages.find((message) => message.msgId === 'review-dispatch');
      if (!canonicalReceipt || !canonicalReview) throw Error('missing_fixture_receipts');
      canonicalReceipt.payload.sourceWorkspaceId = successor.workspaceId;
      canonicalReview.payload.workspaceReviewBinding = {
        ...binding,
        sourceWorkspaceId: successor.workspaceId,
      };
      const nextSources = await historical.read({ projectId: 'project', taskId: 'task' });
      expect(nextSources.baseline).toEqual(baseline);
      expect(nextSources.artifact).toEqual(artifact);
      expect(nextSources.sourceReceipts.baseline).toBe('binding:coder');
      const originReceipt = state.localExecution.receipts[0];
      if (!originReceipt) throw Error('missing_origin_receipt');
      originReceipt.registryRevision = 3;
      await expect(historical.read({ projectId: 'project', taskId: 'task' })).rejects.toThrow(
        'delivery_historical_source_invalid',
      );
      originReceipt.registryRevision = 1;
      corrupt = true;
      await expect(historical.read({ projectId: 'project', taskId: 'task' })).rejects.toThrow(
        'delivery_validation_evidence_changed',
      );
      evidence.directSources = {
        comparisonId: prepared.deliveryComparisonId,
        staleRejected: true,
        corruptRejected: true,
      };
    } finally {
      await owner.release();
    }
  });
}, 60_000);
