/** Materialize compared C into task-private immutable bytes. This grants no
 * model execution or application authority, including for stale comparisons. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AppState,
  deliveryReaderAssignment,
  isWorkspaceVersionV1,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import type {
  LocalDeliveryComparisonRecord,
  LocalDeliveryComparisonStore,
} from './local-delivery-comparison-record';
import { inspectLocalRoot, type LocalRootBinding } from './local-file-transaction';
import type { LocalRegistryOwner } from './local-registry-file';
import { localRecordHash } from './local-registry-records';
import type { LocalVersionStore } from './local-version-store';

interface Candidate {
  schemaVersion: 'local-delivery-candidate-v1';
  deliveryComparisonId: string;
  inputHash: string;
  candidateTreeHash: string;
  version: WorkspaceVersionV1;
  binding: LocalRootBinding;
}
const keyFor = (comparison: LocalDeliveryComparisonRecord) =>
  localRecordHash({
    kind: 'local-delivery-candidate',
    deliveryComparisonId: comparison.deliveryComparisonId,
    inputHash: comparison.inputHash,
  });
async function directory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw Error('delivery_candidate_root_changed');
  return `${stat.dev}:${stat.ino}`;
}
async function syncDirectory(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}

export class LocalDeliveryCandidates {
  private constructor(
    private readonly owner: LocalRegistryOwner,
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
    private readonly comparisons: LocalDeliveryComparisonStore,
    private readonly root: string,
    private readonly identity: string,
  ) {}
  static async open(
    owner: LocalRegistryOwner,
    objects: LocalControlObjects,
    versions: LocalVersionStore,
    comparisons: LocalDeliveryComparisonStore,
  ) {
    await owner.assertHeld();
    const root = join(owner.root, 'delivery-candidates');
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await syncDirectory(owner.root);
    return new LocalDeliveryCandidates(
      owner,
      objects,
      versions,
      comparisons,
      root,
      await directory(root),
    );
  }
  private async check() {
    await this.owner.assertHeld();
    if ((await directory(this.root)) !== this.identity)
      throw Error('delivery_candidate_root_changed');
    return true;
  }
  private async comparison(id: string) {
    await this.check();
    const value = await this.comparisons.readHistorical(id);
    if (!value.comparison.candidate || !value.candidateTreeHash) throw Error('delivery_conflict');
    if (value.comparison.status === 'matches_artifact')
      throw Error('delivery_candidate_not_required');
    return value;
  }
  /** A task-private reader binding, never a writer grant for the user root. */
  async validationBinding(
    state: AppState,
    workerId: string,
    version: WorkspaceVersionV1,
    grant: { rootId: string; grantId: string; revision: number; policyHash: string },
  ): Promise<LocalRootBinding> {
    const selected = deliveryReaderAssignment(state, workerId);
    const worker = state.workers.find((entry) => entry.workerId === workerId);
    if (!selected || selected.workerId !== workerId || worker?.role !== selected.role)
      throw Error('delivery_candidate_assignment_mismatch');
    if (
      ['pending', 'running', 'paused'].includes(worker.status) &&
      (state.phase !== (selected.role === 'TESTER' ? 'testing' : 'review') ||
        state.nextRole !== selected.role)
    )
      throw Error('delivery_candidate_assignment_mismatch');
    const { round } = selected;
    const compared = await this.comparison(round.deliveryComparisonId);
    const candidate = await this.read(round.deliveryComparisonId);
    const source = compared.source;
    if (
      source.scope.projectId !== state.projectId ||
      source.scope.taskId !== state.taskId ||
      source.scope.rootId !== grant.rootId ||
      source.scope.policyHash !== grant.policyHash ||
      source.goal !== state.localExecution?.delivery?.goal ||
      state.localExecution.delivery.rootId !== grant.rootId ||
      source.grantId !== grant.grantId ||
      source.grantRevision !== grant.revision ||
      localRecordHash(version) !== localRecordHash(candidate.version) ||
      localRecordHash(round) !==
        localRecordHash({
          roundId: round.roundId,
          actionId: round.actionId,
          deliveryComparisonId: compared.deliveryComparisonId,
          inputHash: compared.inputHash,
          grantId: source.grantId,
          grantRevision: source.grantRevision,
          sourceReceiptId: source.sourceReceipts.artifact,
          sourceVersion: source.artifact,
          candidateVersion: candidate.version,
          targetVersion: source.current,
          targetIndexHash: source.targetIndexHash,
          controlFingerprint: source.controlFingerprint,
        })
    )
      throw Error('delivery_candidate_assignment_mismatch');
    return structuredClone(candidate.binding);
  }
  async read(id: string): Promise<Candidate & { receiptId: string }> {
    const comparison = await this.comparison(id);
    const key = keyFor(comparison);
    const reference = await this.objects.getReference(key);
    if (!reference) throw Error('delivery_candidate_missing');
    const saved = (await this.objects.get(reference)) as Candidate;
    if (
      !saved ||
      Object.keys(saved).sort().join(',') !==
        'binding,candidateTreeHash,deliveryComparisonId,inputHash,schemaVersion,version' ||
      saved.schemaVersion !== 'local-delivery-candidate-v1' ||
      saved.deliveryComparisonId !== id ||
      saved.inputHash !== comparison.inputHash ||
      saved.candidateTreeHash !== comparison.candidateTreeHash ||
      !isWorkspaceVersionV1(saved.version) ||
      saved.version.kind !== 'files' ||
      saved.binding?.root !== join(this.root, key) ||
      localRecordHash(inspectLocalRoot(saved.binding.root)) !== localRecordHash(saved.binding)
    )
      throw Error('delivery_candidate_changed');
    const manifest = await this.versions.read(saved.version, comparison.source.scope);
    const logical = {
      directories: manifest.directories
        .filter((entry) => entry.path !== '')
        .map((entry) => entry.path),
      files: manifest.files.map(({ path, version }) => ({
        path,
        sha256: version.sha256,
        size: version.size,
        executable: version.executable,
      })),
    };
    if (localRecordHash(logical) !== saved.candidateTreeHash)
      throw Error('delivery_candidate_changed');
    await this.versions.verify(saved.version, comparison.source.scope, saved.binding, () =>
      this.check(),
    );
    await this.check();
    return { ...structuredClone(saved), receiptId: `candidate:${key}` };
  }
  async materialize(id: string): Promise<Candidate & { receiptId: string }> {
    const comparison = await this.comparison(id);
    const key = keyFor(comparison);
    if (await this.objects.getReference(key)) return this.read(id);
    const candidate = comparison.comparison.candidate;
    if (!candidate || !comparison.candidateTreeHash) throw Error('delivery_conflict');
    const path = join(this.root, key);
    // A partial directory without a final receipt is preserved, never guessed
    // complete or overwritten. Recovery must inspect its original ownership.
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw Error('delivery_candidate_recovery_required');
      throw error;
    }
    await syncDirectory(this.root);
    await mkdir(join(path, '.agora-operations'), { mode: 0o700 });
    const binding = inspectLocalRoot(path);
    const check = async () => {
      await this.check();
      if (localRecordHash(inspectLocalRoot(path)) !== localRecordHash(binding))
        throw Error('delivery_candidate_root_changed');
      return true;
    };
    for (const relative of [...candidate.directories].sort(
      (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
    )) {
      await check();
      await mkdir(join(path, relative), { mode: 0o700 });
    }
    for (const file of candidate.files) {
      await check();
      const bytes = await this.objects.getBytes(file.sha256);
      if (bytes.length !== file.size) throw Error('delivery_candidate_changed');
      const fd = await open(
        join(path, file.path),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        file.executable ? 0o700 : 0o600,
      );
      try {
        await fd.writeFile(bytes);
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    for (const relative of [...candidate.directories].reverse())
      await syncDirectory(join(path, relative));
    await syncDirectory(join(path, '.agora-operations'));
    await syncDirectory(path);
    const version = await this.versions.capture(comparison.source.scope, binding, check);
    const record: Candidate = {
      schemaVersion: 'local-delivery-candidate-v1',
      deliveryComparisonId: id,
      inputHash: comparison.inputHash,
      candidateTreeHash: comparison.candidateTreeHash,
      version,
      binding,
    };
    await check();
    await this.objects.bindReference(key, await this.objects.put(record));
    return this.read(id);
  }
}
