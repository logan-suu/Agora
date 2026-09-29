/** Compute an immutable merge candidate. No ref, index, or source file is updated. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isGitObjectId, isWorkspaceRelativePath } from '@agora/core-domain';
import { completeLocalMergeTree } from '../../../core/domain/src/local-tree-comparison';
import {
  assertLocalGitActionKind,
  type LocalGitSession,
  type LocalGitSessionOptions,
  readLocalGitRecord,
  withLocalGitSession,
  writeLocalGitRecord,
} from './local-git-session';
import { readLocalGitTreeFiles } from './local-git-tree-files';
import {
  localGitDirectories,
  readOwnedLocalGitWorktree,
  verifyLocalGitFiles,
  verifyLocalGitTree,
  verifyOwnedLocalGitWorktree,
} from './local-git-worktree';
import { localRecordHash } from './local-registry-records';
import { isLocalReservedName } from './local-reserved-path';

type Side = {
  workspaceId: string;
  creationActionId: string;
  head: string;
  stagingIdentity?: string;
  files: { path: string; content: Buffer; executable: boolean }[];
  directories?: string[];
};
type Options = LocalGitSessionOptions & { target: Side; source: Side };
type CompleteContents = { files: Side['files']; directories: string[] };
type CompleteOptions = Options & {
  baseline: CompleteContents & { commit: string };
  target: Side & CompleteContents;
  source: Side & CompleteContents;
};
export type LocalGitMergeCandidate = {
  schemaVersion: 'local-git-merge-candidate-v1';
  inputHash: string;
  projectId: string;
  taskId: string;
  actionId: string;
  targetHead: string;
  sourceHead: string;
  result:
    | { kind: 'merged'; tree: string; commit: string }
    | { kind: 'conflict'; tree: string; paths: string[] };
};
const id = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function copySide(input: Side) {
  const side = {
    ...input,
    files: input.files
      .map((file) => ({ ...file, content: Buffer.from(file.content) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    directories: localGitDirectories(input.files, input.directories),
  };
  if (
    !id(side.workspaceId) ||
    !id(side.creationActionId) ||
    !isGitObjectId(side.head) ||
    new Set(side.files.map((f) => f.path)).size !== side.files.length ||
    side.files.some(
      (f) =>
        !isWorkspaceRelativePath(f.path) ||
        f.path.split('/').some(isLocalReservedName) ||
        typeof f.executable !== 'boolean' ||
        f.content.length > 16 * 1024 * 1024,
    ) ||
    side.files.reduce((size, f) => size + f.content.length, 0) > 256 * 1024 * 1024 ||
    (side.stagingIdentity !== undefined &&
      !/^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$/.test(side.stagingIdentity))
  )
    throw Error('invalid_local_git_input');
  return side;
}
export function assertLocalGitNoMerge(metadata: string) {
  try {
    lstatSync(join(metadata, 'MERGE_HEAD'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw Error('local_git_merge_in_progress');
}

export async function planLocalGitMerge(input: Options): Promise<LocalGitMergeCandidate> {
  return withLocalGitMerge(input, async (candidate) => candidate);
}

/** Verify original immutable evidence and independently rederive its exact object
 * result. Publication has already applied files, so this does not require the
 * target's old file contents; its caller must check target and source identities. */
export async function verifyLocalGitMergeCandidate(
  session: LocalGitSession,
  candidate: LocalGitMergeCandidate,
) {
  if (
    !candidate ||
    Object.keys(candidate).sort().join(',') !==
      'actionId,inputHash,projectId,result,schemaVersion,sourceHead,targetHead,taskId' ||
    candidate.schemaVersion !== 'local-git-merge-candidate-v1' ||
    ![candidate.projectId, candidate.taskId, candidate.actionId].every(id) ||
    !/^[a-f0-9]{64}$/.test(candidate.inputHash) ||
    ![candidate.targetHead, candidate.sourceHead].every(isGitObjectId) ||
    candidate.targetHead === candidate.sourceHead ||
    candidate.result?.kind !== 'merged' ||
    Object.keys(candidate.result).sort().join(',') !== 'commit,kind,tree' ||
    ![candidate.result.commit, candidate.result.tree].every(isGitObjectId)
  )
    throw Error('local_git_merge_proof_invalid');
  const key = localRecordHash({
    projectId: candidate.projectId,
    taskId: candidate.taskId,
    actionId: candidate.actionId,
  });
  const read = (stage: string) =>
    JSON.parse(
      readLocalGitRecord(join(session.privateRoot, `${key}.merge-${stage}.json`), true)?.toString(
        'utf8',
      ) ?? 'null',
    );
  const prepared = read('prepared'),
    completed = read('completed');
  if (
    !prepared ||
    Object.keys(prepared).sort().join(',') !== 'inputHash,schemaVersion' ||
    prepared.schemaVersion !== 'local-git-merge-prepared-v1' ||
    prepared.inputHash !== candidate.inputHash ||
    !completed ||
    Object.keys(completed).sort().join(',') !== 'candidate,hash' ||
    completed.hash !== localRecordHash(candidate) ||
    localRecordHash(completed.candidate) !== completed.hash
  )
    throw Error('local_git_merge_proof_invalid');
  // Recomputing the merge writes content-addressed objects. Prove the original
  // reachable graph first so verification cannot silently repair missing evidence.
  await session.run([
    'rev-list',
    '--objects',
    '--no-object-names',
    '--missing=error',
    candidate.result.commit,
  ]);
  const merged = await session.mergeObjects(
    candidate.targetHead,
    candidate.sourceHead,
    true,
    candidate.actionId,
  );
  const tree = merged.output.replace(/\0$/, '');
  if (merged.status !== 0 || tree !== candidate.result.tree)
    throw Error('local_git_merge_proof_invalid');
  const commit = await session.run(
    ['commit-tree', tree, '-p', candidate.targetHead, '-p', candidate.sourceHead],
    Buffer.from(`Agora merge candidate ${key}\n`),
  );
  if (commit !== candidate.result.commit) throw Error('local_git_merge_proof_invalid');
  await session.check();
}

