/** Immutable application proof lookup. Physical admission remains the authority's job. */
import {
  type AppState,
  applyMutations,
  type Integration,
  planIntegrationAcknowledgement,
  type selectIntegrationBranch,
} from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalRootBinding } from './local-file-transaction';
import type { LocalGitWorkspaceOptions } from './local-git-workspaces';
import type { LocalIntegrationCall } from './local-integration-authority';
import type { LocalIntegrationCandidate } from './local-integration-candidates';
import type { LocalIntegrationPublicationReceipt } from './local-integration-publication';
import type { IntegrationTreeResult } from './local-integration-tree-batch';
import { localRecordHash } from './local-registry-records';
import type { LocalTreePlanInput } from './local-tree-plan';

export type ApplicationRequest = { call: LocalIntegrationCall; actionId: string };
export type ApplicationPrepared = {
  schemaVersion: 'local-integration-application-prepared-v1';
  request: ApplicationRequest;
  integration: Integration;
  selection: ReturnType<typeof selectIntegrationBranch>;
  candidate: LocalIntegrationCandidate;
  plan: LocalTreePlanInput;
  candidateActionId: string;
  treeActionId: string;
  publishActionId: string;
  gitOptions: LocalGitWorkspaceOptions;
  registryRevision: number;
  stateHash: string;
  binding: LocalRootBinding;
  sourceReceiptId: string;
};
export const applicationPhase = (key: string, stage: string) =>
  localRecordHash({ kind: 'integration-application', key, stage });
export const applicationAction = (request: ApplicationRequest) =>
  localRecordHash({
    kind: 'integration-application-action',
    projectId: request.call.projectId,
    taskId: request.call.taskId,
    actionId: request.actionId,
  });
export const applicationSlot = (
  call: Pick<LocalIntegrationCall, 'projectId' | 'taskId' | 'workspaceId' | 'integrationId'>,
  selection: Pick<ApplicationPrepared['selection'], 'waveId' | 'attempt' | 'position'>,
) =>
  localRecordHash({
    kind: 'integration-application',
    projectId: call.projectId,
    taskId: call.taskId,
    workspaceId: call.workspaceId,
    integrationId: call.integrationId,
    waveId: selection.waveId,
    attempt: selection.attempt,
    position: selection.position,
  });
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const fail = (): never => {
  throw Error('integration_application_recovery_required');
};
export function validateApplicationRequest(request: ApplicationRequest) {
  localRecordHash(request);
  if (
    Object.keys(request).sort().join(',') !== 'actionId,call' ||
    typeof request.actionId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.actionId)
  )
    fail();
}
export type CompletedApplication = {
  key: string;
  inputHash: string;
  resultHash: string;
  effectsHash: string;
  prepared: ApplicationPrepared;
  result: LocalIntegrationPublicationReceipt;
  effects: { schemaVersion: string; inputHash: string; applied: IntegrationTreeResult };
};
export async function readCompletedApplication(
  objects: LocalControlObjects,
  request: ApplicationRequest,
): Promise<CompletedApplication> {
  validateApplicationRequest(request);
  const actionHash = await objects.getReference(applicationAction(request));
  if (!actionHash) return fail();
  const action = (await objects.get(actionHash)) as {
    schemaVersion: string;
    key: string;
    inputHash: string;
  };
  const key = action.key;
  const inputHash = await objects.getReference(applicationPhase(key, 'prepared'));
  const resultHash = await objects.getReference(applicationPhase(key, 'result'));
  const effectsHash = await objects.getReference(applicationPhase(key, 'effects'));
  const completionHash = await objects.getReference(applicationPhase(key, 'completion'));
  if (
    !inputHash ||
    !resultHash ||
    !effectsHash ||
    !completionHash ||
    (await objects.getReference(applicationPhase(key, 'invalid'))) ||
    (await objects.getReference(applicationPhase(key, 'state-invalid')))
  )
    return fail();
  const prepared = (await objects.get(inputHash)) as ApplicationPrepared;
  const result = (await objects.get(resultHash)) as LocalIntegrationPublicationReceipt;
  const effects = (await objects.get(effectsHash)) as {
    schemaVersion: string;
    inputHash: string;
    applied: IntegrationTreeResult;
  };
  if (
    !equal(action, { schemaVersion: 'local-integration-application-action-v1', key, inputHash }) ||
    prepared.schemaVersion !== 'local-integration-application-prepared-v1' ||
    !equal(prepared.request, request) ||
    applicationSlot(request.call, prepared.selection) !== key ||
    !equal(prepared.selection, prepared.candidate.sources.selection) ||
    prepared.candidateActionId !== `candidate:${key}` ||
    prepared.treeActionId !== `apply:${key}` ||
    prepared.publishActionId !== `publish:${key}` ||
    result.schemaVersion !== 'local-integration-application-result-v1' ||
    result.inputHash !== inputHash ||
    result.effectsHash !== effectsHash ||
    effects.schemaVersion !== 'local-integration-application-effects-v1' ||
    effects.inputHash !== inputHash ||
    effects.applied.stage !== 'applied' ||
    !effects.applied.version ||
    !equal(await objects.get(completionHash), {
      schemaVersion: 'local-integration-application-completed-v1',
      inputHash,
      resultHash,
    })
  )
    return fail();
  return { key, inputHash, resultHash, effectsHash, prepared, result, effects };
}
export function applicationStates(
  state: AppState,
  proof: Awaited<ReturnType<typeof readCompletedApplication>>,
) {
  const { prepared, result, inputHash, resultHash } = proof;
  const before = { ...state, integration: prepared.integration };
  if (localRecordHash(before) !== prepared.stateHash) return fail();
  const expected = {
    projectId: state.projectId,
    taskId: state.taskId,
    integration: prepared.integration,
    selection: prepared.selection,
  };
  const mutations = planIntegrationAcknowledgement(state, expected, result.publication);
  const after = applyMutations(
    before,
    planIntegrationAcknowledgement(before, expected, result.publication),
  );
  const plan = {
    schemaVersion: 'local-integration-state-plan-v1',
    inputHash,
    resultHash,
    beforeStateHash: prepared.stateHash,
    afterStateHash: localRecordHash(after),
  };
  return { before, after, mutations, plan };
}

