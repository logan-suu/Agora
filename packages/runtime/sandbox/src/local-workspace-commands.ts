import type { WorkspaceCommandReceipt, WorkspaceCommandResult } from './workspace-port';

export type { WorkspaceCommandReceipt, WorkspaceCommandResult } from './workspace-port';

import type { WorkspaceCommandRequest } from './workspace-port';

export type { WorkspaceCommandRequest } from './workspace-port';

/** Trusted Node command port. Commands read a fixed input tree, write a fresh
 * private output tree, and never receive the live project or credential domains. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isWorkspaceCall, isWorkspaceVersionV1, type WorkspaceCall } from '@agora/core-domain';
import { type LocalCommandAuthority, LocalCommandBinding } from './local-command-binding';
import { LocalCommandJournal } from './local-command-journal';
import { buildLocalCommandPolicy } from './local-command-policy';
import { runHeldLocalCommand } from './local-command-start';
import type { LocalControlObjects } from './local-control-objects';
import { LocalDependencyInputs } from './local-dependency-inputs';
import {
  inspectLocalFileBytes,
  inspectLocalRoot,
  type LocalRootBinding,
} from './local-file-transaction';
import type { LocalFixedInput, LocalFixedInputs } from './local-fixed-inputs';
import { localGenerationArguments } from './local-generation-command';
import { type LocalGrantPolicy, validateLocalGrantPolicy } from './local-grant-policy';
import {
  checkLocalPackageManifest,
  localInstallationArguments,
  type ManagedPnpm,
  parseLocalPackagePlan,
  verifyManagedPnpm,
} from './local-installation-command';
import type { LocalRegistryOwner } from './local-registry-file';
import { localRecordHash } from './local-registry-records';
import type { LocalVersionStore } from './local-version-store';
import type { LocalWorkspaceApply } from './local-workspace-apply';
import type { LocalWorkspaceAuthority } from './local-workspace-authority';
import { workspaceFileActionKey } from './local-workspace-batch';
import {
  LocalWorkspaceDownloads,
  type WorkspaceDownloadReceipt,
} from './local-workspace-downloads';
import { serializeWorkspaceOperation } from './local-workspace-operation';

type Binary = { path: string; sha256: string };
export type LocalCommandTools = {
  manifestHash: string;
  node: Binary & { version: string };
  bootstrap: Binary;
  processControl: Binary;
  pnpm?: ManagedPnpm;
};
type Prepared = {
  schemaVersion: 'workspace-command-prepared-v1';
  call: WorkspaceCall;
  request: WorkspaceCommandRequest;
  inputHash: string;
  canonicalSourceRef: string;
  authorityHash: string;
  dependencyInputHash: string | null;
};
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const resultKey = (key: string) => localRecordHash({ key, phase: 'command-result' });
const invalidationKey = (key: string) => localRecordHash({ key, phase: 'command-invalidation' });
const authorityValue = (
  call: WorkspaceCall,
  admitted: Awaited<ReturnType<LocalWorkspaceAuthority['assertCall']>>,
): LocalCommandAuthority => ({
  projectId: call.projectId,
  taskId: call.taskId,
  workspaceId: call.workspaceId,
  workerId: call.workerId,
  rootId: admitted.root.rootId,
  grantId: admitted.grant.grantId,
  grantRevision: call.grantRevision,
  writerEpoch: call.writerEpoch,
  policyVersion: admitted.grant.policyVersion,
  grantHash: localRecordHash(admitted.grant),
  toolchainHash: admitted.grant.toolchainHash,
  networkHash: admitted.grant.networkHash,
});
function validRequest(value: WorkspaceCommandRequest) {
  return (
    value &&
    Object.keys(value).sort().join(',') ===
      'argv,inputVersion,networkGrantId,outputRoot,timeoutMs,toolId' &&
    ['node', 'node-generate', 'pnpm-install'].includes(value.toolId) &&
    Array.isArray(value.argv) &&
    value.argv.length > 0 &&
    value.argv.length <= 256 &&
    value.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0')) &&
    Buffer.byteLength(JSON.stringify(value.argv)) <= 65536 &&
    isWorkspaceVersionV1(value.inputVersion) &&
    value.inputVersion.kind === 'files' &&
    value.outputRoot === 'private-per-operation' &&
    value.networkGrantId === null &&
    Number.isInteger(value.timeoutMs) &&
    value.timeoutMs >= 1 &&
    value.timeoutMs <= 30000
  );
}
function localNodeArguments(inputRoot: string, outputRoot: string, argv: string[]): string[] {
  return argv.map((arg) => {
    const match = /^@(input|output)\/(.*)$/.exec(arg);
    if (!match) return arg;
    const path = match[2];
    if (
      !path ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw Error('invalid_command_argument');
    return join(match[1] === 'input' ? inputRoot : outputRoot, path);
  });
}
async function directory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw Error('command_control_root_changed');
  return `${stat.dev}:${stat.ino}`;
}
export class LocalWorkspaceCommands {
  private dependencyInputs() {
    if (!this.filesHelper) throw Error('workspace_dependencies_unavailable');
    return new LocalDependencyInputs(this.objects, this.versions, this.inputs, this.filesHelper);
  }
  private async packageInputs(key: string) {
    const hash = await this.objects.getReference(localRecordHash({ key, phase: 'package-inputs' }));
    const root = join(this.roots.dependencies, key);
    await directory(root);
    if (!hash) {
      if ((await readdir(root)).length) throw Error('command_dependencies_changed');
      return;
    }
    const files = (await this.objects.get(hash)) as { name: string; contentRef: string }[];
    if (
      !Array.isArray(files) ||
      files.length > 32 ||
      localRecordHash((await readdir(root)).sort()) !==
        localRecordHash(files.map((f) => f.name).sort())
    )
      throw Error('command_dependencies_changed');
    for (const [i, f] of files.entries()) {
      const p = join(root, f.name),
        stat = await lstat(p);
      if (
        f.name !== `${i}.tgz` ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o400 ||
        !(await readFile(p)).equals(await this.objects.getBytes(f.contentRef))
      )
        throw Error('command_dependencies_changed');
    }
  }

  private constructor(
    private readonly owner: LocalRegistryOwner,
    private readonly authority: LocalWorkspaceAuthority,
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
    private readonly inputs: LocalFixedInputs,
    private readonly files: LocalWorkspaceApply,
    private readonly tools: LocalCommandTools,
    private readonly journal: LocalCommandJournal,
    private readonly roots: { outputs: string; dependencies: string; journal: string },
    private readonly identities: string[],
    private readonly filesHelper?: string,
  ) {}
  static async open(
    owner: LocalRegistryOwner,
    authority: LocalWorkspaceAuthority,
    objects: LocalControlObjects,
    versions: LocalVersionStore,
    inputs: LocalFixedInputs,
    files: LocalWorkspaceApply,
    tools: LocalCommandTools,
    filesHelper?: string,
  ) {
    localRecordHash(tools);
    tools = structuredClone(tools);
    if (
      !/^[a-f0-9]{64}$/.test(tools.manifestHash) ||
      ![tools.node, tools.bootstrap, tools.processControl].every((tool) =>
        /^[a-f0-9]{64}$/.test(tool.sha256),
      ) ||
      !/^\d+\.\d+\.\d+$/.test(tools.node.version)
    )
      throw Error('invalid_command_tools');
    await owner.assertHeld();
    const roots = {
      outputs: join(owner.root, 'command-outputs'),
      dependencies: join(owner.root, 'command-dependencies'),
      journal: join(owner.root, 'command-journal'),
    };
    let newJournal = false;
    for (const [key, path] of Object.entries(roots)) {
      try {
        await mkdir(path, { mode: 0o700 });
        if (key === 'journal') newJournal = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const identities = await Promise.all(Object.values(roots).map(directory));
    const service = new LocalWorkspaceCommands(
      owner,
      authority,
      objects,
      versions,
      inputs,
      files,
      tools,
      new LocalCommandJournal(roots.journal, newJournal),
      roots,
      identities,
      filesHelper,
    );
    files.bindCommandGuard((call, allowed) => service.assertQuiescent(call, allowed));
    return service;
  }
  private async assertRoots() {
    await this.owner.assertHeld();
    const identities = await Promise.all(Object.values(this.roots).map(directory));
    if (localRecordHash(identities) !== localRecordHash(this.identities))
      throw Error('command_control_root_changed');
  }
  /** Recheck private immutable facts and the native journal without reviving
   * the completed worker lease or launching a command. */
  async verifyCommand(
    scope: { projectId: string; taskId: string; workspaceId: string },
    receiptId: string,
  ): Promise<{
    command: WorkspaceCommandResult;
    request: WorkspaceCommandRequest;
    toolchainHash: string;
    dependenciesHash: string;
  }> {
    if (!/^run:[a-f0-9]{64}$/.test(receiptId)) throw Error('invalid_command_receipt');
    await this.assertRoots();
    const key = receiptId.slice(4);
    const preparedHash = await this.objects.getReference(key);
    const receiptHash = await this.objects.getReference(resultKey(key));
    if (!preparedHash || !receiptHash) throw Error('workspace_command_recovery_required');
    const prepared = (await this.objects.get(preparedHash)) as Prepared;
    this.validatePrepared(prepared);
    if (
      workspaceFileActionKey(prepared.call) !== key ||
      prepared.call.projectId !== scope.projectId ||
      prepared.call.taskId !== scope.taskId ||
      prepared.call.workspaceId !== scope.workspaceId
    )
      throw Error('workspace_command_scope_mismatch');
    const command = await this.result(prepared, receiptHash);
    await this.packageInputs(key);
    if (
      prepared.request.toolId === 'pnpm-install' &&
      command.stage === 'exited' &&
      command.exitCode === 0 &&
      !(await this.objects.getReference(localRecordHash({ key, phase: 'installation-complete' })))
    )
      throw Error('installation_recovery_required');
    const attached = this.filesHelper
      ? await this.dependencyInputs().verify(
          command,
          localRecordHash({ manifestHash: this.tools.manifestHash }),
          async (id, workspaceId) =>
            (await this.verifyCommand({ ...scope, workspaceId }, id)).command,
        )
      : null;
    if (attached !== prepared.dependencyInputHash) throw Error('invalid_dependency_attachment');
    const dependenciesHash =
      attached ??
      (await this.objects.put({
        schemaVersion: 'empty-command-dependencies-v1',
        commandId: command.commandId,
        policyHash: command.policyHash,
        entries: [],
      }));
    return {
      command,
      request: structuredClone(prepared.request),
      toolchainHash: localRecordHash({ manifestHash: this.tools.manifestHash }),
      dependenciesHash,
    };
  }
  async readGenerated(call: WorkspaceCall, receiptId: string, path: string) {
    if (!this.filesHelper || !isWorkspaceCall(call) || !/^run:[a-f0-9]{64}$/.test(receiptId))
      throw Error('workspace_generation_unavailable');
    return serializeWorkspaceOperation(call, async () => {
      await this.files.assertQuiescent(call);
      const checked = await this.verifyCommand(call, receiptId);
      const action = checked.request.toolId === 'pnpm-install' ? 'install' : 'generate';
      const admitted = await this.authority.assertCall(call, action);
      const key = receiptId.slice(4);
      const preparedHash = await this.objects.getReference(key);
      if (!preparedHash) throw Error('workspace_command_recovery_required');
      const prepared = (await this.objects.get(preparedHash)) as Prepared;
      if (
        !['node-generate', 'pnpm-install'].includes(prepared.request.toolId) ||
        prepared.call.workerId !== call.workerId ||
        checked.command.stage !== 'exited' ||
        checked.command.exitCode !== 0 ||
        !checked.command.quiescent
      )
        throw Error('workspace_generation_incomplete');
      const current = async () => {
        const next = await this.authority.assertCall(call, action);
        return localRecordHash(next) === localRecordHash(admitted);
      };
      await this.versions.verify(
        checked.command.inputVersion,
        {
          projectId: call.projectId,
          taskId: call.taskId,
          rootId: admitted.root.rootId,
          policyHash: admitted.grant.policyHash,
        },
        admitted.binding,
        current,
      );
      const outputRoot = join(this.roots.outputs, key);
      const record = this.journal
        .snapshot()
        .records.find((r) => r.commandId === checked.command.commandId);
      if (
        (await directory(outputRoot)) !== record?.roots.find((r) => r.path === outputRoot)?.identity
      )
        throw Error('command_control_root_changed');
      const bindingKey = localRecordHash({ key, phase: 'generated-root' });
      const saved = await this.objects.getReference(bindingKey);
      let binding: LocalRootBinding;
      if (saved) binding = (await this.objects.get(saved)) as LocalRootBinding;
      else {
        if (prepared.request.toolId !== 'pnpm-install')
          await mkdir(join(outputRoot, '.agora-operations'), { mode: 0o700 });
        binding = inspectLocalRoot(outputRoot);
        await this.objects.bindReference(bindingKey, await this.objects.put(binding));
      }
      if (binding.root !== outputRoot) throw Error('invalid_generation_receipt');
      const result = inspectLocalFileBytes(binding, `project/${path}`, this.filesHelper as string);
      if (!(await current())) throw Error('authorization_closed');
      return {
        kind: 'generated' as const,
        inputVersion: checked.command.inputVersion,
        content: result.content,
      };
    });
  }
  async assertQuiescent(call: WorkspaceCall, allowed?: string) {
    await this.assertRoots();
    for (const ref of await this.objects.references()) {
      const value = (await this.objects.get(ref.valueHash)) as Prepared;
      if (value.schemaVersion !== 'workspace-command-prepared-v1') continue;
      this.validatePrepared(value);
      if (ref.key !== workspaceFileActionKey(value.call)) throw Error('invalid_command_receipt');
      if (
        ref.key === allowed ||
        value.call.projectId !== call.projectId ||
        value.call.taskId !== call.taskId ||
        value.call.workspaceId !== call.workspaceId
      )
        continue;
      const hash = await this.objects.getReference(resultKey(ref.key));
      if (!hash || !(await this.result(value, hash)).quiescent)
        throw Error('workspace_command_recovery_required');
      const closed = await this.result(value, hash);
      if (
        value.request.toolId === 'pnpm-install' &&
        closed.stage === 'exited' &&
        closed.exitCode === 0 &&
        !(await this.objects.getReference(
          localRecordHash({ key: ref.key, phase: 'installation-complete' }),
        ))
      )
        throw Error('installation_recovery_required');
    }
  }
  async runCommand(
    input: WorkspaceCall,
    inputRequest: WorkspaceCommandRequest,
  ): Promise<WorkspaceCommandResult> {
    localRecordHash({ input, inputRequest });
    if (!isWorkspaceCall(input) || !validRequest(inputRequest))
      throw Error('invalid_workspace_command');
    if (inputRequest.toolId === 'node') localNodeArguments('/input', '/output', inputRequest.argv);
    if (inputRequest.toolId === 'node-generate')
      localGenerationArguments('/input', '/output', inputRequest.argv);
    const call = structuredClone(input),
      request = structuredClone(inputRequest);
    let packages: WorkspaceDownloadReceipt[] | undefined;
    if (request.toolId === 'pnpm-install') {
      const plan = parseLocalPackagePlan(request.argv);
      if (!this.tools.pnpm || !this.filesHelper) throw Error('workspace_installation_unavailable');
      await verifyManagedPnpm(this.tools.pnpm, this.tools.manifestHash);
      const admitted = await this.authority.assertCall(call, 'install');
      const manifest = await this.versions.read(request.inputVersion, {
        projectId: call.projectId,
        taskId: call.taskId,
        rootId: admitted.root.rootId,
        policyHash: admitted.grant.policyHash,
      });
      const pkg = manifest.files.find((f) => f.path === 'package.json');
      if (
        !pkg ||
        manifest.directories.some((d) => d.path === 'node_modules') ||
        manifest.files.some((f) =>
          [
            'pnpm-lock.yaml',
            'package-lock.json',
            'yarn.lock',
            '.npmrc',
            'pnpm-workspace.yaml',
            '.pnpmfile.cjs',
            'pnpmfile.cjs',
          ].includes(f.path),
        )
      )
        throw Error('unsupported_installation_input');
      checkLocalPackageManifest(await this.objects.getBytes(pkg.contentHash), plan);
      const downloads = new LocalWorkspaceDownloads(
        this.authority,
        this.objects,
        this.versions,
        this.files,
      );
      packages = [];
      for (const [index, p] of plan.entries())
        packages.push(
          await downloads.download(
            { ...call, actionId: `download:${localRecordHash({ call, index })}` },
            { inputVersion: request.inputVersion, url: p.url, integrity: p.integrity },
          ),
        );
    }
    return serializeWorkspaceOperation(call, () => this.run(call, request, packages));
  }
  private async run(
    call: WorkspaceCall,
    request: WorkspaceCommandRequest,
    packages?: WorkspaceDownloadReceipt[],
  ): Promise<WorkspaceCommandResult> {
    const key = workspaceFileActionKey(call);
    await this.files.assertQuiescent(call, key);
    const action =
      request.toolId === 'pnpm-install'
        ? 'install'
        : request.toolId === 'node-generate'
          ? 'generate'
          : 'run';
    const admitted = await this.authority.assertCall(call, action),
      expected = authorityValue(call, admitted);
    if (
      admitted.workspace.purpose === 'validation' &&
      (admitted.workspace.mode !== 'direct' ||
        request.inputVersion.manifestId !== admitted.workspace.baselineManifestId)
    )
      throw Error('workspace_validation_input_changed');
    const grantPolicy = validateLocalGrantPolicy(
      (await this.objects.get(admitted.grant.policyHash)) as LocalGrantPolicy,
    );
    if (
      admitted.grant.toolchainHash !== localRecordHash({ manifestHash: this.tools.manifestHash }) ||
      admitted.grant.networkHash !== localRecordHash(grantPolicy.network)
    )
      throw Error('command_policy_mismatch');
    const current = async () => {
      await this.assertRoots();
      const checked = await this.authority.assertCall(call, action);
      return (
        localRecordHash(authorityValue(call, checked)) === localRecordHash(expected) &&
        localRecordHash(checked.binding) === localRecordHash(admitted.binding)
      );
    };
    const versionScope = {
      projectId: call.projectId,
      taskId: call.taskId,
      rootId: admitted.root.rootId,
      policyHash: admitted.grant.policyHash,
    };
    await this.versions.verify(request.inputVersion, versionScope, admitted.binding, current);
    if (!this.filesHelper) {
      const manifest = await this.versions.read(request.inputVersion, versionScope);
      if (
        manifest.files.some((f) => f.path === 'package.json') ||
        manifest.directories.some((d) => d.path === 'node_modules')
      )
        throw Error('workspace_dependencies_unavailable');
    }
    const attached =
      request.toolId === 'pnpm-install'
        ? null
        : this.filesHelper
          ? await this.dependencyInputs().prepare(
              versionScope,
              request.inputVersion,
              `run:${key}`,
              admitted.grant.toolchainHash,
              current,
              async (id, workspaceId) =>
                (await this.verifyCommand({ ...call, workspaceId }, id)).command,
            )
          : null;
    const dependencyInputHash =
      (await this.objects.getReference(
        localRecordHash({ kind: 'local-command-dependency-input-v1', receiptId: `run:${key}` }),
      )) ?? null;
    const inputHash = localRecordHash({
      call,
      request,
      tools: this.tools,
      authority: expected,
      dependencyInputHash,
    });
    const prepared: Prepared = {
      schemaVersion: 'workspace-command-prepared-v1',
      call,
      request,
      inputHash,
      canonicalSourceRef: admitted.sourceReceiptId,
      authorityHash: localRecordHash(expected),
      dependencyInputHash,
    };
    const previous = await this.objects.getReference(key);
    if (previous) {
      if (localRecordHash(await this.objects.get(previous)) !== localRecordHash(prepared))
        throw Error('operation_conflict');
      const hash = await this.objects.getReference(resultKey(key));
      if (!hash) throw Error('workspace_command_recovery_required');
      const result = await this.result(prepared, hash);
      await this.authority.assertCall(call, action);
      await this.verifyCommand(call, result.receiptId);
      return result;
    }
    await this.objects.bindReference(key, await this.objects.put(prepared));
    const fixed = await this.inputs.materialize(
      versionScope,
      request.inputVersion,
      `input:${key}`,
      current,
    );
    const outputRoot = join(this.roots.outputs, key),
      dependencies = join(this.roots.dependencies, key);
    await mkdir(outputRoot, { mode: 0o700 });
    await mkdir(dependencies, { mode: 0o700 });
    if (packages) {
      const files = [];
      for (const [i, p] of packages.entries()) {
        const name = `${i}.tgz`;
        await writeFile(join(dependencies, name), await this.objects.getBytes(p.contentRef), {
          flag: 'wx',
          mode: 0o400,
        });
        files.push({ name, contentRef: p.contentRef });
      }
      await this.objects.bindReference(
        localRecordHash({ key, phase: 'package-inputs' }),
        await this.objects.put(files),
      );
    }
    const executionInput = attached?.path ?? fixed.path;

    const deniedRoots: string[] = [];
    for (const name of await readdir(this.owner.root)) {
      if (['fixed-inputs', 'command-outputs', 'command-dependencies'].includes(name)) continue;
      const path = join(this.owner.root, name),
        stat = await lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) deniedRoots.push(path);
    }
    const policy = buildLocalCommandPolicy({
      executable: this.tools.node.path,
      bootstrap: this.tools.bootstrap.path,
      sourceRoot: fixed.path,
      inputRoot: attached?.path ?? dependencies,
      ...(request.toolId === 'pnpm-install' && this.tools.pnpm
        ? { toolRoots: [this.tools.pnpm.root] }
        : {}),
      outputRoot,
      deniedRoots,
    });
    const argv =
      request.toolId === 'pnpm-install' && this.tools.pnpm
        ? localInstallationArguments(
            fixed.path,
            outputRoot,
            dependencies,
            this.tools.pnpm,
            parseLocalPackagePlan(request.argv),
            this.tools.node.path,
          )
        : request.toolId === 'node-generate'
          ? localGenerationArguments(executionInput, outputRoot, request.argv)
          : localNodeArguments(executionInput, outputRoot, request.argv);
    const commandId = `command:${key}`,
      invocation = {
        commandId,
        bootstrap: this.tools.bootstrap.path,
        executable: this.tools.node.path,
        helper: this.tools.processControl.path,
        argv,
        policy,
        outputRoot,
      };
    if (!(await current())) throw Error('authorization_closed');
    const binding = new LocalCommandBinding(
      invocation,
      [
        admitted.root.path,
        fixed.path,
        dependencies,
        outputRoot,
        this.roots.journal,
        ...(attached ? [attached.path] : []),
        ...(request.toolId === 'pnpm-install' && this.tools.pnpm ? [this.tools.pnpm.root] : []),
      ],
      expected,
      () => expected,
    );
    const bound = binding.snapshot();
    if (
      bound.tools[0]?.sha256 !== this.tools.bootstrap.sha256 ||
      bound.tools[1]?.sha256 !== this.tools.node.sha256 ||
      bound.tools[2]?.sha256 !== this.tools.processControl.sha256
    )
      throw Error('toolchain_identity_mismatch');
    const reservation = this.journal.reserve({
      commandId,
      workspaceId: call.workspaceId,
      policyHash: sha(policy),
      inputHash,
      roots: [outputRoot],
    });
    const startedAt = Date.now();
    const result = await runHeldLocalCommand({
      ...invocation,
      binding,
      journal: this.journal,
      revision: reservation.revision,
      timeoutMs: request.timeoutMs,
      authorize: () => true,
      authorizeCurrent: current,
    });
    const observation = result.observation;
    let qualified = false;
    let qualificationFailure: WorkspaceCommandReceipt['reason'] = 'authority_changed';
    try {
      if (!(await current())) throw Error('authorization_closed');
      qualificationFailure = 'fixed_input_changed';
      await this.inputs.verify(fixed, versionScope, request.inputVersion, current);
      if (attached) await this.inputs.verify(attached, versionScope, attached.version, current);
      await this.packageInputs(key);
      if (request.toolId === 'pnpm-install' && this.tools.pnpm)
        await verifyManagedPnpm(this.tools.pnpm, this.tools.manifestHash);
      qualificationFailure = 'source_version_changed';
      await this.versions.verify(request.inputVersion, versionScope, admitted.binding, current);
      qualified = true;
      qualificationFailure = 'none';
    } catch {
      /* Preserve the real exit, but do not qualify stale input or authority. */
    }
    const quiescent =
      qualified &&
      result.launchDurable &&
      observation?.durable === true &&
      observation.bindingFailure === null &&
      !observation.discoveryFailed &&
      observation.stop.registeredState === 'stopped' &&
      observation.output.stdout.error === null &&
      observation.output.stderr.error === null &&
      !observation.output.stdout.truncated &&
      !observation.output.stderr.truncated;
    const timedOut = observation?.cause === 'timeout';
    const stage =
      quiescent && timedOut
        ? 'timedOut'
        : quiescent &&
            result.error === null &&
            result.payloadResult?.exitCode !== null &&
            result.payloadResult !== null
          ? 'exited'
          : 'needsAttention';
    const record = this.journal.snapshot().records.find((entry) => entry.commandId === commandId);
    if (!record) throw Error('workspace_command_recovery_required');
    const receipt: WorkspaceCommandReceipt = {
      ...call,
      schemaVersion: 'workspace-command-receipt-v1',
      receiptId: `run:${key}`,
      commandId,
      inputHash,
      canonicalSourceRef: admitted.sourceReceiptId,
      inputVersion: request.inputVersion,
      policyHash: sha(policy),
      toolVersion: this.tools.node.version,
      stage,
      createdAt: Date.now(),
      startedAt,
      finishedAt: Date.now(),
      exitCode: result.payloadResult?.exitCode ?? null,
      timedOut,
      quiescent: quiescent && stage !== 'needsAttention',
      assurance: 'bounded',
      reason:
        stage !== 'needsAttention'
          ? 'none'
          : !qualified
            ? qualificationFailure
            : !result.launchDurable || result.error !== null
              ? 'launch_failed'
              : observation?.output.stdout.truncated ||
                  observation?.output.stderr.truncated ||
                  observation?.output.stdout.error ||
                  observation?.output.stderr.error
                ? 'output_incomplete'
                : 'cleanup_incomplete',
      stdoutRef: await this.objects.putBytes(observation?.output.stdout.bytes ?? Buffer.alloc(0)),
      stderrRef: await this.objects.putBytes(observation?.output.stderr.bytes ?? Buffer.alloc(0)),
      nativeRecordHash: await this.objects.put(record),
      fixedInputHash: await this.objects.put(fixed),
    };
    const hash = await this.objects.put(receipt);
    await this.objects.bindReference(resultKey(key), hash);
    if (receipt.quiescent) {
      let valid = false;
      try {
        valid = await current();
      } catch {
        /* Current proof is mandatory. */
      }
      if (!valid) {
        await this.objects.bindReference(
          invalidationKey(key),
          await this.objects.put({
            schemaVersion: 'workspace-command-invalidation-v1',
            receiptHash: hash,
            reason: 'authority_or_root_changed',
          }),
        );
        throw Error('workspace_command_recovery_required');
      }
    }
    const completed = {
      ...receipt,
      stdout: observation?.output.stdout.bytes.toString('utf8') ?? '',
      stderr: observation?.output.stderr.bytes.toString('utf8') ?? '',
    };
    if (
      request.toolId === 'pnpm-install' &&
      completed.stage === 'exited' &&
      completed.exitCode === 0
    ) {
      const installed = await this.dependencyInputs().capture(
        versionScope,
        completed,
        outputRoot,
        parseLocalPackagePlan(request.argv),
        admitted.grant.toolchainHash,
        current,
      );
      await this.objects.bindReference(
        localRecordHash({ key, phase: 'installation-complete' }),
        installed,
      );
    }
    return completed;
  }
  private validatePrepared(value: Prepared) {
    if (
      !value ||
      Object.keys(value).sort().join(',') !==
        'authorityHash,call,canonicalSourceRef,dependencyInputHash,inputHash,request,schemaVersion' ||
      value.schemaVersion !== 'workspace-command-prepared-v1' ||
      !isWorkspaceCall(value.call) ||
      !validRequest(value.request) ||
      !/^[a-f0-9]{64}$/.test(value.inputHash) ||
      (value.dependencyInputHash !== null && !/^[a-f0-9]{64}$/.test(value.dependencyInputHash)) ||
      !/^[a-f0-9]{64}$/.test(value.authorityHash)
    )
      throw Error('invalid_command_receipt');
  }
  private async result(prepared: Prepared, hash: string): Promise<WorkspaceCommandResult> {
    this.validatePrepared(prepared);
    const key = workspaceFileActionKey(prepared.call);
    if (await this.objects.getReference(invalidationKey(key)))
      throw Error('workspace_command_recovery_required');
    const receipt = (await this.objects.get(hash)) as WorkspaceCommandReceipt;
    if (
      !receipt ||
      Object.keys(receipt).sort().join(',') !==
        'actionId,assurance,canonicalSourceRef,commandId,createdAt,exitCode,finishedAt,fixedInputHash,grantRevision,inputHash,inputVersion,nativeRecordHash,policyHash,projectId,quiescent,reason,receiptId,schemaVersion,stage,startedAt,stderrRef,stdoutRef,taskId,timedOut,toolVersion,workerId,workspaceId,writerEpoch'.replace(
          'taskId, timedOut',
          'taskId,timedOut',
        ) ||
      receipt.schemaVersion !== 'workspace-command-receipt-v1' ||
      receipt.receiptId !== `run:${key}` ||
      receipt.commandId !== `command:${key}` ||
      receipt.inputHash !== prepared.inputHash ||
      receipt.canonicalSourceRef !== prepared.canonicalSourceRef ||
      localRecordHash(receipt.inputVersion) !== localRecordHash(prepared.request.inputVersion) ||
      !['exited', 'timedOut', 'needsAttention'].includes(receipt.stage) ||
      receipt.quiescent !== (receipt.stage !== 'needsAttention') ||
      receipt.assurance !== 'bounded' ||
      ![
        'none',
        'authority_changed',
        'fixed_input_changed',
        'source_version_changed',
        'launch_failed',
        'cleanup_incomplete',
        'output_incomplete',
      ].includes(receipt.reason) ||
      (receipt.stage !== 'needsAttention' && receipt.reason !== 'none') ||
      ![receipt.createdAt, receipt.startedAt, receipt.finishedAt].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      typeof receipt.timedOut !== 'boolean' ||
      !/^[a-f0-9]{64}$/.test(receipt.policyHash) ||
      receipt.toolVersion !== this.tools.node.version
    )
      throw Error('invalid_command_receipt');
    for (const field of Object.keys(prepared.call) as (keyof WorkspaceCall)[])
      if (receipt[field] !== prepared.call[field]) throw Error('invalid_command_receipt');
    await this.assertRoots();
    const record = this.journal
      .snapshot()
      .records.find((entry) => entry.commandId === receipt.commandId);
    if (
      !record ||
      localRecordHash(record) !== receipt.nativeRecordHash ||
      record.inputHash !== receipt.inputHash ||
      record.policyHash !== receipt.policyHash ||
      (record.launchReceipt?.payloadResult?.exitCode ?? null) !== receipt.exitCode
    )
      throw Error('workspace_command_recovery_required');
    const observation = record.observationReceipt,
      launch = record.launchReceipt;
    if (
      receipt.timedOut !== (observation?.cause === 'timeout') ||
      receipt.exitCode !== (launch?.payloadResult?.exitCode ?? null) ||
      (receipt.quiescent &&
        (!observation ||
          !launch ||
          observation.bindingFailure !== null ||
          observation.discoveryFailed ||
          observation.stop.registeredState !== 'stopped' ||
          observation.stdout.truncated ||
          observation.stderr.truncated ||
          observation.stdout.error !== null ||
          observation.stderr.error !== null)) ||
      (receipt.stage === 'exited' &&
        (launch?.released !== true ||
          launch.error !== null ||
          launch.payloadResult?.exitCode === null ||
          launch.payloadResult === null)) ||
      (receipt.stage === 'timedOut' && !receipt.timedOut)
    )
      throw Error('invalid_command_receipt');
    const stdout = await this.objects.getBytes(receipt.stdoutRef),
      stderr = await this.objects.getBytes(receipt.stderrRef);
    if (
      stdout.length > 1024 * 1024 ||
      stderr.length > 1024 * 1024 ||
      (record.observationReceipt &&
        (record.observationReceipt.stdout.sha256 !== receipt.stdoutRef ||
          record.observationReceipt.stderr.sha256 !== receipt.stderrRef))
    )
      throw Error('invalid_command_receipt');
    const fixed = (await this.objects.get(receipt.fixedInputHash)) as LocalFixedInput;
    if (receipt.quiescent)
      await this.inputs.verify(fixed, fixed.scope, receipt.inputVersion, async () => {
        await this.assertRoots();
        return true;
      });
    return { ...receipt, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
  }
}
