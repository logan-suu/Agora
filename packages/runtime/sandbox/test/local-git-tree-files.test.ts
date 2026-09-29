// Real Git objects and Seatbelt, including malformed metadata and binary boundaries.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { withLocalGitSession } from '../src/local-git-session';
import { readLocalGitTreeFiles } from '../src/local-git-tree-files';
import { binary, fixture, metadataHelper } from './local-git-fixture';

it(
  'reads exact maximum-sized binary blobs, empty files and executable Unicode paths',
  async () =>
    fixture(async (f) => {
      const binaryBytes = Buffer.alloc(16 * 1024 * 1024, 0xff);
      binaryBytes[0] = 0;
      binaryBytes[binaryBytes.length - 1] = 0x20;
      const blob = f.git(['hash-object', '-w', '--stdin'], binaryBytes);
      const empty = f.git(['hash-object', '-w', '--stdin'], Buffer.alloc(0));
      const nested = f.git(['mktree', '-z'], Buffer.from(`100755 blob ${blob}\t 空白 \0`));
      const tree = f.git(
        ['mktree', '-z'],
        Buffer.from(`100644 blob ${empty}\tempty\0` + `040000 tree ${nested}\tdir\0`),
      );
      const userIndex = readFileSync(join(f.metadata, 'index'));
      const result = await withLocalGitSession(
        {
          ...f,
          git: binary,
          metadataHelper,
          projectId: 'p',
          taskId: 't',
          actionId: 'read',
          authorize: async () => true,
        },
        (session) => readLocalGitTreeFiles(session, tree),
      );
      expect(result.requiredDirectories).toEqual(['dir']);
      expect(
        result.files.map(({ content, ...file }) => ({ ...file, size: content.length })),
      ).toEqual([
        { path: 'dir/ 空白 ', executable: true, size: binaryBytes.length },
        { path: 'empty', executable: false, size: 0 },
      ]);
      // Native equality checks every byte without enumerating millions of Buffer properties.
      expect(result.files[0]?.content.equals(binaryBytes)).toBe(true);
      expect(result.files[1]?.content.equals(Buffer.alloc(0))).toBe(true);
      expect(readFileSync(join(f.metadata, 'index'))).toEqual(userIndex);
    }),
  30_000,
);

it(
  'rejects unsafe trees, oversized manifests, missing or corrupt blobs and revoked reads',
  async () =>
    fixture(async (f) => {
      const blob = f.git(['hash-object', '-w', '--stdin'], Buffer.from('safe\n'));
      const head = f.git(['rev-parse', 'HEAD']);
      const tree = (entries: Buffer | string) => f.git(['mktree', '-z'], Buffer.from(entries));
      const read = (commit: string, authorize = async () => true) =>
        withLocalGitSession(
          {
            ...f,
            git: binary,
            metadataHelper,
            projectId: 'p',
            taskId: 't',
            actionId: 'read',
            authorize,
          },
          (session) => readLocalGitTreeFiles(session, commit),
        );
      for (const entry of [
        `120000 blob ${blob}\tlink\0`,
        `160000 commit ${head}\tsubmodule\0`,
        `100644 blob ${blob}\t.git\0`,
      ])
        await expect(read(tree(entry))).rejects.toThrow('local_git_tree_mismatch');
      await expect(
        read(tree(Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xff, 0])]))),
      ).rejects.toThrow();
      const oversized = f.git(['hash-object', '-w', '--stdin'], Buffer.alloc(16 * 1024 * 1024 + 1));
      await expect(read(tree(`100644 blob ${oversized}\tlarge\0`))).rejects.toThrow(
        'local_git_tree_limit',
      );
      const maximum = f.git(['hash-object', '-w', '--stdin'], Buffer.alloc(16 * 1024 * 1024));
      await expect(
        read(
          tree(Array.from({ length: 17 }, (_, i) => `100644 blob ${maximum}\tf${i}\0`).join('')),
        ),
      ).rejects.toThrow('local_git_tree_limit');
      await expect(
        read(tree(Array.from({ length: 4097 }, (_, i) => `100644 blob ${blob}\tf${i}\0`).join(''))),
      ).rejects.toThrow('local_git_tree_limit');
      const safeTree = tree(`100644 blob ${blob}\tfile\0`);
      let checks = 0;
      await expect(read(safeTree, async () => ++checks < 3)).rejects.toThrow(
        'authorization_closed',
      );
      const objectPath = join(f.metadata, 'objects', blob.slice(0, 2), blob.slice(2));
      const original = readFileSync(objectPath);
      chmodSync(objectPath, 0o600);
      writeFileSync(objectPath, deflateSync(Buffer.from('blob 5\0evil\n')));
      await expect(read(safeTree)).rejects.toThrow('local_git_tree_mismatch');
      writeFileSync(objectPath, original);
      const nestedRoot = tree(`040000 tree ${safeTree}\tnested\0`);
      const treePath = join(f.metadata, 'objects', safeTree.slice(0, 2), safeTree.slice(2));
      const originalTree = readFileSync(treePath);
      const forgedTree = Buffer.concat([Buffer.from('100644 evil\0'), Buffer.from(blob, 'hex')]);
      chmodSync(treePath, 0o600);
      writeFileSync(
        treePath,
        deflateSync(Buffer.concat([Buffer.from(`tree ${forgedTree.length}\0`), forgedTree])),
      );
      await expect(read(safeTree)).rejects.toThrow('local_git_command_failed');
      await expect(read(nestedRoot)).rejects.toThrow('local_git_tree_mismatch');
      writeFileSync(treePath, originalTree);
      const missing = f.git(
        ['mktree', '--missing', '-z'],
        Buffer.from(`100644 blob ${'1'.repeat(40)}\tmissing\0`),
      );
      await expect(read(missing)).rejects.toThrow();
    }),
  30_000,
);
