/** Trusted pre-lease registration for canonical native coding retries. */
import {
  type AppState,
  canonicalJson,
  readCodingWorkerLineage,
  validationReceipt,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalControlObjects } from '../../../../packages/runtime/sandbox/src/local-control-objects';
import type { LocalGitWorkspaces } from '../../../../packages/runtime/sandbox/src/local-git-workspaces';
import { localRecordHash } from '../../../../packages/runtime/sandbox/src/local-registry-records';

type Scope = { projectId: string; taskId: string };
type Registration = Parameters<LocalGitWorkspaces['registerCodingWave']>[0];
type Options = {
  control: LocalBindingCoordinator;
  objects: LocalControlObjects;
  workspaces: Pick<
    LocalGitWorkspaces,
    'registerCodingWave' | 'resolveAssignment' | 'readAcceptedCodingBaseline' | 'readCodingBaseline'
  >;
  verifyReceipt(state: AppState, receiptId: string): Promise<WorkspaceVersionV1>;
  runTaskSerial<T>(scope: Scope, operation: () => Promise<T>): Promise<T>;
};
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
// Reducer commits retain cleared optional fields in memory; persisted State omits them.
const sameState = (a: AppState, b: AppState) => canonicalJson(a) === canonicalJson(b);

export class LocalCodingPreparation {
  constructor(private readonly options: Options) {}

  async prepare(input: AppState): Promise<AppState> {
    const expected = structuredClone(input);
    const scope = { projectId: expected.projectId, taskId: expected.taskId };
    return this.options.runTaskSerial(scope, async () => {
      const { control, objects, workspaces } = this.options;
      if (
        !sameState(await control.assertClosed(scope), expected) ||
        expected.phase !== 'coding' ||
        expected.humanGate ||
        !expected.localExecution?.git
      )
        throw Error('local_coding_preparation_changed');
      const lineage = readCodingWorkerLineage(expected);
      const pending = lineage.assignments.filter(
        (a) => expected.workers.find((w) => w.workerId === a.workerId)?.status === 'pending',
      );
      const missing = pending.filter(
        (a) => !expected.localExecution?.bindings.some((b) => b.workerId === a.workerId),
      );
      if (missing.length) {
        // A partially registered batch cannot silently choose a new transaction.
        if (missing.length !== pending.length || !lineage.sourceReceiptId)
          throw Error('local_coding_registration_required');
        const receipt = validationReceipt(expected, lineage.sourceReceiptId);
        const sourceId = expected.localExecution.bindings.find(
          (b) => b.workerId === receipt.workerId,
        )?.workspaceId;
        const source = expected.localExecution.workspaces.find((w) => w.workspaceId === sourceId);
        if (source?.mode !== 'linked-worktree' || source.purpose !== 'validation')
          throw Error('local_coding_source_required');
        const version = await this.options.verifyReceipt(expected, lineage.sourceReceiptId);
        const identity = {
          ...scope,
          waveId: lineage.waveId,
          attempt: lineage.attempt,
          workerIds: pending.map((a) => a.workerId),
        };
        const key = localRecordHash({ kind: 'coding-registration', ...identity });
        const saved = await objects.getReference(key);
        let request: Registration;
        if (saved) {
          request = (await objects.get(saved)) as Registration;
        } else {
          request = {
            ...scope,
            actionId: `coding:${key}`,
            waveId: lineage.waveId,
            attempt: lineage.attempt,
            sourceWorkspaceId: source.workspaceId,
            rootId: source.rootId,
            grantId: source.grantId,
            expectedRevision: (await control.snapshot()).revision,
            version,
            targets: pending.map((a) => ({
              workspaceId: `coding:${localRecordHash({ ...identity, workerId: a.workerId })}`,
              purpose: 'coding',
              workerId: a.workerId,
            })),
          };
          if (!sameState(await control.assertClosed(scope), expected))
            throw Error('local_coding_preparation_changed');
          await objects.bindReference(key, await objects.put(request));
        }
        if (
          !same(request.version, version) ||
          request.sourceWorkspaceId !== source.workspaceId ||
          request.actionId !== `coding:${key}` ||
          !same(
            request.targets.map((t) => (t.purpose === 'coding' ? t.workerId : null)),
            pending.map((a) => a.workerId),
          )
        )
          throw Error('local_coding_registration_changed');
        await workspaces.registerCodingWave(request);
      }
      const current = await control.assertClosed(scope);
      if (!sameState({ ...current, localExecution: expected.localExecution }, expected))
        throw Error('local_coding_preparation_changed');
      for (const assignment of pending) {
        const input = { ...scope, workerId: assignment.workerId };
        if (lineage.sourceReceiptId) await workspaces.readAcceptedCodingBaseline(input);
        else await workspaces.readCodingBaseline(input);
        await workspaces.resolveAssignment({ ...scope, workerId: assignment.workerId });
      }
      if (!sameState(await control.assertClosed(scope), current))
        throw Error('local_coding_preparation_changed');
      return current;
    });
  }
}
