/** Immutable dependency snapshots are composed with fixed source bytes. The
 * writable install tree is never reused as a validation input. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { inspectLocalFileBytes, inspectLocalRoot } from './local-file-transaction';
import type { LocalFixedInput, LocalFixedInputs } from './local-fixed-inputs';
import type { LocalPackagePlan } from './local-installation-command';
import { localRecordHash } from './local-registry-records';
import type {
  LocalFileManifest,
  LocalVersionScope,
  LocalVersionStore,
} from './local-version-store';
import type { WorkspaceCommandResult } from './workspace-port';

const selectionKey = (
  scope: LocalVersionScope,
  version: WorkspaceVersionV1,
  toolchainHash: string,
) => localRecordHash({ kind: 'local-installation-selection-v1', scope, version, toolchainHash });
const commandKey = (receiptId: string) =>
  localRecordHash({ kind: 'local-command-dependency-input-v1', receiptId });
type Installation = {
  schemaVersion: 'local-installation-v1';
  scope: LocalVersionScope;
  sourceVersion: WorkspaceVersionV1;
  toolchainHash: string;
  receiptId: string;
  commandHash: string;
  workspaceId: string;
  dependencyVersion: WorkspaceVersionV1;
  fixed: LocalFixedInput;
  lockContentRef: string;
  plan: LocalPackagePlan;
};
type Attachment = {
  schemaVersion: 'local-command-dependency-input-v1';
  receiptId: string;
  sourceVersion: WorkspaceVersionV1;
  installationHash: string;
  fixed: LocalFixedInput;
};
export class LocalDependencyInputs {
  constructor(
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
    private readonly inputs: LocalFixedInputs,
    private readonly helper: string,
  ) {}
  async capture(
    scope: LocalVersionScope,
    command: WorkspaceCommandResult,
    outputRoot: string,
    plan: LocalPackagePlan,
    toolchainHash: string,
    current: () => Promise<boolean>,
  ) {
    if (command.stage !== 'exited' || command.exitCode !== 0 || !command.quiescent)
      throw Error('installation_incomplete');
    const saved = await this.objects.getReference(
      selectionKey(scope, command.inputVersion, toolchainHash),
    );
    if (saved) {
      const old = await this.read(saved, scope, command.inputVersion, toolchainHash, current);
      if (old.receiptId !== command.receiptId || old.commandHash !== localRecordHash(command))
        throw Error('installation_already_selected');
      return saved;
    }
    if (!(await current())) throw Error('authorization_closed');
    // Exclusive technical directories reject package-created substitutes.
    await mkdir(join(outputRoot, '.agora-operations'), { mode: 0o700 });
    const outputBinding = inspectLocalRoot(outputRoot);
    const lock = inspectLocalFileBytes(outputBinding, 'project/pnpm-lock.yaml', this.helper);
    const root = join(outputRoot, 'project/node_modules');
    await mkdir(join(root, '.agora-operations'), { mode: 0o700 });
    const binding = inspectLocalRoot(root);
    const dependencyVersion = await this.versions.capture(scope, binding, current);
    const manifest = await this.versions.read(dependencyVersion, scope);
    if (manifest.excludedPaths.some((p) => p !== '.agora-operations'))
      throw Error('unsupported_dependency_entry');
    const fixed = await this.inputs.materialize(
      scope,
      dependencyVersion,
      `installed:${command.receiptId.slice(4)}`,
      current,
    );
    const receipt: Installation = {
      schemaVersion: 'local-installation-v1',
      scope,
      sourceVersion: command.inputVersion,
      toolchainHash,
      receiptId: command.receiptId,
      commandHash: localRecordHash(command),
      workspaceId: command.workspaceId,
      dependencyVersion,
      fixed,
      lockContentRef: await this.objects.putBytes(lock.content),
      plan,
    };
    const hash = await this.objects.put(receipt);
    if (!(await current())) throw Error('authorization_closed');
    await this.objects.bindReference(
      selectionKey(scope, command.inputVersion, toolchainHash),
      hash,
    );
    return hash;
  }
  private async read(
    hash: string,
    scope: LocalVersionScope,
    sourceVersion: WorkspaceVersionV1,
    toolchainHash: string,
    current: () => Promise<boolean>,
  ) {
    const receipt = (await this.objects.get(hash)) as Installation;
    if (
      receipt?.schemaVersion !== 'local-installation-v1' ||
      localRecordHash(receipt.scope) !== localRecordHash(scope) ||
      localRecordHash(receipt.sourceVersion) !== localRecordHash(sourceVersion) ||
      receipt.toolchainHash !== toolchainHash
    )
      throw Error('invalid_installation_receipt');
    await this.inputs.verify(receipt.fixed, scope, receipt.dependencyVersion, current);
    await this.objects.getBytes(receipt.lockContentRef);
    return receipt;
  }
  async prepare(
    scope: LocalVersionScope,
    version: WorkspaceVersionV1,
    receiptId: string,
    toolchainHash: string,
    current: () => Promise<boolean>,
    verifyInstall: (id: string, workspaceId: string) => Promise<WorkspaceCommandResult>,
  ) {
    const source = await this.versions.read(version, scope);
    if (
      source.directories.find((d) => d.path === '')?.entries.some((e) => e.name === 'node_modules')
    )
      throw Error('source_dependency_directory_unsupported');
    const pkg = source.files.find((f) => f.path === 'package.json');
    const json = pkg
      ? JSON.parse((await this.objects.getBytes(pkg.contentHash)).toString('utf8'))
      : {};
    const required = [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ].some((f) => json[f] && Object.keys(json[f]).length > 0);
    const hash = await this.objects.getReference(selectionKey(scope, version, toolchainHash));
    if (!hash) {
      if (required) throw Error('workspace_dependencies_required');
      return null;
    }
    const installation = await this.read(hash, scope, version, toolchainHash, current);
    if (
      localRecordHash(await verifyInstall(installation.receiptId, installation.workspaceId)) !==
      installation.commandHash
    )
      throw Error('invalid_installation_receipt');
    const dependencies = await this.versions.read(installation.dependencyVersion, scope);
    const combined: LocalFileManifest = structuredClone(source);
    const root = combined.directories.find((d) => d.path === '');
    if (!root) throw Error('invalid_workspace_version');
    root.entries.push({ name: 'node_modules', kind: 'directory' });
    combined.directories.push(
      ...dependencies.directories.map((d) => ({
        ...structuredClone(d),
        path: d.path ? `node_modules/${d.path}` : 'node_modules',
      })),
    );
    combined.files.push(
      ...dependencies.files.map((f) => ({ ...structuredClone(f), path: `node_modules/${f.path}` })),
    );
    combined.excludedPaths.push(...dependencies.excludedPaths.map((p) => `node_modules/${p}`));
    combined.excludedPaths.sort();
    const manifestHash = await this.objects.put(combined);
    const derived: WorkspaceVersionV1 = {
      kind: 'files',
      manifestId: `manifest:${manifestHash}`,
      manifestHash,
    };
    const fixed = await this.inputs.materialize(
      scope,
      derived,
      `dependencies:${receiptId.slice(4)}`,
      current,
    );
    const attachment: Attachment = {
      schemaVersion: 'local-command-dependency-input-v1',
      receiptId,
      sourceVersion: version,
      installationHash: hash,
      fixed,
    };
    await this.objects.bindReference(commandKey(receiptId), await this.objects.put(attachment));
    return fixed;
  }
  async verify(
    command: WorkspaceCommandResult,
    toolchainHash: string,
    verifyInstall: (id: string, workspaceId: string) => Promise<WorkspaceCommandResult>,
  ) {
    const hash = await this.objects.getReference(commandKey(command.receiptId));
    if (!hash) return null;
    const fact = (await this.objects.get(hash)) as Attachment;
    if (
      fact?.schemaVersion !== 'local-command-dependency-input-v1' ||
      fact.receiptId !== command.receiptId ||
      localRecordHash(fact.sourceVersion) !== localRecordHash(command.inputVersion)
    )
      throw Error('invalid_dependency_attachment');
    const installed = await this.read(
      fact.installationHash,
      fact.fixed.scope,
      command.inputVersion,
      toolchainHash,
      async () => true,
    );
    if (
      installed.receiptId === command.receiptId ||
      localRecordHash(await verifyInstall(installed.receiptId, installed.workspaceId)) !==
        installed.commandHash
    )
      throw Error('invalid_installation_receipt');
    await this.inputs.verify(fact.fixed, fact.fixed.scope, fact.fixed.version, async () => true);
    return hash;
  }
}
