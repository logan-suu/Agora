/** Derive a first-TESTER registration request from the canonical dispatch.
 * This is L2 control planning only; physical provenance and binding remain L4. */
import {
  type AppState,
  canonicalJson,
  isWorkspaceVersionV1,
  type RoleSpec,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type {
  ValidationDispatchCall,
  ValidationDispatchScope,
  ValidationGitRegistrationRequest,
} from '@agora/runtime-sandbox';
import type { ParallelDecisionContext } from './parallel-coordinator';
import {
  type InitialValidationDispatchPlan,
  initialValidationDispatchChanges,
} from './validation-dispatch-plan';

type RegistryView = {
  revision: number;
  roots: { rootId: string; projectId: string }[];
  grants: { grantId: string; rootId: string; projectId: string; status: string }[];
  workspaces: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    rootId: string;
    grantId: string;
    purpose: string;
    mode: string;
  }[];
  claims: { claimId: string; workspaceId: string; status: string }[];
  operations?: { actionId: string }[];
};
type Input = {
  scope: ValidationDispatchScope;
  planHash: string;
  actionId: string;
  validationWorkspaceId: string;
  call: ValidationDispatchCall;
  version: WorkspaceVersionV1;
  plan: InitialValidationDispatchPlan;
  current: AppState;
  registry: RegistryView;
};
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);

/** Caller provides only facts read from the exclusive durable slot and current
 * control stores. This does not admit a TESTER or mutate either store. */
export function createInitialValidationRegistrationRequest(
  input: Input,
  context: ParallelDecisionContext,
  roster: readonly RoleSpec[],
): ValidationGitRegistrationRequest {
  const { scope, call, plan, current, registry, version } = structuredClone(input);
  const wave = current.parallelExecution?.activeWave;
  const integration = current.integration;
  const validation = wave?.validation;
  const workerId = `worker:${plan.seed.dispatchId}:0`;
  const source = registry.workspaces.find((w) => w.workspaceId === call.workspaceId);
  const root = registry.roots.find((r) => r.rootId === source?.rootId);
  const grant = registry.grants.find((g) => g.grantId === source?.grantId);
  const claim = registry.claims.find((c) => c.claimId === call.claimId);
  if (
    !id(input.actionId) ||
    input.actionId.length > 120 ||
    !id(input.validationWorkspaceId) ||
    !/^[a-f0-9]{64}$/.test(input.planHash) ||
    !Number.isSafeInteger(registry.revision) ||
    registry.revision < 0 ||
    !isWorkspaceVersionV1(version) ||
    version.kind !== 'git' ||
    !equal(current, plan.after) ||
    initialValidationDispatchChanges(current, plan, context, roster).length !== 0 ||
    !equal(scope, {
      projectId: current.projectId,
      taskId: current.taskId,
      waveId: wave?.waveId,
      attempt: wave?.attempt,
      integrationId: integration?.integrationId,
    }) ||
    !equal(
      { projectId: call.projectId, taskId: call.taskId, integrationId: call.integrationId },
      {
        projectId: scope.projectId,
        taskId: scope.taskId,
        integrationId: scope.integrationId,
      },
    ) ||
    integration?.status !== 'done' ||
    integration.resultCommit !== version.commit ||
    validation?.dispatchId !== plan.seed.dispatchId ||
    validation.workerId !== workerId ||
    validation.inputCommit !== version.commit ||
    current.phase !== 'testing' ||
    current.humanGate !== undefined ||
    current.workers.find((w) => w.workerId === workerId)?.status !== 'pending' ||
    current.workers.find((w) => w.workerId === workerId)?.role !== 'TESTER' ||
    current.workers.find((w) => w.workerId === workerId)?.worktree !== undefined ||
    current.workers.find((w) => w.workerId === workerId)?.subtaskId !== undefined ||
    input.validationWorkspaceId === call.workspaceId ||
    registry.workspaces.some((w) => w.workspaceId === input.validationWorkspaceId) ||
    registry.operations?.some((o) => o.actionId === input.actionId) ||
    source?.projectId !== scope.projectId ||
    source.taskId !== scope.taskId ||
    source.purpose !== 'integration' ||
    source.mode !== 'linked-worktree' ||
    root?.projectId !== scope.projectId ||
    grant?.projectId !== scope.projectId ||
    grant.rootId !== root.rootId ||
    grant.status !== 'active' ||
    claim?.workspaceId !== call.workspaceId ||
    claim.status !== 'released'
  )
    throw Error('initial_validation_registration_mismatch');
  return {
    ...scope,
    planHash: input.planHash,
    dispatchId: plan.seed.dispatchId,
    actionId: input.actionId,
    rootId: root.rootId,
    grantId: grant.grantId,
    expectedRevision: registry.revision,
    sourceWorkspaceId: call.workspaceId,
    version,
    targets: [{ purpose: 'validation', workspaceId: input.validationWorkspaceId, workerId }],
  };
}
