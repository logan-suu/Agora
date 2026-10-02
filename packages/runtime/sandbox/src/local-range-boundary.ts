/** Historical close facts for a just-stopped canonical worker. This does not
 * close anything, grant a lease, or infer native closure from an absent PID. */
import type { AppState } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { localRecordHash } from './local-registry-records';

type Scope = {
  projectId: string;
  taskId: string;
  workerId: string;
  sessionId: string;
  safePointRef: string;
};
type Port = {
  objects: Pick<LocalControlObjects, 'get' | 'references'>;
  tasks: { load(scope: Scope): Promise<AppState | undefined> };
  isActive(scope: Scope): boolean;
};
function fail(): never {
  throw Error('range_worker_boundary_unverified');
}
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys;
export async function readLocalRangeBoundary(input: Scope, port: Port): Promise<string> {
  localRecordHash(input);
  const scope = structuredClone(input);
  if (
    !exact(scope, 'projectId,safePointRef,sessionId,taskId,workerId') ||
    ![scope.projectId, scope.taskId, scope.workerId, scope.sessionId].every(
      (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),
    ) ||
    typeof scope.safePointRef !== 'string' ||
    !scope.safePointRef ||
    scope.safePointRef.length > 65536 ||
    port.isActive(scope)
  )
    fail();
  const state = await port.tasks.load(scope),
    worker = state?.workers.find((w) => w.workerId === scope.workerId);
  if (
    !state ||
    state.projectId !== scope.projectId ||
    state.taskId !== scope.taskId ||
    !worker ||
    !['paused', 'done', 'failed'].includes(worker.status) ||
    worker.sessionId !== scope.sessionId ||
    worker.safePoint !== scope.safePointRef
  )
    fail();
  const binding = state.localExecution?.bindings.find((b) => b.workerId === scope.workerId),
    identity = localRecordHash({
      projectId: scope.projectId,
      taskId: scope.taskId,
      workerId: scope.workerId,
    });
  const matches: string[] = [];
  for (const ref of await port.objects.references()) {
    const v = (await port.objects.get(ref.valueHash)) as Record<string, unknown>;
    if (
      !v ||
      !['workspace-worker-boundary-v1', 'workspace-control-boundary-v1'].includes(
        v.schemaVersion as string,
      ) ||
      v.projectId !== scope.projectId ||
      v.taskId !== scope.taskId ||
      v.workerId !== scope.workerId ||
      v.sessionId !== scope.sessionId ||
      v.reason !== 'close'
    )
      continue;
    if (
      localRecordHash(v) !== ref.valueHash ||
      v.quiescent !== true ||
      typeof v.boundary !== 'number' ||
      !Number.isSafeInteger(v.boundary) ||
      v.boundary < 0
    )
      fail();
    if (v.schemaVersion === 'workspace-control-boundary-v1') {
      if (
        binding ||
        !['COORDINATOR', 'PM'].includes(worker.role) ||
        v.role !== worker.role ||
        v.fileCapabilities !== false ||
        typeof v.grantId !== 'string' ||
        !exact(
          v,
          'boundary,fileCapabilities,grantId,projectId,quiescent,reason,role,schemaVersion,sessionId,taskId,workerId',
        ) ||
        ref.key !==
          localRecordHash({
            kind: 'control-boundary',
            identity,
            sessionId: scope.sessionId,
            boundary: v.boundary,
          })
      )
        fail();
    } else {
      const workspace = state.localExecution?.workspaces.find(
        (w) => w.workspaceId === binding?.workspaceId,
      );
      const writer =
        worker.role === 'CODER' ||
        (worker.role === 'TESTER' && workspace?.mode === 'linked-worktree');
      if (
        !binding ||
        !workspace ||
        v.workspaceId !== binding.workspaceId ||
        v.canonicalSourceRef !== binding.receiptId ||
        v.actionId !== `session:${localRecordHash({ identity, sessionId: scope.sessionId })}` ||
        v.assurance !== 'bounded' ||
        v.claimRetained !== writer ||
        typeof v.writerEpoch !== 'number' ||
        !Number.isSafeInteger(v.writerEpoch) ||
        v.writerEpoch < 0 ||
        typeof v.grantRevision !== 'number' ||
        !Number.isSafeInteger(v.grantRevision) ||
        v.grantRevision < 0 ||
        typeof v.createdAt !== 'number' ||
        !Number.isSafeInteger(v.createdAt) ||
        v.createdAt < 0 ||
        !exact(
          v,
          'actionId,assurance,boundary,canonicalSourceRef,claimRetained,createdAt,grantRevision,projectId,quiescent,reason,schemaVersion,sessionId,taskId,workerId,workspaceId,writerEpoch',
        ) ||
        ref.key !==
          localRecordHash({ kind: 'worker-boundary', actionId: v.actionId, boundary: v.boundary })
      )
        fail();
    }
    matches.push(`closure:${ref.key}`);
  }
  const latest = await port.tasks.load(scope);
  if (
    matches.length !== 1 ||
    port.isActive(scope) ||
    !latest ||
    localRecordHash(latest.workers.find((w) => w.workerId === scope.workerId)) !==
      localRecordHash(worker) ||
    localRecordHash(latest.localExecution ?? null) !== localRecordHash(state.localExecution ?? null)
  )
    fail();
  return matches[0] as string;
}
