/** Private fixed candidates only. No executable workspace, Git ref or TaskState
 * authority is conferred by physical materialization or its durable receipt. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import {
  applyLocalCreation,
  applyLocalDirectoryCreation,
  inspectLocalCreationBasis,
  inspectLocalRoot,
  type LocalRootBinding,
} from './local-file-transaction';
import {
  type LocalGitMergeCandidate,
  readLocalGitMergeTree,
  verifyLocalGitMergeCandidate,
} from './local-git-merge';
import { type LocalGitSessionOptions, withLocalGitSession } from './local-git-session';
import { readLocalGitTreeFiles } from './local-git-tree-files';
import type { LocalRegistryOwner } from './local-registry-file';
import { localRecordHash } from './local-registry-records';
import type { LocalVersionScope, LocalVersionStore } from './local-version-store';
import { serializeWorkspaceOperation } from './local-workspace-operation';

type Merge = Parameters<typeof readLocalGitMergeTree>[0];
type Request = { scope: LocalVersionScope; actionId: string; merge: Merge };
export type LocalMergeCandidate = {
  schemaVersion: 'local-merge-candidate-v1';
  scope: LocalVersionScope;
  actionId: string;
  inputHash: string;
  candidate: LocalGitMergeCandidate;
  binding: LocalRootBinding;
  version: WorkspaceVersionV1;
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const phase = (key: string, name: string) =>
  localRecordHash({ kind: 'merge-candidate', key, name });
function directory(path: string) {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw Error('merge_candidate_root_changed');
  return `${s.dev}:${s.ino}`;
}
function sync(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function snapshot(input: Merge): Merge {
  const contents = <T extends Pick<Merge['baseline'], 'files' | 'directories'>>(c: T) => ({
    ...c,
    directories: [...c.directories],
    files: c.files.map((f) => ({ ...f, content: Buffer.from(f.content) })),
  });
  return {
    actionId: input.actionId,
    projectId: input.projectId,
    taskId: input.taskId,
    root: input.root,
    privateRoot: input.privateRoot,
    git: { ...input.git },
    metadataHelper: { ...input.metadataHelper },
    authorize: input.authorize,
    baseline: contents(input.baseline),
    target: contents(input.target),
    source: contents(input.source),
  };
}
export class LocalMergeCandidates {
  private constructor(
    private readonly owner: LocalRegistryOwner,
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
    private readonly helper: string,
    private readonly root: string,
    private readonly identity: string,
    private readonly helperHash: string,
  ) {}
  static async open(
    owner: LocalRegistryOwner,
    objects: LocalControlObjects,
    versions: LocalVersionStore,
    helper: string,
  ) {
    await owner.assertHeld();
    const root = join(owner.root, 'merge-candidates');
    try {
      mkdirSync(root, { mode: 0o700 });
      sync(owner.root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const s = lstatSync(helper);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      (s.mode & 0o022) !== 0 ||
      !(s.mode & 0o111) ||
      realpathSync(helper) !== helper
    )
      throw Error('untrusted_runtime_path');
    return new LocalMergeCandidates(
      owner,
      objects,
      versions,
      helper,
      root,
      directory(root),
      hash(readFileSync(helper)),
    );
  }
  private async check(authorize: Merge['authorize']) {
    await this.owner.assertHeld();
    if (
      directory(this.root) !== this.identity ||
      hash(readFileSync(this.helper)) !== this.helperHash
    )
      throw Error('merge_candidate_root_changed');
    if (!(await authorize())) throw Error('authorization_closed');
    await this.owner.assertHeld();
    if (
      directory(this.root) !== this.identity ||
      hash(readFileSync(this.helper)) !== this.helperHash
    )
      throw Error('merge_candidate_root_changed');
    return true;
  }
  async materialize(input: Request): Promise<LocalMergeCandidate> {
    localRecordHash({ scope: input.scope, actionId: input.actionId });
    const scope = structuredClone(input.scope),
      actionId = input.actionId;
    if (
      Object.keys(scope).sort().join(',') !== 'policyHash,projectId,rootId,taskId' ||
      ![scope.projectId, scope.taskId, scope.rootId].every(id) ||
      !/^[a-f0-9]{64}$/.test(scope.policyHash) ||
      scope.projectId !== input.merge.projectId ||
      scope.taskId !== input.merge.taskId
    )
      throw Error('workspace_version_scope_mismatch');
    if (!id(actionId)) throw Error('invalid_merge_candidate');
    const merge = snapshot(input.merge);
    const key = localRecordHash({
      kind: 'merge-candidate',
      projectId: scope.projectId,
      taskId: scope.taskId,
      actionId,
    });
    return serializeWorkspaceOperation({ ...scope, workspaceId: `candidate:${key}` }, () =>
      this.execute(scope, actionId, merge, key),
    );
  }
  /** Existing private evidence only. The caller must independently authenticate
   * canonical source/target ownership and the current application state. */
  async readCompleted(input: { receipt: LocalMergeCandidate; git: LocalGitSessionOptions }) {
    const receipt = structuredClone(input.receipt);
    const { authorize, ...data } = input.git;
    const git = { ...structuredClone(data), authorize };
    const { scope, actionId } = receipt;
    if (
      !id(actionId) ||
      scope.projectId !== git.projectId ||
      scope.taskId !== git.taskId ||
      receipt.candidate.projectId !== scope.projectId ||
      receipt.candidate.taskId !== scope.taskId
    )
      throw Error('merge_candidate_recovery_required');
    const key = localRecordHash({
      kind: 'merge-candidate',
      projectId: scope.projectId,
      taskId: scope.taskId,
      actionId,
    });
    return serializeWorkspaceOperation({ ...scope, workspaceId: `candidate:${key}` }, async () => {
      const check = () => this.check(authorize);
      await check();
      const preparedHash = await this.objects.getReference(phase(key, 'prepared'));
      const resultHash = await this.objects.getReference(phase(key, 'result'));
      const marker = await this.objects.getReference(phase(key, 'completion'));
      if (
        !preparedHash ||
        resultHash !== localRecordHash(receipt) ||
        !marker ||
        (await this.objects.getReference(phase(key, 'invalid'))) ||
        !equal(await this.objects.get(marker), {
          schemaVersion: 'local-merge-candidate-completion-v1',
          receiptHash: resultHash,
          valid: true,
        }) ||
        receipt.binding.root !== join(this.root, key, 'tree') ||
        receipt.version.kind !== 'files'
      )
        throw Error('merge_candidate_recovery_required');
      if (!equal(await this.objects.get(resultHash), receipt))
        throw Error('merge_candidate_recovery_required');
      await this.versions.verify(receipt.version, scope, receipt.binding, check);
      const manifest = await this.versions.read(receipt.version, scope);
      const logical = {
        directories: manifest.directories.map((d) => d.path).filter(Boolean),
        files: manifest.files.map(({ path, version }) => ({
          path,
          sha256: version.sha256,
          size: version.size,
          executable: version.executable,
        })),
      };
      const payload = {
        scope,
        actionId,
        candidate: receipt.candidate,
        logical,
        helperHash: this.helperHash,
      };
      const inputHash = localRecordHash(payload);
      const { binding: _, version: __, ...fixed } = receipt;
      if (
        !equal(fixed, {
          schemaVersion: 'local-merge-candidate-v1',
          scope,
          actionId,
          inputHash,
          candidate: receipt.candidate,
        }) ||
        !equal(await this.objects.get(preparedHash), {
          schemaVersion: 'local-merge-candidate-prepared-v1',
          inputHash,
          ...payload,
        }) ||
        !equal(manifest.excludedPaths, ['.agora-operations'])
      )
        throw Error('merge_candidate_recovery_required');
      await withLocalGitSession({ ...git, authorize: check }, async (session) => {
        await verifyLocalGitMergeCandidate(session, receipt.candidate);
        if (receipt.candidate.result.kind !== 'merged') throw Error('local_git_merge_conflict');
        const { files } = await readLocalGitTreeFiles(session, receipt.candidate.result.tree);
        if (
          !equal(
            files
              .map(({ path, content, executable }) => ({
                path,
                sha256: hash(content),
                size: content.length,
                executable,
              }))
              .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
            logical.files,
          )
        )
          throw Error('merge_candidate_changed');
      });
      await this.versions.verify(receipt.version, scope, receipt.binding, check);
      await check();
      return receipt;
    });
  }
  private async execute(scope: LocalVersionScope, actionId: string, merge: Merge, key: string) {
    const check = () => this.check(merge.authorize);
    await check();
    const source = await readLocalGitMergeTree({ ...merge, authorize: check });
    if (source.result.kind !== 'merged') throw Error('local_git_merge_conflict');
    const contents = source.result;
    if (contents.files.length + contents.directories.length + 1 > 4096)
      throw Error('workspace_version_limit');
    const logical = {
      directories: contents.directories,
      files: contents.files
        .map(({ path, content, executable }) => ({
          path,
          sha256: hash(content),
          size: content.length,
          executable,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
    const payload = {
      scope,
      actionId,
      candidate: source.candidate,
      logical,
      helperHash: this.helperHash,
    };
    const inputHash = localRecordHash(payload);
    const prepared = { schemaVersion: 'local-merge-candidate-prepared-v1', inputHash, ...payload };
    const preparedKey = phase(key, 'prepared'),
      resultKey = phase(key, 'result'),
      completionKey = phase(key, 'completion'),
      invalidKey = phase(key, 'invalid');
    const path = join(this.root, key),
      root = join(path, 'tree'),
      journalRoot = join(path, 'journal');
    const verify = async (receipt: LocalMergeCandidate) => {
      const { binding, version, ...fixed } = receipt;
      if (
        !equal(fixed, {
          schemaVersion: 'local-merge-candidate-v1',
          scope,
          actionId,
          inputHash,
          candidate: source.candidate,
        }) ||
        binding.root !== root ||
        version.kind !== 'files'
      )
        throw Error('merge_candidate_recovery_required');
      await check();
      await this.versions.verify(version, scope, binding, check);
      const manifest = await this.versions.read(version, scope);
      if (
        !equal(
          {
            directories: manifest.directories.filter((d) => d.path !== '').map((d) => d.path),
            files: manifest.files.map(({ path, version: v }) => ({
              path,
              sha256: v.sha256,
              size: v.size,
              executable: v.executable,
            })),
          },
          logical,
        ) ||
        !equal(manifest.excludedPaths, ['.agora-operations'])
      )
        throw Error('merge_candidate_changed');
      const current = await readLocalGitMergeTree({ ...merge, authorize: check });
      if (!equal(current.candidate, source.candidate) || current.result.kind !== 'merged')
        throw Error('merge_candidate_changed');
      await this.versions.verify(version, scope, binding, check);
    };
    const old = await this.objects.getReference(preparedKey);
    if (old) {
      if (!equal(await this.objects.get(old), prepared)) throw Error('operation_conflict');
      const completed = await this.objects.getReference(resultKey),
        marker = await this.objects.getReference(completionKey);
      if (!completed || !marker || (await this.objects.getReference(invalidKey)))
        throw Error('merge_candidate_recovery_required');
      if (
        !equal(await this.objects.get(marker), {
          schemaVersion: 'local-merge-candidate-completion-v1',
          receiptHash: completed,
          valid: true,
        })
      )
        throw Error('merge_candidate_recovery_required');
      const receipt = (await this.objects.get(completed)) as LocalMergeCandidate;
      await verify(receipt);
      return receipt;
    }
    if (
      (await this.objects.getReference(resultKey)) ||
      (await this.objects.getReference(completionKey)) ||
      (await this.objects.getReference(invalidKey))
    )
      throw Error('merge_candidate_recovery_required');
    if ((await this.objects.references()).length + 4 > 4096) throw Error('control_reference_limit');
    await this.objects.bindReference(preparedKey, await this.objects.put(prepared));
    await check();
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw Error('merge_candidate_recovery_required');
      throw e;
    }
    sync(this.root);
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(journalRoot, { mode: 0o700 });
    sync(path);
    mkdirSync(join(root, '.agora-operations'), { mode: 0o700 });
    sync(root);
    const binding = inspectLocalRoot(root);
    let index = 0;
    const create = async (path: string, file?: (typeof contents.files)[number]) => {
      await check();
      const request = {
        actionId: `candidate-${key}-${index++}`,
        binding,
        path,
        expected: inspectLocalCreationBasis(binding, path, this.helper),
        journalRoot,
        helper: this.helper,
        authorize: check,
      };
      const result = file
        ? await applyLocalCreation({
            ...request,
            content: file.content,
            executable: file.executable,
          })
        : await applyLocalDirectoryCreation(request);
      if (result.stage !== 'applied' || !result.quiescent || !result.created)
        throw Error('merge_candidate_recovery_required');
    };
    for (const path of [...contents.directories].sort(
      (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0),
    ))
      await create(path);
    for (const file of contents.files) await create(file.path, file);
    const version = await this.versions.capture(scope, binding, check);
    const receipt: LocalMergeCandidate = {
      schemaVersion: 'local-merge-candidate-v1',
      scope,
      actionId,
      inputHash,
      candidate: source.candidate,
      binding,
      version,
    };
    await verify(receipt);
    const receiptHash = await this.objects.put(receipt);
    await this.objects.bindReference(resultKey, receiptHash);
    try {
      await verify(receipt);
      await this.objects.bindReference(
        completionKey,
        await this.objects.put({
          schemaVersion: 'local-merge-candidate-completion-v1',
          receiptHash,
          valid: true,
        }),
      );
      await verify(receipt);
    } catch (error) {
      await this.objects.bindReference(
        invalidKey,
        await this.objects.put({ schemaVersion: 'local-merge-candidate-invalid-v1', receiptHash }),
      );
      throw error;
    }
    return receipt;
  }
}
