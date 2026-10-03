/** Read-only recovery. A missing proof preserves the barrier; this reader never
 * pauses, resumes, writes a file, changes a claim or clears a registry record. */

import type { LocalControlObjects } from './local-control-objects';
import {
  type LocalRangeHold,
  type LocalRangePlan,
  parseLocalRangeHold,
} from './local-range-records';
import { localRecordHash } from './local-registry-records';

export type LocalRangeSourceProof = {
  schemaVersion: 'local-range-source-v1';
  planHash: string;
  registryHash: string;
  taskStateHashes: { projectId: string; taskId: string; hash: string }[];
  manifestHash: string;
  targetFactsHash: string;
};
export type LocalRangeCanonicalProof = {
  schemaVersion: 'local-range-canonical-v1';
  planHash: string;
  sourceRef: string;
  messageHash: string;
};
export type LocalRangeWorkerProof = {
  schemaVersion: 'local-range-worker-closed-v1';
  planHash: string;
  sourceRef: string;
  projectId: string;
  taskId: string;
  workerId: string;
  sessionId: string;
  status: 'paused' | 'done' | 'failed';
  safePointRef: string;
  boundaryReceiptId: string;
  closed: true;
  leaseReleased: true;
};
export type LocalRangeHeldProof = {
  schemaVersion: 'local-range-held-v1';
  planHash: string;
  sourceRef: string;
  workerProofs: string[];
  writersProofRef: string;
};
export interface LocalRangeEvidencePort {
  objects: Pick<LocalControlObjects, 'get' | 'getReference'>;
  /** Verify original private source binding, manifest, physical targets and
   * every affected canonical assignment, including unknown/control writers. */
  verifySource(plan: LocalRangePlan, proof: LocalRangeSourceProof): Promise<void>;
  verifyCanonical(plan: LocalRangePlan, proof: LocalRangeCanonicalProof): Promise<void>;
  /** Read native/session closure and official safe-point evidence. It must not
   * infer OS closure or lease release from an absent process or worker status. */
  verifyWorker(plan: LocalRangePlan, proof: LocalRangeWorkerProof): Promise<void>;
  verifyWriters(plan: LocalRangePlan, proof: LocalRangeHeldProof): Promise<void>;
  verifyCurrentRootAndGrant(plan: LocalRangePlan): Promise<void>;
}
export type LocalRangeView = {
  schemaVersion: 'workspace-range-view-v1';
  takeoverId: string | null;
  stage: LocalRangeHold['stage'] | 'unknown';
  effectiveScope: 'workspace';
  editable: boolean;
  needsAttention: boolean;
  reason: 'none' | 'waiting_for_control_or_quiescence' | 'range_evidence_unverified';
};
export const localRangeSourceKey = (plan: LocalRangePlan) =>
  localRecordHash({
    kind: 'local-range-source',
    projectId: plan.projectId,
    taskId: plan.taskId,
    takeoverId: plan.takeoverId,
  });
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const key = (v: { projectId: string; taskId: string; workerId: string }) =>
  `${v.projectId}/${v.taskId}/${v.workerId}`;
