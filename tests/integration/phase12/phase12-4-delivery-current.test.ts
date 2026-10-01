// Mock reason (R11): the canonical State/registry read ports are fixed to
// exercise admission and drift; U itself is captured by real native APFS code.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialAppState, type WorkspaceRefV1 } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';
import { LocalDirectDeliveryCurrentSource } from '../../../packages/runtime/sandbox/src/local-delivery-current';
import { LocalRegistryFile } from '../../../packages/runtime/sandbox/src/local-registry-file';
import {
  type LocalRegistryRecords,
  parseLocalRegistry,
} from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalVersionStore } from '../../../packages/runtime/sandbox/src/local-version-store';
import { fileEffectsFixture } from './local-file-effects-fixture';

it('captures live direct U only for closed task and active idle grant', async () => {
  await fileEffectsFixture(async ({ base, root, helper, binding, evidence }) => {
    const owner = await acquireState(join(base, 'state'));
    try {
      await LocalRegistryFile.open(owner, parseLocalRegistry, true);
      const objects = await LocalControlObjects.open(owner);
      const versions = new LocalVersionStore(objects, helper);
      const scope = { projectId: 'project', taskId: 'task' };
      const workspace: WorkspaceRefV1 = {
        schemaVersion: 'workspace-v1',
        ...scope,
        workspaceId: 'coding',
        rootId: 'root',
        grantId: 'grant',
        purpose: 'coding',
        mode: 'direct',
        baselineManifestId: `manifest:${'b'.repeat(64)}`,
      };
      const state = createInitialAppState('task', 'fixed goal', 'project');
      state.localExecution = {
        schemaVersion: 'local-execution-v1',
        rootIds: ['root'],
        workspaces: [workspace],
        bindings: [],
        receipts: [],
        delivery: {
          schemaVersion: 'local-delivery-v1',
          goal: 'apply_to_directory',
          rootId: 'root',
          currentRoundId: null,
          rounds: [],
        },
      };
      const registry: LocalRegistryRecords = {
        schemaVersion: 'local-workspaces-v1',
        revision: 1,
        roots: [
          {
            rootId: 'root',
            projectId: 'project',
            selectionRef: 'selection',
            path: root,
            volumeId: 'volume',
            dev: '1',
            inode: '1',
            chain: binding.chain,
            staging: { path: join(root, '.agora-operations'), identity: binding.stagingIdentity },
            inspectionHash: 'a'.repeat(64),
          },
        ],
        grants: [
          {
            grantId: 'grant',
            projectId: 'project',
            rootId: 'root',
            revision: 2,
            policyVersion: 'local-v1',
            actions: ['read', 'edit'],
            toolchainHash: 'a'.repeat(64),
            networkHash: 'b'.repeat(64),
            policyHash: 'c'.repeat(64),
            createdActionId: 'grant-action',
            leaderMessageId: 'grant-message',
            status: 'active',
            revocationActionId: null,
          },
        ],
        workspaces: [workspace],
        claims: [],
        operations: [],
      };
      const control = {
        assertClosed: async () => structuredClone(state),
        snapshot: async () => structuredClone(registry),
      };
      const source = new LocalDirectDeliveryCurrentSource(control, versions, async () => {});
      writeFileSync(join(root, 'code.txt'), 'before');
      const first = await source.capture(scope);
      expect(first).toMatchObject({
        scope: { ...scope, rootId: 'root', policyHash: 'c'.repeat(64) },
        grantId: 'grant',
        grantRevision: 2,
        goal: 'apply_to_directory',
        sourceReceiptId: first.version.manifestId,
      });
      writeFileSync(join(root, 'code.txt'), 'outside change');
      const changed = await source.capture(scope);
      expect(changed.version.manifestHash).not.toBe(first.version.manifestHash);
      registry.claims.push({
        claimId: 'active-claim',
        ...scope,
        workspaceId: 'coding',
        writerEpoch: 1,
        createdActionId: 'claim-action',
        status: 'active',
        closureReceiptId: null,
        workerId: 'coder',
      });
      await expect(source.capture(scope)).rejects.toThrow('delivery_direct_source_unavailable');
      registry.claims = [];
      const originalRoot = registry.roots[0];
      if (!originalRoot) throw Error('missing_fixture_root');
      registry.roots.push({
        ...originalRoot,
        projectId: 'other-project',
        rootId: 'other-root',
      });
      registry.workspaces.push({
        ...workspace,
        projectId: 'other-project',
        taskId: 'other-task',
        workspaceId: 'other-workspace',
        rootId: 'other-root',
      });
      registry.claims.push({
        claimId: 'other-claim',
        projectId: 'other-project',
        taskId: 'other-task',
        workspaceId: 'other-workspace',
        writerEpoch: 1,
        createdActionId: 'other-action',
        status: 'active',
        closureReceiptId: null,
        workerId: 'other-coder',
      });
      await expect(source.capture(scope)).rejects.toThrow('delivery_direct_source_unavailable');
      registry.claims = [];
      const grant = registry.grants[0];
      if (!grant) throw Error('missing_fixture_grant');
      grant.status = 'revoked';
      await expect(source.capture(scope)).rejects.toThrow('delivery_direct_source_unavailable');
      evidence.directCurrent = { first, changed, activeClaimRejected: true, revokedRejected: true };
    } finally {
      await owner.release();
    }
  });
}, 60_000);
