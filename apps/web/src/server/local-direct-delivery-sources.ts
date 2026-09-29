/** Historical direct B/A proof plus independently captured live U. Read-only;
 * the caller still owns serial admission, round registration and application. */
import {
  canonicalJson,
  currentLocalCompletionEvidence,
  deliveryValidationDispatch,
  localValidationReceipt,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { WorkspaceValidationEvidencePort } from '@agora/runtime-sandbox';
import type { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalDeliverySources } from '../../../../packages/runtime/sandbox/src/local-delivery-comparison-record';
import type { LocalDirectDeliveryCurrentSource } from '../../../../packages/runtime/sandbox/src/local-delivery-current';
import { localRecordHash } from '../../../../packages/runtime/sandbox/src/local-registry-records';
import type { LocalVersionStore } from '../../../../packages/runtime/sandbox/src/local-version-store';
import { localControlFingerprint } from './local-validation';
import { localValidationCommand, parseLocalValidationResult } from './local-validation-command';

type Scope = { projectId: string; taskId: string };
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const fileVersion = (manifestId: string): WorkspaceVersionV1 => {
  if (!/^manifest:[a-f0-9]{64}$/.test(manifestId)) throw Error('delivery_baseline_invalid');
  return { kind: 'files', manifestId, manifestHash: manifestId.slice(9) };
};

export class LocalDirectDeliverySources {
  constructor(
    private readonly control: Pick<LocalBindingCoordinator, 'assertClosed'>,
    private readonly current: Pick<LocalDirectDeliveryCurrentSource, 'capture'>,
    private readonly versions: LocalVersionStore,
    private readonly evidence: Pick<WorkspaceValidationEvidencePort, 'verifyCommand'>,
  ) {}

  async read(scope: Scope): Promise<LocalDeliverySources> {
    const state = await this.control.assertClosed(scope);
    const binding = currentLocalCompletionEvidence(state);
    const receipt = localValidationReceipt(state, binding.validationReceiptId);
    const source = state.localExecution?.workspaces.filter(
      (workspace) => workspace.purpose === 'coding' && workspace.mode === 'direct',
    );
    const round = receipt.roundId === undefined ? undefined : deliveryValidationDispatch(state);
    const coding = state.localExecution?.workspaces.find(
      (workspace) => workspace.workspaceId === receipt.sourceWorkspaceId,
    );
    if (
      (receipt.roundId === undefined && coding?.purpose !== 'coding') ||
      (receipt.roundId !== undefined &&
        (!round ||
          round.round.roundId !== receipt.roundId ||
          round.workerId !== receipt.workerId ||
          coding?.purpose !== 'validation' ||
          receipt.sourceWorkspaceId !== receipt.validationWorkspaceId ||
          !equal(round.workspaceVersion, receipt.workspaceVersion)))
    )
      throw Error('delivery_historical_source_invalid');
    const origins = source?.map((workspace) => {
      const refs = state.localExecution?.bindings.filter(
        (entry) => entry.workspaceId === workspace.workspaceId,
      );
      const entry = refs?.[0];
      const records = state.localExecution?.receipts.filter(
        (record) => record.receiptId === entry?.receiptId,
      );
      if (refs?.length !== 1 || !entry || records?.length !== 1 || !records[0])
        throw Error('delivery_historical_source_invalid');
      return { workspace, binding: entry, revision: records[0].registryRevision };
    });
    origins?.sort((left, right) => left.revision - right.revision);
    const origin = origins?.[0];
    const sourceBinding = origin?.binding;
    if (
      coding?.mode !== 'direct' ||
      !origin ||
      origin.workspace.mode !== 'direct' ||
      !sourceBinding ||
      (origins?.length !== 1 && origins?.[1]?.revision === origin.revision) ||
      source?.some(
        (workspace) => workspace.rootId !== coding.rootId || workspace.grantId !== coding.grantId,
      ) ||
      localControlFingerprint(state) !== receipt.controlFingerprint
    )
      throw Error('delivery_historical_source_invalid');
    const baseline = fileVersion(origin.workspace.baselineManifestId);
    const artifact = receipt.workspaceVersion;
    const current = await this.current.capture(scope);
    if (
      coding.rootId !== current.scope.rootId ||
      coding.grantId !== current.grantId ||
      artifact.kind !== 'files' ||
      current.goal !== state.localExecution?.delivery?.goal
    )
      throw Error('delivery_historical_source_invalid');
    const baselineManifest = await this.versions.read(baseline, current.scope);
    const artifactManifest = await this.versions.read(artifact, current.scope);
    if (
      baselineManifest.projectId !== scope.projectId ||
      artifactManifest.projectId !== scope.projectId
    )
      throw Error('delivery_historical_source_invalid');
    const observed = await this.evidence.verifyCommand(
      { ...scope, workspaceId: receipt.validationWorkspaceId },
      receipt.commandReceiptId,
    );
    const expected = localValidationCommand({
      version: artifact,
      files: artifactManifest.files.map(({ path, version }) => ({ path, version })),
      excludedPaths: artifactManifest.excludedPaths,
    });
    if (
      !equal(observed.request, expected) ||
      !equal(
        expected.argv.slice(2).map((path) => path.slice(7)),
        receipt.testPaths,
      ) ||
      observed.command.workerId !== receipt.workerId ||
      observed.command.inputHash !== receipt.commandInputHash ||
      observed.command.policyHash !== receipt.policyHash ||
      observed.toolchainHash !== receipt.toolchainHash ||
      observed.dependenciesHash !== receipt.dependenciesHash ||
      !equal(observed.command.inputVersion, artifact) ||
      !equal(parseLocalValidationResult(observed.command), receipt.results) ||
      observed.command.exitCode !== receipt.execution.exitCode
    )
      throw Error('delivery_validation_evidence_changed');
    if (localRecordHash(await this.control.assertClosed(scope)) !== localRecordHash(state))
      throw Error('delivery_historical_source_changed');
    return {
      scope: current.scope,
      baseline,
      artifact,
      current: current.version,
      grantId: current.grantId,
      grantRevision: current.grantRevision,
      goal: current.goal,
      sourceReceipts: {
        baseline: sourceBinding.receiptId,
        artifact: binding.validationReceiptId,
        current: current.sourceReceiptId,
      },
      targetIndexHash: null,
      controlFingerprint: receipt.controlFingerprint,
    };
  }
}
