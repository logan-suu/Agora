// Pure immutable archive identity checks. Native materialization and release
// recovery are covered by the real Phase 12 workspace fixtures.
import { expect, it } from 'vitest';
import { localFileArtifactKey, parseLocalFileArtifact } from '../src/local-file-artifact';
import { localRecordHash } from '../src/local-registry-records';

const scope = { projectId: 'project', taskId: 'task' };
const base = {
  schemaVersion: 'workspace-file-artifact-v1',
  ...scope,
  sourceWorkspaceId: 'validation',
  validationReceiptId: 'workspace-validation:test',
  approvalActionId: 'approve',
  workspaceVersion: { kind: 'files', manifestId: 'manifest:1', manifestHash: 'a'.repeat(64) },
  path: '/owned/artifact',
  fixedInputHash: 'b'.repeat(64),
};
it('keeps the legacy reference unchanged and separates every new round/review', () => {
  const legacy = localFileArtifactKey(scope);
  expect(legacy).toBe(localRecordHash({ kind: 'task-file-artifact', ...scope }));
  const first = localFileArtifactKey({ ...scope, roundId: 'round-1', reviewId: 'review-1' });
  const second = localFileArtifactKey({ ...scope, roundId: 'round-2', reviewId: 'review-2' });
  expect(new Set([legacy, first, second]).size).toBe(3);
  expect(parseLocalFileArtifact({ ...base, receiptId: `artifact:${legacy}` }, legacy)).toEqual({
    ...base,
    receiptId: `artifact:${legacy}`,
  });
  expect(
    parseLocalFileArtifact(
      { ...base, roundId: 'round-1', reviewId: 'review-1', receiptId: `artifact:${first}` },
      first,
    ).roundId,
  ).toBe('round-1');
});
it('rejects incomplete, forged or ambiguous archived identities', () => {
  const key = localFileArtifactKey({ ...scope, roundId: 'round', reviewId: 'review' });
  const artifact = { ...base, roundId: 'round', reviewId: 'review', receiptId: `artifact:${key}` };
  for (const altered of [
    { ...artifact, roundId: undefined },
    { ...artifact, reviewId: undefined },
    { ...artifact, receiptId: 'artifact:another' },
    { ...artifact, taskId: 'another' },
    { ...artifact, extra: true },
    { ...artifact, fixedInputHash: 'bad' },
  ])
    expect(() => parseLocalFileArtifact(altered, key)).toThrow('local_artifact_conflict');
  expect(() => parseLocalFileArtifact(artifact, localFileArtifactKey(scope))).toThrow(
    'local_artifact_conflict',
  );
});

it('preserves an exact Git version in a fixed-tree artifact without changing its key', () => {
  const key = localFileArtifactKey(scope);
  const artifact = {
    ...base,
    receiptId: `artifact:${key}`,
    workspaceVersion: { ...base.workspaceVersion, kind: 'git', commit: 'c'.repeat(40) },
  };
  expect(parseLocalFileArtifact(artifact, key)).toEqual(artifact);
  expect(() =>
    parseLocalFileArtifact(
      { ...artifact, workspaceVersion: { ...artifact.workspaceVersion, commit: 'bad' } },
      key,
    ),
  ).toThrow();
});
