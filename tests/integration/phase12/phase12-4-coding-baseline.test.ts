// Real registration, native manifests and Git; lifecycle control remains test-owned.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readLocalDeliveryGitBaseline } from '../../../packages/runtime/sandbox/src/local-delivery-git-baseline';
import { readLocalDeliveryGitCurrent } from '../../../packages/runtime/sandbox/src/local-delivery-git-current';
import type { LocalGitBatchRequest } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { firstCodingWave, registeredFixture } from './local-linked-workspace-fixture';

it(
  'reads the original complete baseline after user edits without replaying registration',
  async () =>
    fixture(async (f) => {
      mkdirSync(join(f.root, 'empty/nested'), { recursive: true });
      await registeredFixture(
        f,
        async (ctx) => {
          const { manager, request } = await firstCodingWave(ctx);
          await manager.registerCodingWave(request);
          const workerId = request.targets[0]?.workerId;
          if (!workerId) throw Error('missing worker');
          const original = readFileSync(join(f.root, 'file.txt'), 'utf8');
          writeFileSync(join(f.root, 'file.txt'), 'later user edit\n');
          writeFileSync(join(f.root, 'later.txt'), 'not part of baseline\n');
          f.git(['add', 'file.txt', 'later.txt']);
          f.git(['commit', '-qm', 'Advance user checkout']);
          const userHead = f.git(['rev-parse', 'HEAD']);
          const userIndex = readFileSync(join(f.metadata, 'index'));
          const before = await ctx.control.assertClosed(ctx.scope);
          const registry = await ctx.control.snapshot();
          const refs = await ctx.objects.references();
          const result = await manager.readCodingBaseline({ ...ctx.scope, workerId });
          const deliveryBaseline = await readLocalDeliveryGitBaseline(
            {
              control: ctx.control,
              objects: ctx.objects,
              versions: ctx.versions,
              verifyGrant: ctx.verifyGrant,
              gitOptions: ctx.gitOptions,
            },
            ctx.scope,
          );
          expect(deliveryBaseline.version).toEqual(result.version);
          expect(deliveryBaseline.receipt).toEqual(result.receipt);
          expect(result.manifest.directories.map((d) => d.path)).toContain('empty/nested');
          expect(result.manifest.files.some((file) => file.path === 'later.txt')).toBe(false);
          const file = result.manifest.files.find((file) => file.path === 'file.txt');
          if (!file) throw Error('missing baseline file');
          expect((await ctx.objects.getBytes(file.contentHash)).toString()).toBe(original);
          expect(result.receipt.commit).toBe(
            request.version.kind === 'git' && request.version.commit,
          );
          expect(readFileSync(join(f.root, 'file.txt'), 'utf8')).toBe('later user edit\n');
          expect(await ctx.control.assertClosed(ctx.scope)).toEqual(before);
          expect(await ctx.control.snapshot()).toEqual(registry);
          expect(await ctx.objects.references()).toEqual(refs);
          expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.metadata, 'index'))).toEqual(userIndex);
          expect(result.receipt.sourceHead.commit).not.toBe(userHead);
          await expect(
            manager.readCodingBaseline({ ...ctx.scope, workerId: 'unknown' }),
          ).rejects.toThrow();
          const objectsRoot = join(f.base, 'state/local-workspaces/objects');
          const baselineKey = localRecordHash({ ...ctx.scope, actionId: result.receipt.actionId });
          const firstKey = localRecordHash({
            kind: 'initial-git-batch',
            ...ctx.scope,
            actionId: result.initialBatch.receipt.actionId,
          });
          const missing = [
            join(objectsRoot, `${firstKey}.ref`),
            join(objectsRoot, `${result.initialBatch.bindingHash}.json`),
            join(objectsRoot, `${result.version.manifestHash}.json`),
            join(objectsRoot, `${result.codingVersion.manifestHash}.json`),
            join(f.privateRoot, `${baselineKey}.prepared.json`),
            join(f.privateRoot, `${baselineKey}.completed.json`),
          ];
          for (const path of missing) {
            renameSync(path, `${path}.held`);
            try {
              await expect(
                manager.readCodingBaseline({ ...ctx.scope, workerId }),
              ).rejects.toThrow();
              expect(existsSync(path)).toBe(false);
            } finally {
              renameSync(`${path}.held`, path);
            }
          }
          const privateNames = readdirSync(f.privateRoot).sort();
          f.git([
            'update-ref',
            `refs/heads/${result.receipt.branch}`,
            userHead,
            result.receipt.commit,
          ]);
          try {
            await expect(manager.readCodingBaseline({ ...ctx.scope, workerId })).rejects.toThrow(
              'local_git_baseline_proof_mismatch',
            );
          } finally {
            f.git([
              'update-ref',
              `refs/heads/${result.receipt.branch}`,
              result.receipt.commit,
              userHead,
            ]);
          }
          expect(readdirSync(f.privateRoot).sort()).toEqual(privateNames);
          expect(await ctx.control.assertClosed(ctx.scope)).toEqual(before);
          expect(await ctx.control.snapshot()).toEqual(registry);
          expect(await ctx.objects.references()).toEqual(refs);
          // A self-consistent replacement of both manifests must still fail the original
          // creation receipt's complete-directory hash. This is deliberate private-store corruption.
          const codingKey = localRecordHash({
            kind: 'coding-git-batch',
            ...ctx.scope,
            actionId: result.codingBatch.receipt.actionId,
          });
          const gitManifest = await ctx.versions.readGitManifest(
            result.codingVersion,
            ctx.versionScope,
          );
          const codingManifest = await ctx.versions.read(result.codingVersion, ctx.versionScope);
          const withoutEmpty = (value: typeof result.manifest) => ({
            ...value,
            directories: value.directories
              .filter((d) => d.path !== 'empty' && !d.path.startsWith('empty/'))
              .map((d) => ({
                ...d,
                entries: d.entries.filter((entry) => d.path !== '' || entry.name !== 'empty'),
              })),
          });
          const fixed = async (value: typeof result.manifest) => {
            const manifestHash = await ctx.objects.put(withoutEmpty(value));
            return { kind: 'files' as const, manifestId: `manifest:${manifestHash}`, manifestHash };
          };
          const initialVersion = await fixed(result.manifest);
          const filesVersion = await fixed(codingManifest);
          await ctx.versions.read(initialVersion, ctx.versionScope);
          await ctx.versions.read(filesVersion, ctx.versionScope);
          const manifestHash = await ctx.objects.put({ ...gitManifest, filesVersion });
          const overrides = [
            { key: firstKey, inputHash: result.initialBatch.inputHash, version: initialVersion },
            {
              key: codingKey,
              inputHash: result.codingBatch.inputHash,
              version: {
                ...result.codingVersion,
                manifestId: `manifest:${manifestHash}`,
                manifestHash,
              },
            },
          ];
          const changed: string[] = [];
          try {
            for (const override of overrides) {
              const saved = (await ctx.objects.get(override.inputHash)) as {
                request: LocalGitBatchRequest;
                gitOptions: typeof ctx.gitOptions;
              };
              const valueHash = await ctx.objects.put({
                ...saved,
                request: { ...saved.request, version: override.version },
              });
              const path = join(objectsRoot, `${override.key}.ref`);
              renameSync(path, `${path}.held`);
              changed.push(path);
              const ref = { key: override.key, valueHash };
              writeFileSync(path, JSON.stringify({ ...ref, sha256: localRecordHash(ref) }), {
                flag: 'wx',
                mode: 0o400,
              });
            }
            await expect(manager.readCodingBaseline({ ...ctx.scope, workerId })).rejects.toThrow(
              'coding_baseline_proof_mismatch',
            );
          } finally {
            for (const path of changed) {
              if (existsSync(path)) unlinkSync(path);
              renameSync(`${path}.held`, path);
            }
          }
          expect(await ctx.control.assertClosed(ctx.scope)).toEqual(before);
          expect(await ctx.objects.references()).toEqual(refs);
          // Historical reads above must not publish references. Explicit U capture
          // separately retains exactly one immutable metadata proof for later application.
          const current = await readLocalDeliveryGitCurrent(ctx, ctx.scope);
          expect(current.sourceReceiptId).toMatch(/^git-current:[a-f0-9]{64}$/);
          expect(current.targetIndexHash).not.toBeNull();
          const currentManifest = await ctx.versions.read(current.version, ctx.versionScope);
          expect(currentManifest.files.some((entry) => entry.path === 'later.txt')).toBe(true);
          expect(current.version).not.toEqual(deliveryBaseline.version);
          const currentKey = localRecordHash({
            kind: 'delivery-git-current',
            scope: current.scope,
            grantId: current.grantId,
            grantRevision: current.grantRevision,
            sourceReceiptId: current.sourceReceiptId,
          });
          const currentHash = await ctx.objects.getReference(currentKey);
          expect(currentHash).toMatch(/^[a-f0-9]{64}$/);
          if (!currentHash) throw Error('missing current metadata proof');
          const currentProof = (await ctx.objects.get(currentHash)) as { userStateHash: string };
          expect(currentProof.userStateHash).toMatch(/^[a-f0-9]{64}$/);
          expect(currentProof).toEqual({
            schemaVersion: 'delivery-git-current-v1',
            ...current,
            userStateHash: currentProof.userStateHash,
          });
          expect(current.sourceReceiptId).toBe(
            `git-current:${localRecordHash({
              version: current.version,
              userStateHash: currentProof.userStateHash,
            })}`,
          );
          const capturedRefs = [...refs, { key: currentKey, valueHash: currentHash }].sort((a, b) =>
            a.key.localeCompare(b.key),
          );
          expect(await ctx.objects.references()).toEqual(capturedRefs);
          expect(await readLocalDeliveryGitCurrent(ctx, ctx.scope)).toEqual(current);
          expect(await ctx.objects.references()).toEqual(capturedRefs);
          expect(await ctx.control.assertClosed(ctx.scope)).toEqual(before);
          expect(await ctx.control.snapshot()).toEqual(registry);
          expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.metadata, 'index'))).toEqual(userIndex);
          writeFileSync(
            join(f.privateRoot, 'coding-baseline-proof.json'),
            JSON.stringify({
              result,
              userHead,
              userHeadAndIndexUnchanged: true,
              stateAndRegistryUnchanged: true,
              missingEvidenceRejected: missing.length,
              privateRefDriftRejected: true,
              coherentEmptyDirectoryRemovalRejected: true,
              explicitCurrentCaptureMetadata: { currentKey, currentHash, current },
              repeatedCurrentCaptureReferenceStable: true,
            }),
          );
        },
        true,
      );
    }),
  90_000,
);
