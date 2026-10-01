/** Publish a precomputed merge after trusted tree effects. This primitive does
 * not authenticate canonical Integration progress or mutate application State. */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isWorkspaceRelativePath } from '@agora/core-domain';
import {
  assertLocalGitNoMerge,
  type LocalGitMergeCandidate,
  verifyLocalGitMergeCandidate,
} from './local-git-merge';
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
  verifyOwnedLocalGitWorktreeState,
} from './local-git-worktree';
import { localRecordHash } from './local-registry-records';
import { isLocalReservedName } from './local-reserved-path';

type Options = LocalGitSessionOptions & {
  workspaceId: string;
  creationActionId: string;
  sourceWorkspaceId: string;
  sourceCreationActionId: string;
  candidate: LocalGitMergeCandidate;
  /** Opaque binding only; the canonical caller must authenticate this proof. */
  applicationHash: string;
  stagingIdentity?: string;
  files: { path: string; content: Buffer; executable: boolean }[];
  directories: string[];
};
export type LocalGitPublicationReceipt = {
  schemaVersion: 'local-git-publication-v1';
  inputHash: string;
  applicationHash: string;
  candidateHash: string;
  workspaceId: string;
  previousCommit: string;
  commit: string;
  tree: string;
  indexHash: string;
  userStateHash: string;
};
const id = (v: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);

export async function publishLocalGitCandidate(input: Options) {
  return publish(input, false);
}

/** Explicit trusted recovery: ordinary retries never enter a partial write. */
export async function recoverLocalGitCandidate(input: Options) {
  return publish(input, true);
}

/** Read a completed historical publication. The current session still pins the
 * user's current checkout; this never authorizes first publication or recovery. */
export async function readLocalGitPublication(input: Options) {
  return publish(input, false, true);
}

/** Historical effects only. The caller separately proves a canonical chain and
 * its latest physical version; this never admits a target HEAD or changes Git. */
export async function readLocalGitPublicationHistory(input: Options) {
  return publish(input, false, true, true);
}

