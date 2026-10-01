// Real durable task/registry, native manifests and private command proof.
// The calling fixture's synthetic review/Fork is not delivery lifecycle G5.
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createLocalDirectDeliveryComparisons } from '../../../apps/web/src/server/local-direct-delivery-composition';
import type { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';

export async function exerciseDirectDeliveryComparison(input: {
  options: Parameters<typeof LocalWorkspaceSessions.create>[0];
  local: LocalWorkspaceSessions;
  root: string;
}) {
  const scope = { projectId: 'project', taskId: 'task' };
  const { control } = input.options;
  const before = await control.assertClosed(scope);
  const next = structuredClone(before.localExecution);
  if (!next?.rootIds[0]) throw Error('missing_local_execution');
  next.delivery = {
    schemaVersion: 'local-delivery-v1',
    goal: 'artifact_only',
    rootId: next.rootIds[0],
    currentRoundId: null,
    rounds: [],
  };
  const snapshot = await control.snapshot();
  await control.commitBinding({
    ...scope,
    actionId: 'delivery-fixture-goal',
    sourceMessageId: snapshot.grants[0]?.leaderMessageId ?? 'missing-grant',
    expectedRevision: snapshot.revision,
    nextLocalExecution: next,
    records: {
      roots: snapshot.roots,
      grants: snapshot.grants,
      workspaces: snapshot.workspaces,
      claims: snapshot.claims,
    },
  });
  const state = await control.assertClosed(scope);
  const registry = await control.snapshot();
  expect(state.phase).not.toBe('done');
  expect(registry.claims.some((claim) => claim.status === 'active')).toBe(true);
  const comparisons = createLocalDirectDeliveryComparisons(input.options, input.local);
  const prepared = await comparisons.prepare(scope);
  expect(prepared.comparison.status).toBe('matches_artifact');
  expect(await comparisons.verifyCurrent(prepared.deliveryComparisonId)).toEqual(prepared);
  const path = join(input.root, 'user-late-edit.txt');
  writeFileSync(path, 'preserve this external change');
  try {
    await expect(comparisons.verifyCurrent(prepared.deliveryComparisonId)).rejects.toThrow(
      'delivery_stale',
    );
    const changed = await comparisons.prepare(scope);
    expect(changed.comparison.status).toBe('requires_validation');
    expect(changed.source.baseline).toEqual(prepared.source.baseline);
    expect(changed.source.artifact).toEqual(prepared.source.artifact);
    expect(changed.source.current).not.toEqual(prepared.source.current);
    expect(await comparisons.readHistorical(prepared.deliveryComparisonId)).toEqual(prepared);
    // Reconstruct the read service without executing another validation command.
    const reopened = createLocalDirectDeliveryComparisons(input.options, input.local);
    expect(await reopened.verifyCurrent(changed.deliveryComparisonId)).toEqual(changed);
    expect(await control.assertClosed(scope)).toEqual(state);
    expect(await control.snapshot()).toEqual(registry);
    return {
      originalComparisonId: prepared.deliveryComparisonId,
      changedComparisonId: changed.deliveryComparisonId,
      sourceReceipts: changed.source.sourceReceipts,
      baselinePreserved: true,
      testedArtifactPreserved: true,
      staleRejected: true,
      requiresValidation: true,
      canonicalStateUnchanged: true,
      registryUnchanged: true,
    };
  } finally {
    unlinkSync(path);
  }
}
