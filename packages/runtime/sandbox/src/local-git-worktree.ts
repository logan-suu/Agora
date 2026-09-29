/** Internal fixed-tree creation. Registry binding and worker admission are separate. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isGitObjectId, isWorkspaceRelativePath } from '@agora/core-domain';
import {
  assertLocalGitActionKind,
  type LocalGitSession,
  type LocalGitSessionOptions,
  readLocalGitRecord,
  withLocalGitSession,
  writeLocalGitRecord,
} from './local-git-session';
import { localRecordHash } from './local-registry-records';
import { isLocalReservedName } from './local-reserved-path';

type FileInput = { path: string; content: Buffer; executable: boolean };
type Options = LocalGitSessionOptions & {
  workspaceId: string;
  baseCommit: string;
  files: FileInput[];
  /** Complete non-root directory set from the fixed manifest, including empty directories. */
  directories?: string[];
};
export interface LocalGitWorktreeReceipt {
  schemaVersion: 'local-git-worktree-v1';
  stage: 'applied';
  inputHash: string;
  projectId: string;
  taskId: string;
  actionId: string;
  workspaceId: string;
  path: string;
  identity: string;
  metadata: string;
  metadataIdentity: string;
  commonDir: string;
  commonDirIdentity: string;
  branch: string;
  baseCommit: string;
  tree: string;
  gitHash: string;
  userStateHash: string;
  indexHash: string;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function directory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw Error('local_git_worktree_changed');
  return `${stat.dev}:${stat.ino}`;
}
function metadataAt(session: LocalGitSession, path: string, branch: string) {
  const marker = session.readLinked(path, 'marker');
  if (
    Object.keys(marker).sort().join(',') !== 'marker,schemaVersion' ||
    typeof marker.marker !== 'string' ||
    !marker.marker.startsWith('gitdir: ')
  )
    throw Error('local_git_worktree_changed');
  const metadata = marker.marker.slice(8);
  if (
    !metadata.startsWith('/') ||
    !isWorkspaceRelativePath(metadata.slice(1)) ||
    dirname(metadata) !== join(session.metadata, 'worktrees')
  )
    throw Error('local_git_worktree_changed');
  const linked = session.readLinked(metadata, 'linked');
  if (
    Object.keys(linked).sort().join(',') !== 'commonDir,gitDir,head,indexHash,schemaVersion' ||
    linked.head !== `ref: refs/heads/${branch}` ||
    linked.gitDir !== join(path, '.git') ||
    typeof linked.commonDir !== 'string' ||
    resolve(metadata, linked.commonDir) !== session.metadata ||
    (linked.indexHash !== null &&
      (typeof linked.indexHash !== 'string' || !/^[a-f0-9]{64}$/.test(linked.indexHash)))
  )
    throw Error('local_git_worktree_changed');
  return { metadata, indexHash: linked.indexHash as string | null };
}
async function verifyList(session: LocalGitSession, path: string, branch: string, commit: string) {
  const raw = await session.run(['worktree', 'list', '--porcelain', '-z']);
  const matches = raw.split('\0\0').filter((record) => {
    if (!record) return false;
    const paths = record.split('\0').filter((field) => field.startsWith('worktree '));
    const candidate = paths[0]?.slice(9);
    if (paths.length !== 1 || !candidate?.startsWith('/'))
      throw Error('local_git_worktree_changed');
    // Inspect path identity only, never read other worktrees or admit their contents.
    try {
      return realpathSync(candidate) === path;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw Error('local_git_worktree_changed');
    }
  });
  if (matches.length !== 1) throw Error('local_git_worktree_changed');
  const fields = matches[0]?.split('\0') ?? [];
  if (
    fields.filter((field) => field.startsWith('worktree ')).length !== 1 ||
    fields.filter((field) => field.startsWith('HEAD ')).length !== 1 ||
    fields.filter((field) => field.startsWith('branch ')).length !== 1 ||
    !fields.includes(`worktree ${path}`) ||
    !fields.includes(`HEAD ${commit}`) ||
    !fields.includes(`branch refs/heads/${branch}`) ||
    fields.some((field) => field === 'prunable' || field.startsWith('prunable '))
  )
    throw Error('local_git_worktree_changed');
}
export function localGitDirectories(files: { path: string }[], input?: string[]): string[] {
  if (
    input !== undefined &&
    (!Array.isArray(input) || input.some((path) => typeof path !== 'string'))
  )
    throw Error('invalid_local_git_input');
  const directories = new Set(input ?? []);
  if (input && directories.size !== input.length) throw Error('invalid_local_git_input');
  const parents = new Set<string>();
  for (const path of [...files.map((file) => file.path), ...directories]) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) {
      parents.add(parts.join('/'));
      parts.pop();
    }
  }
  if (input === undefined) for (const path of parents) directories.add(path);
  const filePaths = new Set(files.map((file) => file.path));
  if (
    files.length + directories.size > 4096 ||
    [...parents].some((path) => !directories.has(path)) ||
    [...directories].some(
      (path) =>
        !isWorkspaceRelativePath(path) ||
        path.split('/').some(isLocalReservedName) ||
        filePaths.has(path),
    )
  )
    throw Error('invalid_local_git_input');
  return [...directories].sort();
}

