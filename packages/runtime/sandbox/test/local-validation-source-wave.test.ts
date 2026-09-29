// Pure canonical control fixtures; the real Git and native source are checked by registration.
import { createInitialAppState, type Message } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { assertValidationSourceWave } from '../src/local-validation-source-wave';

const original = 'a'.repeat(40);
const accepted = 'b'.repeat(40);
const result = 'c'.repeat(40);
const message = (msgId: string, payload: Message['payload']): Message => ({
  msgId,
  payload,
  channelId: 'main',
  fromRole: 'COORDINATOR',
  type: 'announce',
  ts: 1,
  display: 'Control fixture',
});

function fixture(later: boolean) {
  const state = createInitialAppState('task', 'Code', 'project');
  state.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: [],
    workspaces: [],
    bindings: [],
    receipts: [],
    git: { version: 1, initialWorkspaceId: 'initial', worktrees: [] },
  };
  state.parallelExecution = {
    version: 1,
    planId: 'plan',
    initialBase: { branch: 'initial', commit: original },
    ...(later ? { acceptedReceiptId: 'wave-validation:previous-dispatch' } : {}),
  };
  state.integration = {
    integrationId: 'current',
    waveId: 'current-wave',
    base: later
      ? { branch: 'accepted-branch', commit: accepted }
      : { branch: 'initial-branch', commit: original },
    integrationWorktree: {
      path: '/owned/current',
      branch: 'current-branch',
      baseCommit: later ? accepted : original,
      headCommit: result,
    },
    pendingBranches: [],
    mergedBranches: [],
    conflicts: [],
    status: 'done',
    resultCommit: result,
  };
  if (later) {
    state.workers.push({
      workerId: 'worker:previous-dispatch:0',
      role: 'TESTER',
      executor: 'harness',
      status: 'done',
      startedTs: 1,
    });
    state.messages.push(
      message('previous-dispatch', {
        kind: 'wave_validation_dispatch',
        planId: 'plan',
        waveId: 'previous-wave',
        attempt: 1,
        integrationId: 'previous-integration',
        inputCommit: original,
        subtaskIds: ['A'],
      }),
      message('wave-validation:previous-dispatch', {
        kind: 'wave_validation',
        version: 1,
        planId: 'plan',
        waveId: 'previous-wave',
        attempt: 1,
        dispatchId: 'previous-dispatch',
        workerId: 'worker:previous-dispatch:0',
        integrationId: 'previous-integration',
        inputCommit: original,
        worktree: {
          path: '/owned/accepted',
          branch: 'accepted-branch',
          baseCommit: original,
          headCommit: accepted,
        },
        subtaskIds: ['A'],
        controlFingerprint: 'c'.repeat(64),
        results: { passed: true, total: 1, failed: 0, failures: [] },
        evidence: {
          path: 'validation/previous-dispatch.json',
          sha256: 'd'.repeat(64),
          exitCode: 0,
          timedOut: false,
        },
      }),
    );
  }
  return state;
}

it('keeps first validation on the original integration source', () => {
  const state = fixture(false);
  expect(() => assertValidationSourceWave(state, 'initial', original)).not.toThrow();
  expect(() => assertValidationSourceWave(state, 'later', original)).toThrow(
    'workspace_validation_source_mismatch',
  );
});

it('requires a later dedicated integration source based on the accepted HEAD', () => {
  const state = fixture(true);
  expect(() => assertValidationSourceWave(state, 'later', accepted)).not.toThrow();
  expect(() => assertValidationSourceWave(state, 'initial', accepted)).toThrow(
    'workspace_validation_source_mismatch',
  );
  expect(() => assertValidationSourceWave(state, 'later', original)).toThrow(
    'workspace_validation_source_mismatch',
  );
  if (!state.integration) throw Error('missing integration fixture');
  state.integration.base.branch = 'forged-branch';
  expect(() => assertValidationSourceWave(state, 'later', accepted)).toThrow(
    'workspace_validation_source_mismatch',
  );
});
