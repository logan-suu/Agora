// Real managed Git, APFS and native effects. Publication fault injection below
// delegates all storage except the explicitly interrupted completion boundary.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { acquireState } from '../../../../apps/desktop/src/storage';
import { LocalControlObjects } from '../src/local-control-objects';
import { createLocalGitBaseline } from '../src/local-git-baseline';
import { commitLocalGitWorktree } from '../src/local-git-commit';
import { createLocalGitWorktree } from '../src/local-git-worktree';
import { LocalMergeCandidates } from '../src/local-merge-candidates';
import { LocalRegistryFile } from '../src/local-registry-file';
import { localRecordHash, parseLocalRegistry } from '../src/local-registry-records';
import { LocalVersionStore } from '../src/local-version-store';
import { binary, fixture, metadataHelper } from './local-git-fixture';

it.each([
  'normal',
  'conflict',
  'partial',
  'lost-completion',
  'late-edit',
  'completion-edit',
  'source-drift',
  'directory-drift',
] as const)(
  'materializes a real immutable merge candidate: %s',
  async (scenario) =>
    fixture(async (f) => {
      const owner = await acquireState(join(f.base, 'state'));
      try {
        await LocalRegistryFile.open(owner, parseLocalRegistry, true);
        const objects = await LocalControlObjects.open(owner);
        const helper = resolve(
          'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
        );
        const versions = new LocalVersionStore(objects, helper);
        let service = await LocalMergeCandidates.open(owner, objects, versions, helper);
        const scope = {
          projectId: 'project',
          taskId: 'task',
          rootId: 'root',
          policyHash: 'a'.repeat(64),
        };
        const common = {
          ...f,
          git: binary,
          metadataHelper,
          projectId: 'project',
          taskId: 'task',
          authorize: async () => true,
        };
        const binaryFile = {
          path: 'binary',
          content: Buffer.from([0, 255, 128, 10]),
          executable: true,
        };
        const files = [
          binaryFile,
          ...(scenario === 'normal'
            ? ['\uE000', '😀'].map((path) => ({
                path,
                content: Buffer.from(path),
                executable: false,
              }))
            : []),
        ];
        const baseline = await createLocalGitBaseline({ ...common, actionId: 'baseline', files });
        const sides = [];
        for (const name of ['ours', 'theirs']) {
          const directories = ['empty', name];
          const created = await createLocalGitWorktree({
            ...common,
            actionId: `create-${name}`,
            workspaceId: name,
            baseCommit: baseline.commit,
            files,
            directories: ['empty'],
          });
          mkdirSync(join(created.path, name));
          const next =
            scenario === 'conflict'
              ? [{ ...binaryFile, content: Buffer.from(name) }]
              : [...files, { path: `${name}/code`, content: Buffer.from(name), executable: false }];
          for (const file of next) {
            writeFileSync(join(created.path, file.path), file.content);
            chmodSync(join(created.path, file.path), file.executable ? 0o755 : 0o644);
          }
          const commit = await commitLocalGitWorktree({
            ...common,
            actionId: `commit-${name}`,
            workspaceId: name,
            creationActionId: created.actionId,
            expectedHead: baseline.commit,
            files: next,
            directories,
          });
          sides.push({
            workspaceId: name,
            creationActionId: created.actionId,
            head: commit.commit,
            files: next,
            directories,
            created,
          });
        }
        const [target, source] = sides;
        if (!target || !source) throw Error('missing fixture sides');
        const merge = {
          ...common,
          actionId: 'merge',
          baseline: { commit: baseline.commit, files, directories: ['empty'] },
          target,
          source,
        };
        const request = { scope, actionId: 'materialize', merge };
        const candidateRoot = join(owner.root, 'merge-candidates');
        const targetIndex = readFileSync(join(f.metadata, 'index'));
        const initial = readdirSync(candidateRoot).sort();
        await expect(
          service.materialize({ ...request, scope: { ...scope, taskId: 'other' } }),
        ).rejects.toThrow('workspace_version_scope_mismatch');
        expect(readdirSync(candidateRoot).sort()).toEqual(initial);
        if (scenario === 'conflict') {
          await expect(service.materialize(request)).rejects.toThrow('local_git_merge_conflict');
          expect(readdirSync(candidateRoot).sort()).toEqual(initial);
          return;
        }
        let deny = scenario === 'partial';
        let faultInjected = false;
        if (deny)
          merge.authorize = async () => {
            const allowed =
              !deny ||
              !readdirSync(candidateRoot).some((name) =>
                existsSync(join(candidateRoot, name, 'tree', 'empty')),
              );
            if (!allowed) faultInjected = true;
            return allowed;
          };
        let drifted = false;
        if (scenario === 'source-drift')
          merge.authorize = async () => {
            if (
              !drifted &&
              readdirSync(candidateRoot).some((name) =>
                existsSync(join(candidateRoot, name, 'tree', 'empty')),
              )
            ) {
              writeFileSync(join(source.created.path, 'binary'), 'source edit');
              drifted = true;
            }
            return true;
          };
        const bind = objects.bindReference.bind(objects);
        if (['lost-completion', 'late-edit', 'completion-edit'].includes(scenario))
          objects.bindReference = async (key, hash) => {
            const record = (await objects.get(hash)) as {
              schemaVersion?: string;
              binding?: { root: string };
              receiptHash?: string;
            };
            if (
              scenario === 'lost-completion' &&
              record.schemaVersion === 'local-merge-candidate-completion-v1'
            ) {
              faultInjected = true;
              throw Error('injected_completion_failure');
            }
            await bind(key, hash);
            if (
              scenario === 'completion-edit' &&
              record.schemaVersion === 'local-merge-candidate-completion-v1'
            ) {
              if (!record.receiptHash) throw Error('missing receipt');
              const result = (await objects.get(record.receiptHash)) as {
                binding: { root: string };
              };
              writeFileSync(join(result.binding.root, 'binary'), 'post-completion edit');
              faultInjected = true;
            }
            if (scenario === 'late-edit' && record.schemaVersion === 'local-merge-candidate-v1') {
              if (!record.binding) throw Error('missing candidate binding');
              writeFileSync(join(record.binding.root, 'binary'), 'external edit');
              faultInjected = true;
            }
          };
        if (
          ['partial', 'lost-completion', 'late-edit', 'completion-edit', 'source-drift'].includes(
            scenario,
          )
        ) {
          await expect(service.materialize(request)).rejects.toThrow();
          if (scenario !== 'source-drift') expect(faultInjected).toBe(true);
          const paths = readdirSync(candidateRoot).sort();
          expect(paths).toHaveLength(1);
          deny = false;
          if (scenario === 'source-drift') {
            expect(drifted).toBe(true);
            writeFileSync(join(source.created.path, 'binary'), binaryFile.content);
          }
          objects.bindReference = bind;
          service = await LocalMergeCandidates.open(owner, objects, versions, helper);
          await expect(service.materialize(request)).rejects.toThrow(
            'merge_candidate_recovery_required',
          );
          expect(readdirSync(candidateRoot).sort()).toEqual(paths);
        } else {
          const result = await service.materialize(request);
          expect(result.version.kind).toBe('files');
          const manifest = await versions.read(result.version, scope);
          expect(manifest.directories.map((d) => d.path)).toEqual(['', 'empty', 'ours', 'theirs']);
          expect(manifest.excludedPaths).toEqual(['.agora-operations']);
          expect(readFileSync(join(result.binding.root, 'binary')).equals(binaryFile.content)).toBe(
            true,
          );
          expect(manifest.files.find((f) => f.path === 'binary')?.version.executable).toBe(true);
          service = await LocalMergeCandidates.open(owner, objects, versions, helper);
          const proofInput = { receipt: result, git: { ...common, actionId: 'read-candidate' } };
          const proofRefs = await objects.references();
          expect(await service.readCompleted(proofInput)).toEqual(result);
          const key = localRecordHash({
            kind: 'merge-candidate',
            projectId: scope.projectId,
            taskId: scope.taskId,
            actionId: request.actionId,
          });
          const marker = localRecordHash({ kind: 'merge-candidate', key, name: 'completion' });
          const markerPath = join(owner.root, 'local-workspaces/objects', `${marker}.ref`);
          renameSync(markerPath, `${markerPath}.held`);
          try {
            await expect(service.readCompleted(proofInput)).rejects.toThrow(
              'merge_candidate_recovery_required',
            );
          } finally {
            renameSync(`${markerPath}.held`, markerPath);
          }
          expect(await objects.references()).toEqual(proofRefs);
          expect(await service.materialize(request)).toEqual(result);
          await expect(
            service.materialize({ ...request, scope: { ...scope, policyHash: 'b'.repeat(64) } }),
          ).rejects.toThrow('operation_conflict');
          if (scenario === 'directory-drift') {
            renameSync(join(result.binding.root, 'empty'), join(result.binding.root, 'previous'));
            mkdirSync(join(result.binding.root, 'empty'));
            await expect(service.materialize(request)).rejects.toThrow();
          } else {
            const other = {
              ...request,
              actionId: 'denied',
              merge: { ...merge, authorize: async () => false },
            };
            await expect(service.materialize(other)).rejects.toThrow('authorization_closed');
          }
        }
        for (const side of sides) {
          expect(f.git(['-C', side.created.path, 'rev-parse', 'HEAD'])).toBe(side.head);
          for (const file of side.files)
            expect(readFileSync(join(side.created.path, file.path))).toEqual(file.content);
        }
        expect(readFileSync(join(f.metadata, 'index'))).toEqual(targetIndex);
      } finally {
        await owner.release();
      }
    }),
  120_000,
);
