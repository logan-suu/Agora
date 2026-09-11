import { describe, expect, it } from 'vitest';
import { architectTurnMutations, reviewerTurnMutations } from '../src/runtime-contracts';

describe('architectTurnMutations structured transport', () => {
  const executionPlan = {
    version: 1,
    subtasks: [{ id: 'A', title: 'Implement module', dependsOn: [] }],
  };
  it('requires both architecture and conventions objects promised by the prompt', () => {
    expect(() => architectTurnMutations('{"architecture":{"modules":[]}}')).toThrow(/conventions/);
  });
  it.each(['executionPlan', 'unexpected'])('rejects the extra top-level key %s', (key) => {
    expect(() =>
      architectTurnMutations(
        JSON.stringify({ architecture: {}, conventions: {}, [key]: executionPlan }),
      ),
    ).toThrow(/top-level/);
  });
  it('rejects object modules without a nested execution plan before state can be committed', () => {
    expect(() =>
      architectTurnMutations(
        JSON.stringify({ architecture: { modules: [{ id: 'A' }] }, conventions: {} }),
      ),
    ).toThrow(/legacy modules/);
  });
  it('accepts object modules with a nested plan and preserves legacy string modules', () => {
    const architecture = { modules: [{ id: 'A' }], executionPlan };
    expect(
      architectTurnMutations(JSON.stringify({ architecture, conventions: {} })),
    ).toContainEqual({
      op: 'set',
      field: 'architecture',
      value: architecture,
    });
    expect(() =>
      architectTurnMutations(
        JSON.stringify({ architecture: { modules: ['Module A'] }, conventions: {} }),
      ),
    ).not.toThrow();
    expect(() =>
      architectTurnMutations(JSON.stringify({ architecture: {}, conventions: {} })),
    ).not.toThrow();
  });
});

describe('reviewerTurnMutations structured transport', () => {
  const verdict = '[{"id":"rv-live","kind":"verdict","verdict":"approved","summary":"looks good"}]';

  it('accepts one JSON code fence while preserving strict verdict validation', () => {
    expect(reviewerTurnMutations(`\`\`\`json\n${verdict}\n\`\`\``)).toHaveLength(1);
    expect(reviewerTurnMutations(`\`\`\`json\n${verdict}\`\`\``)).toHaveLength(1);
    expect(() => reviewerTurnMutations('```json\n[{"kind":"verdict"}]```')).toThrow(/safe id/);
  });

  it('rejects prose outside a fenced JSON payload', () => {
    expect(() => reviewerTurnMutations(`Review complete.\n\`\`\`json\n${verdict}\n\`\`\``)).toThrow(
      /not valid JSON/,
    );
  });

  it('requires the verdict summary promised by the prompt', () => {
    expect(() =>
      reviewerTurnMutations('[{"id":"rv-live","kind":"verdict","verdict":"approved"}]'),
    ).toThrow(/summary/);
  });

  it('requires a verdict id that can safely bind the D16 completion gate', () => {
    expect(() =>
      reviewerTurnMutations(
        '[{"id":"review verdict/1","kind":"verdict","verdict":"approved","summary":"looks good"}]',
      ),
    ).toThrow(/safe id/);
  });
});
