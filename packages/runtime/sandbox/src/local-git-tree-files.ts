/** Read bounded raw Git objects; never apply filters or inspect live source paths. */
import { createHash } from 'node:crypto';
import { isGitObjectId, isWorkspaceRelativePath } from '@agora/core-domain';
import type { LocalGitSession } from './local-git-session';
import { localGitDirectories } from './local-git-worktree';
import { isLocalReservedName } from './local-reserved-path';

function objectHash(type: 'blob' | 'tree', content: Buffer, reference: string) {
  return createHash(reference.length === 40 ? 'sha1' : 'sha256')
    .update(`${type} ${content.length}\0`)
    .update(content)
    .digest('hex');
}

export async function readLocalGitTreeFiles(session: LocalGitSession, tree: string) {
  if (!isGitObjectId(tree)) throw Error('invalid_local_git_input');
  const raw = await session.readObjectBytes([
    'ls-tree',
    '-r',
    '-t',
    '-l',
    '-z',
    '--full-tree',
    tree,
  ]);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  if (text && !text.endsWith('\0')) throw Error('local_git_tree_mismatch');
  const entries = text ? text.slice(0, -1).split('\0') : [];
  if (entries.length > 4096) throw Error('local_git_tree_limit');
  let total = 0;
  const listed = entries.map((entry) => {
    const match =
      /^(100644 blob|100755 blob|040000 tree) ([a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+|-)\t([\s\S]+)$/.exec(
        entry,
      );
    if (!match) throw Error('local_git_tree_mismatch');
    const [, mode, object, length, path] = match;
    const directory = mode === '040000 tree';
    const size = directory ? 0 : Number(length);
    if (
      !path ||
      !object ||
      object.length !== tree.length ||
      (directory ? length !== '-' : length === '-') ||
      !isWorkspaceRelativePath(path) ||
      path.split('/').some(isLocalReservedName)
    )
      throw Error('local_git_tree_mismatch');
    if (!Number.isSafeInteger(size) || size > 16 * 1024 * 1024) throw Error('local_git_tree_limit');
    total += size;
    return { path, object, size, directory, executable: mode === '100755 blob' };
  });
  if (total > 256 * 1024 * 1024) throw Error('local_git_tree_limit');
  if (new Set(listed.map((entry) => entry.path)).size !== listed.length)
    throw Error('local_git_tree_mismatch');
  const planned = listed.filter((entry) => !entry.directory);
  const directories = listed.filter((entry) => entry.directory);
  const requiredDirectories = localGitDirectories(
    planned,
    directories.map((entry) => entry.path),
  );
  // ls-tree validates the root but can traverse a corrupt child tree without hashing it.
  // Rebuild each tree's exact object bytes from its immediate entries before reading blobs.
  const trees = new Map([
    ['', { object: tree, entries: [] as Buffer[] }],
    ...directories.map(
      (entry) => [entry.path, { object: entry.object, entries: [] as Buffer[] }] as const,
    ),
  ]);
  for (const entry of listed) {
    const separator = entry.path.lastIndexOf('/');
    const parent = trees.get(entry.path.slice(0, Math.max(0, separator)));
    if (!parent) throw Error('local_git_tree_mismatch');
    const mode = entry.directory ? '40000' : entry.executable ? '100755' : '100644';
    parent.entries.push(
      Buffer.concat([
        Buffer.from(`${mode} ${entry.path.slice(separator + 1)}\0`),
        Buffer.from(entry.object, 'hex'),
      ]),
    );
  }
  for (const { object, entries: children } of trees.values()) {
    if (objectHash('tree', Buffer.concat(children), object) !== object)
      throw Error('local_git_tree_mismatch');
  }
  const files = [];
  for (const entry of planned) {
    const content = await session.readObjectBytes(['cat-file', 'blob', entry.object]);
    const object = objectHash('blob', content, entry.object);
    if (content.length !== entry.size || object !== entry.object)
      throw Error('local_git_tree_mismatch');
    files.push({ path: entry.path, executable: entry.executable, content });
  }
  await session.check();
  return { files, requiredDirectories };
}
