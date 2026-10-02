/** Leader-confirmed inverse effects. Prepared/start records precede native
 * work; old or incomplete attempts are read-only and are never re-executed. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileVersionV1, WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import {
  applyLocalDeletion,
  applyLocalDirectoryDeletion,
  applyLocalDirectoryRestoration,
  applyLocalReplacement,
  applyLocalRestoration,
  type EmptyDirectoryBasis,
  inspectLocalCreationBasis,
  inspectLocalDirectoryMetadata,
  inspectLocalEmptyDirectoryBasis,
  inspectLocalFileBytes,
  type LocalRootBinding,
} from './local-file-transaction';
import { readNativeInstalledFile } from './local-native-file-effect';
import {
  type LocalNativeJournalSeal,
  localPrivateDirectoryIdentity,
  sealLocalNativeJournal,
} from './local-native-journal-seal';
import type { LocalRegistryOwner } from './local-registry-file';
import { localRecordHash, parseLocalRegistry } from './local-registry-records';
import type { LocalUndoAuthority, LocalUndoCall } from './local-undo-authority';
import { advanceLocalUndoPrefix, assertLocalUndoPrefix } from './local-undo-prefix';
import type { LocalUndoProposalStore } from './local-undo-proposal';
import type { LocalUndoTreeInput, LocalUndoTreeItem } from './local-undo-tree-plan';
import {
  type LocalVersionScope,
  type LocalVersionStore,
  localFileVersion,
} from './local-version-store';
import { localRootBinding } from './local-workspace-authority';
import { serializeWorkspaceOperation } from './local-workspace-operation';

type Native = Awaited<
  ReturnType<
    | typeof applyLocalReplacement
    | typeof applyLocalDeletion
    | typeof applyLocalRestoration
    | typeof applyLocalDirectoryDeletion
    | typeof applyLocalDirectoryRestoration
  >
>;
type Prepared = {
  schemaVersion: 'local-undo-batch-prepared-v1';
  call: LocalUndoCall;
  binding: LocalRootBinding;
  scope: LocalVersionScope;
  helperHash: string;
};
type Start = {
  schemaVersion: 'local-undo-batch-start-v1';
  preparedHash: string;
  index: number;
  actionId: string;
  file: { version: FileVersionV1; metadata: string; contentRef: string } | null;
  directory: EmptyDirectoryBasis | null;
  creation: { parentIdentity: string } | null;
};
type Actual = {
  effect: boolean;
  file: {
    path: string;
    version: Extract<FileVersionV1, { kind: 'regular' }>;
    metadata: string;
    contentRef: string;
  } | null;
  directory: LocalUndoTreeInput['directories'][number] | null;
};
type Item = {
  schemaVersion: 'local-undo-batch-item-v1';
  preparedHash: string;
  index: number;
  startHash: string;
  native: Native;
  seal: LocalNativeJournalSeal;
  actual: Actual;
};
export type LocalUndoBatchResult = {
  schemaVersion: 'local-undo-batch-result-v1';
  receiptId: string;
  inputHash: string;
  preparedHash: string;
  stage: 'applied' | 'conflict' | 'partial' | 'recoveryRequired';
  reason: string;
  attempted: number;
  items: { index: number; recordHash: string }[];
  prefixHash: string;
  currentVersion: WorkspaceVersionV1 | null;
  closed: boolean;
};
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const keyFor = (call: LocalUndoCall) => localRecordHash({ kind: 'local-undo-batch', ...call });
const phase = (key: string, name: string) => localRecordHash({ key, name });
const nativeId = (key: string, index: number) => `undo-${key}-${index}`;
function fail(): never {
  throw Error('undo_batch_evidence_unverified');
}
function nativeEffect(native: Native) {
  return 'exchanged' in native
    ? native.exchanged
    : 'removed' in native
      ? native.removed
      : native.created;
}
/** Directory/removal primitives retain native.json instead of the file
 * candidate outcome. Validate that original closed protocol, never infer it
 * from the public receipt's stage or a missing process. */
