// Real managed Git and Seatbelt. Fixture writes stand for previously applied
// tree effects; this proves historical Git evidence, not canonical admission.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLocalGitBaseline } from '../src/local-git-baseline';
import { commitLocalGitWorktree } from '../src/local-git-commit';
import { readLocalGitMergeTree } from '../src/local-git-merge';
import { publishLocalGitCandidate, recoverLocalGitCandidate } from '../src/local-git-publish';
import { createLocalGitWorktree } from '../src/local-git-worktree';
import { localRecordHash } from '../src/local-registry-records';
import { binary, fixture, metadataHelper } from './local-git-fixture';

it.each(['history', 'evidence', 'drift'] as const)(
  'reads an existing exact publication without granting replay: %s',
  async (scenario) => {
    const { readLocalGitPublication } = await import('../src/local-git-publish');
    expect(readLocalGitPublication).toBeTypeOf('function');
    await fixture(async (f) => {
      const common = {
        ...f,
        projectId: 'project',
        taskId: 'task',
        git: binary,
        metadataHelper,
        authorize: async () => true,
      };
      const files = [{ path: 'file.txt', content: Buffer.from('base\n'), executable: false }];
      const directories = ['empty'];
      const baseline = await createLocalGitBaseline({ ...common, actionId: 'base', files });
      const target = await createLocalGitWorktree({
        ...common,
        actionId: 'target',
        workspaceId: 'target',
        baseCommit: baseline.commit,
        files,
        directories,
      });
      const source = await createLocalGitWorktree({
        ...common,
        actionId: 'source',
        workspaceId: 'source',
        baseCommit: baseline.commit,
        files,
        directories,
      });
      const content = Buffer.from('changed\n');
      const changed = [{ path: 'file.txt', executable: false, content }];
      writeFileSync(join(source.path, 'file.txt'), content);
      const committed = await commitLocalGitWorktree({
        ...common,
        actionId: 'source-commit',
        workspaceId: 'source',
        creationActionId: 'source',
        expectedHead: baseline.commit,
        files: changed,
        directories,
      });
      const merge = await readLocalGitMergeTree({
        ...common,
        actionId: 'merge',
        baseline: { commit: baseline.commit, files, directories },
        target: {
          workspaceId: 'target',
          creationActionId: 'target',
          head: baseline.commit,
          files,
          directories,
        },
        source: {
          workspaceId: 'source',
          creationActionId: 'source',
          head: committed.commit,
          files: changed,
          directories,
        },
      });
      if (merge.result.kind !== 'merged') throw Error('missing merge');
      writeFileSync(join(target.path, 'file.txt'), content);
      const request = {
        ...common,
        actionId: 'publish',
        workspaceId: 'target',
        creationActionId: 'target',
        sourceWorkspaceId: 'source',
        sourceCreationActionId: 'source',
        applicationHash: 'a'.repeat(64),
        candidate: merge.candidate,
        files: merge.result.files,
        directories: merge.result.directories,
      };
      const key = localRecordHash({ projectId: 'project', taskId: 'task', actionId: 'publish' });
      const prepared = join(f.privateRoot, `${key}.publish-prepared.json`);
      const completed = join(f.privateRoot, `${key}.publish-completed.json`);
      const invalid = join(f.privateRoot, `${key}.publish-invalid.json`);
      const records = () =>
        Object.fromEntries(
          readdirSync(f.privateRoot)
            .filter((n) => n.endsWith('.json'))
            .sort()
            .map((n) => [n, readFileSync(join(f.privateRoot, n), 'utf8')]),
        );
      const before = records();
      await expect(readLocalGitPublication(request)).rejects.toThrow('local_git_recovery_required');
      expect(records()).toEqual(before);
      expect(f.git(['-C', target.path, 'rev-parse', 'HEAD'])).toBe(baseline.commit);
      const receipt = await publishLocalGitCandidate(request);
      const fixed = records();
      const targetIndex = readFileSync(join(target.metadata, 'index'));
      const sourceIndex = readFileSync(join(source.metadata, 'index'));
      if (scenario === 'history') {
        writeFileSync(join(f.root, 'later.txt'), 'legitimate later user commit\n');
        f.git(['add', 'later.txt']);
        f.git(['commit', '-qm', 'Advance user after publication']);
        const userHead = f.git(['rev-parse', 'HEAD']);
        const userIndex = readFileSync(join(f.metadata, 'index'));
        expect(await readLocalGitPublication(request)).toEqual(receipt);
        await expect(publishLocalGitCandidate(request)).rejects.toThrow('operation_conflict');
        await expect(recoverLocalGitCandidate(request)).rejects.toThrow('operation_conflict');
        expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
        expect(readFileSync(join(f.metadata, 'index'))).toEqual(userIndex);
        let moved = false;
        await expect(
          readLocalGitPublication({
            ...request,
            authorize: async () => {
              if (!moved) {
                moved = true;
                writeFileSync(join(f.root, 'during.txt'), 'change during proof\n');
                f.git(['add', 'during.txt']);
              }
              return true;
            },
          }),
        ).rejects.toThrow('local_git_user_state_changed');
      } else if (scenario === 'evidence') {
        const blob = f.git(['rev-parse', `${receipt.commit}:file.txt`]);
        for (const objectId of [receipt.commit, receipt.tree, blob]) {
          const object = join(f.metadata, 'objects', objectId.slice(0, 2), objectId.slice(2));
          const objectBytes = readFileSync(object);
          unlinkSync(object);
          try {
            await expect(readLocalGitPublication(request)).rejects.toThrow();
            expect(existsSync(object)).toBe(false);
          } finally {
            if (existsSync(object)) unlinkSync(object);
            writeFileSync(object, objectBytes, { mode: 0o444 });
          }
        }
        const blobPath = join(f.metadata, 'objects', blob.slice(0, 2), blob.slice(2));
        const blobBytes = readFileSync(blobPath);
        unlinkSync(blobPath);
        writeFileSync(blobPath, 'corrupt object', { mode: 0o444 });
        try {
          await expect(readLocalGitPublication(request)).rejects.toThrow();
          expect(readFileSync(blobPath, 'utf8')).toBe('corrupt object');
        } finally {
          unlinkSync(blobPath);
          writeFileSync(blobPath, blobBytes, { mode: 0o444 });
        }
        for (const path of [prepared, completed]) {
          const bytes = readFileSync(path);
          unlinkSync(path);
          await expect(readLocalGitPublication(request)).rejects.toThrow(
            'local_git_recovery_required',
          );
          expect(readdirSync(f.privateRoot)).not.toContain(path.split('/').at(-1));
          writeFileSync(path, 'null', { mode: 0o600 });
          await expect(readLocalGitPublication(request)).rejects.toThrow(
            'local_git_recovery_required',
          );
          writeFileSync(path, bytes);
        }
        const envelope = JSON.parse(readFileSync(completed, 'utf8'));
        delete envelope.receipt.userStateHash;
        envelope.hash = localRecordHash(envelope.receipt);
        writeFileSync(completed, JSON.stringify(envelope));
        await expect(readLocalGitPublication(request)).rejects.toThrow(
          'local_git_recovery_required',
        );
        envelope.receipt.userStateHash = 'f'.repeat(64);
        envelope.hash = localRecordHash(envelope.receipt);
        writeFileSync(completed, JSON.stringify(envelope));
        await expect(readLocalGitPublication(request)).rejects.toThrow('operation_conflict');
        writeFileSync(completed, fixed[`${key}.publish-completed.json`] as string);
        writeFileSync(invalid, '{}', { mode: 0o600 });
        await expect(readLocalGitPublication(request)).rejects.toThrow(
          'local_git_recovery_required',
        );
        unlinkSync(invalid);
      } else {
        await expect(
          readLocalGitPublication({ ...request, applicationHash: 'b'.repeat(64) }),
        ).rejects.toThrow('operation_conflict');
        writeFileSync(join(target.path, 'file.txt'), 'external drift\n');
        await expect(readLocalGitPublication(request)).rejects.toThrow(
          'local_git_worktree_changed',
        );
        writeFileSync(join(target.path, 'file.txt'), content);
        mkdirSync(join(target.path, 'unknown-empty'));
        await expect(readLocalGitPublication(request)).rejects.toThrow(
          'local_git_worktree_changed',
        );
        rmdirSync(join(target.path, 'unknown-empty'));
        f.git(['-C', target.path, 'read-tree', baseline.commit]);
        await expect(readLocalGitPublication(request)).rejects.toThrow(
          'local_git_worktree_changed',
        );
        writeFileSync(join(target.metadata, 'index'), targetIndex);
        f.git(['update-ref', `refs/heads/${source.branch}`, baseline.commit]);
        await expect(readLocalGitPublication(request)).rejects.toThrow(
          'local_git_worktree_changed',
        );
        f.git(['update-ref', `refs/heads/${source.branch}`, committed.commit]);
        f.git(['update-ref', `refs/heads/${target.branch}`, baseline.commit]);
        await expect(readLocalGitPublication(request)).rejects.toThrow(
          'local_git_worktree_changed',
        );
        f.git(['update-ref', `refs/heads/${target.branch}`, receipt.commit]);
      }
      expect(records()).toEqual(fixed);
      expect(readFileSync(join(target.metadata, 'index'))).toEqual(targetIndex);
      expect(readFileSync(join(source.metadata, 'index'))).toEqual(sourceIndex);
      expect(f.git(['-C', target.path, 'rev-parse', 'HEAD'])).toBe(receipt.commit);
      writeFileSync(
        join(f.privateRoot, 'publication-read-proof.json'),
        JSON.stringify({
          scenario,
          receipt,
          unchangedRecords: true,
          unchangedIndices: true,
          noEffects: true,
        }),
      );
    });
  },
  60_000,
);