async function publish(
  input: Options,
  recovery: boolean,
  readOnly = false,
  historical = false,
): Promise<LocalGitPublicationReceipt> {
  const request = {
    ...input,
    git: { ...input.git },
    metadataHelper: { ...input.metadataHelper },
    candidate: structuredClone(input.candidate),
    files: input.files.map((f) => ({ ...f, content: Buffer.from(f.content) })),
    directories: localGitDirectories(input.files, input.directories),
  };
  if (
    ![
      request.workspaceId,
      request.creationActionId,
      request.sourceWorkspaceId,
      request.sourceCreationActionId,
    ].every(id) ||
    request.workspaceId === request.sourceWorkspaceId ||
    !Array.isArray(input.directories) ||
    !digest(request.applicationHash) ||
    request.candidate?.projectId !== request.projectId ||
    request.candidate?.taskId !== request.taskId ||
    (request.stagingIdentity !== undefined &&
      !/^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$/.test(request.stagingIdentity)) ||
    request.files.length > 4096 ||
    new Set(request.files.map((f) => f.path)).size !== request.files.length ||
    request.files.some(
      (f) =>
        !isWorkspaceRelativePath(f.path) ||
        f.path.split('/').some(isLocalReservedName) ||
        typeof f.executable !== 'boolean' ||
        f.content.length > 16 * 1024 * 1024,
    ) ||
    request.files.reduce((n, f) => n + f.content.length, 0) > 256 * 1024 * 1024
  )
    throw Error('invalid_local_git_input');
  return withLocalGitSession(request, async (session) => {
    assertLocalGitActionKind(session, 'publish');
    const { candidate } = request;
    const path = (stage: string) =>
      join(session.privateRoot, `${session.key}.publish-${stage}.json`);
    const present = (stage: string) => {
      try {
        lstatSync(path(stage));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    const read = (stage: string) => {
      if (!present(stage)) return null;
      const bytes = readLocalGitRecord(path(stage));
      if (!bytes) throw Error('local_git_recovery_required');
      return JSON.parse(bytes.toString('utf8'));
    };
    if (present('invalid')) throw Error('local_git_recovery_required');
    const prior = read('prepared');
    if (
      ((recovery || readOnly) && !prior) ||
      (readOnly && !present('completed')) ||
      (!prior && present('completed')) ||
      (present('prepared') &&
        (!prior ||
          Object.keys(prior).sort().join(',') !== 'indexHash,inputHash,schemaVersion' ||
          prior.schemaVersion !== 'local-git-publication-prepared-v1' ||
          !digest(prior.indexHash) ||
          !digest(prior.inputHash)))
    )
      throw Error('local_git_recovery_required');
    if (prior && !recovery && !present('completed')) throw Error('local_git_recovery_required');
    const saved = read('completed');
    if (
      present('completed') &&
      (!saved ||
        Object.keys(saved).sort().join(',') !== 'hash,receipt' ||
        !saved.receipt ||
        !digest(saved.receipt.userStateHash) ||
        saved.hash !== localRecordHash(saved.receipt))
    )
      throw Error('local_git_recovery_required');
    // Historical reads reconstruct the original fixed input. Mutating replay
    // deliberately retains the stricter current user-state observation.
    const userStateHash = readOnly ? saved.receipt.userStateHash : session.initialUserState;
    await verifyLocalGitMergeCandidate(session, candidate);
    if (candidate.result.kind !== 'merged') throw Error('local_git_merge_proof_invalid');
    const target = readOwnedLocalGitWorktree(session, {
      ...request,
      gitHash: request.git.sha256,
    });
    const source = readOwnedLocalGitWorktree(session, {
      ...request,
      workspaceId: request.sourceWorkspaceId,
      creationActionId: request.sourceCreationActionId,
      gitHash: request.git.sha256,
    });
    const verifyFiles = () =>
      verifyLocalGitFiles(
        session,
        target.path,
        request.files,
        request.stagingIdentity,
        request.directories,
      );
    const verifySource = async () => {
      assertLocalGitNoMerge(target.metadata);
      assertLocalGitNoMerge(source.metadata);
      await verifyOwnedLocalGitWorktree(session, source, candidate.sourceHead);
      await session.check();
    };
    await verifySource();
    await verifyLocalGitTree(session, candidate.result.commit, request.files);
    if (readOnly)
      for (const file of request.files) {
        const blob = await session.run(['hash-object', '--stdin', '--no-filters'], file.content);
        const bytes = await session.readObjectBytes(['cat-file', 'blob', blob]);
        if (!bytes.equals(file.content)) throw Error('local_git_merge_proof_invalid');
      }
    if (!historical) verifyFiles();
    const originalIndex = prior
      ? prior.indexHash
      : await verifyOwnedLocalGitWorktreeState(
          session,
          target,
          candidate.targetHead,
          candidate.targetHead,
        );
    const inputHash = localRecordHash({
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
      target,
      source,
      candidate,
      applicationHash: request.applicationHash,
      files: request.files.map(({ path, content, executable }) => ({
        path,
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.length,
        executable,
      })),
      directories: request.directories,
      stagingIdentity: request.stagingIdentity ?? null,
      git: request.git,
      metadataHelper: request.metadataHelper,
      chains: session.chains,
      userStateHash,
      indexHash: originalIndex,
    });
    if (prior && prior.inputHash !== inputHash) throw Error('operation_conflict');
    const fixed = {
      schemaVersion: 'local-git-publication-v1' as const,
      inputHash,
      applicationHash: request.applicationHash,
      candidateHash: localRecordHash(candidate),
      workspaceId: request.workspaceId,
      previousCommit: candidate.targetHead,
      commit: candidate.result.commit,
      tree: candidate.result.tree,
      userStateHash,
    };
    const verify = async (receipt: LocalGitPublicationReceipt) => {
      const { indexHash, ...rest } = receipt;
      if (!digest(indexHash) || !equal(rest, fixed)) throw Error('local_git_recovery_required');
      if (historical) {
        await verifySource();
        return;
      }
      const current = await verifyOwnedLocalGitWorktreeState(
        session,
        target,
        fixed.commit,
        fixed.commit,
      );
      if (current !== indexHash) throw Error('local_git_worktree_changed');
      verifyFiles();
      await verifySource();
    };
    if (present('completed')) {
      await verify(saved.receipt);
      return saved.receipt;
    }
    if (readOnly) throw Error('local_git_recovery_required');
    if (!prior)
      writeLocalGitRecord(path('prepared'), {
        schemaVersion: 'local-git-publication-prepared-v1',
        inputHash,
        indexHash: originalIndex,
      });
    // Recovery accepts only the two original HEAD values and an original or
    // exact candidate index. The normal admission path remains strict elsewhere.
    let head = await session.run(['rev-parse', '--verify', `refs/heads/${target.branch}`]);
    if (head !== candidate.targetHead && head !== fixed.commit)
      throw Error('local_git_worktree_changed');
    const linked = session.readLinked(target.metadata, 'linked');
    const oldIndex = linked.indexHash === originalIndex;
    if (head === candidate.targetHead && !oldIndex) throw Error('local_git_worktree_changed');
    await verifyOwnedLocalGitWorktreeState(
      session,
      target,
      head,
      oldIndex ? candidate.targetHead : fixed.commit,
    );
    verifyFiles();
    await verifySource();
    if (head === candidate.targetHead) {
      await session.run([
        'update-ref',
        `refs/heads/${target.branch}`,
        fixed.commit,
        candidate.targetHead,
      ]);
      head = fixed.commit;
    }
    if (oldIndex) await session.run(['read-tree', '--reset', fixed.commit], undefined, target);
    const indexHash = await verifyOwnedLocalGitWorktreeState(session, target, head, fixed.commit);
    const receipt = { ...fixed, indexHash };
    await verify(receipt);
    try {
      writeLocalGitRecord(path('completed'), { receipt, hash: localRecordHash(receipt) });
      await verify(receipt);
    } catch (error) {
      if (present('completed'))
        writeLocalGitRecord(path('invalid'), { inputHash, receiptHash: localRecordHash(receipt) });
      throw error;
    }
    return receipt;
  });
}
