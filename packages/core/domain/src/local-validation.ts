/** Immutable evidence data. Only trusted validation services may produce these
 * messages; parsing data does not grant filesystem or execution authority. */
import { assertLocalExecutionState } from './local-execution';
import { isWorkspaceVersionV1, type WorkspaceVersionV1 } from './local-workspace';
import { canonicalJson, currentReviewDispatch, isStrictTestResults } from './parallel-execution';
import type { AppState, Message, TestResults } from './state';

export interface LocalValidationReceipt {
  kind: 'workspace_validation';
  version: 1;
  projectId: string;
  taskId: string;
  dispatchId: string;
  workerId: string;
  sourceWorkspaceId: string;
  validationWorkspaceId: string;
  workspaceVersion: WorkspaceVersionV1;
  controlFingerprint: string;
  toolchainHash: string;
  policyHash: string;
  dependenciesHash: string;
  commandReceiptId: string;
  commandInputHash: string;
  testPaths: string[];
  results: TestResults & { workspaceVersion: WorkspaceVersionV1 };
  execution: { exitCode: number; timedOut: false; quiescent: true };
}
export interface LocalReviewBinding {
  kind: 'workspace_review';
  version: 1;
  validationReceiptId: string;
  sourceWorkspaceId: string;
  workspaceVersion: WorkspaceVersionV1;
  controlFingerprint: string;
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function record(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(v).every((key) => {
      const d = Object.getOwnPropertyDescriptor(v, key);
      return typeof key === 'string' && d?.enumerable === true && Object.hasOwn(d, 'value');
    })
  );
}
const exact = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length && names.every((name) => Object.hasOwn(v, name));
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function isLocalTestPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    /\.(?:test|spec)\.(?:mjs|cjs|js)$/.test(value) &&
    value
      .split('/')
      .every(
        (part) =>
          !!part &&
          part !== '.' &&
          part !== '..' &&
          !part.startsWith('.env') &&
          part !== '.git' &&
          part !== '.agora-operations' &&
          [...part].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127 && c !== '\\'),
      )
  );
}
export function isLocalValidationReceipt(v: unknown): v is LocalValidationReceipt {
  if (
    !record(v) ||
    !exact(v, [
      'kind',
      'version',
      'projectId',
      'taskId',
      'dispatchId',
      'workerId',
      'sourceWorkspaceId',
      'validationWorkspaceId',
      'workspaceVersion',
      'controlFingerprint',
      'toolchainHash',
      'policyHash',
      'dependenciesHash',
      'commandReceiptId',
      'commandInputHash',
      'testPaths',
      'results',
      'execution',
    ]) ||
    v.kind !== 'workspace_validation' ||
    v.version !== 1 ||
    ![
      'projectId',
      'taskId',
      'dispatchId',
      'workerId',
      'sourceWorkspaceId',
      'validationWorkspaceId',
      'commandReceiptId',
    ].every((key) => id(v[key])) ||
    ![
      'controlFingerprint',
      'toolchainHash',
      'policyHash',
      'dependenciesHash',
      'commandInputHash',
    ].every((key) => hash(v[key])) ||
    v.sourceWorkspaceId === v.validationWorkspaceId ||
    !isWorkspaceVersionV1(v.workspaceVersion) ||
    v.workspaceVersion.kind !== 'files' ||
    !Array.isArray(v.testPaths) ||
    v.testPaths.length === 0 ||
    v.testPaths.length > 4096 ||
    !v.testPaths.every(isLocalTestPath) ||
    new Set(v.testPaths).size !== v.testPaths.length ||
    !record(v.results) ||
    !record(v.execution) ||
    !exact(v.execution, ['exitCode', 'timedOut', 'quiescent']) ||
    !Number.isSafeInteger(v.execution.exitCode) ||
    (v.execution.exitCode as number) < 0 ||
    v.execution.timedOut !== false ||
    v.execution.quiescent !== true
  )
    return false;
  const { workspaceVersion, ...results } = v.results;
  return (
    isWorkspaceVersionV1(workspaceVersion) &&
    equal(workspaceVersion, v.workspaceVersion) &&
    isStrictTestResults(results) &&
    results.passed === (v.execution.exitCode === 0)
  );
}
export function isLocalReviewBinding(v: unknown): v is LocalReviewBinding {
  return (
    record(v) &&
    exact(v, [
      'kind',
      'version',
      'validationReceiptId',
      'sourceWorkspaceId',
      'workspaceVersion',
      'controlFingerprint',
    ]) &&
    v.kind === 'workspace_review' &&
    v.version === 1 &&
    id(v.validationReceiptId) &&
    id(v.sourceWorkspaceId) &&
    hash(v.controlFingerprint) &&
    isWorkspaceVersionV1(v.workspaceVersion) &&
    v.workspaceVersion.kind === 'files'
  );
}
const dispatchFor = (m: Message, role: string) =>
  m.fromRole === 'COORDINATOR' &&
  m.channelId === 'main' &&
  m.type === 'announce' &&
  m.payload.nextRole === role;

