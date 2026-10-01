// Real managed Git and Seatbelt; direct fixture writes represent already applied
// tree effects. These tests prove the Git primitive, not canonical State admission.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLocalGitBaseline } from '../src/local-git-baseline';
import { commitLocalGitWorktree } from '../src/local-git-commit';
import { readLocalGitMergeTree } from '../src/local-git-merge';
import { createLocalGitWorktree } from '../src/local-git-worktree';
import { localRecordHash } from '../src/local-registry-records';
import { binary, fixture, hash, metadataHelper } from './local-git-fixture';

it.each(['normal', 'prepared-gap', 'ref-gap', 'index-gap', 'drift', 'completion-gap'] as const)(
  'publishes the exact merge candidate with explicit recovery: %s',
  async (scenario) => {
    const { publishLocalGitCandidate, recoverLocalGitCandidate } = await import(
      '../src/local-git-publish'
    );
    await fixture(async (f) => {
      const common = {
        ...f,
        git: binary,
        metadataHelper,
        projectId: 'project',
        taskId: 'task',
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
      const next = [
        { path: 'file.txt', content: Buffer.from('changed\n'), executable: false },
        { path: 'binary.dat', content: Buffer.from([0, 255, 128, 10]), executable: true },
      ];
      const nextDirectories = ['empty', '空'];
      for (const item of next) {
        writeFileSync(join(source.path, item.path), item.content);
        chmodSync(join(source.path, item.path), item.executable ? 0o755 : 0o644);
      }
      mkdirSync(join(source.path, '空'));
      const committed = await commitLocalGitWorktree({
        ...common,
        actionId: 'source-commit',
        workspaceId: source.workspaceId,
        creationActionId: source.actionId,
        expectedHead: baseline.commit,
        files: next,
        directories: nextDirectories,
      });
      const merge = await readLocalGitMergeTree({
        ...common,
        actionId: 'merge',
        baseline: { commit: baseline.commit, files, directories },
        target: {
          workspaceId: target.workspaceId,
          creationActionId: target.actionId,
          head: baseline.commit,
          files,
          directories,
        },
        source: {
          workspaceId: source.workspaceId,
          creationActionId: source.actionId,
          head: committed.commit,
          files: next,
          directories: nextDirectories,
        },
      });
      if (merge.candidate.result.kind !== 'merged' || merge.result.kind !== 'merged')
        throw Error('missing candidate');
      for (const item of merge.result.files) {
        writeFileSync(join(target.path, item.path), item.content);
        chmodSync(join(target.path, item.path), item.executable ? 0o755 : 0o644);
      }
      mkdirSync(join(target.path, '空'));
      const request = {
        ...common,
        actionId: 'publish',
        workspaceId: target.workspaceId,
        creationActionId: target.actionId,
        sourceWorkspaceId: source.workspaceId,
        sourceCreationActionId: source.actionId,
        candidate: merge.candidate,
        applicationHash: 'a'.repeat(64),
        files: merge.result.files,
        directories: merge.result.directories,
      };
      const key = localRecordHash({ projectId: 'project', taskId: 'task', actionId: 'publish' });
      const prepared = join(f.privateRoot, `${key}.publish-prepared.json`);
      const completed = join(f.privateRoot, `${key}.publish-completed.json`);
      const invalid = join(f.privateRoot, `${key}.publish-invalid.json`);
      const head = () => f.git(['-C', target.path, 'rev-parse', 'HEAD']);
      const index = () => readFileSync(join(target.metadata, 'index'));
      const originalIndex = index();
      const userHead = f.git(['rev-parse', 'HEAD']);
      const userIndex = readFileSync(join(f.metadata, 'index'));
      const userFile = readFileSync(join(f.root, 'file.txt'));
      const sourceIndex = readFileSync(join(source.metadata, 'index'));
      const unchanged = () => {
        expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
        expect(readFileSync(join(f.metadata, 'index'))).toEqual(userIndex);
        expect(readFileSync(join(f.root, 'file.txt'))).toEqual(userFile);
        expect(f.git(['-C', source.path, 'rev-parse', 'HEAD'])).toBe(committed.commit);
        expect(readFileSync(join(source.metadata, 'index'))).toEqual(sourceIndex);
        for (const file of next)
          expect(readFileSync(join(source.path, file.path))).toEqual(file.content);
      };
      await expect(recoverLocalGitCandidate(request)).rejects.toThrow(
        'local_git_recovery_required',
      );
      if (scenario === 'normal') {
        const forged = structuredClone(merge.candidate);
        if (forged.result.kind !== 'merged') throw Error('missing candidate');
        forged.result.commit = committed.commit;
        await expect(publishLocalGitCandidate({ ...request, candidate: forged })).rejects.toThrow(
          'local_git_merge_proof_invalid',
        );
        expect(existsSync(prepared)).toBe(false);
      } else {
        const authorize = async () => {
          if (scenario === 'completion-gap') return !existsSync(completed);
          if (scenario === 'index-gap') return hash(index()) === hash(originalIndex);
          if (scenario === 'ref-gap') return head() === baseline.commit;
          return !existsSync(prepared);
        };
        await expect(publishLocalGitCandidate({ ...request, authorize })).rejects.toThrow(
          'authorization_closed',
        );
        expect(existsSync(prepared)).toBe(true);
        unchanged();
        if (scenario === 'completion-gap') {
          expect(existsSync(invalid)).toBe(true);
          await expect(recoverLocalGitCandidate(request)).rejects.toThrow(
            'local_git_recovery_required',
          );
          await expect(publishLocalGitCandidate(request)).rejects.toThrow(
            'local_git_recovery_required',
          );
          return;
        }
        expect(existsSync(completed)).toBe(false);
        await expect(publishLocalGitCandidate(request)).rejects.toThrow(
          'local_git_recovery_required',
        );
        if (scenario === 'drift') {
          writeFileSync(join(target.path, 'file.txt'), 'external edit\n');
          await expect(recoverLocalGitCandidate(request)).rejects.toThrow(
            'local_git_worktree_changed',
          );
          expect(head()).toBe(baseline.commit);
          expect(index()).toEqual(originalIndex);
          expect(existsSync(completed)).toBe(false);
          writeFileSync(join(target.path, 'file.txt'), 'changed\n');
          f.git(['-C', target.path, 'add', 'file.txt']);
          await expect(recoverLocalGitCandidate(request)).rejects.toThrow(
            'local_git_worktree_changed',
          );
          writeFileSync(join(target.metadata, 'index'), originalIndex);
          f.git(['update-ref', `refs/heads/${target.branch}`, committed.commit]);
          await expect(recoverLocalGitCandidate(request)).rejects.toThrow(
            'local_git_worktree_changed',
          );
          f.git(['update-ref', `refs/heads/${target.branch}`, baseline.commit]);
          f.git(['update-ref', `refs/heads/${source.branch}`, baseline.commit]);
          await expect(recoverLocalGitCandidate(request)).rejects.toThrow(
            'local_git_worktree_changed',
          );
          f.git(['update-ref', `refs/heads/${source.branch}`, committed.commit]);
          const originalPrepared = readFileSync(prepared);
          unlinkSync(prepared);
          await expect(recoverLocalGitCandidate(request)).rejects.toThrow(
            'local_git_recovery_required',
          );
          writeFileSync(prepared, originalPrepared, { mode: 0o600, flag: 'wx' });
          unchanged();
          writeFileSync(join(f.root, 'file.txt'), 'new user commit\n');
          f.git(['add', 'file.txt']);
          f.git(['commit', '-qm', 'Advance user during interrupted publication']);
          await expect(recoverLocalGitCandidate(request)).rejects.toThrow('operation_conflict');
          expect(head()).toBe(baseline.commit);
          expect(index()).toEqual(originalIndex);
          expect(existsSync(completed)).toBe(false);
          writeFileSync(
            join(f.privateRoot, 'publish-proof.json'),
            JSON.stringify({
              scenario,
              rejected: ['files', 'index', 'head', 'source', 'prepared', 'user-state'],
            }),
          );
          return;
        }
        expect(head()).toBe(
          scenario === 'prepared-gap' ? baseline.commit : merge.candidate.result.commit,
        );
        if (scenario !== 'index-gap') expect(index()).toEqual(originalIndex);
      }
      const receipt =
        scenario === 'normal'
          ? await publishLocalGitCandidate(request)
          : await recoverLocalGitCandidate(request);
      expect(receipt.commit).toBe(merge.candidate.result.commit);
      expect(receipt.tree).toBe(merge.candidate.result.tree);
      expect(receipt.applicationHash).toBe(request.applicationHash);
      expect(head()).toBe(receipt.commit);
      expect(f.git(['rev-list', '--parents', '-n', '1', receipt.commit])).toBe(
        `${receipt.commit} ${baseline.commit} ${committed.commit}`,
      );
      const appliedIndex = index();
      expect(await publishLocalGitCandidate(request)).toEqual(receipt);
      expect(await recoverLocalGitCandidate(request)).toEqual(receipt);
      expect(index()).toEqual(appliedIndex);
      await expect(
        recoverLocalGitCandidate({ ...request, applicationHash: 'b'.repeat(64) }),
      ).rejects.toThrow('operation_conflict');
      if (scenario === 'normal') {
        for (const path of [prepared, completed]) {
          const saved = readFileSync(path);
          writeFileSync(path, 'null');
          await expect(publishLocalGitCandidate(request)).rejects.toThrow(
            'local_git_recovery_required',
          );
          await expect(recoverLocalGitCandidate(request)).rejects.toThrow(
            'local_git_recovery_required',
          );
          expect(index()).toEqual(appliedIndex);
          expect(head()).toBe(receipt.commit);
          writeFileSync(path, saved);
        }
        symlinkSync(join(f.privateRoot, 'missing-invalid'), invalid);
        await expect(recoverLocalGitCandidate(request)).rejects.toThrow(
          'local_git_recovery_required',
        );
        unlinkSync(invalid);
        const mergeHead = join(target.metadata, 'MERGE_HEAD');
        writeFileSync(mergeHead, `${committed.commit}\n`);
        await expect(recoverLocalGitCandidate(request)).rejects.toThrow(
          'local_git_merge_in_progress',
        );
        unlinkSync(mergeHead);
        const mergeKey = localRecordHash({
          projectId: 'project',
          taskId: 'task',
          actionId: 'merge',
        });
        const mergeCompleted = join(f.privateRoot, `${mergeKey}.merge-completed.json`);
        const originalMerge = readFileSync(mergeCompleted);
        const fake = structuredClone(merge.candidate);
        if (fake.result.kind !== 'merged') throw Error('missing candidate');
        const tree = f.git(['rev-parse', `${baseline.commit}^{tree}`]);
        fake.result = { ...fake.result, tree };
        writeFileSync(
          mergeCompleted,
          JSON.stringify({ candidate: fake, hash: localRecordHash(fake) }),
        );
        await expect(recoverLocalGitCandidate({ ...request, candidate: fake })).rejects.toThrow(
          'local_git_merge_proof_invalid',
        );
        writeFileSync(mergeCompleted, originalMerge);
      }
      unchanged();
      writeFileSync(
        join(f.privateRoot, 'publish-proof.json'),
        JSON.stringify({ scenario, receipt, unchangedUser: true, sourceHead: committed.commit }),
      );
    });
  },
  60_000,
);