export function verifyLocalGitFiles(
  session: LocalGitSession,
  path: string,
  files: FileInput[],
  stagingIdentity?: string,
  directoryPaths?: string[],
) {
  const directories = localGitDirectories(files, directoryPaths);
  const actual = session.readLinked(path, 'tree', stagingIdentity);
  if (
    Object.keys(actual).sort().join(',') !== 'directories,entryCount,files,schemaVersion' ||
    actual.schemaVersion !== 'local-git-tree-v2' ||
    !Array.isArray(actual.files) ||
    !Array.isArray(actual.directories) ||
    localRecordHash([...actual.directories].sort()) !== localRecordHash(directories) ||
    actual.entryCount !== files.length + directories.length ||
    actual.files.length !== files.length
  )
    throw Error('local_git_worktree_changed');
  const ordered = [...actual.files].sort((a, b) =>
    typeof a?.path === 'string' && typeof b?.path === 'string'
      ? a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0
      : 0,
  );
  const expected = files.map((file) => ({
    path: file.path,
    sha256: hash(file.content),
    size: file.content.length,
    executable: file.executable,
  }));
  if (localRecordHash(ordered) !== localRecordHash(expected))
    throw Error('local_git_worktree_changed');
}

export async function verifyLocalGitTree(
  session: LocalGitSession,
  commit: string,
  files: FileInput[],
) {
  const entries = (await session.run(['ls-tree', '-r', '-z', '--full-tree', commit]))
    .split('\0')
    .filter(Boolean);
  if (entries.length !== files.length) throw Error('local_git_tree_mismatch');
  for (const file of files) {
    const blob = await session.run(['hash-object', '--stdin', '--no-filters'], file.content);
    if (
      !isGitObjectId(blob) ||
      !entries.includes(`${file.executable ? '100755' : '100644'} blob ${blob}\t${file.path}`)
    )
      throw Error('local_git_tree_mismatch');
  }
}

const receiptKeys =
  'actionId,baseCommit,branch,commonDir,commonDirIdentity,gitHash,identity,indexHash,inputHash,metadata,metadataIdentity,path,projectId,schemaVersion,stage,taskId,tree,userStateHash,workspaceId';

