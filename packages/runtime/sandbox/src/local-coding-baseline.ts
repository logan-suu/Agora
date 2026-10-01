/** Canonical initial-wave provenance. Historical manifests never recapture the user directory. */
import { readCodingWorkerLineage, type WorktreeRef } from '@agora/core-domain';
import type { LocalBindingRequest } from './local-binding-coordinator';
import { readLocalGitBaseline } from './local-git-baseline-reader';
import { withLocalGitSession } from './local-git-session';
import type { LocalCodingBaselineOptions, LocalGitBatchRequest } from './local-git-workspaces';
import { localGitDirectories, readOwnedLocalGitWorktree } from './local-git-worktree';
import {
  type ApplicationRequest,
  checkApplicationState,
  readCompletedApplication,
} from './local-integration-application-records';
import { verifyLocalLinkedRoot } from './local-linked-root';
import { isLocalBindingOperation, localRecordHash } from './local-registry-records';
import type { LocalFileManifest } from './local-version-store';
import { localRootBinding } from './local-workspace-authority';

const fail = (): never => {
  throw Error('coding_baseline_proof_mismatch');
};
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const contents = (manifest: LocalFileManifest) => ({
  directories: manifest.directories.map((d) => d.path),
  files: manifest.files.map((f) => ({
    path: f.path,
    contentHash: f.contentHash,
    executable: f.version.executable,
  })),
});