export function localValidationReceipt(state: AppState, receiptId: string): LocalValidationReceipt {
  assertLocalExecutionState(state);
  const matches = state.messages.filter((m) => m.msgId === receiptId);
  const message = matches[0];
  if (
    matches.length !== 1 ||
    !message ||
    message.fromRole !== 'COORDINATOR' ||
    message.channelId !== 'main' ||
    message.type !== 'announce' ||
    !isLocalValidationReceipt(message.payload)
  )
    throw Error('invalid_local_validation_receipt');
  const receipt = message.payload;
  const dispatches = state.messages.filter((m) => m.msgId === receipt.dispatchId);
  const dispatch = dispatches[0];
  const worker = state.workers.filter((w) => w.workerId === receipt.workerId);
  const source = state.localExecution?.workspaces.filter(
    (w) => w.workspaceId === receipt.sourceWorkspaceId,
  );
  const validation = state.localExecution?.workspaces.filter(
    (w) => w.workspaceId === receipt.validationWorkspaceId,
  );
  const binding = state.localExecution?.bindings.filter((b) => b.workerId === receipt.workerId);
  if (
    receiptId !== `workspace-validation:${receipt.dispatchId}` ||
    receipt.projectId !== state.projectId ||
    receipt.taskId !== state.taskId ||
    dispatches.length !== 1 ||
    !dispatch ||
    !dispatchFor(dispatch, 'TESTER') ||
    state.messages.indexOf(dispatch) >= state.messages.indexOf(message) ||
    message.ts < dispatch.ts ||
    worker.length !== 1 ||
    worker[0]?.role !== 'TESTER' ||
    binding?.length !== 1 ||
    binding[0]?.workspaceId !== receipt.validationWorkspaceId ||
    binding[0]?.subtaskId !== worker[0]?.subtaskId ||
    source?.length !== 1 ||
    source[0]?.purpose !== 'coding' ||
    source[0]?.mode !== 'direct' ||
    validation?.length !== 1 ||
    validation[0]?.purpose !== 'validation' ||
    validation[0]?.mode !== 'direct' ||
    validation[0].baselineManifestId !== receipt.workspaceVersion.manifestId ||
    [source[0], validation[0]].some(
      (w) => w.projectId !== state.projectId || w.taskId !== state.taskId,
    ) ||
    source[0].rootId !== validation[0].rootId ||
    source[0].grantId !== validation[0].grantId
  )
    throw Error('local_validation_binding_changed');
  return structuredClone(receipt);
}

/** Current canonical data only. The caller must also verify the private command
 * receipt and live source mapping before review, approval, application or archive. */
export function localReviewBindingForValidation(state: AppState): LocalReviewBinding {
  const latestTest = [...state.messages].reverse().find((m) => dispatchFor(m, 'TESTER'));
  if (!latestTest) throw Error('local_review_requires_validation');
  const validationReceiptId = `workspace-validation:${latestTest.msgId}`;
  const receipt = localValidationReceipt(state, validationReceiptId);
  if (!receipt.results.passed || !equal(state.testResults, receipt.results))
    throw Error('local_review_requires_passing_validation');
  return {
    kind: 'workspace_review',
    version: 1,
    validationReceiptId,
    sourceWorkspaceId: receipt.sourceWorkspaceId,
    workspaceVersion: receipt.workspaceVersion,
    controlFingerprint: receipt.controlFingerprint,
  };
}

export function currentLocalCompletionEvidence(state: AppState): LocalReviewBinding {
  const dispatch = currentReviewDispatch(state);
  const binding = dispatch?.payload.workspaceReviewBinding;
  if (!dispatch || !dispatchFor(dispatch, 'REVIEWER') || !isLocalReviewBinding(binding))
    throw Error('local_review_requires_validation');
  const receipt = localValidationReceipt(state, binding.validationReceiptId);
  const latestTest = [...state.messages].reverse().find((m) => dispatchFor(m, 'TESTER'));
  const receiptIndex = state.messages.findIndex((m) => m.msgId === binding.validationReceiptId);
  if (
    latestTest?.msgId !== receipt.dispatchId ||
    receiptIndex >= state.messages.indexOf(dispatch) ||
    !receipt.results.passed ||
    !equal(state.testResults, receipt.results) ||
    !equal(binding.workspaceVersion, receipt.workspaceVersion) ||
    binding.sourceWorkspaceId !== receipt.sourceWorkspaceId ||
    binding.controlFingerprint !== receipt.controlFingerprint
  )
    throw Error('local_completion_evidence_changed');
  return structuredClone(binding);
}
