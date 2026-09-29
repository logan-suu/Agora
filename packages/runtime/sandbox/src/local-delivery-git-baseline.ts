/** Historical task baseline proof, independent of the current coding wave.
 * No recapture, registration replay or user checkout mutation is performed. */
import type { LocalBindingRequest } from './local-binding-coordinator';
import { readLocalGitBaseline } from './local-git-baseline-reader';
import type { LocalCodingBaselineOptions, LocalGitBatchRequest } from './local-git-workspaces';
import { isLocalBindingOperation, localRecordHash } from './local-registry-records';
import { localRootBinding } from './local-workspace-authority';

type Scope = { projectId: string; taskId: string };
const same = (left: unknown, right: unknown) => localRecordHash(left) === localRecordHash(right);
const fail = (): never => {
  throw Error('delivery_git_baseline_invalid');
};

export async function readLocalDeliveryGitBaseline(
  options: LocalCodingBaselineOptions,
  scope: Scope,
) {
  const { control, objects, versions, verifyGrant } = options;
  const state = await control.assertClosed(scope);
  const registry = await control.snapshot();
  const local = state.localExecution;
  const initial = local?.workspaces.find(
    (workspace) => workspace.workspaceId === local.git?.initialWorkspaceId,
  );
  const mapping = local?.git?.worktrees.find((entry) => entry.workspaceId === initial?.workspaceId);
  const physical = registry.linkedRoots?.find(
    (entry) => entry.workspaceId === initial?.workspaceId,
  );
  const root = registry.roots.find(
    (entry) => entry.projectId === scope.projectId && entry.rootId === initial?.rootId,
  );
  const grant = registry.grants.find(
    (entry) => entry.projectId === scope.projectId && entry.grantId === initial?.grantId,
  );
  const reference = local?.receipts.find((entry) => entry.receiptId === mapping?.receiptId);
  const operation = registry.operations.find((entry) => entry.actionId === reference?.actionId);
  if (
    !local?.git ||
    initial?.mode !== 'linked-worktree' ||
    initial.purpose !== 'integration' ||
    !mapping ||
    !physical ||
    !root ||
    !grant ||
    !reference ||
    !operation ||
    !isLocalBindingOperation(operation) ||
    operation.stage !== 'committed' ||
    grant.rootId !== root.rootId ||
    grant.status !== 'active' ||
    physical.projectId !== scope.projectId ||
    physical.taskId !== scope.taskId ||
    physical.path !== mapping.path ||
    physical.bindingReceiptId !== mapping.receiptId ||
    !registry.workspaces.some((entry) => same(entry, initial))
  )
    return fail();
  const authorize = async () => {
    await verifyGrant(scope, grant.grantId);
    if (
      !same(await control.assertClosed(scope), state) ||
      !same(await control.snapshot(), registry)
    )
      fail();
    return true;
  };
  await authorize();
  const key = localRecordHash({
    kind: 'initial-git-batch',
    ...scope,
    actionId: operation.actionId,
  });
  const inputHash = await objects.getReference(key);
  const bindingHash = await objects.getReference(localRecordHash({ key, stage: 'binding' }));
  if (!inputHash || !bindingHash || bindingHash !== operation.inputHash) return fail();
  const saved = (await objects.get(inputHash)) as {
    request: LocalGitBatchRequest;
    gitOptions: typeof options.gitOptions;
  };
  const prepared = (await objects.get(bindingHash)) as LocalBindingRequest;
  const request = saved.request;
  if (
    request?.version?.kind !== 'files' ||
    'waveId' in request ||
    !same(saved.gitOptions, options.gitOptions) ||
    request.projectId !== scope.projectId ||
    request.taskId !== scope.taskId ||
    request.actionId !== operation.actionId ||
    request.rootId !== root.rootId ||
    request.grantId !== grant.grantId ||
    !request.targets.some(
      (target) => target.workspaceId === initial.workspaceId && target.purpose === 'integration',
    ) ||
    !prepared.nextLocalExecution ||
    !prepared.records ||
    prepared.projectId !== scope.projectId ||
    prepared.taskId !== scope.taskId ||
    prepared.actionId !== operation.actionId ||
    prepared.sourceMessageId !== operation.sourceMessageId ||
    prepared.sourceMessageId !== grant.leaderMessageId ||
    prepared.expectedRevision !== request.expectedRevision ||
    operation.preparedRevision !== request.expectedRevision + 1 ||
    !same(reference, {
      receiptId: operation.receiptId,
      actionId: operation.actionId,
      inputHash: bindingHash,
      registryRevision: operation.preparedRevision,
    }) ||
    !same(operation.nextLocalExecution, {
      ...prepared.nextLocalExecution,
      receipts: [...prepared.nextLocalExecution.receipts, reference],
    }) ||
    prepared.nextLocalExecution.git?.initialWorkspaceId !== initial.workspaceId ||
    !prepared.records.workspaces.some((entry) => same(entry, initial)) ||
    !prepared.records.linkedRoots?.some((entry) => same(entry, physical)) ||
    !prepared.records.roots.some((entry) => same(entry, root))
  )
    return fail();
  const versionScope = { ...scope, rootId: root.rootId, policyHash: grant.policyHash };
  const manifest = await versions.read(request.version, versionScope);
  if (manifest.bindingHash !== localRecordHash(localRootBinding(root))) return fail();
  const files = [];
  for (const file of manifest.files)
    files.push({
      path: file.path,
      content: await objects.getBytes(file.contentHash),
      executable: file.version.executable,
    });
  const receipt = await readLocalGitBaseline({
    ...options.gitOptions,
    ...scope,
    root: root.path,
    actionId: `git-${localRecordHash({ key, kind: 'baseline', workspaceId: null })}`,
    files,
    authorize,
  });
  if (receipt.commit !== initial.baseCommit) return fail();
  await authorize();
  return {
    version: request.version,
    manifest,
    receipt,
    sourceReceiptId: reference.receiptId,
    root,
    grant,
  };
}
