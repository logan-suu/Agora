// Real managed Git, native metadata helper and Seatbelt in disposable roots.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLocalGitBaseline } from '../src/local-git-baseline';
import { commitLocalGitWorktree } from '../src/local-git-commit';
import { readLocalGitMergeTree } from '../src/local-git-merge';
import { createLocalGitWorktree } from '../src/local-git-worktree';
import { binary, fixture, metadataHelper } from './local-git-fixture';

const file = (content: string) => ({
  path: 'code',
  content: Buffer.from(content),
  executable: false,
});
it.each(['text', 'directory-conflict', 'git-conflict', 'base-proof'] as const)(
  'reads complete immutable merge tree: %s',
  async (kind) =>
    fixture(async (f) => {
      const common = {
        ...f,
        git: binary,
        metadataHelper,
        projectId: 'project',
        taskId: 'task',
        authorize: async () => true,
      };
      const files = [file('1\n2\n3\n4\n5\n')],
        directories = ['empty'];
      const baseline = await createLocalGitBaseline({
        ...common,
        actionId: 'baseline',
        files,
      });
      const sides = [];
      for (const name of ['ours', 'theirs']) {
        const created = await createLocalGitWorktree({
          ...common,
          actionId: `create-${name}`,
          workspaceId: name,
          baseCommit: baseline.commit,
          files,
          directories,
        });
        const nextFiles = [
          file(
            kind === 'git-conflict'
              ? `${name}\n`
              : name === 'ours'
                ? 'ours\n2\n3\n4\n5\n'
                : '1\n2\n3\n4\ntheirs\n',
          ),
        ];
        const nextDirs =
          kind === 'directory-conflict'
            ? name === 'ours'
              ? []
              : ['empty', 'empty/new']
            : ['empty', name];
        rmSync(join(created.path, 'empty'), { recursive: true });
        for (const path of nextDirs) mkdirSync(join(created.path, path), { recursive: true });
        for (const item of nextFiles) writeFileSync(join(created.path, item.path), item.content);
        const committed = await commitLocalGitWorktree({
          ...common,
          actionId: `commit-${name}`,
          workspaceId: name,
          creationActionId: created.actionId,
          expectedHead: baseline.commit,
          files: nextFiles,
          directories: nextDirs,
        });
        sides.push({
          workspaceId: name,
          creationActionId: created.actionId,
          head: committed.commit,
          files: nextFiles,
          directories: nextDirs,
          created,
        });
      }
      const [ours, theirs] = sides;
      if (!ours || !theirs) throw Error('missing fixture sides');
      const request = {
        ...common,
        actionId: 'complete-merge',
        baseline: { commit: baseline.commit, files, directories },
        target: ours,
        source: theirs,
      };
      const index = readFileSync(join(f.metadata, 'index'));
      if (kind === 'base-proof') {
        const saved = readdirSync(f.privateRoot).sort();
        await expect(
          readLocalGitMergeTree({
            ...request,
            baseline: { ...request.baseline, commit: ours.head },
          }),
        ).rejects.toThrow('local_git_merge_base_invalid');
        await expect(
          readLocalGitMergeTree({
            ...request,
            baseline: { ...request.baseline, files: [file('wrong')] },
          }),
        ).rejects.toThrow('local_git_tree_mismatch');
        await expect(
          readLocalGitMergeTree({
            ...request,
            target: { ...ours, directories: undefined },
          } as unknown as Parameters<typeof readLocalGitMergeTree>[0]),
        ).rejects.toThrow('invalid_local_git_input');
        expect(readdirSync(f.privateRoot).sort()).toEqual(saved);
      }
      const result = await readLocalGitMergeTree(request);
      expect(result.result).toEqual(
        kind === 'git-conflict'
          ? { kind: 'conflict', source: 'git', paths: ['code'] }
          : kind === 'directory-conflict'
            ? { kind: 'conflict', source: 'directories', paths: ['empty', 'empty/new'] }
            : {
                kind: 'merged',
                files: [file('ours\n2\n3\n4\ntheirs\n')],
                directories: ['empty', 'ours', 'theirs'],
              },
      );
      expect(await readLocalGitMergeTree(request)).toEqual(result);
      await expect(
        readLocalGitMergeTree({
          ...request,
          baseline: { ...request.baseline, directories: ['different'] },
        }),
      ).rejects.toThrow('operation_conflict');
      for (const side of sides) {
        expect(f.git(['-C', side.created.path, 'rev-parse', 'HEAD'])).toBe(side.head);
        expect(existsSync(join(side.created.metadata, 'MERGE_HEAD'))).toBe(false);
        for (const item of side.files)
          expect(readFileSync(join(side.created.path, item.path))).toEqual(item.content);
        for (const path of side.directories)
          expect(existsSync(join(side.created.path, path))).toBe(true);
      }
      expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
      const saved = readdirSync(f.privateRoot).sort();
      await expect(
        readLocalGitMergeTree({ ...request, authorize: async () => false }),
      ).rejects.toThrow('authorization_closed');
      expect(readdirSync(f.privateRoot).sort()).toEqual(saved);
      writeFileSync(join(ours.created.path, 'code'), 'drift');
      await expect(readLocalGitMergeTree(request)).rejects.toThrow('local_git_worktree_changed');
    }),
  60_000,
);

it(
  'refuses multiple real merge bases before preparing a complete candidate',
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
      const files = [file('fixed\n')];
      const baseline = await createLocalGitBaseline({ ...common, actionId: 'baseline', files });
      const tree = f.git(['rev-parse', `${baseline.commit}^{tree}`]);
      const left = f.git(['commit-tree', tree, '-p', baseline.commit, '-m', 'Left base']);
      const right = f.git(['commit-tree', tree, '-p', baseline.commit, '-m', 'Right base']);
      const first = f.git(['commit-tree', tree, '-p', left, '-p', right, '-m', 'First merge']);
      const second = f.git(['commit-tree', tree, '-p', right, '-p', left, '-m', 'Second merge']);
      expect(f.git(['merge-base', '--all', first, second]).split('\n').sort()).toEqual(
        [left, right].sort(),
      );
      const sides = [];
      for (const [workspaceId, head] of [
        ['ours', first],
        ['theirs', second],
      ] as const) {
        const created = await createLocalGitWorktree({
          ...common,
          workspaceId,
          actionId: `create-${workspaceId}`,
          baseCommit: head,
          files,
          directories: [],
        });
        sides.push({
          workspaceId,
          creationActionId: created.actionId,
          head,
          files,
          directories: [],
        });
      }
      const [target, source] = sides;
      if (!target || !source) throw Error('missing fixture sides');
      const saved = readdirSync(f.privateRoot).sort();
      await expect(
        readLocalGitMergeTree({
          ...common,
          actionId: 'ambiguous',
          target,
          source,
          baseline: { commit: left, files, directories: [] },
        }),
      ).rejects.toThrow('local_git_merge_base_invalid');
      expect(readdirSync(f.privateRoot).sort()).toEqual(saved);
    }),
  60_000,
);
