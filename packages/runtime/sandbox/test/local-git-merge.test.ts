// Real managed Git and Seatbelt in ownership-checked disposable roots.
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLocalGitBaseline } from '../src/local-git-baseline';
import { commitLocalGitWorktree, readLocalGitCommit } from '../src/local-git-commit';
import { createLocalGitWorktree } from '../src/local-git-worktree';
import { localRecordHash } from '../src/local-registry-records';
import { binary, fixture, metadataHelper } from './local-git-fixture';

const file = (path: string, content: string) => ({
  path,
  content: Buffer.from(content),
  executable: false,
});

it(
  'reads historical commits after a user commit while refusing mutating replay',
  async () =>
    fixture(async (f) => {
      const common = {
        ...f,
        git: binary,
        metadataHelper,
        projectId: 'project',
        taskId: 'task',
        authorize: async () => true,
      };
      const files = [file('file.txt', 'fixed\n')];
      const baseline = await createLocalGitBaseline({ ...common, actionId: 'baseline', files });
      const created = await createLocalGitWorktree({
        ...common,
        actionId: 'create',
        workspaceId: 'worker',
        baseCommit: baseline.commit,
        files,
      });
      const next = [file('file.txt', 'completed\n')];
      writeFileSync(join(created.path, 'file.txt'), 'completed\n');
      const request = {
        ...common,
        actionId: 'commit',
        workspaceId: 'worker',
        creationActionId: created.actionId,
        expectedHead: baseline.commit,
        files: next,
      };
      const receipt = await commitLocalGitWorktree(request);
      writeFileSync(join(f.root, 'file.txt'), 'new user commit\n');
      f.git(['add', 'file.txt']);
      f.git(['commit', '-qm', 'Advance user checkout']);
      const head = f.git(['rev-parse', 'HEAD']),
        index = readFileSync(join(f.metadata, 'index'));
      const names = readdirSync(f.privateRoot).sort();
      expect(await readLocalGitCommit(request)).toEqual(receipt);
      await expect(commitLocalGitWorktree(request)).rejects.toThrow('operation_conflict');
      expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
      expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
      expect(readdirSync(f.privateRoot).sort()).toEqual(names);
      const completed = join(
        f.privateRoot,
        `${localRecordHash({ projectId: 'project', taskId: 'task', actionId: 'commit' })}.commit-completed.json`,
      );
      const saved = readFileSync(completed);
      const forged = { ...receipt, userStateHash: '0'.repeat(64) };
      writeFileSync(completed, JSON.stringify({ receipt: forged, hash: localRecordHash(forged) }));
      await expect(readLocalGitCommit(request)).rejects.toThrow('operation_conflict');
      writeFileSync(completed, saved);
      writeFileSync(join(created.path, 'file.txt'), 'worker drift\n');
      await expect(readLocalGitCommit(request)).rejects.toThrow('local_git_worktree_changed');
    }),
  30_000,
);