export async function checkApplicationState(
  objects: LocalControlObjects,
  state: AppState,
  proof: Awaited<ReturnType<typeof readCompletedApplication>>,
) {
  const states = applicationStates(state, proof);
  const planHash = await objects.getReference(applicationPhase(proof.key, 'state-plan'));
  if (
    (states.mutations.length === 0 && !planHash) ||
    (planHash && planHash !== localRecordHash(states.plan))
  )
    return fail();
  return states;
}

/** Walk only confirmed canonical predecessors. This checks control provenance,
 * not native/Git effects; callers must verify each returned historical proof. */
export async function readConfirmedApplicationPrefix(
  objects: LocalControlObjects,
  state: AppState,
  call: LocalIntegrationCall,
) {
  const integration = state.integration;
  const wave = state.parallelExecution?.activeWave;
  if (
    !integration ||
    !wave ||
    integration.integrationId !== call.integrationId ||
    state.projectId !== call.projectId ||
    state.taskId !== call.taskId ||
    integration.mergedBranches.length > integration.pendingBranches.length ||
    integration.mergedBranches.length > 4096
  )
    return fail();
  const proofs: (CompletedApplication & { confirmationHash: string })[] = [];
  let cursor = state;
  let child: CompletedApplication | undefined;
  for (let position = integration.mergedBranches.length - 1; position >= 0; position--) {
    const key = applicationSlot(call, { waveId: wave.waveId, attempt: wave.attempt, position });
    const inputHash = await objects.getReference(applicationPhase(key, 'prepared'));
    if (!inputHash) return fail();
    const prepared = (await objects.get(inputHash)) as ApplicationPrepared;
    const proof = await readCompletedApplication(objects, prepared.request);
    if (
      proof.key !== key ||
      !equal(prepared.request.call, call) ||
      prepared.selection.position !== position
    )
      return fail();
    const states = await checkApplicationState(objects, cursor, proof);
    const confirmationHash = await objects.getReference(applicationPhase(key, 'state-confirmed'));
    if (
      states.mutations.length ||
      !confirmationHash ||
      !equal(await objects.get(confirmationHash), {
        schemaVersion: 'local-integration-state-confirmed-v1',
        planHash: localRecordHash(states.plan),
        resultHash: proof.resultHash,
        stateHash: localRecordHash(states.after),
      })
    )
      return fail();
    if (
      child &&
      (!equal(child.prepared.candidate.predecessor, {
        inputHash,
        resultHash: proof.resultHash,
        confirmationHash,
      }) ||
        !equal(child.prepared.candidate.targetVersion, proof.result.version))
    )
      return fail();
    proofs.push({ ...proof, confirmationHash });
    cursor = states.before;
    child = proof;
  }
  if (child?.prepared.candidate.predecessor !== undefined) return fail();
  return proofs;
}
