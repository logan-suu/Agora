/** Create a fixed-input baseline without changing user HEAD or index. */
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
import { localRecordHash } from './local-registry-records';
import { isLocalReservedName } from './local-reserved-path';

type FileInput = { path: string; content: Buffer; executable: boolean };
type Options = LocalGitSessionOptions & { files: FileInput[] };
export type LocalGitBaselineReceipt = {
  schemaVersion: 'local-git-baseline-v1';
  stage: 'applied';
  inputHash: string;
  actionId: string;
  projectId: string;
  taskId: string;
  branch: string;
  commit: string;
  tree: string;
  userStateHash: string;
  gitHash: string;
  sourceHead: { symbolicRef: string | null; commit: string | null; indexHash: string | null };
};
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const id = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export async function createLocalGitBaseline(input: Options): Promise<LocalGitBaselineReceipt> {
  const request = {
    ...input,
    git: { ...input.git },
    metadataHelper: { ...input.metadataHelper },
    files: input.files.map((f) => ({ ...f, content: Buffer.from(f.content) })),
  };
  if (
    ![request.actionId, request.projectId, request.taskId].every(id) ||
    request.files.length > 4096 ||
    new Set(request.files.map((f) => f.path)).size !== request.files.length ||
    request.files.some(
      (f) =>
        !isWorkspaceRelativePath(f.path) ||
        f.path.split('/').some(isLocalReservedName) ||
        typeof f.executable !== 'boolean' ||
        f.content.length > 16 * 1024 * 1024,
    ) ||
    request.files.reduce((size, f) => size + f.content.length, 0) > 256 * 1024 * 1024
  )
    throw Error('invalid_local_git_input');
  request.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return withLocalGitSession(
    request,
    async ({ root, privateRoot, key, index, chains, initialUserState, sourceHead, check, run }) => {
      const baseHash = localRecordHash({
        actionId: request.actionId,
        projectId: request.projectId,
        taskId: request.taskId,
        root,
        privateRoot,
        git: request.git,
        metadataHelper: request.metadataHelper,
        files: request.files.map((f) => ({
          path: f.path,
          executable: f.executable,
          hash: hash(f.content),
        })),
      });
      const branch = `agora-baseline-${key}`;
      const prepared = join(privateRoot, `${key}.prepared.json`),
        completed = join(privateRoot, `${key}.completed.json`);
      const inputHash = localRecordHash({ baseHash, chains, userStateHash: initialUserState });
      await check();
      assertLocalGitActionKind({ privateRoot, key }, 'baseline');
      if (existsSync(prepared)) {
        const saved = JSON.parse(readLocalGitRecord(prepared)?.toString('utf8') ?? 'null');
        if (saved?.inputHash !== inputHash || saved?.baseHash !== baseHash)
          throw Error('operation_conflict');
        if (!existsSync(completed)) throw Error('local_git_recovery_required');
        const envelope = JSON.parse(readLocalGitRecord(completed)?.toString('utf8') ?? 'null');
        const receipt = envelope?.receipt as LocalGitBaselineReceipt;
        if (
          !receipt ||
          envelope.hash !== localRecordHash(receipt) ||
          receipt.inputHash !== inputHash ||
          receipt.branch !== branch ||
          receipt.schemaVersion !== 'local-git-baseline-v1' ||
          receipt.stage !== 'applied' ||
          receipt.actionId !== request.actionId ||
          receipt.projectId !== request.projectId ||
          receipt.taskId !== request.taskId ||
          receipt.gitHash !== request.git.sha256 ||
          receipt.userStateHash !== initialUserState ||
          localRecordHash(receipt.sourceHead ?? null) !== localRecordHash(sourceHead) ||
          !isGitObjectId(receipt.commit) ||
          !isGitObjectId(receipt.tree)
        )
          throw Error('local_git_recovery_required');
        if (
          (await run(['rev-parse', '--verify', `refs/heads/${branch}`])) !== receipt.commit ||
          (await run(['rev-parse', '--verify', `${receipt.commit}^{tree}`])) !== receipt.tree
        )
          throw Error('local_git_recovery_required');
        return receipt;
      }
      if (existsSync(completed) || existsSync(index)) throw Error('local_git_recovery_required');
      writeLocalGitRecord(prepared, { version: 1, inputHash, baseHash });
      const entries: string[] = [];
      for (const file of request.files) {
        const blob = await run(['hash-object', '--stdin', '--no-filters', '-w'], file.content);
        if (!isGitObjectId(blob)) throw Error('local_git_command_failed');
        entries.push(`${file.executable ? '100755' : '100644'} ${blob}\t${file.path}\0`);
      }
      await run(['update-index', '-z', '--index-info'], Buffer.from(entries.join('')));
      const tree = await run(['write-tree']);
      if (!isGitObjectId(tree)) throw Error('local_git_command_failed');
      const commit = await run(['commit-tree', tree], Buffer.from(`Agora fixed baseline ${key}\n`));
      if (!isGitObjectId(commit)) throw Error('local_git_command_failed');
      await run(['update-ref', `refs/heads/${branch}`, commit, '0'.repeat(commit.length)]);
      const receipt: LocalGitBaselineReceipt = {
        schemaVersion: 'local-git-baseline-v1',
        stage: 'applied',
        inputHash,
        actionId: request.actionId,
        projectId: request.projectId,
        taskId: request.taskId,
        branch,
        commit,
        tree,
        userStateHash: initialUserState,
        gitHash: request.git.sha256,
        sourceHead: sourceHead,
      };
      await check();
      writeLocalGitRecord(completed, { receipt, hash: localRecordHash(receipt) });
      await check();
      return receipt;
    },
  );
}
