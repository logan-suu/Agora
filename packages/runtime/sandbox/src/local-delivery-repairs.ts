/** Prepare an owned repair copy. This is not a grant or a writer admission;
 * callers must register the copy and prove current task/grant/lease separately. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AppState,
  type DeliveryRepairCandidate,
  type DeliveryRepairSource,
  deliveryReaderAssignment,
  deliveryRepairAssignment,
  isDeliveryRepairCandidate,
  isDeliveryRepairSource,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { inspectLocalRoot, type LocalRootBinding } from './local-file-transaction';
import type { LocalRegistryOwner } from './local-registry-file';
import { localRecordHash } from './local-registry-records';
import type {
  LocalFileManifest,
  LocalVersionScope,
  LocalVersionStore,
} from './local-version-store';

type Request = { scope: LocalVersionScope; dispatchId: string; source: DeliveryRepairSource };
type Authorize = () => Promise<boolean>;
type Grant = { rootId: string; grantId: string; revision: number; policyHash: string };
interface Prepared {
  schemaVersion: 'local-delivery-repair-input-v1';
  request: Request;
  binding: LocalRootBinding;
  initialVersion: WorkspaceVersionV1;
}
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const keyFor = (r: Request) =>
  localRecordHash({
    kind: 'delivery-repair-input',
    projectId: r.scope.projectId,
    taskId: r.scope.taskId,
    dispatchId: r.dispatchId,
  });
async function directory(path: string) {
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw Error('delivery_repair_root_changed');
  return `${s.dev}:${s.ino}`;
}
async function sync(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
const logical = (m: LocalFileManifest) => ({
  directories: m.directories.map((d) => d.path).sort(),
  files: m.files
    .map((f) => ({
      path: f.path,
      hash: f.version.sha256,
      size: f.version.size,
      executable: f.version.executable,
    }))
    .sort((a, b) => a.path.localeCompare(b.path)),
});
export class LocalDeliveryRepairs {
  private constructor(
    private readonly owner: LocalRegistryOwner,
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
    private readonly root: string,
    private readonly identity: string,
  ) {}
  static async open(
    owner: LocalRegistryOwner,
    objects: LocalControlObjects,
    versions: LocalVersionStore,
  ) {
    await owner.assertHeld();
    if ((await realpath(owner.root)) !== owner.root) throw Error('delivery_repair_root_changed');
    const root = join(owner.root, 'delivery-repairs');
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    await sync(owner.root);
    return new LocalDeliveryRepairs(owner, objects, versions, root, await directory(root));
  }
  private async check(authorize: Authorize) {
    await this.owner.assertHeld();
    if ((await directory(this.root)) !== this.identity) throw Error('delivery_repair_root_changed');
    if (!(await authorize())) throw Error('authorization_closed');
    return true;
  }
  private request(input: Request): Request {
    localRecordHash(input);
    if (
      Object.keys(input).sort().join(',') !== 'dispatchId,scope,source' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(input.dispatchId) ||
      !isDeliveryRepairSource(input.source)
    )
      throw Error('delivery_repair_input_invalid');
    return structuredClone(input);
  }
  /** Map a successor TESTER/REVIEWER to the sealed private repair input. */
  async validationBinding(
    state: AppState,
    workerId: string,
    version: WorkspaceVersionV1,
    grant: Grant,
    authorize: Authorize,
  ) {
    const selected = deliveryReaderAssignment(state, workerId);
    const candidate = selected?.repairCandidate?.candidate;
    const worker = state.workers.find((w) => w.workerId === workerId);
    if (
      !selected ||
      !candidate ||
      worker?.role !== selected.role ||
      !same(version, selected.workspaceVersion) ||
      (['pending', 'running', 'paused'].includes(worker.status) &&
        (state.phase !== (selected.role === 'TESTER' ? 'testing' : 'review') ||
          state.nextRole !== selected.role))
    )
      throw Error('delivery_repair_reader_changed');
    const saved = await this.readCandidate(state, candidate.workerId, grant, authorize);
    if (!same(saved, candidate)) throw Error('delivery_repair_candidate_changed');
    return this.workspaceBinding(state, candidate.workerId, grant, authorize);
  }
  /** Only the trusted host may supply closure and authorization proofs. The
   * resulting immutable reference never authorizes a worker or user-root write. */
  async seal(
    state: AppState,
    workerId: string,
    grant: Grant,
    closureReceiptId: string,
    authorize: Authorize,
  ): Promise<DeliveryRepairCandidate> {
    const assignment = deliveryRepairAssignment(state, workerId);
    if (
      assignment?.worker.status !== 'done' ||
      state.humanGate ||
      state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status)) ||
      !/^closure:[a-f0-9]{64}$/.test(closureReceiptId)
    )
      throw Error('delivery_repair_not_closed');
    const binding = await this.workspaceBinding(state, workerId, grant, authorize);
    const scope = {
      projectId: state.projectId,
      taskId: state.taskId,
      rootId: grant.rootId,
      policyHash: grant.policyHash,
    };
    const key = localRecordHash({
      kind: 'delivery-repair-candidate',
      projectId: state.projectId,
      taskId: state.taskId,
      dispatchId: assignment.message.msgId,
    });
    const existing = await this.objects.getReference(key);
    if (existing) {
      const saved = await this.readCandidate(state, workerId, grant, authorize);
      if (saved.closureReceiptId !== closureReceiptId) throw Error('operation_conflict');
      return saved;
    }
    const workspaceVersion = await this.versions.capture(scope, binding, () =>
      this.check(authorize),
    );
    const proof = {
      schemaVersion: 'local-delivery-repair-candidate-v1',
      projectId: state.projectId,
      taskId: state.taskId,
      roundId: assignment.round.roundId,
      dispatchId: assignment.message.msgId,
      workerId,
      workspaceId: assignment.workspace.workspaceId,
      workspaceVersion,
      controlFingerprint: assignment.source.controlFingerprint,
      closureReceiptId,
      grant: structuredClone(grant),
      binding,
      source: assignment.source,
    };
    await this.check(authorize);
    const proofHash = await this.objects.put(proof);
    await this.objects.bindReference(key, proofHash);
    return this.readCandidate(state, workerId, grant, authorize);
  }
  async readCandidate(
    state: AppState,
    workerId: string,
    grant: Grant,
    authorize: Authorize,
  ): Promise<DeliveryRepairCandidate> {
    const assignment = deliveryRepairAssignment(state, workerId);
    if (assignment?.worker.status !== 'done') throw Error('delivery_repair_not_closed');
    const binding = await this.workspaceBinding(state, workerId, grant, authorize);
    const key = localRecordHash({
      kind: 'delivery-repair-candidate',
      projectId: state.projectId,
      taskId: state.taskId,
      dispatchId: assignment.message.msgId,
    });
    const reference = await this.objects.getReference(key);
    if (!reference) throw Error('delivery_repair_candidate_missing');
    const saved = (await this.objects.get(reference)) as Record<string, unknown>;
    const candidate = {
      kind: 'workspace_delivery_repair_candidate',
      version: 1,
      projectId: saved.projectId,
      taskId: saved.taskId,
      roundId: saved.roundId,
      dispatchId: saved.dispatchId,
      workerId: saved.workerId,
      workspaceId: saved.workspaceId,
      workspaceVersion: saved.workspaceVersion,
      controlFingerprint: saved.controlFingerprint,
      closureReceiptId: saved.closureReceiptId,
      proofHash: reference,
    };
    if (
      !isDeliveryRepairCandidate(candidate) ||
      !same(saved, {
        schemaVersion: 'local-delivery-repair-candidate-v1',
        projectId: state.projectId,
        taskId: state.taskId,
        roundId: assignment.round.roundId,
        dispatchId: assignment.message.msgId,
        workerId,
        workspaceId: assignment.workspace.workspaceId,
        workspaceVersion: candidate.workspaceVersion,
        controlFingerprint: assignment.source.controlFingerprint,
        closureReceiptId: candidate.closureReceiptId,
        grant,
        binding,
        source: assignment.source,
      }) ||
      !/^closure:[a-f0-9]{64}$/.test(candidate.closureReceiptId)
    )
      throw Error('delivery_repair_candidate_changed');
    await this.versions.verify(
      candidate.workspaceVersion,
      {
        projectId: state.projectId,
        taskId: state.taskId,
        rootId: grant.rootId,
        policyHash: grant.policyHash,
      },
      binding,
      () => this.check(authorize),
    );
    return structuredClone(candidate);
  }
  /** Resolve only a registered repair Coder to its prepared private root. */
  async workspaceBinding(
    state: AppState,
    workerId: string,
    grant: { rootId: string; grantId: string; revision: number; policyHash: string },
    authorize: Authorize,
  ): Promise<LocalRootBinding> {
    const assignment = deliveryRepairAssignment(state, workerId);
    if (
      !assignment ||
      assignment.round.grantId !== grant.grantId ||
      assignment.round.grantRevision !== grant.revision ||
      assignment.workspace.rootId !== grant.rootId
    )
      throw Error('delivery_repair_assignment_changed');
    const prepared = await this.read(
      {
        scope: {
          projectId: state.projectId,
          taskId: state.taskId,
          rootId: grant.rootId,
          policyHash: grant.policyHash,
        },
        dispatchId: assignment.message.msgId,
        source: assignment.source,
      },
      authorize,
    );
    return prepared.binding;
  }

  /** Identity-only lookup after registration. It does not attest current bytes
   * still equal C; legitimate Coder edits are proved by a later closed capture. */
  async read(input: Request, authorize: Authorize): Promise<Prepared> {
    const request = this.request(input);
    await this.check(authorize);
    await this.versions.read(request.source.workspaceVersion, request.scope);
    const hash = await this.objects.getReference(keyFor(request));
    if (!hash) throw Error('delivery_repair_recovery_required');
    const saved = (await this.objects.get(hash)) as Prepared;
    if (
      !saved ||
      Object.keys(saved).sort().join(',') !== 'binding,initialVersion,request,schemaVersion' ||
      saved.schemaVersion !== 'local-delivery-repair-input-v1' ||
      !same(saved.request, request)
    )
      throw Error('operation_conflict');
    if (
      saved.binding.root !== join(this.root, keyFor(request)) ||
      !same(inspectLocalRoot(saved.binding.root), saved.binding)
    )
      throw Error('delivery_repair_root_changed');
    const initial = await this.versions.read(saved.initialVersion, request.scope);
    const source = await this.versions.read(request.source.workspaceVersion, request.scope);
    if (
      !same(logical(initial), logical(source)) ||
      initial.bindingHash !== localRecordHash(saved.binding)
    )
      throw Error('delivery_repair_input_changed');
    await this.check(authorize);
    if (!same(inspectLocalRoot(saved.binding.root), saved.binding))
      throw Error('delivery_repair_root_changed');
    return structuredClone(saved);
  }
  async prepare(input: Request, authorize: Authorize): Promise<Prepared> {
    const request = this.request(input);
    await this.check(authorize);
    const manifest = await this.versions.read(request.source.workspaceVersion, request.scope);
    const key = keyFor(request);
    if (await this.objects.getReference(key)) {
      const saved = await this.read(request, authorize);
      await this.versions.verify(saved.initialVersion, request.scope, saved.binding, () =>
        this.check(authorize),
      );
      return saved;
    }
    const path = join(this.root, key);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw Error('delivery_repair_recovery_required');
      throw e;
    }
    await sync(this.root);
    await mkdir(join(path, '.agora-operations'), { mode: 0o700 });
    const binding = inspectLocalRoot(path);
    const check = async () => {
      await this.check(authorize);
      if (!same(inspectLocalRoot(path), binding)) throw Error('delivery_repair_root_changed');
      return true;
    };
    for (const entry of [...manifest.directories].sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
    )) {
      await check();
      if (entry.path) await mkdir(join(path, entry.path), { mode: 0o700 });
    }
    for (const file of manifest.files) {
      await check();
      const content = await this.objects.getBytes(file.contentHash);
      if (content.length !== file.version.size) throw Error('delivery_repair_input_changed');
      const fd = await open(
        join(path, file.path),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        file.version.executable ? 0o700 : 0o600,
      );
      try {
        await fd.writeFile(content);
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    for (const entry of [...manifest.directories].sort(
      (a, b) => b.path.split('/').length - a.path.split('/').length,
    ))
      await sync(join(path, entry.path));
    await sync(join(path, '.agora-operations'));
    const initialVersion = await this.versions.capture(request.scope, binding, check);
    if (!same(logical(await this.versions.read(initialVersion, request.scope)), logical(manifest)))
      throw Error('delivery_repair_input_changed');
    const saved: Prepared = {
      schemaVersion: 'local-delivery-repair-input-v1',
      request,
      binding,
      initialVersion,
    };
    await check();
    await this.objects.bindReference(key, await this.objects.put(saved));
    return this.read(request, authorize);
  }
}
