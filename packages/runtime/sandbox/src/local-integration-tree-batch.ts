/** Shared trusted integration/delivery tree effects. Journals govern recovery; the process queue
 * only serializes live callers. Never expose this service to model tools. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FileVersionV1, WorkspaceVersionV1 } from '@agora/core-domain';
import type { TreeOperation } from '../../../core/domain/src/local-tree-comparison';
import type { LocalControlObjects } from './local-control-objects';
import { LocalDeliveryAuthority, type LocalDeliveryCall } from './local-delivery-authority';
import {
  applyLocalCreation,
  applyLocalDeletion,
  applyLocalDirectoryCreation,
  applyLocalDirectoryDeletion,
  applyLocalReplacement,
  inspectLocalCreationBasis,
  inspectLocalDirectory,
  inspectLocalEmptyDirectoryBasis,
  inspectLocalFileBytes,
  type LocalRootBinding,
} from './local-file-transaction';
import {
  type ApplicationRequest,
  readCompletedApplication,
} from './local-integration-application-records';
import type {
  LocalIntegrationAuthority,
  LocalIntegrationCall,
} from './local-integration-authority';
import { readNativeInstalledFile } from './local-native-file-effect';
import type { LocalRegistryOwner } from './local-registry-file';
import {
  type LocalDeliveryClaimRecord,
  type LocalIntegrationClaimRecord,
  localRecordHash,
} from './local-registry-records';
import {
  type LocalTreePlan,
  type LocalTreePlanInput,
  planLocalTreeApplication,
} from './local-tree-plan';
import {
  type LocalFileManifest,
  type LocalVersionStore,
  localFileVersion,
} from './local-version-store';
import { serializeWorkspaceOperation } from './local-workspace-operation';

type TreeCall = LocalIntegrationCall | LocalDeliveryCall;
type TreeAuthority = LocalIntegrationAuthority | LocalDeliveryAuthority;
const deliveryCall = (call: TreeCall): call is LocalDeliveryCall => 'deliveryProposalId' in call;
const schema = <T extends string>(
  call: TreeCall,
  suffix: T,
): `integration-tree-${T}-v1` | `delivery-tree-${T}-v1` =>
  `${deliveryCall(call) ? 'delivery' : 'integration'}-tree-${suffix}-v1`;

type Native = Awaited<
  ReturnType<
    | typeof applyLocalReplacement
    | typeof applyLocalCreation
    | typeof applyLocalDeletion
    | typeof applyLocalDirectoryCreation
    | typeof applyLocalDirectoryDeletion
  >
>;
type Seal = {
  identity: string;
  files: { name: string; identity: string; bytes: number; sha256: string }[];
};
type Prepared = {
  schemaVersion: 'integration-tree-prepared-v1' | 'delivery-tree-prepared-v1';
  call: TreeCall;
  actionId: string;
  plan: LocalTreePlan;
  binding: LocalRootBinding;
  sourceRef: string;
  helperHash: string;
  inputHash: string;
};
type Item = {
  schemaVersion: 'integration-tree-item-v1' | 'delivery-tree-item-v1';
  index: number;
  key: string;
  native: Native;
  seal: Seal;
};
export type IntegrationTreeResult = {
  schemaVersion: 'integration-tree-result-v1' | 'delivery-tree-result-v1';
  receiptId: string;
  inputHash: string;
  stage: 'applied' | 'conflict' | 'partial';
  reason: string;
  attempted: number;
  items: { index: number; recordHash: string }[];
  version: WorkspaceVersionV1 | null;
};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const keyFor = (call: TreeCall, actionId: string) =>
  localRecordHash({
    kind: deliveryCall(call) ? 'delivery-tree-batch' : 'integration-tree-batch',
    projectId: call.projectId,
    taskId: call.taskId,
    actionId,
  });
const phase = (key: string, name: string) => localRecordHash({ key, name });
const nativeId = (key: string, index: number) => `tree-${key}-${index}`;
const identity = (s: NonNullable<ReturnType<typeof lstatSync>>) =>
  `${s.dev}:${s.ino}:${s.uid}:${s.mode}`;
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
function directory(path: string) {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw Error('tree_batch_evidence_changed');
  return identity(s);
}
function seal(path: string): Seal {
  const root = directory(path),
    names = readdirSync(path).sort(),
    files: Seal['files'] = [];
  for (const name of names) {
    const file = join(path, name),
      before = lstatSync(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.size > 16 * 1024 * 1024 + 16_384
    )
      throw Error('tree_batch_evidence_changed');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (identity(fstatSync(fd)) !== identity(before)) throw Error('tree_batch_evidence_changed');
      const bytes = readFileSync(fd);
      if (
        identity(lstatSync(file)) !== identity(before) ||
        bytes.length !== before.size ||
        fstatSync(fd).mtimeMs !== before.mtimeMs
      )
        throw Error('tree_batch_evidence_changed');
      files.push({ name, identity: identity(before), bytes: bytes.length, sha256: sha(bytes) });
    } finally {
      closeSync(fd);
    }
  }
  if (directory(path) !== root || !equal(names, readdirSync(path).sort()))
    throw Error('tree_batch_evidence_changed');
  return { identity: root, files };
}

export class LocalControlledTreeBatch {
  private constructor(
    private readonly owner: LocalRegistryOwner,
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
    private readonly authority: TreeAuthority,
    private readonly helper: string,
    private readonly root: string,
    private readonly rootIdentity: string,
    private readonly helperHash: string,
  ) {}
  withAuthority(authority: TreeAuthority) {
    if (
      authority instanceof LocalDeliveryAuthority !==
      this.authority instanceof LocalDeliveryAuthority
    )
      throw Error('tree_batch_authority_changed');
    return new LocalControlledTreeBatch(
      this.owner,
      this.objects,
      this.versions,
      authority,
      this.helper,
      this.root,
      this.rootIdentity,
      this.helperHash,
    );
  }
  static async open(
    owner: LocalRegistryOwner,
    objects: LocalControlObjects,
    versions: LocalVersionStore,
    authority: TreeAuthority,
    helper: string,
  ) {
    await owner.assertHeld();
    const parent = join(owner.root, 'local-workspaces'),
      root = join(
        parent,
        authority instanceof LocalDeliveryAuthority
          ? 'delivery-tree-transactions'
          : 'integration-tree-transactions',
      );
    directory(parent);
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const result = new LocalControlledTreeBatch(
      owner,
      objects,
      versions,
      authority,
      helper,
      root,
      directory(root),
      sha(readFileSync(helper)),
    );
    await result.assertRoot();
    return result;
  }
  private async admit(call: TreeCall, action: 'read' | 'edit' | 'remove') {
    if (this.authority instanceof LocalDeliveryAuthority) {
      if (!deliveryCall(call)) throw Error('tree_batch_authority_changed');
      return this.authority.assertCall(call, action);
    }
    if (deliveryCall(call)) throw Error('tree_batch_authority_changed');
    return this.authority.assertCall(call, action);
  }
  private async checkpoint(call: TreeCall) {
    if (this.authority instanceof LocalDeliveryAuthority) {
      if (!deliveryCall(call)) throw Error('tree_batch_authority_changed');
      return this.authority.readCheckpoint(call);
    }
    if (deliveryCall(call)) throw Error('tree_batch_authority_changed');
    return this.authority.readCheckpoint(call);
  }
  private async publishedCheckpoint(request: ApplicationRequest) {
    if (this.authority instanceof LocalDeliveryAuthority)
      throw Error('delivery_history_not_integration');
    return this.authority.readPublishedCheckpoint(request);
  }
  private async assertRoot() {
    await this.owner.assertHeld();
    if (
      directory(this.root) !== this.rootIdentity ||
      sha(readFileSync(this.helper)) !== this.helperHash
    )
      throw Error('tree_batch_evidence_changed');
  }
  async apply(
    input: TreeCall,
    actionId: string,
    request: LocalTreePlanInput,
  ): Promise<IntegrationTreeResult> {
    localRecordHash({ input, actionId, request });
    if (!id(actionId)) throw Error('invalid_tree_batch');
    const call = structuredClone(input),
      planInput = structuredClone(request);
    return serializeWorkspaceOperation(call, () => this.execute(call, actionId, planInput));
  }
  /** Read an already applied batch under the original live claim. This is not
   * an application entry point or permission to acknowledge canonical progress. */
  async readPublished(request: ApplicationRequest): Promise<IntegrationTreeResult> {
    const proof = await readCompletedApplication(this.objects, request);
    return this.readAppliedProof(
      request.call,
      proof.prepared.treeActionId,
      proof.prepared.plan,
      structuredClone(request),
    );
  }
  async readApplied(
    input: TreeCall,
    actionId: string,
    request: LocalTreePlanInput,
  ): Promise<IntegrationTreeResult> {
    return this.readAppliedProof(input, actionId, request);
  }
  async readHistorical(input: ApplicationRequest, inputAnchor?: ApplicationRequest) {
    const request = structuredClone(input),
      anchor = inputAnchor && structuredClone(inputAnchor);
    if (this.authority instanceof LocalDeliveryAuthority)
      throw Error('delivery_history_not_integration');
    await this.authority.readHistoricalSelection(request, anchor);
    const proof = await readCompletedApplication(this.objects, request);
    return this.readAppliedProof(
      request.call,
      proof.prepared.treeActionId,
      proof.prepared.plan,
      anchor,
      true,
    );
  }
  /** Original, closed native effects remain readable after invalidation, grant
   * closure or later edits. No current claim, source read, retry or repair runs. */
  async readActual(
    scope: { projectId: string; taskId: string; workspaceId: string },
    receiptId: string,
  ) {
    await this.assertRoot();
    if (!/^tree:[a-f0-9]{64}$/.test(receiptId)) throw Error('tree_batch_evidence_changed');
    const key = receiptId.slice(5),
      preparedHash = await this.objects.getReference(key),
      resultHash = await this.objects.getReference(phase(key, 'result'));
    if (!preparedHash || !resultHash) throw Error('tree_batch_recovery_required');
    const p = await this.decode(preparedHash);
    if (
      p.call.projectId !== scope.projectId ||
      p.call.taskId !== scope.taskId ||
      p.call.workspaceId !== scope.workspaceId ||
      keyFor(p.call, p.actionId) !== key
    )
      throw Error('tree_batch_evidence_changed');
    const result = await this.terminal(p, resultHash, true);
    if (result.items.length !== result.attempted) throw Error('tree_batch_recovery_required');
    const original = await this.versions.read(p.plan.current, p.plan.scope);
    const effects = [];
    for (const [index, entry] of result.items.entries()) {
      const item = (await this.objects.get(entry.recordHash)) as Item;
      const startHash = await this.objects.getReference(phase(key, `start:${index}`));
      if (!startHash) throw Error('tree_batch_recovery_required');
      const start = (await this.objects.get(startHash)) as {
        operation: TreeOperation;
        expected: {
          identity?: string;
          metadata?: string;
          parentIdentity?: string;
          contentHash?: string;
        };
        contentHash: string | null;
      };
      const op = start.operation,
        native = item.native;
      const effect =
        'created' in native
          ? native.created
          : 'removed' in native
            ? native.removed
            : native.exchanged;
      if (typeof effect !== 'boolean' || !native.quiescent)
        throw Error('tree_batch_recovery_required');
      const before = original.files.find((f) => f.path === op.path);
      const baselineContentRef = before?.contentHash ?? null;
      const baseline = baselineContentRef
        ? await this.objects.getBytes(baselineContentRef)
        : Buffer.alloc(0);
      const write = p.plan.writes.find((w) => w.path === op.path);
      const expected = before?.version ?? {
        kind: 'absent' as const,
        parentIdentity: start.expected.parentIdentity ?? '',
        name: op.path.split('/').at(-1) as string,
      };
      if (
        before &&
        (start.expected.identity !== before.version.identity ||
          start.expected.contentHash !== before.contentHash ||
          !start.expected.metadata ||
          !equal(
            localFileVersion({
              identity: start.expected.identity,
              metadata: start.expected.metadata,
              content: baseline,
            }),
            before.version,
          ))
      )
        throw Error('tree_batch_evidence_changed');
      let installedVersion: FileVersionV1 | null = null,
        installedMetadata: string | null = null;
      if (op.op === 'put') {
        if (
          !write ||
          op.after?.kind !== 'file' ||
          start.contentHash !== write.contentHash ||
          (native.schemaVersion !== 'local-creation-primitive-v1' &&
            native.schemaVersion !== 'local-replacement-primitive-v1')
        )
          throw Error('tree_batch_evidence_changed');
        const proof = await readNativeInstalledFile({
          native,
          journalRoot: this.root,
          bindingHash: localRecordHash(p.binding),
          path: op.path,
          expected,
          baselineMetadata: before ? (start.expected.metadata ?? null) : null,
          baseline,
          candidate: await this.objects.getBytes(write.contentHash),
          executable: op.after.file.executable,
          assertPrivateRoot: () => this.assertRoot(),
        });
        if (proof.effect !== effect || (effect && !proof.installedVersion))
          throw Error('tree_batch_recovery_required');
        installedVersion = proof.installedVersion;
        installedMetadata = proof.installedMetadata;
      } else {
        const prepared = JSON.parse(
          readFileSync(join(native.journalPath, 'prepared.json'), 'utf8'),
        );
        const expectedBytes = readFileSync(join(native.journalPath, 'expected'));
        if (
          !equal(prepared.binding, p.binding) ||
          prepared.path !== op.path ||
          prepared.actionId !== native.actionId ||
          prepared.helperHash !== p.helperHash ||
          prepared.inputHash !== native.inputHash ||
          prepared.expectedHash !== sha(expectedBytes) ||
          prepared.replacementHash !== sha(Buffer.alloc(0)) ||
          (op.op === 'remove' && !baseline.equals(expectedBytes)) ||
          (op.op !== 'remove' && expectedBytes.length !== 0)
        )
          throw Error('tree_batch_evidence_changed');
        const creating = op.op === 'mkdir';
        const expectedNative = {
          identity: creating ? start.expected.parentIdentity : start.expected.identity,
          metadata: creating ? '' : start.expected.metadata,
          content: op.op === 'remove' ? baseline : '',
        };
        if (
          (creating
            ? prepared.parentIdentity !== expectedNative.identity
            : prepared.expectedIdentity !== expectedNative.identity ||
              prepared.expectedMetadata !== expectedNative.metadata) ||
          sha(
            Buffer.from(
              JSON.stringify({
                actionId: native.actionId,
                binding: p.binding,
                parents: prepared.parents,
                path: op.path,
                expected: expectedNative,
                content: '',
                helperHash: p.helperHash,
                operation: op.op,
              }),
            ),
          ) !== native.inputHash
        )
          throw Error('tree_batch_evidence_changed');
        if (effect && (native.stage !== 'applied' || native.nativeExitCode !== 0))
          throw Error('tree_batch_recovery_required');
        if (effect && 'directory' in native && !native.directory)
          throw Error('tree_batch_recovery_required');
      }
      effects.push({
        path: op.path,
        operation: op.op,
        effect,
        itemHash: entry.recordHash,
        startHash,
        native: structuredClone(native),
        baselineVersion: op.op === 'rmdir' ? null : expected,
        baselineContentRef,
        baselineMetadata: start.expected.metadata ?? null,
        baselineDirectory:
          op.op === 'rmdir'
            ? { identity: start.expected.identity, metadata: start.expected.metadata }
            : null,
        directory: 'directory' in native ? native.directory : null,
        candidateContentRef: write?.contentHash ?? null,
        installedVersion,
        installedMetadata,
      });
    }
    // A terminal prefix has no omitted or extra attempted child. Half journals
    // are recovery work, never an invitation to infer inverse operations.
    for (let i = result.attempted; i < (p.plan.comparison.operations?.length ?? 0); i++)
      if (
        (await this.objects.getReference(phase(key, `start:${i}`))) ||
        (await this.objects.getReference(phase(key, `item:${i}`)))
      )
        throw Error('tree_batch_recovery_required');
    await this.assertRoot();
    return {
      schemaVersion: 'local-actual-tree-effects-v1' as const,
      receiptId,
      preparedHash,
      resultHash,
      call: structuredClone(p.call),
      binding: structuredClone(p.binding),
      plan: structuredClone(p.plan),
      result: structuredClone(result),
      effects,
    };
  }
  private async readAppliedProof(
    input: TreeCall,
    actionId: string,
    request: LocalTreePlanInput,
    published?: ApplicationRequest,
    historical = false,
  ): Promise<IntegrationTreeResult> {
    localRecordHash({ input, actionId, request });
    if (!id(actionId)) throw Error('invalid_tree_batch');
    const call = structuredClone(input),
      planInput = structuredClone(request);
    const read = async () => {
      await this.assertRoot();
      const key = keyFor(call, actionId);
      const original = await this.objects.getReference(key);
      const resultHash = await this.objects.getReference(phase(key, 'result'));
      if (!original || !resultHash) throw Error('tree_batch_recovery_required');
      const prepared = await this.decode(original);
      const admission = () =>
        published ? this.publishedCheckpoint(published) : this.checkpoint(call);
      const checkpoint = await admission();
      const scope = {
        projectId: call.projectId,
        taskId: call.taskId,
        rootId: checkpoint.root.rootId,
        policyHash: checkpoint.grant.policyHash,
      };
      const plan = await planLocalTreeApplication(this.versions, planInput);
      if (
        !equal(scope, planInput.scope) ||
        !equal(prepared.call, call) ||
        prepared.actionId !== actionId ||
        !equal(prepared.plan, plan) ||
        !equal(prepared.binding, checkpoint.binding) ||
        prepared.sourceRef !== checkpoint.sourceReceiptId
      )
        throw Error('operation_conflict');
      await this.assertClosed(call, key);
      const result = await this.terminal(prepared, resultHash);
      if (result.stage !== 'applied' || !result.version)
        throw Error('tree_batch_recovery_required');
      if (!historical)
        await this.versions.verify(result.version, scope, prepared.binding, checkpoint.authorize);
      const after = await admission();
      if (
        after.snapshot.revision !== checkpoint.snapshot.revision ||
        !equal(after.state, checkpoint.state)
      )
        throw Error('integration_selection_changed');
      await checkpoint.authorize();
      if (
        (await this.objects.getReference(key)) !== original ||
        (await this.objects.getReference(phase(key, 'result'))) !== resultHash ||
        !equal(await this.terminal(prepared, resultHash), result)
      )
        throw Error('tree_batch_evidence_changed');
      await this.assertRoot();
      return result;
    };
    return historical ? read() : serializeWorkspaceOperation(call, read);
  }
  private async execute(call: TreeCall, actionId: string, request: LocalTreePlanInput) {
    await this.assertRoot();
    const admitted = await this.admit(call, 'edit');
    if (deliveryCall(call)) {
      if (
        !('proposal' in admitted) ||
        admitted.claim.kind !== 'delivery' ||
        actionId !== admitted.claim.createdActionId ||
        !equal(request, {
          scope: admitted.proposal.source.scope,
          baseline: admitted.proposal.source.baseline,
          artifact: admitted.proposal.source.artifact,
          current: admitted.proposal.source.current,
        })
      )
        throw Error('delivery_application_plan_changed');
    }
    const scope = {
      projectId: call.projectId,
      taskId: call.taskId,
      rootId: admitted.root.rootId,
      policyHash: admitted.grant.policyHash,
    };
    if (!equal(scope, request.scope)) throw Error('workspace_version_scope_mismatch');
    const plan = await planLocalTreeApplication(this.versions, request);
    if (plan.comparison.status === 'conflict') throw Error('tree_plan_conflict');
    const operations = plan.comparison.operations;
    if (operations.some((o) => o.op === 'remove' || o.op === 'rmdir'))
      await this.admit(call, 'remove');
    const key = keyFor(call, actionId);
    await this.assertClosed(call, key);
    const payload = {
      call,
      actionId,
      plan,
      binding: admitted.binding,
      sourceRef: admitted.sourceReceiptId,
      helperHash: this.helperHash,
    };
    const prepared: Prepared = {
      schemaVersion: schema(call, 'prepared'),
      ...payload,
      inputHash: localRecordHash(payload),
    };
    const previous = await this.objects.getReference(key);
    if (previous) {
      if (!equal(await this.decode(previous), prepared)) throw Error('operation_conflict');
      const saved = await this.objects.getReference(phase(key, 'result'));
      if (!saved) throw Error('tree_batch_recovery_required');
      return this.terminal(prepared, saved);
    }
    if ((await this.objects.references()).length + 3 + operations.length * 2 > 4096)
      throw Error('tree_batch_reference_limit');
    const current = await this.versions.read(plan.current, scope);
    if (current.bindingHash !== localRecordHash(admitted.binding))
      throw Error('root_identity_changed');
    await this.objects.bindReference(key, await this.objects.put(prepared));
    const check = async (action: 'read' | 'edit' | 'remove') => {
      await this.assertRoot();
      const live = await this.admit(call, action);
      if (!equal(live.binding, prepared.binding) || live.sourceReceiptId !== prepared.sourceRef)
        throw Error('tree_batch_authority_changed');
      return true;
    };
    const currentFiles =
      plan.current.kind === 'git'
        ? (await this.versions.readGitManifest(plan.current, scope)).filesVersion
        : plan.current;
    try {
      await this.versions.verify(currentFiles, scope, prepared.binding, () => check('read'));
    } catch {
      return this.finish(prepared, [], 0, null, 'conflict', 'preflight_conflict');
    }
    const directories = new Map(current.directories.map((d) => [d.path, d.identity]));
    const files = new Map(current.files.map((f) => [f.path, f.version]));
    const items: IntegrationTreeResult['items'] = [];
    let attempted = 0,
      version: WorkspaceVersionV1 | null = null,
      failure = 'none';
    try {
      for (const [index, operation] of operations.entries()) {
        const permission =
          operation.op === 'remove' || operation.op === 'rmdir' ? 'remove' : 'edit';
        const authorize = async () => {
          await check(permission);
          this.parents(prepared.binding, operation.path, directories);
          return true;
        };
        await authorize();
        const path = operation.path,
          action = nativeId(key, index);
        const common = {
          actionId: action,
          path,
          binding: prepared.binding,
          helper: this.helper,
          journalRoot: this.root,
          authorize,
        };
        const fileBasis =
          operation.before?.kind === 'file'
            ? inspectLocalFileBytes(prepared.binding, path, this.helper)
            : null;
        const directoryBasis =
          operation.op === 'rmdir'
            ? inspectLocalEmptyDirectoryBasis(prepared.binding, path, this.helper)
            : null;
        const creationBasis =
          !fileBasis && !directoryBasis
            ? inspectLocalCreationBasis(prepared.binding, path, this.helper)
            : null;
        if (directoryBasis && directoryBasis.identity !== directories.get(path))
          throw Error('file_version_conflict');
        if (fileBasis && !equal(localFileVersion(fileBasis), files.get(path)))
          throw Error('file_version_conflict');
        const contentHash = plan.writes.find((w) => w.path === path)?.contentHash;
        const content =
          operation.op === 'put' && contentHash ? await this.objects.getBytes(contentHash) : null;
        const start = {
          schemaVersion: schema(call, 'start'),
          key,
          index,
          actionId: action,
          operation,
          expected: fileBasis
            ? {
                identity: fileBasis.identity,
                metadata: fileBasis.metadata,
                contentHash: sha(fileBasis.content),
              }
            : (directoryBasis ?? creationBasis),
          contentHash: content ? sha(content) : null,
        };
        attempted = index + 1;
        await this.objects.bindReference(
          phase(key, `start:${index}`),
          await this.objects.put(start),
        );
        let native: Native;
        if (operation.op === 'remove' && fileBasis)
          native = await applyLocalDeletion({ ...common, expected: fileBasis });
        else if (operation.op === 'rmdir' && directoryBasis)
          native = await applyLocalDirectoryDeletion({ ...common, expected: directoryBasis });
        else if (operation.op === 'mkdir' && creationBasis)
          native = await applyLocalDirectoryCreation({ ...common, expected: creationBasis });
        else if (operation.op === 'put' && operation.after?.kind === 'file' && content) {
          const executable = operation.after.file.executable;
          if (!fileBasis && !creationBasis) throw Error('invalid_tree_batch');
          native = fileBasis
            ? await applyLocalReplacement({
                ...common,
                expected: fileBasis,
                content,
                executable,
              })
            : await applyLocalCreation({
                ...common,
                expected: creationBasis as { parentIdentity: string },
                content,
                executable,
              });
        } else throw Error('invalid_tree_batch');
        const record: Item = {
          schemaVersion: schema(call, 'item'),
          key,
          index,
          native,
          seal: seal(join(this.root, action)),
        };
        const recordHash = await this.objects.put(record);
        await this.objects.bindReference(phase(key, `item:${index}`), recordHash);
        items.push({ index, recordHash });
        if (native.stage !== 'applied' || !native.quiescent) {
          failure = 'item_failed';
          break;
        }
        if (operation.op === 'remove') files.delete(path);
        else if (operation.op === 'rmdir') directories.delete(path);
        else if (operation.op === 'mkdir') {
          if (!('directory' in native) || !native.directory)
            throw Error('tree_batch_evidence_changed');
          directories.set(path, native.directory.identity);
        } else {
          const observed = localFileVersion(
            inspectLocalFileBytes(prepared.binding, path, this.helper),
          );
          if (
            operation.after?.kind !== 'file' ||
            observed.sha256 !== operation.after.file.sha256 ||
            observed.size !== operation.after.file.size ||
            observed.executable !== operation.after.file.executable
          )
            throw Error('file_version_conflict');
          files.set(path, observed);
        }
      }
      if (failure === 'none') {
        version = await this.versions.capture(scope, prepared.binding, () => check('read'));
        const final = await this.versions.read(version, scope);
        this.finalMatches(final, directories, files, current.excludedPaths);
        await check('edit');
      }
    } catch {
      failure = 'authority_or_evidence_changed';
      version = null;
    }
    const result = await this.finish(
      prepared,
      items,
      attempted,
      failure === 'none' ? version : null,
      failure === 'none' ? 'applied' : attempted ? 'partial' : 'conflict',
      failure,
    );
    if (result.stage === 'applied' && result.version) {
      let valid = true;
      try {
        await this.versions.verify(result.version, scope, prepared.binding, () => check('edit'));
      } catch {
        valid = false;
      }
      // A missing completion marker blocks replay even if the success object was persisted.
      await this.objects.bindReference(
        phase(key, 'completion'),
        await this.objects.put({
          schemaVersion: schema(prepared.call, 'completion'),
          key,
          inputHash: prepared.inputHash,
          resultHash: localRecordHash(result),
          valid,
        }),
      );
      if (!valid)
        return {
          ...result,
          stage: 'partial' as const,
          reason: 'completion_invalidated',
          version: null,
        };
    }
    return result;
  }
  private parents(binding: LocalRootBinding, path: string, expected: Map<string, string>) {
    const parts = path.split('/').slice(0, -1);
    for (let i = 0; i <= parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (inspectLocalDirectory(binding, parent, this.helper).identity !== expected.get(parent))
        throw Error('root_identity_changed');
    }
  }
  private finalMatches(
    manifest: LocalFileManifest,
    directories: Map<string, string>,
    files: Map<string, FileVersionV1>,
    excluded: string[],
  ) {
    const sort = <T extends { path: string }>(entries: T[]) =>
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (
      !equal(manifest.excludedPaths, excluded) ||
      !equal(
        manifest.directories.map(({ path, identity }) => ({ path, identity })),
        sort([...directories].map(([path, identity]) => ({ path, identity }))),
      ) ||
      !equal(
        manifest.files.map(({ path, version }) => ({ path, version })),
        sort([...files].map(([path, version]) => ({ path, version }))),
      )
    )
      throw Error('file_version_conflict');
  }
  private async finish(
    prepared: Prepared,
    items: IntegrationTreeResult['items'],
    attempted: number,
    version: WorkspaceVersionV1 | null,
    stage: IntegrationTreeResult['stage'],
    reason: string,
  ) {
    const key = keyFor(prepared.call, prepared.actionId);
    const result: IntegrationTreeResult = {
      schemaVersion: schema(prepared.call, 'result'),
      receiptId: `tree:${key}`,
      inputHash: prepared.inputHash,
      stage,
      reason,
      attempted,
      items,
      version,
    };
    await this.objects.bindReference(phase(key, 'result'), await this.objects.put(result));
    return result;
  }
  private async decode(hash: string): Promise<Prepared> {
    const p = (await this.objects.get(hash)) as Prepared;
    if (
      !p ||
      Object.keys(p).sort().join(',') !==
        'actionId,binding,call,helperHash,inputHash,plan,schemaVersion,sourceRef' ||
      !p.call ||
      p.schemaVersion !== schema(p.call, 'prepared') ||
      !id(p.actionId) ||
      p.helperHash !== this.helperHash
    )
      throw Error('tree_batch_evidence_changed');
    if (
      !p.call ||
      Object.keys(p.call).sort().join(',') !==
        (deliveryCall(p.call)
          ? 'claimId,deliveryProposalId,grantRevision,inputHash,projectId,taskId,workspaceId,writerEpoch'
          : 'claimId,grantRevision,integrationId,projectId,taskId,workspaceId,writerEpoch') ||
      ![
        p.call.projectId,
        p.call.taskId,
        p.call.claimId,
        p.call.workspaceId,
        deliveryCall(p.call) ? p.call.deliveryProposalId : p.call.integrationId,
      ].every(id) ||
      (deliveryCall(p.call) && !/^[a-f0-9]{64}$/.test(p.call.inputHash)) ||
      !Number.isSafeInteger(p.call.writerEpoch) ||
      p.call.writerEpoch < 1 ||
      !Number.isSafeInteger(p.call.grantRevision) ||
      p.call.grantRevision < 0 ||
      typeof p.sourceRef !== 'string' ||
      !p.sourceRef
    )
      throw Error('tree_batch_evidence_changed');
    const { schemaVersion: _, inputHash, ...payload } = p;
    const { scope, baseline, artifact, current } = p.plan;
    if (
      p.plan.scope.projectId !== p.call.projectId ||
      p.plan.scope.taskId !== p.call.taskId ||
      localRecordHash(payload) !== inputHash ||
      !equal(
        await planLocalTreeApplication(this.versions, { scope, baseline, artifact, current }),
        p.plan,
      )
    )
      throw Error('tree_batch_evidence_changed');
    return p;
  }
  private async terminal(
    p: Prepared,
    hash: string,
    actual = false,
  ): Promise<IntegrationTreeResult> {
    await this.assertRoot();
    const key = keyFor(p.call, p.actionId),
      result = (await this.objects.get(hash)) as IntegrationTreeResult;
    const operations = p.plan.comparison.operations;
    if (
      !operations ||
      !result ||
      Object.keys(result).sort().join(',') !==
        'attempted,inputHash,items,reason,receiptId,schemaVersion,stage,version' ||
      result.schemaVersion !== schema(p.call, 'result') ||
      result.receiptId !== `tree:${key}` ||
      result.inputHash !== p.inputHash ||
      !['applied', 'conflict', 'partial'].includes(result.stage) ||
      !Number.isSafeInteger(result.attempted) ||
      result.attempted < 0 ||
      result.attempted > operations.length ||
      !Array.isArray(result.items) ||
      result.items.length > result.attempted ||
      result.items.length < result.attempted - 1 ||
      !['none', 'preflight_conflict', 'item_failed', 'authority_or_evidence_changed'].includes(
        result.reason,
      ) ||
      (result.stage === 'applied' &&
        (result.reason !== 'none' ||
          result.attempted !== operations.length ||
          result.items.length !== operations.length ||
          !result.version)) ||
      (result.stage === 'conflict' &&
        (result.attempted !== 0 || result.items.length !== 0 || result.version !== null)) ||
      (result.stage === 'partial' && (result.version !== null || result.attempted === 0))
    )
      throw Error('tree_batch_evidence_changed');
    for (let index = 0; index < result.attempted; index++) {
      const ref = await this.objects.getReference(phase(key, `start:${index}`));
      if (!ref) throw Error('tree_batch_evidence_changed');
      const start = (await this.objects.get(ref)) as {
        schemaVersion: string;
        key: string;
        index: number;
        actionId: string;
        operation: TreeOperation;
      };
      if (
        !start ||
        Object.keys(start).sort().join(',') !==
          'actionId,contentHash,expected,index,key,operation,schemaVersion' ||
        start.schemaVersion !== schema(p.call, 'start') ||
        start.key !== key ||
        start.index !== index ||
        start.actionId !== nativeId(key, index) ||
        !equal(start.operation, operations[index])
      )
        throw Error('tree_batch_evidence_changed');
    }
    for (const [index, entry] of result.items.entries()) {
      if (
        entry.index !== index ||
        (await this.objects.getReference(phase(key, `item:${index}`))) !== entry.recordHash
      )
        throw Error('tree_batch_evidence_changed');
      const item = (await this.objects.get(entry.recordHash)) as Item;
      try {
        if (
          !item ||
          Object.keys(item).sort().join(',') !== 'index,key,native,schemaVersion,seal' ||
          item.schemaVersion !== schema(p.call, 'item') ||
          item.key !== key ||
          item.index !== index ||
          item.native.actionId !== nativeId(key, index) ||
          item.native.journalPath !== join(this.root, nativeId(key, index)) ||
          !equal(item.seal, seal(item.native.journalPath)) ||
          !equal(
            JSON.parse(readFileSync(join(item.native.journalPath, 'result.json'), 'utf8')),
            item.native,
          ) ||
          ((result.stage === 'applied' || index < result.items.length - 1) &&
            (item.native.stage !== 'applied' || !item.native.quiescent))
        )
          throw Error('tree_batch_evidence_changed');
      } catch {
        throw Error('tree_batch_evidence_changed');
      }
    }
    if (result.version) {
      const manifest = await this.versions.read(result.version, p.plan.scope);
      if (
        manifest.bindingHash !== localRecordHash(p.binding) ||
        !equal(
          {
            directories: manifest.directories.map((d) => d.path).filter(Boolean),
            files: manifest.files.map(({ path, version }) => ({
              path,
              sha256: version.sha256,
              size: version.size,
              executable: version.executable,
            })),
          },
          p.plan.comparison.candidate,
        )
      )
        throw Error('tree_batch_evidence_changed');
    }
    if (result.stage === 'applied') {
      const ref = await this.objects.getReference(phase(key, 'completion'));
      if (!ref) throw Error('tree_batch_recovery_required');
      const completion = (await this.objects.get(ref)) as { valid: boolean };
      if (
        typeof completion.valid !== 'boolean' ||
        !equal(completion, {
          schemaVersion: schema(p.call, 'completion'),
          key,
          inputHash: p.inputHash,
          resultHash: hash,
          valid: completion.valid,
        })
      )
        throw Error('tree_batch_evidence_changed');
      if (!completion.valid && !actual)
        return { ...result, stage: 'partial', reason: 'completion_invalidated', version: null };
    }
    return result;
  }
  private async records(call: Pick<TreeCall, 'projectId' | 'taskId' | 'workspaceId'>) {
    const records: { key: string; prepared: Prepared }[] = [];
    for (const ref of await this.objects.references()) {
      const value = (await this.objects.get(ref.valueHash)) as Partial<Prepared>;
      if (
        value.schemaVersion !==
        (this.authority instanceof LocalDeliveryAuthority
          ? 'delivery-tree-prepared-v1'
          : 'integration-tree-prepared-v1')
      )
        continue;
      const p = await this.decode(ref.valueHash);
      if (keyFor(p.call, p.actionId) !== ref.key) throw Error('tree_batch_evidence_changed');
      if (
        p.call.projectId === call.projectId &&
        p.call.taskId === call.taskId &&
        p.call.workspaceId === call.workspaceId
      )
        records.push({ key: ref.key, prepared: p });
    }
    return records;
  }
  async assertClosed(
    call: Pick<TreeCall, 'projectId' | 'taskId' | 'workspaceId'>,
    allowed?: string,
  ) {
    await this.assertRoot();
    for (const { key, prepared } of await this.records(call)) {
      if (key === allowed) continue;
      const hash = await this.objects.getReference(phase(key, 'result'));
      if (!hash || (await this.terminal(prepared, hash)).stage === 'partial')
        throw Error('tree_batch_recovery_required');
    }
  }
  async closure(claim: LocalIntegrationClaimRecord | LocalDeliveryClaimRecord): Promise<string> {
    await this.assertRoot();
    const receipts = [];
    for (const { key, prepared } of await this.records(claim)) {
      if (prepared.call.claimId !== claim.claimId) continue;
      if (
        prepared.call.writerEpoch !== claim.writerEpoch ||
        prepared.call.grantRevision !== claim.grantRevision ||
        (claim.kind === 'delivery'
          ? !deliveryCall(prepared.call) ||
            prepared.call.deliveryProposalId !== claim.deliveryProposalId ||
            prepared.call.inputHash !== claim.inputHash
          : deliveryCall(prepared.call) || prepared.call.integrationId !== claim.integrationId)
      )
        throw Error('tree_batch_evidence_changed');
      const hash = await this.objects.getReference(phase(key, 'result'));
      if (!hash || (await this.terminal(prepared, hash)).stage === 'partial')
        throw Error('tree_batch_recovery_required');
      receipts.push({ key, hash });
    }
    return `closure:${localRecordHash({ claimId: claim.claimId, projectId: claim.projectId, taskId: claim.taskId, workspaceId: claim.workspaceId, writerEpoch: claim.writerEpoch, receipts })}`;
  }
}

// Preserve the internal integration entry point and its historical record format.
export {
  LocalControlledTreeBatch as LocalIntegrationTreeBatch,
  LocalControlledTreeBatch as LocalDeliveryTreeBatch,
};
