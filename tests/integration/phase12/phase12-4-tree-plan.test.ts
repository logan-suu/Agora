// Real native manifest capture and private immutable objects. Authorization here
// permits only fixture reads; this verifies planning, not application or G5 delivery.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';
import { inspectLocalRoot } from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { LocalRegistryFile } from '../../../packages/runtime/sandbox/src/local-registry-file';
import {
  localRecordHash,
  parseLocalRegistry,
} from '../../../packages/runtime/sandbox/src/local-registry-records';
import { planLocalTreeApplication } from '../../../packages/runtime/sandbox/src/local-tree-plan';
import { LocalVersionStore } from '../../../packages/runtime/sandbox/src/local-version-store';
import { fileEffectsFixture } from './local-file-effects-fixture';

it.each(['normal', 'concurrent-child', 'excluded-child', 'invalid-evidence', 'corrupt-bytes'])(
  'plans complete fixed trees through real native manifests: %s',
  async (scenario) => {
    await fileEffectsFixture(async ({ base, root, helper, evidence }) => {
      const owner = await acquireState(join(base, 'state'));
      try {
        await LocalRegistryFile.open(owner, parseLocalRegistry, true);
        const objects = await LocalControlObjects.open(owner),
          versions = new LocalVersionStore(objects, helper);
        const scope = {
          projectId: 'project',
          taskId: 'task',
          rootId: 'root',
          policyHash: 'a'.repeat(64),
        };
        const capture = async (path: string) =>
          versions.capture(scope, inspectLocalRoot(path), async () => true);
        const baselineRoot = join(base, 'baseline'),
          artifactRoot = join(base, 'artifact');
        for (const path of [baselineRoot, artifactRoot]) {
          mkdirSync(path);
          mkdirSync(join(path, '.agora-operations'), { mode: 0o700 });
        }
        for (const path of [baselineRoot, root]) {
          mkdirSync(join(path, 'old'));
          writeFileSync(join(path, 'old/code'), 'original');
        }
        if (scenario === 'concurrent-child') writeFileSync(join(root, 'old/user'), 'external edit');
        if (scenario === 'excluded-child')
          writeFileSync(join(root, 'old/.env'), 'excluded fixture');
        mkdirSync(join(artifactRoot, 'new'));
        mkdirSync(join(artifactRoot, 'new/empty'));
        const bytes = Buffer.from([0, 255, 128, 10]);
        writeFileSync(join(artifactRoot, 'new/code'), bytes);
        const input = {
          scope,
          baseline: await capture(baselineRoot),
          artifact: await capture(artifactRoot),
          current: await capture(root),
        };
        evidence.input = structuredClone(input);
        if (scenario === 'corrupt-bytes') {
          const source = await versions.read(input.artifact, scope);
          const file = source.files.find((f) => f.path === 'new/code');
          if (!file) throw Error('missing artifact content');
          const path = join(owner.root, 'local-workspaces/objects', `${file.contentHash}.bin`);
          chmodSync(path, 0o600);
          writeFileSync(path, Buffer.from([0, 0, 0, 0]));
          chmodSync(path, 0o400);
          await expect(planLocalTreeApplication(versions, input)).rejects.toThrow(
            'invalid_control_object',
          );
          expect(readFileSync(join(root, 'old/code'), 'utf8')).toBe('original');
          return;
        }
        if (scenario === 'invalid-evidence') {
          const source = await versions.read(input.artifact, scope);
          const corruptHash = await objects.put({
            ...source,
            directories: source.directories.filter((d) => d.path !== 'new/empty'),
          });
          await expect(
            planLocalTreeApplication(versions, {
              ...input,
              artifact: {
                kind: 'files',
                manifestId: `manifest:${corruptHash}`,
                manifestHash: corruptHash,
              },
            }),
          ).rejects.toThrow('invalid_workspace_version');
          await expect(
            planLocalTreeApplication(versions, { ...input, scope: { ...scope, taskId: 'other' } }),
          ).rejects.toThrow('workspace_version_scope_mismatch');
          await expect(
            planLocalTreeApplication(versions, { ...input, extra: true } as typeof input),
          ).rejects.toThrow('invalid_tree_plan');
          return;
        }
        writeFileSync(join(artifactRoot, 'new/code'), 'later artifact edit');
        const result = await planLocalTreeApplication(versions, input);
        evidence.plan = result;
        if (scenario !== 'normal') {
          expect(result.comparison.status).toBe('conflict');
          expect(result.comparison.operations).toBeNull();
          expect(result.writes).toEqual([]);
        } else {
          expect(result.comparison.status).toBe('matches_artifact');
          expect(result.comparison.operations?.map((o) => `${o.op}:${o.path}`)).toEqual([
            'remove:old/code',
            'rmdir:old',
            'mkdir:new',
            'mkdir:new/empty',
            'put:new/code',
          ]);
          expect(result.writes).toHaveLength(1);
          const write = result.writes[0];
          if (!write) throw Error('missing fixed write');
          expect(write.path).toBe('new/code');
          expect((await objects.getBytes(write.contentHash)).equals(bytes)).toBe(true);
          expect(readFileSync(join(root, 'old/code'), 'utf8')).toBe('original');
          expect(localRecordHash(await planLocalTreeApplication(versions, input))).toBe(
            localRecordHash(result),
          );
          const pending = planLocalTreeApplication(versions, input);
          input.scope.taskId = 'mutated-after-call';
          expect(localRecordHash(await pending)).toBe(localRecordHash(result));
          evidence.unchangedTarget = true;
        }
      } finally {
        await owner.release();
      }
    });
  },
  60_000,
);