export async function readLocalGitMergeFiles(input: Options) {
  return withLocalGitMerge(input, async (candidate, session) => {
    if (candidate.result.kind !== 'merged') throw Error('local_git_merge_conflict');
    return { candidate, ...(await readLocalGitTreeFiles(session, candidate.result.tree)) };
  });
}

const logicalTree = (contents: CompleteContents) => ({
  directories: contents.directories,
  files: contents.files.map(({ path, content, executable }) => ({
    path,
    sha256: sha(content),
    size: content.length,
    executable,
  })),
});

/** The caller supplies canonical complete baseline facts. Git verifies its file
 * contents and unique merge base, but cannot authenticate historical empty directories. */
export async function readLocalGitMergeTree(input: CompleteOptions) {
  if (
    !input.baseline ||
    !isGitObjectId(input.baseline.commit) ||
    !Array.isArray(input.baseline.directories) ||
    !Array.isArray(input.target.directories) ||
    !Array.isArray(input.source.directories)
  )
    throw Error('invalid_local_git_input');
  const baseline = {
    commit: input.baseline.commit,
    files: input.baseline.files
      .map((file) => ({ ...file, content: Buffer.from(file.content) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    directories: localGitDirectories(input.baseline.files, input.baseline.directories),
  };
  const target = copySide(input.target),
    source = copySide(input.source);
  const b = logicalTree(baseline),
    t = logicalTree(target),
    s = logicalTree(source);
  // Validate complete bounded facts before any metadata operation, including their union.
  completeLocalMergeTree(b, t, s, []);
  return withLocalGitMerge(
    { ...input, target, source },
    async (candidate, session) => {
      if (candidate.result.kind === 'conflict')
        return {
          candidate,
          result: {
            kind: 'conflict' as const,
            source: 'git' as const,
            paths: candidate.result.paths,
          },
        };
      const extracted = await readLocalGitTreeFiles(session, candidate.result.tree);
      const merged = completeLocalMergeTree(
        b,
        t,
        s,
        logicalTree({ ...extracted, directories: [] }).files,
      );
      return merged.kind === 'conflict'
        ? {
            candidate,
            result: {
              kind: 'conflict' as const,
              source: 'directories' as const,
              paths: merged.paths,
            },
          }
        : {
            candidate,
            result: {
              kind: 'merged' as const,
              files: extracted.files,
              directories: merged.tree.directories,
            },
          };
    },
    baseline,
  );
}

async function withLocalGitMerge<T>(
  input: Options,
  consume: (candidate: LocalGitMergeCandidate, session: LocalGitSession) => Promise<T>,
  baseline?: CompleteOptions['baseline'],
): Promise<T> {
  const target = copySide(input.target),
    source = copySide(input.source);
  if (target.workspaceId === source.workspaceId || target.head === source.head)
    throw Error('invalid_local_git_input');
  const request = { ...input, git: { ...input.git }, metadataHelper: { ...input.metadataHelper } };
  return withLocalGitSession(request, async (session) => {
    const { run, check, privateRoot, key } = session;
    assertLocalGitActionKind(session, 'merge');
    const sides = [target, source].map((side) => ({
      side,
      created: readOwnedLocalGitWorktree(session, {
        ...request,
        ...side,
        gitHash: request.git.sha256,
      }),
    }));
    const verifySides = async () => {
      if (baseline) {
        if ((await run(['merge-base', '--all', target.head, source.head])) !== baseline.commit)
          throw Error('local_git_merge_base_invalid');
        await verifyLocalGitTree(session, baseline.commit, baseline.files);
      }
      for (const { side, created } of sides) {
        assertLocalGitNoMerge(created.metadata);
        await verifyOwnedLocalGitWorktree(session, created, side.head);
        await verifyLocalGitTree(session, side.head, side.files);
        verifyLocalGitFiles(
          session,
          created.path,
          side.files,
          side.stagingIdentity,
          side.directories,
        );
      }
      await check();
    };
    const inputHash = localRecordHash({
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
      git: request.git,
      metadataHelper: request.metadataHelper,
      chains: session.chains,
      userStateHash: session.initialUserState,
      sides: sides.map(({ side, created }) => ({
        ...side,
        creationHash: localRecordHash(created),
        files: side.files.map(({ content, ...file }) => ({ ...file, sha256: sha(content) })),
      })),
      strategy: 'isolated-attributes-ort-v1',
      ...(baseline
        ? { completeBaseline: { commit: baseline.commit, ...logicalTree(baseline) } }
        : {}),
    });
    const fixed = {
      schemaVersion: 'local-git-merge-candidate-v1' as const,
      inputHash,
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
      targetHead: target.head,
      sourceHead: source.head,
    };
    const prepared = join(privateRoot, `${key}.merge-prepared.json`),
      completed = join(privateRoot, `${key}.merge-completed.json`);
    let proof: LocalGitMergeCandidate['result'] | undefined;
    const derive = async (replay: boolean) => {
      const merged = await session.mergeObjects(target.head, source.head, replay);
      const entries = merged.output.split('\0');
      if (entries.at(-1) === '') entries.pop();
      const tree = entries.shift();
      if (
        !tree ||
        !isGitObjectId(tree) ||
        (merged.status === 0 && entries.length !== 0) ||
        (merged.status === 1 && entries.length === 0)
      )
        throw Error('local_git_merge_result_invalid');
      let result: LocalGitMergeCandidate['result'];
      if (merged.status === 1) result = { kind: 'conflict', tree, paths: entries.sort() };
      else {
        const commit = await run(
          ['commit-tree', tree, '-p', target.head, '-p', source.head],
          Buffer.from(`Agora merge candidate ${key}\n`),
        );
        if (!isGitObjectId(commit)) throw Error('local_git_merge_result_invalid');
        result = { kind: 'merged', tree, commit };
      }
      return result;
    };
    const verify = async (candidate: LocalGitMergeCandidate) => {
      const { result, ...rest } = candidate;
      if (
        localRecordHash(rest) !== localRecordHash(fixed) ||
        !result ||
        !isGitObjectId(result.tree)
      )
        throw Error('local_git_recovery_required');
      if (result.kind === 'merged') {
        if (
          Object.keys(result).sort().join(',') !== 'commit,kind,tree' ||
          !isGitObjectId(result.commit) ||
          (await run(['rev-parse', '--verify', `${result.commit}^{tree}`])) !== result.tree ||
          (await run(['rev-list', '--parents', '-n', '1', result.commit])) !==
            `${result.commit} ${target.head} ${source.head}`
        )
          throw Error('local_git_recovery_required');
      } else if (
        result.kind !== 'conflict' ||
        Object.keys(result).sort().join(',') !== 'kind,paths,tree' ||
        !Array.isArray(result.paths) ||
        !result.paths.length ||
        new Set(result.paths).size !== result.paths.length ||
        result.paths.some(
          (path) => !isWorkspaceRelativePath(path) || path.split('/').some(isLocalReservedName),
        )
      )
        throw Error('local_git_recovery_required');
      proof ??= await derive(true);
      if (localRecordHash(result) !== localRecordHash(proof))
        throw Error('local_git_recovery_required');
      if ((await run(['cat-file', '-t', result.tree])) !== 'tree')
        throw Error('local_git_recovery_required');
      await verifySides();
    };
    await verifySides();
    if (existsSync(prepared)) {
      const saved = JSON.parse(readLocalGitRecord(prepared)?.toString('utf8') ?? 'null');
      if (saved?.inputHash !== inputHash) throw Error('operation_conflict');
      if (!existsSync(completed)) throw Error('local_git_recovery_required');
      const envelope = JSON.parse(readLocalGitRecord(completed)?.toString('utf8') ?? 'null');
      if (!envelope?.candidate || envelope.hash !== localRecordHash(envelope.candidate))
        throw Error('local_git_recovery_required');
      await verify(envelope.candidate);
      const extracted = await consume(envelope.candidate, session);
      await verifySides();
      return extracted;
    }
    if (existsSync(completed)) throw Error('local_git_recovery_required');
    // Refuse unrelated histories before preparing a new operation.
    if (!isGitObjectId(await run(['merge-base', target.head, source.head])))
      throw Error('local_git_merge_base_invalid');
    writeLocalGitRecord(prepared, { schemaVersion: 'local-git-merge-prepared-v1', inputHash });
    const result = await derive(false);
    proof = result;
    const candidate = { ...fixed, result };
    await verify(candidate);
    writeLocalGitRecord(completed, { candidate, hash: localRecordHash(candidate) });
    await verify(candidate);
    const extracted = await consume(candidate, session);
    await verifySides();
    return extracted;
  });
}
