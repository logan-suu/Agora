/** Trusted validation command selection. The caller must obtain the execution
 * from the durable command verifier, never from model-produced JSON. */
import type { TestResults, WorkspaceVersionV1 } from '@agora/core-domain';
import { canonicalJson, isLocalTestPath, isWorkspaceVersionV1 } from '@agora/core-domain';
import type {
  WorkspaceCommandRequest,
  WorkspaceCommandResult,
  WorkspaceInspection,
} from '@agora/runtime-sandbox';
import { parseTap } from '@agora/tools-test';

function validationCommand(
  input: WorkspaceInspection,
  kind: 'files' | 'git',
  expectedCommit?: string,
): WorkspaceCommandRequest {
  if (!isWorkspaceVersionV1(input.version) || input.version.kind !== kind)
    throw Error('invalid_local_validation_version');
  if (kind === 'git' && (input.version.kind !== 'git' || input.version.commit !== expectedCommit))
    throw Error('invalid_local_validation_version');
  // A native Node verifier must not silently omit tests that need a different
  // runner or preparation step. Those projects require a supported adapter.
  if (
    input.files.some(
      (file) => /\.(?:test|spec)\.[^/]+$/.test(file.path) && !isLocalTestPath(file.path),
    ) ||
    (kind === 'git' && input.excludedPaths.some((path) => /\.(?:test|spec)\.[^/]+$/.test(path)))
  )
    throw Error('local_validation_test_set_unavailable');
  const paths = input.files
    .map((file) => file.path)
    .filter(isLocalTestPath)
    .sort();
  if (!paths.length || paths.length > 253 || new Set(paths).size !== paths.length)
    throw Error('local_validation_test_set_unavailable');
  return {
    toolId: 'node',
    argv: ['--test', '--test-reporter=tap', ...paths.map((path) => `@input/${path}`)],
    inputVersion: structuredClone(input.version),
    outputRoot: 'private-per-operation',
    networkGrantId: null,
    timeoutMs: 30000,
  };
}

export function localValidationCommand(input: WorkspaceInspection): WorkspaceCommandRequest {
  return validationCommand(input, 'files');
}

/** Select tests only from a separately qualified Git manifest. The caller
 * must prove the manifest and commit before this request reaches a command. */
export function localGitValidationCommand(
  input: WorkspaceInspection,
  expectedCommit: string,
): WorkspaceCommandRequest {
  return validationCommand(input, 'git', expectedCommit);
}

/** A complete failed test run remains evidence. Truncation, timeout, skipped or
 * cancelled tests cannot produce a qualified result. */
function parseValidationResult(run: WorkspaceCommandResult, kind: 'files' | 'git'): TestResults {
  if (
    run.stage !== 'exited' ||
    !run.quiescent ||
    run.timedOut ||
    run.reason !== 'none' ||
    !Number.isSafeInteger(run.exitCode) ||
    (run.exitCode as number) < 0 ||
    !isWorkspaceVersionV1(run.inputVersion) ||
    run.inputVersion.kind !== kind
  )
    throw Error('local_validation_execution_incomplete');
  const summary = parseTap(run.stdout);
  const count = (name: string) => {
    const matches = [...run.stdout.matchAll(new RegExp(`^# ${name} ([0-9]+)$`, 'gm'))];
    if (matches.length !== 1) throw Error('local_validation_report_incomplete');
    return Number(matches[0]?.[1]);
  };
  if (
    !run.stdout.startsWith('TAP version 13\n') ||
    count('tests') !== summary.total ||
    count('pass') !== summary.passed ||
    count('fail') !== summary.failed ||
    count('skipped') !== 0 ||
    count('cancelled') !== 0 ||
    !Number.isSafeInteger(summary.total) ||
    summary.total <= 0 ||
    summary.passed + summary.failed !== summary.total ||
    summary.failures.length !== summary.failed ||
    (run.exitCode === 0) !== (summary.failed === 0)
  )
    throw Error('local_validation_report_incomplete');
  return {
    passed: summary.failed === 0,
    total: summary.total,
    failed: summary.failed,
    failures: summary.failures,
    workspaceVersion: structuredClone(run.inputVersion),
    ...(summary.coverage === undefined ? {} : { coverage: summary.coverage }),
  };
}

export function parseLocalValidationResult(run: WorkspaceCommandResult): TestResults {
  return parseValidationResult(run, 'files');
}

export function parseLocalGitValidationResult(
  run: WorkspaceCommandResult,
  expectedVersion: WorkspaceVersionV1,
): TestResults {
  if (
    !isWorkspaceVersionV1(expectedVersion) ||
    expectedVersion.kind !== 'git' ||
    canonicalJson(run.inputVersion) !== canonicalJson(expectedVersion)
  )
    throw Error('local_validation_execution_incomplete');
  return parseValidationResult(run, 'git');
}