function treeOutcome(native: Native, prepared: Buffer, helperHash: string, operation: string) {
  const raw = JSON.parse(readFileSync(join(native.journalPath, 'native.json'), 'utf8'));
  if (
    !raw ||
    Object.keys(raw).sort().join(',') !== 'code,signal,stderr,stdout' ||
    raw.code !== native.nativeExitCode ||
    typeof raw.stdout !== 'string' ||
    typeof raw.stderr !== 'string' ||
    raw.stdout.length > 16384 ||
    raw.stderr.length > 16384 ||
    !raw.stdout.endsWith('\n') ||
    raw.signal !== null
  )
    fail();
  const events = raw.stdout
      .slice(0, -1)
      .split('\n')
      .map((line: string) => JSON.parse(line)),
    checkpoints = ['before_prepare', 'before_swap', 'after_swap'],
    last = events.pop(),
    creating = operation === 'mkdir',
    key = creating ? 'created' : 'removed';
  if (
    events.length < 1 ||
    events.length > 3 ||
    events.some(
      (event: Record<string, unknown>, index: number) =>
        Object.keys(event).sort().join(',') !== 'event,exchanged,name' ||
        event.event !== 'checkpoint' ||
        event.name !== checkpoints[index] ||
        event.exchanged !== (index === 2),
    ) ||
    !last ||
    Object.keys(last).sort().join(',') !==
      ['event', 'reason', key, 'stage', ...('directory' in native ? ['directory'] : [])]
        .sort()
        .join(',') ||
    last.event !== 'result' ||
    !['applied', 'conflict', 'recoveryRequired'].includes(last.stage) ||
    typeof last.reason !== 'string' ||
    !/^[a-z_]{1,128}$/.test(last.reason) ||
    last[key] !== nativeEffect(native) ||
    ('directory' in native && !same(last.directory, native.directory)) ||
    (last.stage === 'applied' &&
      (events.length !== 3 || !last[key] || raw.code !== 0 || last.reason !== 'none'))
  )
    fail();
  return {
    schemaVersion: 'local-file-native-outcome-v1',
    preparedHash: digest(prepared),
    closed: true,
    actionId: native.actionId,
    inputHash: native.inputHash,
    helperHash,
    exitCode: raw.code,
    signal: raw.signal,
    checkpointCount: events.length,
    protocolFailed: false,
    result: last,
  };
}

