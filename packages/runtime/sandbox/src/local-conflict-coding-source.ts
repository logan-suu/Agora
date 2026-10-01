/** Prove the original coding base through a closed native conflict and Leader receipt. */
import {
  type AppState,
  canonicalJson,
  readCodingWorkerLineage,
  validationReceipt,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import { readConflictReworkHistory } from './local-conflict-rework-records';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalGitWorkspaces } from './local-git-workspaces';
import type {
  LocalIntegrationAuthority,
  LocalIntegrationCall,
} from './local-integration-authority';
import type { LocalIntegrationCandidates } from './local-integration-candidates';
import { completionApplications } from './local-integration-completion-records';
import { localRecordHash } from './local-registry-records';

const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
export class LocalConflictCodingSource {
  constructor(
    private readonly options: {
      control: LocalBindingCoordinator;
      objects: LocalControlObjects;
      authority: LocalIntegrationAuthority;
      candidates: LocalIntegrationCandidates;
      workspaces: LocalGitWorkspaces;
    },
  ) {}
  async read(expected: AppState) {
    const state = await this.options.control.assertClosed(expected),
      snapshot = await this.options.control.snapshot();
    if (canonicalJson(state) !== canonicalJson(expected) || state.humanGate)
      throw Error('integration_conflict_rework_mismatch');
    const lineage = readCodingWorkerLineage(state),
      rework = lineage.conflictReworks.at(-1);
    if (!rework || !same(rework.integration.base, lineage.base))
      throw Error('integration_conflict_rework_mismatch');
    const claim = snapshot.claims.find(
      (c) =>
        c.kind === 'integration' &&
        c.projectId === state.projectId &&
        c.taskId === state.taskId &&
        c.integrationId === rework.integration.integrationId,
    );
    if (claim?.kind !== 'integration' || claim.status !== 'released')
      throw Error('integration_conflict_rework_mismatch');
    const call: LocalIntegrationCall = {
      projectId: claim.projectId,
      taskId: claim.taskId,
      workspaceId: claim.workspaceId,
      claimId: claim.claimId,
      integrationId: claim.integrationId,
      writerEpoch: claim.writerEpoch,
      grantRevision: claim.grantRevision,
    };
    const history = await readConflictReworkHistory(this.options.objects, call, state, snapshot);
    const reader = this.options.candidates.conflictReworkReader(call),
      proof = history.proof.conflict;
    if (
      !same(
        await reader.readOutcome({ call, actionId: proof.plan.actionId }),
        proof.plan.candidate,
      ) ||
      !same(completionApplications(await reader.readConfirmedPrefix(call)), proof.plan.applications)
    )
      throw Error('integration_conflict_evidence_changed');
    const authority = this.options.authority.conflictReworkReader(call);
    const baseline = await this.options.workspaces.readIntegrationCodingBaseline(
      {
        projectId: state.projectId,
        taskId: state.taskId,
        workerId: proof.plan.candidate.sources.selection.branch.workerId,
      },
      authority,
      call,
    );
    const version = baseline.codingVersion;
    const manifestSourceId = lineage.sourceReceiptId
      ? proof.plan.candidate.sources.baseline.codingVersion
      : undefined;
    // The source identity comes from the original Git manifest, never a caller path.
    if (
      version.kind !== 'git' ||
      version.commit !== lineage.base.commit ||
      (manifestSourceId && !same(version, manifestSourceId))
    )
      throw Error('integration_conflict_rework_mismatch');
    const sourceWorkspaceId = lineage.sourceReceiptId
      ? state.localExecution?.bindings.find(
          (b) =>
            b.workerId === validationReceipt(state, lineage.sourceReceiptId as string).workerId,
        )?.workspaceId
      : state.localExecution?.git?.initialWorkspaceId;
    if (
      !sourceWorkspaceId ||
      !same(await this.options.control.assertClosed(state), state) ||
      !same(await this.options.control.snapshot(), snapshot)
    )
      throw Error('integration_conflict_rework_mismatch');
    return { version, sourceWorkspaceId, actionId: rework.actionId };
  }
}
