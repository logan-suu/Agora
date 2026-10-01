/** Fixed-input commits for owner-created worktrees. No model-facing Git API. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isGitObjectId, isWorkspaceRelativePath } from '@agora/core-domain';
import {
  assertLocalGitActionKind,
  type LocalGitSessionOptions,
  readLocalGitRecord,
  withLocalGitSession,
  writeLocalGitRecord,
} from './local-git-session';
import {
  localGitDirectories,
  readOwnedLocalGitWorktree,
  verifyLocalGitFiles,
  verifyLocalGitTree,
  verifyOwnedLocalGitWorktree,
} from './local-git-worktree';
import { localRecordHash } from './local-registry-records';
import { isLocalReservedName } from './local-reserved-path';

type Options = LocalGitSessionOptions & {
  workspaceId: string;
  creationActionId: string;
  expectedHead: string;
  /** Only the trusted registry may supply this identity; it grants no authority. */
  stagingIdentity?: string;
  files: { path: string; content: Buffer; executable: boolean }[];
  directories?: string[];
};
export interface LocalGitCommitReceipt {
  schemaVersion: 'local-git-commit-v1';
  stage: 'applied';
  actionId: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  creationReceiptHash: string;
  inputHash: string;
  previousCommit: string;
  commit: string;
  tree: string;
  filesHash: string;
  gitHash: string;
  userStateHash: string;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function commitLocalGitWorktree(input: Options): Promise<LocalGitCommitReceipt> {
  return accessCommit(input, false);
}

/** Verify an existing completed commit; never enter the first-write path. */
export async function readLocalGitCommit(input: Options): Promise<LocalGitCommitReceipt> {
  return accessCommit(input, true);
}

async function accessCommit(input: Options, readOnly: boolean): Promise<LocalGitCommitReceipt> {
  const request = {
    ...input,
    git: { ...input.git },
    metadataHelper: { ...input.metadataHelper },
    files: input.files.map((file) => ({ ...file, content: Buffer.from(file.content) })),
    directories: localGitDirectories(input.files, input.directories),
  };
  if (
    ![request.workspaceId, request.creationActionId].every((id) =>
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id),
    ) ||
    !isGitObjectId(request.expectedHead) ||
    (request.stagingIdentity !== undefined &&
      !/^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$/.test(request.stagingIdentity)) ||
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
    const { run, check, privateRoot, key } = session;
    await check();
    assertLocalGitActionKind(session, 'commit');
    const created = readOwnedLocalGitWorktree(session, { ...request, gitHash: request.git.sha256 });
    const creationReceiptHash = localRecordHash(created);
    const filesHash = localRecordHash(
      request.files.map((file) => ({
        path: file.path,
        sha256: hash(file.content),
        size: file.content.length,
        executable: file.executable,
      })),
    );
    const prepared = join(privateRoot, `${key}.commit-prepared.json`);
    const completed = join(privateRoot, `${key}.commit-completed.json`);
    const readCompleted = (): LocalGitCommitReceipt => {
      const envelope = JSON.parse(readLocalGitRecord(completed, true)?.toString('utf8') ?? 'null');
      if (
        !envelope?.receipt ||
        Object.keys(envelope).sort().join(',') !== 'hash,receipt' ||
        envelope.hash !== localRecordHash(envelope.receipt) ||
        typeof envelope.receipt.userStateHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(envelope.receipt.userStateHash)
      )
        throw Error('local_git_recovery_required');
      return envelope.receipt;
    };
    // A historical proof retains its original user-state observation. The session
    // still pins current user state for the entire read; mutating replay stays strict.
    const historical = readOnly ? readCompleted() : undefined;
    const userStateHash = historical?.userStateHash ?? session.initialUserState;
    const inputHash = localRecordHash({
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
      workspaceId: request.workspaceId,
      creationReceiptHash,
      filesHash,
      directories: request.directories,
      expectedHead: request.expectedHead,
      git: request.git,
      metadataHelper: request.metadataHelper,
      chains: session.chains,
      userStateHash,
      ...(request.stagingIdentity === undefined
        ? {}
        : { stagingIdentity: request.stagingIdentity }),
    });
    const fixed = {
      schemaVersion: 'local-git-commit-v1' as const,
      stage: 'applied' as const,
      actionId: request.actionId,
      projectId: request.projectId,
      taskId: request.taskId,
      workspaceId: request.workspaceId,
      creationReceiptHash,
      inputHash,
      previousCommit: request.expectedHead,
      filesHash,
      gitHash: request.git.sha256,
      userStateHash,
    };
    const verify = async (receipt: LocalGitCommitReceipt) => {
      const { commit, tree, ...rest } = receipt;
      if (
        localRecordHash(rest) !== localRecordHash(fixed) ||
        !isGitObjectId(commit) ||
        !isGitObjectId(tree)
      )
        throw Error('local_git_recovery_required');
      await verifyOwnedLocalGitWorktree(session, created, commit);
      await verifyLocalGitTree(session, commit, request.files);
      verifyLocalGitFiles(
        session,
        created.path,
        request.files,
        request.stagingIdentity,
        request.directories,
      );
      if (
        (await run(['rev-parse', '--verify', `${commit}^{tree}`])) !== tree ||
        (await run(['rev-list', '--parents', '-n', '1', commit])) !==
          `${commit} ${request.expectedHead}`
      )
        throw Error('local_git_recovery_required');
      await check();
    };
    if (existsSync(prepared)) {
      const saved = JSON.parse(readLocalGitRecord(prepared)?.toString('utf8') ?? 'null');
      if (
        saved?.schemaVersion !== 'local-git-commit-prepared-v1' ||
        Object.keys(saved).sort().join(',') !== 'inputHash,schemaVersion'
      )
        throw Error('local_git_recovery_required');
      if (saved?.inputHash !== inputHash) throw Error('operation_conflict');
      if (!existsSync(completed)) throw Error('local_git_recovery_required');
      const receipt = readCompleted();
      await verify(receipt);
      return receipt;
    }
    if (readOnly || existsSync(completed) || existsSync(session.index))
      throw Error('local_git_recovery_required');
    await verifyOwnedLocalGitWorktree(session, created, request.expectedHead);
    verifyLocalGitFiles(
      session,
      created.path,
      request.files,
      request.stagingIdentity,
      request.directories,
    );
    await check();
    writeLocalGitRecord(prepared, { schemaVersion: 'local-git-commit-prepared-v1', inputHash });
    await run(['read-tree', '--empty']);
    const entries: string[] = [];
    for (const file of request.files) {
      const blob = await run(['hash-object', '--stdin', '--no-filters', '-w'], file.content);
      if (!isGitObjectId(blob)) throw Error('local_git_command_failed');
      entries.push(`${file.executable ? '100755' : '100644'} ${blob}\t${file.path}\0`);
    }
    await run(['update-index', '-z', '--index-info'], Buffer.from(entries.join('')));
    const tree = await run(['write-tree']);
    if (!isGitObjectId(tree)) throw Error('local_git_command_failed');
    const commit = await run(
      ['commit-tree', tree, '-p', request.expectedHead],
      Buffer.from(`Agora fixed workspace ${key}\n`),
    );
    if (!isGitObjectId(commit)) throw Error('local_git_command_failed');
    await verifyOwnedLocalGitWorktree(session, created, request.expectedHead);
    verifyLocalGitFiles(
      session,
      created.path,
      request.files,
      request.stagingIdentity,
      request.directories,
    );
    await run(['update-ref', `refs/heads/${created.branch}`, commit, request.expectedHead]);
    await run(['read-tree', '--reset', commit], undefined, created);
    const receipt: LocalGitCommitReceipt = { ...fixed, commit, tree };
    await verify(receipt);
    writeLocalGitRecord(completed, { receipt, hash: localRecordHash(receipt) });
    await verify(receipt);
    return receipt;
  });
}
