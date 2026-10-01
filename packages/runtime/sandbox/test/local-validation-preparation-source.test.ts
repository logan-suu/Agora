// Port fakes isolate repeated physical-proof scheduling; the real native/Git
// provenance and rejection paths are exercised by the Phase 12 integration test.
import { expect, it } from 'vitest';
import type { LocalIntegrationCompletion } from '../src/local-integration-completion';
import type { LocalValidationPreparationControl } from '../src/local-validation-preparation-control';
import { LocalValidationPreparationSource } from '../src/local-validation-preparation-source';

it('reads the full physical source once while bracketing the fixed commit plan with current control', async () => {
  const reference = {
    scope: { projectId: 'project', taskId: 'task', waveId: 'wave', attempt: 1, integrationId: 'i' },
    planHash: 'a'.repeat(64),
  };
  const summary = {
    stage: 'released' as const,
    call: { projectId: 'project', taskId: 'task', integrationId: 'i' },
    version: { kind: 'git', commit: 'b'.repeat(40) },
    planHash: reference.planHash,
  };
  let controlReads = 0;
  let physicalProofs = 0;
  const control = {
    async read() {
      controlReads++;
      return structuredClone(summary);
    },
    async readFixedDispatch() {
      return { ...structuredClone(summary), before: { projectId: 'project' }, plan: { seed: {} } };
    },
  } as unknown as LocalValidationPreparationControl;
  const completion = {
    async verifyPreparation() {
      physicalProofs++;
      return structuredClone(summary.version);
    },
  } as unknown as LocalIntegrationCompletion;
  const source = new LocalValidationPreparationSource({ control, completion });
  const fixed = await source.readFixedForCommit(reference);
  expect(fixed.plan).toEqual({ seed: {} });
  expect(physicalProofs).toBe(0);
  expect(await source.readForCommit(reference)).toEqual(fixed);
  expect(physicalProofs).toBe(1);
  expect(controlReads).toBe(3);
});

it('rejects control drift after the fixed plan read without reusing a physical approval', async () => {
  const reference = {
    scope: { projectId: 'project', taskId: 'task', waveId: 'wave', attempt: 1, integrationId: 'i' },
    planHash: 'a'.repeat(64),
  };
  const summary = {
    stage: 'released' as const,
    call: { projectId: 'project', taskId: 'task', integrationId: 'i' },
    version: { kind: 'git', commit: 'b'.repeat(40) },
    planHash: reference.planHash,
  };
  let reads = 0;
  let proofs = 0;
  const control = {
    async read() {
      reads++;
      return structuredClone(reads === 3 ? { ...summary, stage: 'dispatched' } : summary);
    },
    async readFixedDispatch() {
      return { ...structuredClone(summary), before: { projectId: 'project' }, plan: { seed: {} } };
    },
  } as unknown as LocalValidationPreparationControl;
  const completion = {
    async verifyPreparation() {
      proofs++;
      return structuredClone(summary.version);
    },
  } as unknown as LocalIntegrationCompletion;
  await expect(
    new LocalValidationPreparationSource({ control, completion }).readForCommit(reference),
  ).rejects.toThrow('initial_validation_preparation_source_changed');
  expect(proofs).toBe(1);
  expect(reads).toBe(3);
});

it('re-proves a registered source through its exact read-only historical adapter', async () => {
  const reference = {
    scope: { projectId: 'project', taskId: 'task', waveId: 'wave', attempt: 1, integrationId: 'i' },
    planHash: 'a'.repeat(64),
  };
  const summary = {
    stage: 'registered' as const,
    call: { projectId: 'project', taskId: 'task', integrationId: 'i' },
    version: { kind: 'git' as const, commit: 'b'.repeat(40) },
    planHash: reference.planHash,
  };
  let reads = 0;
  let physicalProofs = 0;
  const reader = {
    async read() {
      reads++;
      return structuredClone(summary);
    },
    async readFixedHandoff() {
      return { ...structuredClone(summary), releasedState: {}, releasedRegistry: {} };
    },
  } as unknown as LocalValidationPreparationControl;
  const completion = {
    async verifyPreparation(_call: unknown, supplied: unknown) {
      expect(supplied).toBe(reader);
      await reader.readFixedHandoff(reference);
      physicalProofs++;
      return structuredClone(summary.version);
    },
  } as unknown as LocalIntegrationCompletion;
  const source = new LocalValidationPreparationSource({ control: reader, completion });
  expect((await source.readRegistered(reference, reader)).stage).toBe('registered');
  expect(physicalProofs).toBe(1);
  expect(reads).toBe(2);
});