/** Read the owner's immutable creation record; caller input never supplies paths. */
export function readOwnedLocalGitWorktree(
  session: LocalGitSession,
  scope: {
    projectId: string;
    taskId: string;
    workspaceId: string;
    creationActionId: string;
    gitHash: string;
  },
): LocalGitWorktreeReceipt {
  const key = localRecordHash({
    projectId: scope.projectId,
    taskId: scope.taskId,
    actionId: scope.creationActionId,
  });
  const envelope = JSON.parse(
    readLocalGitRecord(join(session.privateRoot, `${key}.worktree-completed.json`))?.toString(
      'utf8',
    ) ?? 'null',
  );
  const prepared = JSON.parse(
    readLocalGitRecord(join(session.privateRoot, `${key}.worktree-prepared.json`))?.toString(
      'utf8',
    ) ?? 'null',
  );
  const receipt = envelope?.receipt as LocalGitWorktreeReceipt;
  if (
    !receipt ||
    envelope.hash !== localRecordHash(receipt) ||
    Object.keys(receipt).sort().join(',') !== receiptKeys ||
    prepared?.inputHash !== receipt.inputHash ||
    receipt.schemaVersion !== 'local-git-worktree-v1' ||
    receipt.stage !== 'applied' ||
    receipt.projectId !== scope.projectId ||
    receipt.taskId !== scope.taskId ||
    receipt.actionId !== scope.creationActionId ||
    receipt.workspaceId !== scope.workspaceId ||
    receipt.gitHash !== scope.gitHash ||
    receipt.commonDir !== session.metadata ||
    receipt.path !== join(session.privateRoot, `worktree-${key}`) ||
    receipt.branch !== `agora-workspace-${key}` ||
    !isGitObjectId(receipt.baseCommit) ||
    !isGitObjectId(receipt.tree) ||
    ![receipt.inputHash, receipt.indexHash, receipt.userStateHash].every(
      (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
    )
  )
    throw Error('local_git_worktree_changed');
  return receipt;
}

export async function verifyOwnedLocalGitWorktree(
  session: LocalGitSession,
  receipt: LocalGitWorktreeReceipt,
  head: string,
) {
  await verifyOwnedLocalGitWorktreeState(session, receipt, head, head);
}

/** Only a durable publication recovery may pair a new HEAD with its original index. */
export async function verifyOwnedLocalGitWorktreeState(
  session: LocalGitSession,
  receipt: LocalGitWorktreeReceipt,
  head: string,
  indexCommit: string,
) {
  await session.check();
  const linked = metadataAt(session, receipt.path, receipt.branch);
  if (
    !isGitObjectId(head) ||
    !isGitObjectId(indexCommit) ||
    receipt.commonDir !== session.metadata ||
    receipt.commonDirIdentity !== directory(session.metadata) ||
    receipt.metadata !== linked.metadata ||
    receipt.metadataIdentity !== directory(linked.metadata) ||
    receipt.identity !== directory(receipt.path) ||
    !linked.indexHash
  )
    throw Error('local_git_worktree_changed');
  await verifyList(session, receipt.path, receipt.branch, head);
  const expected = (await session.run(['ls-tree', '-r', '-z', '--full-tree', indexCommit]))
    .split('\0')
    .filter(Boolean)
    .map((line) => line.replace(' blob ', ' ').replace('\t', ' 0\t'))
    .sort();
  const actual = (await session.run(['ls-files', '--stage', '-z'], undefined, receipt))
    .split('\0')
    .filter(Boolean)
    .sort();
  if (localRecordHash(expected) !== localRecordHash(actual))
    throw Error('local_git_worktree_changed');
  await session.check();
  return linked.indexHash;
}

export async function createLocalGitWorktree(input: Options): Promise<LocalGitWorktreeReceipt> {
  const request = {
    ...input,
    git: { ...input.git },
    metadataHelper: { ...input.metadataHelper },
    files: input.files.map((file) => ({ ...file, content: Buffer.from(file.content) })),
    directories: localGitDirectories(input.files, input.directories),
  };
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.workspaceId) ||
    !isGitObjectId(request.baseCommit) ||
    request.files.length > 4096 ||
    new Set(request.files.map((file) => file.path)).size !== request.files.length ||
    request.files.some(
      (file) =>
        !isWorkspaceRelativePath(file.path) ||
        file.path.split('/').some(isLocalReservedName) ||
        typeof file.executable !== 'boolean' ||
        file.content.length > 16 * 1024 * 1024,
    ) ||
    request.files.reduce((sum, file) => sum + file.content.length, 0) > 256 * 1024 * 1024
  )
    throw Error('invalid_local_git_input');
  request.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return withLocalGitSession(request, async (session) => {
    const { key, privateRoot, metadata, run, check } = session;
    const path = join(privateRoot, `worktree-${key}`),
      branch = `agora-workspace-${key}`;
    const prepared = join(privateRoot, `${key}.worktree-prepared.json`),
      completed = join(privateRoot, `${key}.worktree-completed.json`);
    const inputHash = localRecordHash({
      workspaceId: request.workspaceId,
      baseCommit: request.baseCommit,
      actionId: request.actionId,
      projectId: request.projectId,
      taskId: request.taskId,
      root: session.root,
      privateRoot,
      git: request.git,
      metadataHelper: request.metadataHelper,
      chains: session.chains,
      userStateHash: session.initialUserState,
      files: request.files.map((file) => ({
        path: file.path,
        hash: hash(file.content),
        executable: file.executable,
      })),
      directories: request.directories,
    });
    const verify = async (receipt: LocalGitWorktreeReceipt) => {
      await check();
      const linked = metadataAt(session, path, branch);
      if (
        Object.keys(receipt).sort().join(',') !== receiptKeys ||
        typeof receipt.indexHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.indexHash) ||
        receipt.path !== path ||
        receipt.branch !== branch ||
        receipt.baseCommit !== request.baseCommit ||
        receipt.workspaceId !== request.workspaceId ||
        receipt.inputHash !== inputHash ||
        receipt.projectId !== request.projectId ||
        receipt.taskId !== request.taskId ||
        receipt.actionId !== request.actionId ||
        receipt.schemaVersion !== 'local-git-worktree-v1' ||
        receipt.stage !== 'applied' ||
        receipt.gitHash !== request.git.sha256 ||
        receipt.userStateHash !== session.initialUserState ||
        receipt.commonDir !== metadata ||
        receipt.commonDirIdentity !== directory(metadata) ||
        receipt.metadata !== linked.metadata ||
        receipt.metadataIdentity !== directory(linked.metadata) ||
        receipt.identity !== directory(path) ||
        !linked.indexHash ||
        (await run(['rev-parse', '--verify', `${request.baseCommit}^{tree}`])) !== receipt.tree
      )
        throw Error('local_git_worktree_changed');
      const expectedIndex = (await run(['ls-tree', '-r', '-z', '--full-tree', request.baseCommit]))
        .split('\0')
        .filter(Boolean)
        .map((entry) => entry.replace(' blob ', ' ').replace('\t', ' 0\t'))
        .sort();
      const actualIndex = (
        await run(['ls-files', '--stage', '-z'], undefined, { path, metadata: linked.metadata })
      )
        .split('\0')
        .filter(Boolean)
        .sort();
      if (localRecordHash(actualIndex) !== localRecordHash(expectedIndex))
        throw Error('local_git_worktree_changed');
      await verifyList(session, path, branch, request.baseCommit);
      verifyLocalGitFiles(session, path, request.files, undefined, request.directories);
      await check();
    };
    await check();
    assertLocalGitActionKind(session, 'worktree');
    if (existsSync(prepared)) {
      const saved = JSON.parse(readLocalGitRecord(prepared)?.toString('utf8') ?? 'null');
      if (saved?.inputHash !== inputHash) throw Error('operation_conflict');
      if (!existsSync(completed)) throw Error('local_git_recovery_required');
      const envelope = JSON.parse(readLocalGitRecord(completed)?.toString('utf8') ?? 'null');
      if (!envelope?.receipt || envelope.hash !== localRecordHash(envelope.receipt))
        throw Error('local_git_recovery_required');
      await verify(envelope.receipt);
      return envelope.receipt;
    }
    if (existsSync(path) || existsSync(completed)) throw Error('local_git_recovery_required');
    const tree = await run(['rev-parse', '--verify', `${request.baseCommit}^{tree}`]);
    if (!isGitObjectId(tree)) throw Error('local_git_tree_mismatch');
    await verifyLocalGitTree(session, request.baseCommit, request.files);
    writeLocalGitRecord(prepared, { schemaVersion: 'local-git-worktree-prepared-v1', inputHash });
    await run(['worktree', 'add', '--no-checkout', '-b', branch, path, request.baseCommit]);
    await check();
    directory(path);
    chmodSync(path, 0o700);
    const linked = metadataAt(session, path, branch);
    await verifyList(session, path, branch, request.baseCommit);
    const createdDirectories = new Set([path]);
    for (const relative of request.directories) {
      await check();
      const target = join(path, relative);
      directory(dirname(target));
      mkdirSync(target, { mode: 0o700 });
      directory(target);
      createdDirectories.add(target);
    }
    for (const file of request.files) {
      await check();
      const parts = file.path.split('/');
      parts.pop();
      let parent = path;
      for (const name of parts) {
        parent = join(parent, name);
        if (!createdDirectories.has(parent)) mkdirSync(parent, { mode: 0o700 });
        directory(parent);
        createdDirectories.add(parent);
      }
      const fd = openSync(
        join(path, file.path),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        file.executable ? 0o755 : 0o644,
      );
      try {
        writeFileSync(fd, file.content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    for (const path of [...createdDirectories].sort((a, b) => b.length - a.length)) {
      await check();
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    await run(['read-tree', '--reset', request.baseCommit], undefined, {
      path,
      metadata: linked.metadata,
    });
    const final = metadataAt(session, path, branch);
    if (!final.indexHash) throw Error('local_git_worktree_changed');
    const receipt: LocalGitWorktreeReceipt = {
      schemaVersion: 'local-git-worktree-v1',
      stage: 'applied',
      inputHash,
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
      workspaceId: request.workspaceId,
      path,
      identity: directory(path),
      metadata: linked.metadata,
      metadataIdentity: directory(linked.metadata),
      commonDir: metadata,
      commonDirIdentity: directory(metadata),
      branch,
      baseCommit: request.baseCommit,
      tree,
      gitHash: request.git.sha256,
      userStateHash: session.initialUserState,
      indexHash: final.indexHash,
    };
    await verify(receipt);
    writeLocalGitRecord(completed, { receipt, hash: localRecordHash(receipt) });
    await verify(receipt);
    return receipt;
  });
}
