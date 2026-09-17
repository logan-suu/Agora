/** Bound tool adapter. Private immutable inputs are translated into versioned
 * service calls; the model never receives root paths or authority constructors. */
import type { WorkspaceCall } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { localRecordHash } from './local-registry-records';
import { type LocalVersionStore, localSnapshotVersion } from './local-version-store';
import type { LocalWorkspaceApply } from './local-workspace-apply';
import type { LocalWorkspaceAuthority } from './local-workspace-authority';
import type { LocalWorkspaceCommands } from './local-workspace-commands';
import type { LocalWorkspaceFiles } from './local-workspace-files';
import { serializeWorkspaceOperation } from './local-workspace-operation';
import type { BoundWorkspaceTools, WorkspaceInspection } from './workspace-port';

export function bindLocalWorkspaceTools(options: {
  call(actionId: string): WorkspaceCall;
  authority: LocalWorkspaceAuthority;
  objects: LocalControlObjects;
  versions: LocalVersionStore;
  files: LocalWorkspaceFiles;
  writer: LocalWorkspaceApply;
  commands?: LocalWorkspaceCommands;
}): BoundWorkspaceTools {
  const { authority, objects, versions, files, writer } = options;
  const call = (actionId: string) => {
    if (!/^tool:[a-f0-9]{64}$/.test(actionId)) throw Error('invalid_workspace_action');
    const value = structuredClone(options.call(actionId));
    if (value.actionId !== actionId) throw Error('workspace_action_mismatch');
    return value;
  };
  return {
    async generated(actionId, receiptId, path) {
      if (!options.commands) throw Error('workspace_generation_unavailable');
      return options.commands.readGenerated(call(actionId), receiptId, path);
    },
    async inspect(actionId) {
      const scope = call(actionId);
      return serializeWorkspaceOperation(scope, async () => {
        await writer.assertQuiescent(scope);
        const admitted = await authority.assertCall(scope, 'read');
        const key = localRecordHash({
          kind: 'workspace-file-action',
          projectId: scope.projectId,
          taskId: scope.taskId,
          actionId,
        });
        const inputHash = localRecordHash({
          scope,
          binding: admitted.binding,
          canonicalSourceRef: admitted.sourceReceiptId,
        });
        const savedHash = await objects.getReference(key);
        const versionScope = {
          projectId: scope.projectId,
          taskId: scope.taskId,
          rootId: admitted.root.rootId,
          policyHash: admitted.grant.policyHash,
        };
        if (savedHash) {
          const saved = (await objects.get(savedHash)) as {
            schemaVersion: string;
            inputHash: string;
            result: WorkspaceInspection;
          };
          if (
            saved.schemaVersion !== 'workspace-tool-inspection-v1' ||
            saved.inputHash !== inputHash
          )
            throw Error('operation_conflict');
          const manifest = await versions.read(saved.result.version, versionScope);
          const result = {
            version: saved.result.version,
            files: manifest.files.map(({ path, version }) => ({ path, version })),
            excludedPaths: manifest.excludedPaths,
          };
          if (localRecordHash(result) !== localRecordHash(saved.result))
            throw Error('invalid_workspace_inspection');
          await authority.assertCall(scope, 'read');
          return result;
        }
        const version =
          admitted.workspace.purpose === 'validation'
            ? localSnapshotVersion(admitted.workspace)
            : await versions.capture(versionScope, admitted.binding, async () => {
                const current = await authority.assertCall(scope, 'read');
                return (
                  localRecordHash(current.binding) === localRecordHash(admitted.binding) &&
                  current.sourceReceiptId === admitted.sourceReceiptId
                );
              });
        const manifest = await versions.read(version, versionScope);
        if (manifest.bindingHash !== localRecordHash(admitted.binding))
          throw Error('invalid_workspace_version');
        const result = {
          version,
          files: manifest.files.map(({ path, version }) => ({ path, version })),
          excludedPaths: manifest.excludedPaths,
        };
        await objects.bindReference(
          key,
          await objects.put({ schemaVersion: 'workspace-tool-inspection-v1', inputHash, result }),
        );
        await authority.assertCall(scope, 'read');
        return result;
      });
    },
    async read(actionId, path) {
      return files.readFile(call(actionId), path);
    },
    async apply(actionId, changes, dependencies) {
      const scope = call(actionId);
      // Copy and validate all bytes before the first side effect or await.
      if (!changes.length || changes.length > 64 || dependencies.length > 64)
        throw Error('invalid_workspace_changes');
      const entries = structuredClone([...changes]);
      const readSet = structuredClone([...dependencies]);
      const bytes = entries.map((change) => {
        if (!['utf8', 'base64'].includes(change.encoding)) throw Error('invalid_workspace_content');
        const value = Buffer.from(change.content, change.encoding);
        if (change.encoding === 'base64' && value.toString('base64') !== change.content)
          throw Error('invalid_workspace_content');
        if (change.encoding === 'utf8' && value.toString('utf8') !== change.content)
          throw Error('invalid_workspace_content');
        return value;
      });
      if (bytes.reduce((n, value) => n + value.length, 0) > 1024 * 1024)
        throw Error('workspace_tool_content_limit');
      const merged = [
        ...entries.map((change) => ({
          path: change.path,
          version: change.expected,
          readReceiptId: change.readReceiptId,
        })),
        ...readSet,
      ];
      if (new Set(merged.map((entry) => entry.path)).size !== merged.length || merged.length > 64)
        throw Error('invalid_workspace_read_set');
      const basis = await files.prepareReadSet(
        { ...scope, actionId: `toolbasis:${localRecordHash({ scope })}` },
        merged,
      );
      const prepared = [];
      for (const [index, entry] of entries.entries())
        prepared.push({
          op: 'put' as const,
          path: entry.path,
          expected: entry.expected,
          contentRef: await files.storeContent(scope, bytes[index] as Buffer),
        });
      return writer.applyFiles(scope, prepared, basis);
    },
    async run(actionId, request) {
      if (!options.commands) throw Error('workspace_command_unavailable');
      return options.commands.runCommand(call(actionId), request);
    },
  };
}