export async function readInitialCodingBaseline(
  options: LocalCodingBaselineOptions,
  input: { projectId: string; taskId: string; workerId: string },
  published?: ApplicationRequest,
) {
  localRecordHash(input);
  if (
    Object.keys(input).sort().join(',') !== 'projectId,taskId,workerId' ||
    !Object.values(input).every((v) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v))
  )
    fail();
  const scope = structuredClone(input);
  const { control, objects, versions, verifyGrant } = options;
  const gitOptions = structuredClone(options.gitOptions);
  const state = await control.assertClosed(scope);
  const snapshot = await control.snapshot();
  const proof = published ? await readCompletedApplication(objects, published) : undefined;
  if (proof) {
    await checkApplicationState(objects, state, proof);
    if (
      !proof.prepared.integration.pendingBranches.some((b) => b.workerId === scope.workerId) ||
      proof.prepared.registryRevision !== snapshot.revision ||
      !same(proof.prepared.gitOptions, gitOptions)
    )
      return fail();
  }
  const lineage = readCodingWorkerLineage(state);
  const local = state.localExecution;
  const assignment = lineage.assignments.find((a) => a.workerId === scope.workerId);
  const binding = local?.bindings.find((b) => b.workerId === scope.workerId);
  const workspace = local?.workspaces.find((w) => w.workspaceId === binding?.workspaceId);
  const initial = local?.workspaces.find((w) => w.workspaceId === local.git?.initialWorkspaceId);
  if (
    !local?.git ||
    !assignment ||
    !binding ||
    binding.subtaskId !== assignment.subtaskId ||
    workspace?.mode !== 'linked-worktree' ||
    workspace.purpose !== 'coding' ||
    initial?.mode !== 'linked-worktree' ||
    initial.purpose !== 'integration' ||
    state.parallelExecution?.acceptedReceiptId !== undefined ||
    initial.branch !== lineage.base.branch ||
    initial.baseCommit !== lineage.base.commit ||
    workspace.baseCommit !== lineage.base.commit ||
    workspace.commonDirId !== initial.commonDirId ||
    workspace.rootId !== initial.rootId ||
    workspace.grantId !== initial.grantId
  )
    return fail();
  const record = snapshot.linkedRoots?.find((r) => r.workspaceId === initial.workspaceId);
  const mapping = local.git.worktrees.find((m) => m.workspaceId === initial.workspaceId);
  const root = snapshot.roots.find((r) => r.rootId === initial.rootId);
  const grant = snapshot.grants.find((g) => g.grantId === initial.grantId);
  if (
    !record ||
    !mapping ||
    !root ||
    !grant ||
    mapping.path !== record.path ||
    mapping.receiptId !== record.bindingReceiptId
  )
    return fail();
  const authorize = async () => {
    await verifyGrant(scope, grant.grantId);
    if (
      (await control.snapshot()).revision !== snapshot.revision ||
      !same(await control.assertClosed(scope), state)
    )
      fail();
    return true;
  };
  await authorize();

  async function batch(receiptId: string, kind: 'initial-git-batch' | 'coding-git-batch') {
    const receipt = local?.receipts.find((r) => r.receiptId === receiptId);
    const operation = snapshot.operations.find((o) => o.actionId === receipt?.actionId);
    if (
      !receipt ||
      !operation ||
      !isLocalBindingOperation(operation) ||
      operation.stage !== 'committed'
    )
      return fail();
    const key = localRecordHash({
      kind,
      projectId: scope.projectId,
      taskId: scope.taskId,
      actionId: operation.actionId,
    });
    const inputHash = await objects.getReference(key);
    const bindingHash = await objects.getReference(localRecordHash({ key, stage: 'binding' }));
    if (!inputHash || !bindingHash || operation.inputHash !== bindingHash) return fail();
    const prepared = (await objects.get(bindingHash)) as LocalBindingRequest;
    const saved = (await objects.get(inputHash)) as {
      request: LocalGitBatchRequest;
      gitOptions: typeof gitOptions;
    };
    const request = saved.request;
    if (
      !request ||
      !prepared.nextLocalExecution ||
      !prepared.records ||
      !same(saved.gitOptions, gitOptions) ||
      request.projectId !== scope.projectId ||
      request.taskId !== scope.taskId ||
      request.actionId !== operation.actionId ||
      request.rootId !== root?.rootId ||
      request.grantId !== grant?.grantId ||
      prepared.projectId !== scope.projectId ||
      prepared.taskId !== scope.taskId ||
      prepared.actionId !== operation.actionId ||
      prepared.sourceMessageId !== operation.sourceMessageId ||
      prepared.sourceMessageId !== grant?.leaderMessageId ||
      prepared.expectedRevision !== request.expectedRevision ||
      operation.preparedRevision !== request.expectedRevision + 1 ||
      !same(receipt, {
        receiptId: operation.receiptId,
        actionId: operation.actionId,
        inputHash: bindingHash,
        registryRevision: operation.preparedRevision,
      }) ||
      !same(operation.nextLocalExecution, {
        ...prepared.nextLocalExecution,
        receipts: [...prepared.nextLocalExecution.receipts, receipt],
      }) ||
      !same(
        prepared.records.roots.find((r) => r.rootId === root?.rootId),
        root,
      )
    )
      return fail();
    return { key, inputHash, bindingHash, request, prepared, receipt };
  }
  const first = await batch(mapping.receiptId, 'initial-git-batch');
  const coding = await batch(binding.receiptId, 'coding-git-batch');
  const firstTarget = first.request.targets.find((t) => t.workspaceId === initial.workspaceId);
  const codingTarget = coding.request.targets.find((t) => t.workspaceId === workspace.workspaceId);
  const recordedBinding = coding.prepared.nextLocalExecution.bindings.find(
    (b) => b.workerId === scope.workerId,
  );
  if (
    'waveId' in first.request ||
    first.request.version.kind !== 'files' ||
    firstTarget?.purpose !== 'integration' ||
    first.prepared.nextLocalExecution.git?.initialWorkspaceId !== initial.workspaceId ||
    !same(
      first.prepared.records.workspaces.find((w) => w.workspaceId === initial.workspaceId),
      initial,
    ) ||
    !same(
      first.prepared.records.linkedRoots?.find((r) => r.workspaceId === initial.workspaceId),
      record,
    ) ||
    !same(
      first.prepared.nextLocalExecution.git?.worktrees.find(
        (m) => m.workspaceId === initial.workspaceId,
      ),
      mapping,
    ) ||
    !('waveId' in coding.request) ||
    coding.request.waveId !== lineage.waveId ||
    coding.request.attempt !== assignment.attempt ||
    coding.request.sourceWorkspaceId !== initial.workspaceId ||
    coding.request.version.kind !== 'git' ||
    coding.request.version.commit !== lineage.base.commit ||
    codingTarget?.purpose !== 'coding' ||
    codingTarget.workerId !== scope.workerId ||
    !same(recordedBinding, binding) ||
    !same(
      coding.prepared.records.workspaces.find((w) => w.workspaceId === workspace.workspaceId),
      workspace,
    )
  )
    return fail();
  const versionScope = {
    projectId: scope.projectId,
    taskId: scope.taskId,
    rootId: root.rootId,
    policyHash: grant.policyHash,
  };
  const manifest = await versions.read(first.request.version, versionScope);
  const gitManifest = await versions.readGitManifest(coding.request.version, versionScope);
  const codingManifest = await versions.read(coding.request.version, versionScope);
  if (
    manifest.bindingHash !== localRecordHash(localRootBinding(root)) ||
    gitManifest.workspaceId !== initial.workspaceId ||
    gitManifest.physicalHash !== localRecordHash(record) ||
    gitManifest.commonDirId !== initial.commonDirId ||
    gitManifest.branch !== initial.branch ||
    gitManifest.commit !== lineage.base.commit ||
    !same(contents(manifest), contents(codingManifest))
  )
    return fail();

  const refs: WorktreeRef[] = [
    ...state.workers.flatMap((w) => (typeof w.worktree === 'object' ? [w.worktree] : [])),
    ...(state.integration ? [state.integration.integrationWorktree] : []),
    ...lineage.conflictReworks.map((r) => r.integration.integrationWorktree),
    ...(state.parallelExecution?.activeWave?.validation
      ? [state.parallelExecution.activeWave.validation.worktree]
      : []),
  ].filter((ref): ref is WorktreeRef => ref !== undefined && ref.path === record.path);
  if (refs.some((ref) => ref.branch !== initial.branch || ref.baseCommit !== initial.baseCommit))
    return fail();
  const heads = new Set(refs.map((ref) => ref.headCommit ?? ref.baseCommit));
  if (heads.size > 1) return fail();
  if (
    proof &&
    proof.prepared.request.call.workspaceId !== initial.workspaceId &&
    !lineage.conflictReworks.length
  )
    return fail();
  const current = {
    ...gitOptions,
    projectId: scope.projectId,
    taskId: scope.taskId,
    root: root.path,
    sourceRoot: root,
    workspace: initial,
    record,
    expectedHead:
      (proof?.prepared.request.call.workspaceId === initial.workspaceId
        ? proof.result.publication.commit
        : undefined) ??
      refs[0]?.headCommit ??
      refs[0]?.baseCommit ??
      initial.baseCommit,
    actionId: record.initialization.actionId,
    creationActionId: record.creation.actionId,
    bindingReceiptId: record.bindingReceiptId,
    authorize,
  };
  await verifyLocalLinkedRoot(current);
  const files: { path: string; content: Buffer; executable: boolean }[] = [];
  for (const file of manifest.files)
    files.push({
      path: file.path,
      content: await objects.getBytes(file.contentHash),
      executable: file.version.executable,
    });
  // Git trees omit empty directories. Bind the full set to the original creation receipt.
  await withLocalGitSession(current, async (session) => {
    for (const owned of [initial, workspace]) {
      const physical = snapshot.linkedRoots?.find((r) => r.workspaceId === owned.workspaceId);
      if (!physical) return fail();
      const creation = readOwnedLocalGitWorktree(session, {
        projectId: scope.projectId,
        taskId: scope.taskId,
        workspaceId: owned.workspaceId,
        creationActionId: physical.creation.actionId,
        gitHash: gitOptions.git.sha256,
      });
      if (
        physical.creation.receiptHash !== localRecordHash(creation) ||
        creation.baseCommit !== lineage.base.commit ||
        creation.inputHash !==
          localRecordHash({
            workspaceId: owned.workspaceId,
            baseCommit: lineage.base.commit,
            actionId: physical.creation.actionId,
            projectId: scope.projectId,
            taskId: scope.taskId,
            root: session.root,
            privateRoot: session.privateRoot,
            git: gitOptions.git,
            metadataHelper: gitOptions.metadataHelper,
            chains: session.chains,
            userStateHash: creation.userStateHash,
            files: manifest.files.map((file) => ({
              path: file.path,
              hash: file.contentHash,
              executable: file.version.executable,
            })),
            directories: localGitDirectories(
              files,
              manifest.directories.map((d) => d.path).filter(Boolean),
            ),
          })
      )
        return fail();
    }
  });
  const receipt = await readLocalGitBaseline({
    ...current,
    actionId: `git-${localRecordHash({ key: first.key, kind: 'baseline', workspaceId: null })}`,
    files,
  });
  if (receipt.commit !== lineage.base.commit || receipt.tree !== gitManifest.tree) return fail();
  await verifyLocalLinkedRoot(current);
  await authorize();
  return structuredClone({
    workerId: scope.workerId,
    lineage,
    baseCommit: receipt.commit,
    version: first.request.version,
    codingVersion: coding.request.version,
    manifest,
    receipt,
    initialBatch: {
      inputHash: first.inputHash,
      bindingHash: first.bindingHash,
      receipt: first.receipt,
    },
    codingBatch: {
      inputHash: coding.inputHash,
      bindingHash: coding.bindingHash,
      receipt: coding.receipt,
    },
  });
}
