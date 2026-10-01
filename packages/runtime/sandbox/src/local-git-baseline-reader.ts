/** Read an existing baseline without replaying creation or equating historical B with current U. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isGitObjectId, isWorkspaceRelativePath } from '@agora/core-domain';
import type { LocalGitBaselineReceipt } from './local-git-baseline';
import {
  assertLocalGitActionKind,
  type LocalGitSessionOptions,
  readLocalGitRecord,
  withLocalGitSession,
} from './local-git-session';
import { verifyLocalGitTree } from './local-git-worktree';
import { localRecordHash } from './local-registry-records';
import { isLocalReservedName } from './local-reserved-path';

export async function readLocalGitBaseline(
  input: LocalGitSessionOptions & {
    files: { path: string; content: Buffer; executable: boolean }[];
  },
): Promise<LocalGitBaselineReceipt> {
  const request = {
    ...input,
    git: { ...input.git },
    metadataHelper: { ...input.metadataHelper },
    files: input.files.map((file) => ({ ...file, content: Buffer.from(file.content) })),
  };
  if (
    request.files.length > 4096 ||
    new Set(request.files.map((file) => file.path)).size !== request.files.length ||
    request.files.some(
      (file) =>
        !isWorkspaceRelativePath(file.path) ||
        file.path.split('/').some(isLocalReservedName) ||
        typeof file.executable !== 'boolean' ||
        file.content.length > 16 * 1024 * 1024,
    ) ||
    request.files.reduce((size, file) => size + file.content.length, 0) > 256 * 1024 * 1024
  )
    throw Error('invalid_local_git_input');
  request.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return withLocalGitSession(request, async (session) => {
    const { root, privateRoot, key, chains, run, check } = session;
    await check();
    assertLocalGitActionKind(session, 'baseline');
    const saved = JSON.parse(
      readLocalGitRecord(join(privateRoot, `${key}.prepared.json`))?.toString('utf8') ?? 'null',
    );
    const envelope = JSON.parse(
      readLocalGitRecord(join(privateRoot, `${key}.completed.json`))?.toString('utf8') ?? 'null',
    );
    const receipt = envelope?.receipt as LocalGitBaselineReceipt | undefined;
    const baseHash = localRecordHash({
      actionId: request.actionId,
      projectId: request.projectId,
      taskId: request.taskId,
      root,
      privateRoot,
      git: request.git,
      metadataHelper: request.metadataHelper,
      files: request.files.map((file) => ({
        path: file.path,
        executable: file.executable,
        hash: createHash('sha256').update(file.content).digest('hex'),
      })),
    });
    if (
      !receipt ||
      Object.keys(receipt).sort().join(',') !==
        'actionId,branch,commit,gitHash,inputHash,projectId,schemaVersion,sourceHead,stage,taskId,tree,userStateHash' ||
      saved?.version !== 1 ||
      saved.baseHash !== baseHash ||
      envelope.hash !== localRecordHash(receipt) ||
      receipt.schemaVersion !== 'local-git-baseline-v1' ||
      receipt.stage !== 'applied' ||
      receipt.actionId !== request.actionId ||
      receipt.projectId !== request.projectId ||
      receipt.taskId !== request.taskId ||
      receipt.gitHash !== request.git.sha256 ||
      receipt.branch !== `agora-baseline-${key}` ||
      !/^[a-f0-9]{64}$/.test(receipt.userStateHash) ||
      !receipt.sourceHead ||
      Object.keys(receipt.sourceHead).sort().join(',') !== 'commit,indexHash,symbolicRef' ||
      (receipt.sourceHead.commit !== null && !isGitObjectId(receipt.sourceHead.commit)) ||
      (receipt.sourceHead.indexHash !== null &&
        !/^[a-f0-9]{64}$/.test(receipt.sourceHead.indexHash)) ||
      (receipt.sourceHead.symbolicRef !== null &&
        typeof receipt.sourceHead.symbolicRef !== 'string') ||
      !isGitObjectId(receipt.commit) ||
      !isGitObjectId(receipt.tree) ||
      saved.inputHash !== receipt.inputHash ||
      receipt.inputHash !==
        localRecordHash({ baseHash, chains, userStateHash: receipt.userStateHash })
    )
      throw Error('local_git_baseline_proof_mismatch');
    if (
      (await run(['rev-parse', '--verify', `refs/heads/${receipt.branch}`])) !== receipt.commit ||
      (await run(['rev-parse', '--verify', `${receipt.commit}^{tree}`])) !== receipt.tree ||
      (await run(['rev-list', '--parents', '-n', '1', receipt.commit])) !== receipt.commit
    )
      throw Error('local_git_baseline_proof_mismatch');
    await verifyLocalGitTree(session, receipt.commit, request.files);
    if ((await run(['rev-parse', '--verify', `refs/heads/${receipt.branch}`])) !== receipt.commit)
      throw Error('local_git_baseline_proof_mismatch');
    await check();
    return structuredClone(receipt);
  });
}
