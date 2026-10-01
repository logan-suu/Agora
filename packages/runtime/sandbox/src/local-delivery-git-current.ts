/** Capture live user files and index identity under the trusted Git read
 * boundary. Private linked writers cannot be mistaken for user-root writers. */
import type { AppState } from '@agora/core-domain';
import type { LocalDeliverySources } from './local-delivery-comparison-record';
import { readLocalDeliveryGitBaseline } from './local-delivery-git-baseline';
import { withLocalGitSession } from './local-git-session';
import type { LocalCodingBaselineOptions } from './local-git-workspaces';
import { type LocalClaimRecord, localRecordHash } from './local-registry-records';
import { localRootBinding } from './local-workspace-authority';

const metadataKey = (
  source: Pick<LocalDeliverySources, 'scope' | 'grantId' | 'grantRevision'>,
  sourceReceiptId: string,
) => localRecordHash({ kind: 'delivery-git-current', ...source, sourceReceiptId });

export async function readLocalDeliveryGitCurrent(
  options: LocalCodingBaselineOptions,
  input: { projectId: string; taskId: string },
  verifyClosedClaim?: (
    scope: { projectId: string; taskId: string },
    claim: LocalClaimRecord,
  ) => Promise<string>,
) {
  const scope = structuredClone(input);
  const state = await options.control.assertClosed(scope);
  const registry = await options.control.snapshot();
  const { root, grant } = await readLocalDeliveryGitBaseline(options, scope);
  // Conservatively require closure for retained direct claims, including
  // private repair writers. Linked claims occupy separate registered roots.
  const retained = registry.claims.filter(
    (claim) =>
      claim.status !== 'released' &&
      registry.workspaces.some(
        (workspace) =>
          workspace.workspaceId === claim.workspaceId &&
          workspace.projectId === claim.projectId &&
          workspace.mode === 'direct' &&
          registry.roots.some(
            (other) =>
              other.projectId === workspace.projectId &&
              other.rootId === workspace.rootId &&
              other.volumeId === root.volumeId &&
              other.dev === root.dev &&
              other.inode === root.inode,
          ),
      ),
  );
  if (
    retained.some(
      (claim) =>
        claim.projectId !== scope.projectId ||
        claim.taskId !== scope.taskId ||
        claim.status !== 'active' ||
        claim.kind !== undefined,
    ) ||
    (retained.length > 0 && !verifyClosedClaim)
  )
    throw Error('delivery_user_root_busy');
  const authorize = async () => {
    await options.verifyGrant(scope, grant.grantId);
    for (const claim of retained) {
      if (!verifyClosedClaim) throw Error('delivery_user_root_busy');
      await verifyClosedClaim(scope, claim);
    }
    if (
      localRecordHash(await options.control.assertClosed(scope)) !== localRecordHash(state) ||
      localRecordHash(await options.control.snapshot()) !== localRecordHash(registry)
    )
      throw Error('delivery_git_source_changed');
    return true;
  };
  await authorize();
  const versionScope = { ...scope, rootId: root.rootId, policyHash: grant.policyHash };
  return withLocalGitSession(
    {
      ...options.gitOptions,
      ...scope,
      root: root.path,
      actionId: `delivery-current:${localRecordHash(scope)}`,
      authorize,
    },
    async (session) => {
      await session.check();
      const version = await options.versions.capture(
        versionScope,
        localRootBinding(root),
        authorize,
      );
      if (version.kind !== 'files') throw Error('invalid_workspace_version');
      await session.check();
      const current = {
        scope: versionScope,
        version,
        grantId: grant.grantId,
        grantRevision: grant.revision,
        targetIndexHash: session.sourceHead.indexHash,
        sourceReceiptId: `git-current:${localRecordHash({ version, userStateHash: session.initialUserState })}`,
      };
      const reference = metadataKey(
        { scope: versionScope, grantId: grant.grantId, grantRevision: grant.revision },
        current.sourceReceiptId,
      );
      await options.objects.bindReference(
        reference,
        await options.objects.put({
          schemaVersion: 'delivery-git-current-v1',
          ...current,
          userStateHash: session.initialUserState,
        }),
      );
      await session.check();
      return current;
    },
  );
}

/** Reprove metadata only. A delivery transaction separately proves the changing
 * source bytes; recapturing U here would reject legitimate partial progress. */
export async function verifyLocalDeliveryGitMetadata(
  options: LocalCodingBaselineOptions,
  state: AppState,
  source: LocalDeliverySources,
): Promise<void> {
  const scope = { projectId: state.projectId, taskId: state.taskId };
  const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
  if (!state.localExecution?.git || !same(await options.control.assertClosed(scope), state))
    throw Error('delivery_git_source_changed');
  const registry = await options.control.snapshot();
  const { root, grant } = await readLocalDeliveryGitBaseline(options, scope);
  const versionScope = { ...scope, rootId: root.rootId, policyHash: grant.policyHash };
  if (
    !same(source.scope, versionScope) ||
    source.grantId !== grant.grantId ||
    source.grantRevision !== grant.revision
  )
    throw Error('delivery_git_metadata_proof_invalid');
  const reference = metadataKey(
    { scope: source.scope, grantId: source.grantId, grantRevision: source.grantRevision },
    source.sourceReceipts.current,
  );
  const valueHash = await options.objects.getReference(reference);
  if (!valueHash) throw Error('delivery_git_metadata_proof_missing');
  const saved = (await options.objects.get(valueHash)) as { userStateHash?: unknown };
  if (
    !saved ||
    typeof saved.userStateHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(saved.userStateHash) ||
    source.sourceReceipts.current !==
      `git-current:${localRecordHash({ version: source.current, userStateHash: saved.userStateHash })}` ||
    !same(saved, {
      schemaVersion: 'delivery-git-current-v1',
      scope: source.scope,
      version: source.current,
      grantId: source.grantId,
      grantRevision: source.grantRevision,
      targetIndexHash: source.targetIndexHash,
      sourceReceiptId: source.sourceReceipts.current,
      userStateHash: saved.userStateHash,
    })
  )
    throw Error('delivery_git_metadata_proof_invalid');
  const authorize = async () => {
    await options.verifyGrant(scope, grant.grantId);
    if (
      !same(await options.control.assertClosed(scope), state) ||
      !same(await options.control.snapshot(), registry)
    )
      throw Error('delivery_git_source_changed');
    return true;
  };
  await withLocalGitSession(
    {
      ...options.gitOptions,
      ...scope,
      root: root.path,
      actionId: `delivery-metadata:${localRecordHash(scope)}`,
      authorize,
    },
    async (session) => {
      await session.check();
      if (
        session.initialUserState !== saved.userStateHash ||
        session.sourceHead.indexHash !== source.targetIndexHash
      )
        throw Error('delivery_git_metadata_changed');
    },
  );
  await authorize();
}