it.each(['clean', 'text', 'conflict', 'revoke'] as const)(
  'computes a real %s merge candidate without changing either worktree or user index',
  async (kind) =>
    fixture(async (f) => {
      const { planLocalGitMerge, readLocalGitMergeFiles } = await import('../src/local-git-merge');
      const common = {
        ...f,
        git: binary,
        metadataHelper,
        projectId: 'project',
        taskId: 'task',
        authorize: async () => true,
      };
      const attributes = file('.gitattributes', '* merge=union filter=hostile\n');
      const bytes = {
        path: 'binary.dat',
        content: Buffer.from([0x20, 0xff, 0, 0xc3, 0x28, 0x0a, 0x20]),
        executable: false,
      };
      const files = [
        file('file.txt', kind === 'text' ? '1\n2\n3\n4\n5\n' : 'base\n'),
        attributes,
        bytes,
      ];
      const marker = join(f.privateRoot, 'driver-ran');
      writeFileSync(join(f.metadata, 'info', 'attributes'), '* merge=hostile\n');
      f.git(['config', 'merge.hostile.driver', `touch ${marker}`]);
      f.git(['config', 'merge.default', 'hostile']);
      f.git(['config', 'filter.hostile.smudge', `touch ${marker}`]);
      const baseline = await createLocalGitBaseline({ ...common, actionId: 'baseline', files });
      const sides = [];
      for (const name of ['ours', 'theirs']) {
        const created = await createLocalGitWorktree({
          ...common,
          actionId: `create-${name}`,
          workspaceId: name,
          baseCommit: baseline.commit,
          files,
        });
        const next =
          kind === 'text'
            ? [
                file('file.txt', name === 'ours' ? 'ours\n2\n3\n4\n5\n' : '1\n2\n3\n4\ntheirs\n'),
                attributes,
                bytes,
              ]
            : kind === 'conflict'
              ? [file('file.txt', `${name}\n`), attributes, bytes]
              : [...files, file(`${name}.txt`, name)];
        for (const item of next) writeFileSync(join(created.path, item.path), item.content);
        const commit = await commitLocalGitWorktree({
          ...common,
          actionId: `commit-${name}`,
          workspaceId: name,
          creationActionId: created.actionId,
          expectedHead: baseline.commit,
          files: next,
        });
        sides.push({
          workspaceId: name,
          creationActionId: created.actionId,
          head: commit.commit,
          files: next,
          created,
        });
      }
      const ours = sides[0],
        theirs = sides[1];
      if (!ours || !theirs) throw Error('missing sides');
      const request = {
        ...common,
        actionId: 'merge',
        target: {
          workspaceId: ours.workspaceId,
          creationActionId: ours.creationActionId,
          head: ours.head,
          files: ours.files,
        },
        source: {
          workspaceId: theirs.workspaceId,
          creationActionId: theirs.creationActionId,
          head: theirs.head,
          files: theirs.files,
        },
      };
      const index = readFileSync(join(f.metadata, 'index'));
      if (kind === 'revoke') {
        await expect(
          planLocalGitMerge({
            ...request,
            authorize: async () =>
              !readdirSync(f.privateRoot).some((name) => name.endsWith('.merge-repository')),
          }),
        ).rejects.toThrow('authorization_closed');
        const prepared = readdirSync(f.privateRoot).sort();
        expect(prepared.some((name) => name.endsWith('.merge-prepared.json'))).toBe(true);
        expect(prepared.some((name) => name.endsWith('.merge-completed.json'))).toBe(false);
        await expect(planLocalGitMerge(request)).rejects.toThrow('local_git_recovery_required');
        expect(readdirSync(f.privateRoot).sort()).toEqual(prepared);
        for (const side of sides) {
          expect(f.git(['-C', side.created.path, 'rev-parse', 'HEAD'])).toBe(side.head);
          for (const item of side.files)
            expect(readFileSync(join(side.created.path, item.path))).toEqual(item.content);
        }
        expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
        return;
      }
      const result = await planLocalGitMerge(request);
      expect(result.result.kind).toBe(kind === 'conflict' ? 'conflict' : 'merged');
      if (kind === 'conflict') {
        await expect(readLocalGitMergeFiles(request)).rejects.toThrow('local_git_merge_conflict');
      } else {
        const extracted = await readLocalGitMergeFiles(request);
        expect(extracted.candidate).toEqual(result);
        expect(extracted.requiredDirectories).toEqual([]);
        expect(extracted.files).toEqual(
          (kind === 'text'
            ? [file('file.txt', 'ours\n2\n3\n4\ntheirs\n'), attributes, bytes]
            : [...files, file('ours.txt', 'ours'), file('theirs.txt', 'theirs')]
          ).sort((a, b) => a.path.localeCompare(b.path, 'en')),
        );
      }
      if (result.result.kind === 'merged') {
        if (kind === 'text')
          expect(f.git(['show', `${result.result.commit}:file.txt`])).toBe('ours\n2\n3\n4\ntheirs');
        else {
          expect(f.git(['show', `${result.result.commit}:ours.txt`])).toBe('ours');
          expect(f.git(['show', `${result.result.commit}:theirs.txt`])).toBe('theirs');
        }
        expect(f.git(['rev-list', '--parents', '-n', '1', result.result.commit])).toBe(
          `${result.result.commit} ${ours.head} ${theirs.head}`,
        );
      } else expect(result.result.paths).toEqual(['file.txt']);
      for (const side of sides) {
        expect(f.git(['-C', side.created.path, 'rev-parse', 'HEAD'])).toBe(side.head);
        expect(existsSync(join(side.created.metadata, 'MERGE_HEAD'))).toBe(false);
        for (const item of side.files)
          expect(readFileSync(join(side.created.path, item.path))).toEqual(item.content);
      }
      expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
      expect(existsSync(marker)).toBe(false);
      const preparedFiles = readdirSync(f.privateRoot).sort();
      await expect(
        planLocalGitMerge({ ...request, actionId: 'revoked', authorize: async () => false }),
      ).rejects.toThrow('authorization_closed');
      expect(readdirSync(f.privateRoot).sort()).toEqual(preparedFiles);
      expect(await planLocalGitMerge(request)).toEqual(result);
      await expect(planLocalGitMerge({ ...request, actionId: 'commit-ours' })).rejects.toThrow(
        'operation_conflict',
      );
      await expect(planLocalGitMerge({ ...request, source: request.target })).rejects.toThrow();
      const completed = readdirSync(f.privateRoot).find((name) =>
        name.endsWith('.merge-completed.json'),
      );
      if (!completed) throw Error('missing merge evidence');
      const completedPath = join(f.privateRoot, completed),
        saved = readFileSync(completedPath);
      const forged = JSON.parse(saved.toString('utf8'));
      if (forged.candidate.result.kind === 'merged') {
        const tree = f.git(['rev-parse', `${ours.head}^{tree}`]);
        const commit = f.git([
          'commit-tree',
          tree,
          '-p',
          ours.head,
          '-p',
          theirs.head,
          '-m',
          'Forged candidate',
        ]);
        forged.candidate.result = { kind: 'merged', tree, commit };
      } else forged.candidate.result.paths = ['missing.txt'];
      forged.hash = localRecordHash(forged.candidate);
      writeFileSync(completedPath, JSON.stringify(forged));
      await expect(planLocalGitMerge(request)).rejects.toThrow('local_git_recovery_required');
      writeFileSync(completedPath, saved);
      unlinkSync(completedPath);
      await expect(planLocalGitMerge(request)).rejects.toThrow('local_git_recovery_required');
      writeFileSync(completedPath, saved, { mode: 0o600, flag: 'wx' });
      writeFileSync(join(ours.created.path, 'file.txt'), 'uncommitted drift');
      await expect(planLocalGitMerge(request)).rejects.toThrow('local_git_worktree_changed');
    }),
  30_000,
);
