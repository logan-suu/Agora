/** Fixed bytes plus an exact owned Git commit. This service never grants a lease. */
import { isGitObjectId, type WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { withLocalGitSession } from './local-git-session';
import {
  readOwnedLocalGitWorktree,
  verifyLocalGitTree,
  verifyOwnedLocalGitWorktree,
} from './local-git-worktree';
import { verifyLocalLinkedRoot } from './local-linked-root';
import { localRecordHash } from './local-registry-records';
import type { LocalGitManifest, LocalVersionScope, LocalVersionStore } from './local-version-store';

type Current = Parameters<typeof verifyLocalLinkedRoot>[0];
function snapshot(scope: LocalVersionScope, input: Current) {
  const { authorize, ...data } = input;
  localRecordHash({ scope, data });
  const current = { ...structuredClone(data), authorize };
  if (
    scope.projectId !== current.projectId ||
    scope.taskId !== current.taskId ||
    scope.rootId !== current.sourceRoot.rootId ||
    current.workspace.mode !== 'linked-worktree'
  )
    throw Error('workspace_version_scope_mismatch');
  return { scope: structuredClone(scope), current };
}
const binding = (current: Current) => ({
  root: current.record.path,
  chain: structuredClone(current.record.chain),
  stagingIdentity: current.record.staging.identity,
});

export class LocalGitVersionStore {
  constructor(
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
  ) {}

  private async proveTree(
    filesVersion: WorkspaceVersionV1,
    scope: LocalVersionScope,
    current: Current,
  ) {
    const manifest = await this.versions.read(filesVersion, scope);
    const files: { path: string; content: Buffer; executable: boolean }[] = [];
    for (const file of manifest.files)
      files.push({
        path: file.path,
        content: await this.objects.getBytes(file.contentHash),
        executable: file.version.executable,
      });
    return withLocalGitSession(current, async (session) => {
      const creation = readOwnedLocalGitWorktree(session, {
        ...current,
        workspaceId: current.workspace.workspaceId,
        gitHash: current.git.sha256,
      });
      await verifyOwnedLocalGitWorktree(session, creation, current.expectedHead);
      await verifyLocalGitTree(session, current.expectedHead, files);
      const tree = await session.run(['rev-parse', '--verify', `${current.expectedHead}^{tree}`]);
      if (!isGitObjectId(tree)) throw Error('local_git_tree_mismatch');
      await verifyOwnedLocalGitWorktree(session, creation, current.expectedHead);
      return tree;
    });
  }

  async capture(inputScope: LocalVersionScope, input: Current): Promise<WorkspaceVersionV1> {
    const { scope, current } = snapshot(inputScope, input);
    await verifyLocalLinkedRoot(current);
    const filesVersion = await this.versions.capture(scope, binding(current), current.authorize);
    if (filesVersion.kind !== 'files' || current.workspace.mode !== 'linked-worktree')
      throw Error('invalid_workspace_version');
    const tree = await this.proveTree(filesVersion, scope, current);
    const manifest: LocalGitManifest = {
      ...scope,
      schemaVersion: 'local-git-manifest-v1',
      filesVersion,
      workspaceId: current.workspace.workspaceId,
      physicalHash: localRecordHash(current.record),
      commonDirId: current.workspace.commonDirId,
      branch: current.workspace.branch,
      commit: current.expectedHead,
      tree,
    };
    const hash = await this.objects.put(manifest);
    const version: WorkspaceVersionV1 = {
      kind: 'git',
      commit: current.expectedHead,
      manifestId: `manifest:${hash}`,
      manifestHash: hash,
    };
    await this.verify(version, scope, current);
    return version;
  }

  async verify(
    inputVersion: WorkspaceVersionV1,
    inputScope: LocalVersionScope,
    input: Current,
  ): Promise<void> {
    const version = structuredClone(inputVersion);
    const { scope, current } = snapshot(inputScope, input);
    const manifest = await this.versions.readGitManifest(version, scope);
    if (
      current.workspace.mode !== 'linked-worktree' ||
      manifest.commit !== current.expectedHead ||
      manifest.workspaceId !== current.workspace.workspaceId ||
      manifest.physicalHash !== localRecordHash(current.record) ||
      manifest.commonDirId !== current.workspace.commonDirId ||
      manifest.branch !== current.workspace.branch
    )
      throw Error('workspace_version_scope_mismatch');
    await verifyLocalLinkedRoot(current);
    await this.versions.verify(manifest.filesVersion, scope, binding(current), current.authorize);
    if ((await this.proveTree(manifest.filesVersion, scope, current)) !== manifest.tree)
      throw Error('local_git_tree_mismatch');
    await this.versions.verify(manifest.filesVersion, scope, binding(current), current.authorize);
    await verifyLocalLinkedRoot(current);
  }
}
