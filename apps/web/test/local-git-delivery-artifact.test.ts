// Fixed verifier doubles isolate source selection and prohibit stale-Git
// fallback. Real private command/manifest evidence is covered by Phase 12.
import { type AppState, createInitialAppState, type LocalReviewBinding } from '@agora/core-domain';
import { expect, it, vi } from 'vitest';
import { selectLocalGitDeliveryArtifact } from '../src/server/local-git-delivery-sources';

const hash = 'a'.repeat(64);
const fileBinding: LocalReviewBinding = {
  kind: 'workspace_review',
  version: 1,
  roundId: 'round-new',
  validationReceiptId: 'new-receipt',
  sourceWorkspaceId: 'candidate-new',
  workspaceVersion: { kind: 'files', manifestId: `manifest:${hash}`, manifestHash: hash },
  controlFingerprint: hash,
};
const gitBinding = {
  planId: 'plan-old',
  validationReceiptId: 'old-receipt',
  commit: 'b'.repeat(40),
  controlFingerprint: hash,
};
function state(round: string | null, payload: Record<string, unknown>): AppState {
  const result = createInitialAppState('task', 'Fixed source selection', 'project');
  // This unit supplies only fields selected here. The injected production
  // verifiers own full State and native proof validation.
  result.localExecution = {
    delivery: { currentRoundId: round },
  } as NonNullable<AppState['localExecution']>;
  result.messages.push({
    msgId: 'review',
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce',
    ts: 1,
    display: 'Review',
    payload: { nextRole: 'REVIEWER', ...payload },
  });
  return result;
}
it('requires the current round verifier and never falls back to the old Git candidate', async () => {
  const git = {
    verifiedDeliveryVersion: vi.fn(async () => ({
      kind: 'git' as const,
      commit: gitBinding.commit,
      manifestId: `manifest:${hash}`,
      manifestHash: hash,
    })),
  };
  const files = { verifyCompletion: vi.fn(async () => fileBinding) };
  const current = state('round-new', { workspaceReviewBinding: fileBinding });
  await expect(selectLocalGitDeliveryArtifact(current, git)).rejects.toThrow(
    'local_git_delivery_round_proof_required',
  );
  expect(await selectLocalGitDeliveryArtifact(current, git, files)).toEqual({
    binding: fileBinding,
    artifact: fileBinding.workspaceVersion,
  });
  files.verifyCompletion.mockRejectedValueOnce(Error('private command proof changed'));
  await expect(selectLocalGitDeliveryArtifact(current, git, files)).rejects.toThrow(
    'private command proof changed',
  );
  await expect(
    selectLocalGitDeliveryArtifact(state('round-new', { reviewBinding: gitBinding }), git, files),
  ).rejects.toThrow();
  await expect(
    selectLocalGitDeliveryArtifact(
      state('round-other', { workspaceReviewBinding: fileBinding }),
      git,
      files,
    ),
  ).rejects.toThrow();
  await expect(
    selectLocalGitDeliveryArtifact(
      state('round-new', { workspaceReviewBinding: fileBinding, reviewBinding: gitBinding }),
      git,
      files,
    ),
  ).rejects.toThrow();
  expect(git.verifiedDeliveryVersion).not.toHaveBeenCalled();
});
it('retains the original Git verifier only before a delivery round exists', async () => {
  const version = {
    kind: 'git' as const,
    commit: gitBinding.commit,
    manifestId: `manifest:${hash}`,
    manifestHash: hash,
  };
  const git = { verifiedDeliveryVersion: vi.fn(async () => version) };
  const files = { verifyCompletion: vi.fn(async () => fileBinding) };
  expect(
    await selectLocalGitDeliveryArtifact(state(null, { reviewBinding: gitBinding }), git, files),
  ).toEqual({ binding: gitBinding, artifact: version });
  await expect(
    selectLocalGitDeliveryArtifact(
      state(null, { workspaceReviewBinding: fileBinding }),
      git,
      files,
    ),
  ).rejects.toThrow();
  expect(files.verifyCompletion).not.toHaveBeenCalled();
});
