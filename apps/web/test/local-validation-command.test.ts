import type { WorkspaceCommandResult, WorkspaceInspection } from '@agora/runtime-sandbox';
import { describe, expect, it } from 'vitest';
import {
  localGitValidationCommand,
  localValidationCommand,
  parseLocalGitValidationResult,
  parseLocalValidationResult,
} from '../src/server/local-validation-command';

// Pure command/report contract fixtures, not execution or G5 evidence.
const version = { kind: 'files' as const, manifestId: 'manifest:1', manifestHash: 'a'.repeat(64) };
function inspection(paths: string[]): WorkspaceInspection {
  return {
    version,
    excludedPaths: ['.env'],
    files: paths.map((path) => ({
      path,
      version: {
        kind: 'regular',
        identity: '1:2',
        sha256: 'b'.repeat(64),
        size: 1,
        executable: false,
        metadataHash: 'c'.repeat(64),
      },
    })),
  };
}
function execution(): WorkspaceCommandResult {
  return {
    schemaVersion: 'workspace-command-receipt-v1',
    projectId: 'project',
    taskId: 'task',
    workspaceId: 'validation',
    workerId: 'tester',
    actionId: 'validate',
    grantRevision: 1,
    writerEpoch: 0,
    receiptId: 'run:1',
    commandId: 'command:1',
    inputHash: 'd'.repeat(64),
    canonicalSourceRef: 'binding:1',
    inputVersion: version,
    policyHash: 'e'.repeat(64),
    toolVersion: '24.20.0',
    stage: 'exited',
    createdAt: 2,
    startedAt: 1,
    finishedAt: 2,
    exitCode: 0,
    timedOut: false,
    quiescent: true,
    assurance: 'bounded',
    reason: 'none',
    stdoutRef: 'f'.repeat(64),
    stderrRef: 'a'.repeat(64),
    nativeRecordHash: 'b'.repeat(64),
    fixedInputHash: 'c'.repeat(64),
    stderr: '',
    stdout:
      'TAP version 13\n# Subtest: cache\nok 1 - cache\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n',
  };
}
describe('fixed local Node validation', () => {
  it('selects every supported test in stable order with exact TAP arguments', () => {
    expect(localValidationCommand(inspection(['lib.js', 'b.spec.mjs', 'a.test.cjs'])).argv).toEqual(
      ['--test', '--test-reporter=tap', '@input/a.test.cjs', '@input/b.spec.mjs'],
    );
    for (const paths of [[], ['lib.js'], ['a.test.cjs', 'a.test.cjs'], ['a.test.cjs', 'b.test.ts']])
      expect(() => localValidationCommand(inspection(paths))).toThrow();
  });
  it('requires actual successful exit and complete non-skipped TAP counts', () => {
    expect(parseLocalValidationResult(execution())).toEqual({
      passed: true,
      total: 1,
      failed: 0,
      failures: [],
      workspaceVersion: version,
    });
    for (const patch of [
      { exitCode: 1 },
      { timedOut: true },
      { quiescent: false },
      { reason: 'source_version_changed' },
      { stdout: execution().stdout.replace('# skipped 0', '# skipped 1') },
      { stdout: execution().stdout.replace('# cancelled 0', '# cancelled 1') },
      { stdout: execution().stdout.replace('# fail 0\n', '') },
      { stdout: `${execution().stdout}# pass 1\n` },
      { stdout: '1..1\n# pass 1\n' },
    ])
      expect(() =>
        parseLocalValidationResult({ ...execution(), ...patch } as WorkspaceCommandResult),
      ).toThrow();
  });
  it('preserves a complete failed run instead of converting its real exit into pass', () => {
    const run = execution();
    run.exitCode = 1;
    run.stdout = run.stdout
      .replace('ok 1 - cache', 'not ok 1 - cache')
      .replace('# pass 1', '# pass 0')
      .replace('# fail 0', '# fail 1');
    expect(parseLocalValidationResult(run)).toMatchObject({
      passed: false,
      total: 1,
      failed: 1,
      workspaceVersion: version,
    });
  });
});

describe('fixed Git Worktree Node validation input', () => {
  const commit = '1'.repeat(40);
  const gitVersion = {
    kind: 'git' as const,
    commit,
    manifestId: `manifest:${'2'.repeat(64)}`,
    manifestHash: '2'.repeat(64),
  };
  const gitInspection = (paths: string[]): WorkspaceInspection => ({
    ...inspection(paths),
    version: gitVersion,
  });

  it('fixes the complete supported test set to the qualified Git commit', () => {
    expect(
      localGitValidationCommand(gitInspection(['lib.js', 'b.spec.mjs', 'a.test.cjs']), commit),
    ).toMatchObject({
      toolId: 'node',
      argv: ['--test', '--test-reporter=tap', '@input/a.test.cjs', '@input/b.spec.mjs'],
      inputVersion: gitVersion,
      timeoutMs: 30000,
    });
    for (const candidate of [
      gitInspection([]),
      gitInspection(['a.test.cjs', 'a.test.cjs']),
      gitInspection(['a.test.cjs', 'b.test.ts']),
      { ...gitInspection(['a.test.cjs']), excludedPaths: ['hidden.test.js'] },
      inspection(['a.test.cjs']),
    ])
      expect(() => localGitValidationCommand(candidate, commit)).toThrow();
    expect(() =>
      localGitValidationCommand(gitInspection(['a.test.cjs']), '3'.repeat(40)),
    ).toThrow();
  });

  it('accepts only a complete TAP result for the fixed Git version', () => {
    const run = { ...execution(), inputVersion: gitVersion };
    expect(parseLocalGitValidationResult(run, gitVersion)).toEqual({
      passed: true,
      total: 1,
      failed: 0,
      failures: [],
      workspaceVersion: gitVersion,
    });
    for (const patch of [
      { timedOut: true },
      { quiescent: false },
      { stdout: run.stdout.replace('# skipped 0', '# skipped 1') },
      { inputVersion: version },
      { inputVersion: { ...gitVersion, commit: '3'.repeat(40) } },
    ])
      expect(() => parseLocalGitValidationResult({ ...run, ...patch }, gitVersion)).toThrow();
  });
});