function fail(): never {
  throw Error('range_evidence_unverified');
}
function object(v: unknown, keys: string[]): Record<string, unknown> {
  localRecordHash(v);
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !== keys.sort().join(',')
  )
    fail();
  return v as Record<string, unknown>;
}
async function read(
  port: LocalRangeEvidencePort,
  ref: string,
  keys: string[],
  schema: string,
  hold: LocalRangeHold,
  sourceRef?: string,
) {
  if (!hash(ref)) fail();
  const value = await port.objects.get(ref);
  if (localRecordHash(value) !== ref) fail();
  const proof = object(value, keys);
  if (
    proof.schemaVersion !== schema ||
    proof.planHash !== hold.planHash ||
    (sourceRef !== undefined && proof.sourceRef !== sourceRef)
  )
    fail();
  return structuredClone(proof);
}
export async function reconcileLocalRangeEvidence(
  input: unknown,
  port: LocalRangeEvidencePort,
): Promise<LocalRangeView> {
  let hold: LocalRangeHold | undefined;
  try {
    hold = parseLocalRangeHold(input);
    const sourceRef = await port.objects.getReference(localRangeSourceKey(hold.plan));
    if (!sourceRef) fail();
    const source = await read(
      port,
      sourceRef,
      [
        'schemaVersion',
        'planHash',
        'registryHash',
        'taskStateHashes',
        'manifestHash',
        'targetFactsHash',
      ],
      'local-range-source-v1',
      hold,
    );
    if (
      !hash(source.registryHash) ||
      !hash(source.targetFactsHash) ||
      source.manifestHash !== hold.plan.startVersion.manifestHash ||
      !Array.isArray(source.taskStateHashes) ||
      !source.taskStateHashes.length ||
      source.taskStateHashes.length > 4096
    )
      fail();
    const tasks = source.taskStateHashes.map((v) => {
      const t = object(v, ['projectId', 'taskId', 'hash']);
      if (!id(t.projectId) || !id(t.taskId) || !hash(t.hash)) fail();
      return `${t.projectId}/${t.taskId}`;
    });
    if (
      new Set(tasks).size !== tasks.length ||
      ![
        `${hold.plan.projectId}/${hold.plan.taskId}`,
        ...hold.plan.cohort.map((c) => `${c.projectId}/${c.taskId}`),
      ].every((t) => tasks.includes(t))
    )
      fail();
    await port.verifySource(structuredClone(hold.plan), source as LocalRangeSourceProof);
    const view = (editable: boolean): LocalRangeView => ({
      schemaVersion: 'workspace-range-view-v1',
      takeoverId: hold?.plan.takeoverId ?? null,
      stage: hold?.stage ?? 'unknown',
      effectiveScope: 'workspace',
      editable,
      needsAttention: false,
      reason: editable ? 'none' : 'waiting_for_control_or_quiescence',
    });
    if (hold.stage === 'requested' && hold.evidence.some((e) => e.phase === 'needs_attention'))
      fail();
    if (hold.controlStage === 'prepared') return view(false);
    const canonicalRef = hold.evidence.find((e) => e.phase === 'canonical')?.ref;
    if (!canonicalRef) fail();
    const canonical = await read(
      port,
      canonicalRef,
      ['schemaVersion', 'planHash', 'sourceRef', 'messageHash'],
      'local-range-canonical-v1',
      hold,
      sourceRef,
    );
    if (canonical.messageHash !== localRecordHash(hold.plan.sourceMessage)) fail();
    await port.verifyCanonical(structuredClone(hold.plan), canonical as LocalRangeCanonicalProof);
    const workers = new Map<string, string>();
    for (const e of hold.evidence.filter((e) => e.phase === 'worker_closed')) {
      const worker = await read(
        port,
        e.ref,
        [
          'schemaVersion',
          'planHash',
          'sourceRef',
          'projectId',
          'taskId',
          'workerId',
          'sessionId',
          'status',
          'safePointRef',
          'boundaryReceiptId',
          'closed',
          'leaseReleased',
        ],
        'local-range-worker-closed-v1',
        hold,
        sourceRef,
      );
      const assignment = hold.plan.cohort.find((c) => key(c) === e.workerKey);
      if (
        !assignment ||
        worker.projectId !== assignment.projectId ||
        worker.taskId !== assignment.taskId ||
        worker.workerId !== assignment.workerId ||
        worker.sessionId !== assignment.sessionId ||
        !['paused', 'done', 'failed'].includes(worker.status as string) ||
        typeof worker.safePointRef !== 'string' ||
        !worker.safePointRef.length ||
        worker.safePointRef.length > 65536 ||
        !id(worker.boundaryReceiptId) ||
        worker.closed !== true ||
        worker.leaseReleased !== true
      )
        fail();
      await port.verifyWorker(structuredClone(hold.plan), worker as LocalRangeWorkerProof);
      workers.set(key(assignment), e.ref);
    }
    if (hold.stage === 'requested') return view(false);
    const heldRef = hold.evidence.find((e) => e.phase === 'held')?.ref;
    if (!heldRef || workers.size !== hold.plan.cohort.length) fail();
    const held = await read(
      port,
      heldRef,
      ['schemaVersion', 'planHash', 'sourceRef', 'workerProofs', 'writersProofRef'],
      'local-range-held-v1',
      hold,
      sourceRef,
    );
    if (
      !hash(held.writersProofRef) ||
      localRecordHash(held.workerProofs) !==
        localRecordHash(hold.plan.cohort.map((c) => workers.get(key(c))))
    )
      fail();
    await port.verifyWriters(structuredClone(hold.plan), held as LocalRangeHeldProof);
    // Return/release additionally require version, invalidation and recovery
    // proofs. Until those readers exist, never infer them from phase labels.
    if (
      hold.stage !== 'heldByLeader' ||
      hold.evidence.map((e) => e.phase).lastIndexOf('needs_attention') >
        hold.evidence.map((e) => e.phase).lastIndexOf('held')
    )
      fail();
    await port.verifyCurrentRootAndGrant(structuredClone(hold.plan));
    return view(true);
  } catch {
    return {
      schemaVersion: 'workspace-range-view-v1',
      takeoverId: hold?.plan.takeoverId ?? null,
      stage: hold?.stage ?? 'unknown',
      effectiveScope: 'workspace',
      editable: false,
      needsAttention: true,
      reason: 'range_evidence_unverified',
    };
  }
}