export class LocalUndoBatch {
  private constructor(
    private readonly owner: LocalRegistryOwner,
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
    private readonly authority: LocalUndoAuthority,
    private readonly proposals: LocalUndoProposalStore,
    private readonly helper: string,
    private readonly root: string,
    private readonly rootIdentity: string,
    private readonly helperHash: string,
  ) {}
  static async open(
    owner: LocalRegistryOwner,
    objects: LocalControlObjects,
    versions: LocalVersionStore,
    authority: LocalUndoAuthority,
    proposals: LocalUndoProposalStore,
    helper: string,
  ) {
    await owner.assertHeld();
    const parent = join(owner.root, 'local-workspaces');
    localPrivateDirectoryIdentity(parent);
    const root = join(parent, 'undo-transactions');
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return new LocalUndoBatch(
      owner,
      objects,
      versions,
      authority,
      proposals,
      helper,
      root,
      localPrivateDirectoryIdentity(root),
      digest(readFileSync(helper)),
    );
  }
  private async assertRoot() {
    await this.owner.assertHeld();
    if (
      localPrivateDirectoryIdentity(this.root) !== this.rootIdentity ||
      digest(readFileSync(this.helper)) !== this.helperHash
    )
      fail();
  }
  private async treeHash(tree: LocalUndoTreeInput) {
    return this.objects.put({
      directories: tree.directories,
      protectedPaths: tree.protectedPaths ?? [],
      files: await Promise.all(
        tree.files.map(async ({ content, ...file }) => ({
          ...file,
          contentRef: await this.objects.putBytes(content),
        })),
      ),
    });
  }
  private async readTree(hash: string): Promise<LocalUndoTreeInput> {
    const tree = (await this.objects.get(hash)) as {
      directories: LocalUndoTreeInput['directories'];
      protectedPaths: string[];
      files: ({ contentRef: string } & Omit<LocalUndoTreeInput['files'][number], 'content'>)[];
    };
    if (
      !tree ||
      Object.keys(tree).sort().join(',') !== 'directories,files,protectedPaths' ||
      !Array.isArray(tree.files)
    )
      fail();
    const result = {
      ...tree,
      files: await Promise.all(
        tree.files.map(async ({ contentRef, ...file }) => ({
          ...file,
          content: await this.objects.getBytes(contentRef),
        })),
      ),
    };
    assertLocalUndoPrefix(result, result);
    return result;
  }
  private async prepared(call: LocalUndoCall, hash: string) {
    const p = (await this.objects.get(hash)) as Prepared,
      facts = await this.proposals.read(call.inputHash),
      registry = parseLocalRegistry(await this.objects.get(facts.current.registryHash)),
      root =
        registry.linkedRoots?.find(
          (r) =>
            r.projectId === call.projectId &&
            r.taskId === call.taskId &&
            r.workspaceId === call.workspaceId,
        ) ??
        registry.roots.find(
          (r) => r.projectId === call.projectId && r.rootId === facts.current.rootId,
        );
    if (
      !p ||
      Object.keys(p).sort().join(',') !== 'binding,call,helperHash,schemaVersion,scope' ||
      p.schemaVersion !== 'local-undo-batch-prepared-v1' ||
      !same(p.call, call) ||
      !root ||
      !same(p.binding, localRootBinding(root)) ||
      !same(p.scope, {
        projectId: call.projectId,
        taskId: call.taskId,
        rootId: facts.current.rootId,
        policyHash: facts.current.policyHash,
      }) ||
      p.helperHash !== this.helperHash ||
      facts.plan.kind !== 'candidate'
    )
      fail();
    return { p, facts, plan: facts.plan };
  }
  private async observe(p: Prepared, expected: LocalUndoTreeInput, omit?: string) {
    const pinned = await this.authority.pinObservation(p.call);
    if (!same(pinned.admitted.bound.binding, p.binding)) fail();
    const check = async () => {
      await this.assertRoot();
      await pinned.check();
      return true;
    };
    const version = await this.versions.capture(p.scope, p.binding, check),
      manifest = await this.versions.read(version, p.scope),
      tree: LocalUndoTreeInput = {
        directories: [],
        files: [],
        protectedPaths: [...manifest.excludedPaths],
      };
    for (const d of manifest.directories) {
      await check();
      const basis = inspectLocalDirectoryMetadata(p.binding, d.path, this.helper);
      if (basis.identity !== d.identity) fail();
      tree.directories.push({ path: d.path, ...basis });
    }
    for (const f of manifest.files) {
      await check();
      const basis = inspectLocalFileBytes(p.binding, f.path, this.helper);
      if (!same(localFileVersion(basis), f.version)) fail();
      tree.files.push({
        path: f.path,
        version: f.version,
        metadata: basis.metadata,
        content: basis.content,
      });
    }
    const except = (t: LocalUndoTreeInput) =>
      omit
        ? {
            ...t,
            files: t.files.filter((f) => f.path !== omit),
            directories: t.directories.filter((d) => d.path !== omit),
          }
        : t;
    // In-flight restored/removed directories cannot have children. Other paths,
    // parent identities, metadata and protected names remain the full read set.
    assertLocalUndoPrefix(except(expected), except(tree));
    await this.versions.verify(version, p.scope, p.binding, check);
    await check();
    const final = await this.authority.assertCall(p.call);
    if (
      final.registry.revision !== pinned.admitted.registry.revision ||
      !same(final.state, pinned.admitted.state) ||
      !same(final.bound.binding, p.binding)
    )
      fail();
    return { version, tree };
  }
  private async proof(
    p: Prepared,
    preparedHash: string,
    index: number,
    startHash: string,
    native: Native,
  ): Promise<Actual> {
    const { plan } = await this.prepared(p.call, preparedHash),
      item = plan.items[index],
      start = (await this.objects.get(startHash)) as Start;
    if (
      !item ||
      item.operation === 'none' ||
      !start ||
      Object.keys(start).sort().join(',') !==
        'actionId,creation,directory,file,index,preparedHash,schemaVersion' ||
      start.schemaVersion !== 'local-undo-batch-start-v1' ||
      start.preparedHash !== preparedHash ||
      start.index !== index ||
      start.actionId !== nativeId(keyFor(p.call), index) ||
      native.actionId !== start.actionId ||
      native.journalPath !== join(this.root, start.actionId) ||
      !native.quiescent ||
      typeof nativeEffect(native) !== 'boolean'
    )
      fail();
    if (!item.expected) fail();
    const rawPrepared = readFileSync(join(native.journalPath, 'prepared.json')),
      rawResult = readFileSync(join(native.journalPath, 'result.json')),
      original = JSON.parse(rawPrepared.toString('utf8')),
      result = JSON.parse(rawResult.toString('utf8')),
      outcome =
        item.operation === 'put' || item.operation === 'restoreFile'
          ? JSON.parse(readFileSync(join(native.journalPath, 'native-outcome.json'), 'utf8'))
          : treeOutcome(
              native,
              rawPrepared,
              p.helperHash,
              item.operation === 'restoreDirectory'
                ? 'mkdir'
                : item.operation === 'rmdir'
                  ? 'rmdir'
                  : 'remove',
            );
    const baseline = start.file
        ? await this.objects.getBytes(start.file.contentRef)
        : Buffer.alloc(0),
      creating = item.operation === 'restoreFile' || item.operation === 'restoreDirectory',
      operation =
        item.operation === 'put'
          ? 'replace'
          : item.operation === 'remove'
            ? 'remove'
            : item.operation === 'rmdir'
              ? 'rmdir'
              : item.operation === 'restoreFile'
                ? 'create'
                : 'mkdir',
      nativeExpected = start.file
        ? {
            identity: start.file.version.kind === 'regular' ? start.file.version.identity : '',
            metadata: start.file.metadata,
            content: baseline,
          }
        : {
            identity: start.directory?.identity ?? start.creation?.parentIdentity,
            metadata: start.directory?.metadata ?? '',
            content: '',
          },
      candidate = item.content ?? Buffer.alloc(0),
      input = {
        actionId: native.actionId,
        binding: p.binding,
        parents: original.parents,
        path: item.path,
        expected: nativeExpected,
        content: item.operation === 'put' || item.operation === 'restoreFile' ? candidate : '',
        helperHash: p.helperHash,
        ...(operation === 'replace' ? {} : { operation }),
        ...(item.mode === undefined ? {} : { mode: item.mode }),
        ...(item.restoreFrom === undefined ? {} : { restoreFrom: item.restoreFrom }),
      };
    const preparedKeys = [
      'actionId',
      'binding',
      'candidateName',
      'expectedHash',
      'helperHash',
      'inputHash',
      'parents',
      'path',
      'policyHash',
      'replacementHash',
      'schemaVersion',
      'stage',
      ...(creating ? ['parentIdentity'] : ['expectedIdentity', 'expectedMetadata']),
      ...(item.mode === undefined ? [] : ['mode']),
      ...(item.restoreFrom === undefined ? [] : ['restoreFrom']),
    ]
      .sort()
      .join(',');
    if (
      Object.keys(original).sort().join(',') !== preparedKeys ||
      original.stage !== 'prepared' ||
      original.schemaVersion !== native.schemaVersion ||
      original.actionId !== native.actionId ||
      original.path !== item.path ||
      original.candidateName !== native.candidateName ||
      native.candidateName !== `${native.actionId}-candidate` ||
      !same(original.binding, p.binding) ||
      original.helperHash !== p.helperHash ||
      original.inputHash !== native.inputHash ||
      native.inputHash !== digest(JSON.stringify(input)) ||
      original.expectedHash !== digest(baseline) ||
      original.replacementHash !== digest(candidate) ||
      !readFileSync(join(native.journalPath, 'expected')).equals(baseline) ||
      !readFileSync(join(native.journalPath, 'replacement')).equals(candidate) ||
      !same(original.restoreFrom ?? null, item.restoreFrom ?? null) ||
      original.mode !== item.mode ||
      (creating
        ? original.parentIdentity !== start.creation?.parentIdentity
        : original.expectedIdentity !== nativeExpected.identity ||
          original.expectedMetadata !== nativeExpected.metadata) ||
      !same(result, native) ||
      outcome.schemaVersion !== 'local-file-native-outcome-v1' ||
      outcome.preparedHash !== digest(rawPrepared) ||
      outcome.closed !== true ||
      outcome.actionId !== native.actionId ||
      outcome.inputHash !== native.inputHash ||
      outcome.helperHash !== p.helperHash ||
      outcome.exitCode !== native.nativeExitCode ||
      outcome.result?.[operation === 'replace' ? 'exchanged' : creating ? 'created' : 'removed'] !==
        nativeEffect(native)
    )
      fail();
    if (
      start.file &&
      (!('kind' in item.expected) ||
        start.file.version.kind !== 'regular' ||
        !same(start.file.version, item.expected) ||
        !same(
          localFileVersion({
            identity: start.file.version.kind === 'regular' ? start.file.version.identity : '',
            metadata: start.file.metadata,
            content: baseline,
          }),
          start.file.version,
        ))
    )
      fail();
    if (
      start.directory &&
      (!('metadata' in item.expected) || !same(start.directory, item.expected))
    )
      fail();
    if (
      start.creation &&
      (!('kind' in item.expected) ||
        item.expected.kind !== 'absent' ||
        start.creation.parentIdentity !== item.expected.parentIdentity)
    )
      fail();
    const effect = nativeEffect(native) as boolean;
    let file: Actual['file'] = null,
      directory: Actual['directory'] = null;
    if (item.operation === 'put' || item.operation === 'restoreFile') {
      if (!('exchanged' in native || 'created' in native) || 'directory' in native) fail();
      const actual = await readNativeInstalledFile({
        native,
        journalRoot: this.root,
        bindingHash: localRecordHash(p.binding),
        path: item.path,
        expected: item.expected as FileVersionV1,
        baselineMetadata: start.file?.metadata ?? null,
        baseline,
        candidate,
        ...(item.mode === undefined ? {} : { mode: item.mode }),
        ...(item.restoreFrom === undefined ? {} : { restoreFrom: item.restoreFrom }),
        assertPrivateRoot: () => this.assertRoot(),
      });
      if (
        effect !== actual.effect ||
        (effect && (actual.installedVersion?.kind !== 'regular' || !actual.installedMetadata))
      )
        fail();
      if (effect && actual.installedVersion?.kind === 'regular' && actual.installedMetadata)
        file = {
          path: item.path,
          version: actual.installedVersion,
          metadata: actual.installedMetadata,
          contentRef: digest(candidate),
        };
    } else if (effect && item.operation === 'restoreDirectory') {
      if (
        !('directory' in native) ||
        !native.directory ||
        !same(
          native.directory,
          item.restoreFrom && {
            identity: item.restoreFrom.identity,
            metadata: item.restoreFrom.metadata,
          },
        ) ||
        native.nativeExitCode !== 0 ||
        outcome.protocolFailed !== false ||
        outcome.signal !== null ||
        outcome.checkpointCount !== 3
      )
        fail();
      directory = { path: item.path, ...native.directory };
    } else if (effect && item.operation === 'rmdir') {
      if (!('directory' in native) || !same(native.directory, start.directory)) fail();
    }
    return { effect, file, directory };
  }
  private async advance(prefix: LocalUndoTreeInput, item: LocalUndoTreeItem, actual: Actual) {
    if (!actual.effect) return prefix;
    const installed = actual.file
      ? { file: { ...actual.file, content: await this.objects.getBytes(actual.file.contentRef) } }
      : actual.directory
        ? { directory: actual.directory }
        : {};
    return advanceLocalUndoPrefix(prefix, item, installed);
  }
  async readHistory(input: LocalUndoCall): Promise<LocalUndoBatchResult> {
    await this.assertRoot();
    const call = structuredClone(input),
      key = keyFor(call),
      preparedHash = await this.objects.getReference(key),
      resultHash = await this.objects.getReference(phase(key, 'result'));
    if (!preparedHash || !resultHash) throw Error('undo_recovery_required');
    const { p, plan, facts } = await this.prepared(call, preparedHash),
      result = (await this.objects.get(resultHash)) as LocalUndoBatchResult;
    if (
      !result ||
      Object.keys(result).sort().join(',') !==
        'attempted,closed,currentVersion,inputHash,items,prefixHash,preparedHash,reason,receiptId,schemaVersion,stage' ||
      result.schemaVersion !== 'local-undo-batch-result-v1' ||
      result.receiptId !== `undo:${key}` ||
      result.inputHash !== call.inputHash ||
      result.preparedHash !== preparedHash ||
      !Number.isSafeInteger(result.attempted) ||
      result.attempted < 0 ||
      result.attempted > plan.items.length ||
      !Array.isArray(result.items) ||
      !['applied', 'conflict', 'partial', 'recoveryRequired'].includes(result.stage) ||
      typeof result.closed !== 'boolean'
    )
      fail();
    let prefix = facts.tree,
      missing = false,
      allApplied = true,
      anyEffect = false;
    const expectedIndices: number[] = [];
    for (let index = 0; index < plan.items.length; index++) {
      const item = plan.items[index];
      if (!item) fail();
      const startHash = await this.objects.getReference(phase(key, `start:${index}`)),
        itemHash = await this.objects.getReference(phase(key, `item:${index}`));
      if (index >= result.attempted || item.operation === 'none') {
        if (startHash || itemHash) fail();
        continue;
      }
      if (!startHash) fail();
      if (!itemHash) {
        if (index !== result.attempted - 1 || result.stage !== 'recoveryRequired' || result.closed)
          fail();
        missing = true;
        continue;
      }
      const record = (await this.objects.get(itemHash)) as Item;
      if (
        !record ||
        Object.keys(record).sort().join(',') !==
          'actual,index,native,preparedHash,schemaVersion,seal,startHash' ||
        record.schemaVersion !== 'local-undo-batch-item-v1' ||
        record.preparedHash !== preparedHash ||
        record.index !== index ||
        record.startHash !== startHash ||
        !same(record.seal, sealLocalNativeJournal(record.native.journalPath))
      )
        fail();
      const actual = await this.proof(p, preparedHash, index, startHash, record.native);
      if (!same(actual, record.actual)) fail();
      allApplied &&= record.native.stage === 'applied' && actual.effect;
      anyEffect ||= actual.effect;
      prefix = await this.advance(prefix, item, actual);
      expectedIndices.push(index);
      if (index < result.attempted - 1 && (!actual.effect || record.native.stage !== 'applied'))
        fail();
    }
    if (
      !same(
        result.items.map((i) => i.index),
        expectedIndices,
      )
    )
      fail();
    assertLocalUndoPrefix(prefix, await this.readTree(result.prefixHash));
    for (const item of result.items)
      if (item.recordHash !== (await this.objects.getReference(phase(key, `item:${item.index}`))))
        fail();
    if (result.stage === 'applied') {
      if (
        !result.closed ||
        missing ||
        !allApplied ||
        result.attempted !== plan.items.length ||
        !result.currentVersion
      )
        fail();
      const final = await this.versions.read(result.currentVersion, p.scope);
      if (
        !same(
          final.files.map((f) => ({ path: f.path, version: f.version })),
          prefix.files.map((f) => ({ path: f.path, version: f.version })),
        ) ||
        !same(
          final.directories.map((d) => ({ path: d.path, identity: d.identity })),
          prefix.directories.map((d) => ({ path: d.path, identity: d.identity })),
        ) ||
        !same(final.excludedPaths, prefix.protectedPaths ?? [])
      )
        fail();
    } else if (
      result.currentVersion !== null ||
      (result.stage === 'recoveryRequired' && result.closed) ||
      (result.stage === 'conflict' && anyEffect)
    )
      fail();
    await this.assertRoot();
    return structuredClone(result);
  }
  async apply(input: LocalUndoCall) {
    const call = structuredClone(input),
      key = keyFor(call);
    if (await this.objects.getReference(key)) return this.readHistory(call);
    return serializeWorkspaceOperation(call, async () => {
      if (await this.objects.getReference(key)) return this.readHistory(call);
      await this.assertRoot();
      const admitted = await this.authority.assertCall(call),
        facts = admitted.facts;
      if (facts.plan.kind !== 'candidate') throw Error('undo_candidate_conflict');
      const p: Prepared = {
          schemaVersion: 'local-undo-batch-prepared-v1',
          call,
          binding: admitted.bound.binding,
          scope: admitted.bound.versionScope,
          helperHash: this.helperHash,
        },
        preparedHash = await this.objects.put(p);
      await this.objects.bindReference(key, preparedHash);
      let prefix = facts.tree,
        attempted = 0,
        anyEffect = false,
        closed = true,
        stage: LocalUndoBatchResult['stage'] = 'applied',
        reason = 'none',
        currentVersion: WorkspaceVersionV1 | null = null;
      const items: LocalUndoBatchResult['items'] = [];
      try {
        await this.observe(p, prefix);
        for (const [index, item] of facts.plan.items.entries()) {
          if (item.operation === 'none') {
            attempted = index + 1;
            continue;
          }
          await this.observe(p, prefix);
          const file =
              item.operation === 'put' || item.operation === 'remove'
                ? inspectLocalFileBytes(p.binding, item.path, this.helper)
                : null,
            directory =
              item.operation === 'rmdir'
                ? inspectLocalEmptyDirectoryBasis(p.binding, item.path, this.helper)
                : null,
            creation =
              item.operation === 'restoreFile' || item.operation === 'restoreDirectory'
                ? inspectLocalCreationBasis(p.binding, item.path, this.helper)
                : null,
            start: Start = {
              schemaVersion: 'local-undo-batch-start-v1',
              preparedHash,
              index,
              actionId: nativeId(key, index),
              file: file
                ? {
                    version: localFileVersion(file),
                    metadata: file.metadata,
                    contentRef: await this.objects.putBytes(file.content),
                  }
                : null,
              directory,
              creation,
            };
          if (
            (file && !same(localFileVersion(file), item.expected)) ||
            (directory && !same(directory, item.expected)) ||
            (creation &&
              (!item.expected ||
                !('kind' in item.expected) ||
                item.expected.kind !== 'absent' ||
                creation.parentIdentity !== item.expected.parentIdentity))
          )
            throw Error('undo_prefix_conflict');
          const authorize = async (checkpoint: string) => {
              await this.observe(
                p,
                prefix,
                checkpoint === 'after_swap' || checkpoint === 'completion' ? item.path : undefined,
              );
              return true;
            },
            common = {
              actionId: start.actionId,
              binding: p.binding,
              path: item.path,
              helper: this.helper,
              journalRoot: this.root,
              authorize,
            };
          const startHash = await this.objects.put(start);
          await this.objects.bindReference(phase(key, `start:${index}`), startHash);
          attempted = index + 1;
          closed = false;
          let native: Native;
          if (item.operation === 'put' && file && item.content)
            native = await applyLocalReplacement({
              ...common,
              expected: file,
              content: item.content,
              ...(item.mode === undefined ? {} : { mode: item.mode }),
            });
          else if (item.operation === 'remove' && file)
            native = await applyLocalDeletion({ ...common, expected: file });
          else if (item.operation === 'rmdir' && directory)
            native = await applyLocalDirectoryDeletion({ ...common, expected: directory });
          else if (item.operation === 'restoreFile' && creation && item.restoreFrom && item.content)
            native = await applyLocalRestoration({
              ...common,
              expected: creation,
              restoreFrom: item.restoreFrom,
              content: item.content,
            });
          else if (item.operation === 'restoreDirectory' && creation && item.restoreFrom)
            native = await applyLocalDirectoryRestoration({
              ...common,
              expected: creation,
              restoreFrom: item.restoreFrom,
            });
          else fail();
          const actual = await this.proof(p, preparedHash, index, startHash, native),
            record: Item = {
              schemaVersion: 'local-undo-batch-item-v1',
              preparedHash,
              index,
              startHash,
              native,
              actual,
              seal: sealLocalNativeJournal(native.journalPath),
            },
            recordHash = await this.objects.put(record);
          await this.objects.bindReference(phase(key, `item:${index}`), recordHash);
          items.push({ index, recordHash });
          closed = true;
          anyEffect ||= actual.effect;
          prefix = await this.advance(prefix, item, actual);
          if (native.stage !== 'applied') {
            stage = anyEffect ? 'partial' : 'conflict';
            reason = 'native_item_failed';
            break;
          }
          await this.observe(p, prefix);
        }
        if (stage === 'applied') currentVersion = (await this.observe(p, prefix)).version;
      } catch (error) {
        stage = closed ? (anyEffect ? 'partial' : 'conflict') : 'recoveryRequired';
        reason =
          error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
            ? error.message
            : 'undo_authority_or_evidence_changed';
        currentVersion = null;
      }
      const prefixHash = await this.treeHash(prefix),
        result: LocalUndoBatchResult = {
          schemaVersion: 'local-undo-batch-result-v1',
          receiptId: `undo:${key}`,
          inputHash: call.inputHash,
          preparedHash,
          stage,
          reason,
          attempted,
          items,
          prefixHash,
          currentVersion,
          closed,
        };
      await this.objects.bindReference(phase(key, 'result'), await this.objects.put(result));
      return this.readHistory(call);
    });
  }
  /** Fresh result qualification, not a replay: compare the actual final tree
   * and full current authority with the already closed native prefix. */
  async verifyCurrent(call: LocalUndoCall, result: LocalUndoBatchResult) {
    if (!same(await this.readHistory(call), result) || result.stage !== 'applied') fail();
    const admitted = await this.authority.assertCall(call),
      { p } = await this.prepared(call, result.preparedHash),
      observed = await this.observe(p, await this.readTree(result.prefixHash));
    if (!same(observed.version, result.currentVersion)) throw Error('undo_result_version_changed');
    return {
      schemaVersion: 'local-undo-current-result-v1' as const,
      call: structuredClone(call),
      nativeResultHash: localRecordHash(result),
      registryHash: localRecordHash(admitted.registry),
      stateHash: localRecordHash(admitted.state),
      prefixHash: result.prefixHash,
      currentVersion: result.currentVersion,
    };
  }
}
