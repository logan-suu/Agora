import { describe, expect, it } from 'vitest';
import { architectTurnMutations, reviewerTurnMutations } from '../src/runtime-contracts';

describe('architectTurnMutations structured transport', () => {
  it('requires both architecture and conventions objects promised by the prompt', () => {
    expect(() => architectTurnMutations('{"architecture":{"modules":[]}}')).toThrow(/conventions/);
  });
});

describe('reviewerTurnMutations structured transport', () => {
  const verdict = '[{"id":"rv-live","kind":"verdict","verdict":"approved","summary":"looks good"}]';

  it('accepts one JSON code fence while preserving strict verdict validation', () => {
    expect(reviewerTurnMutations(`\`\`\`json\n${verdict}\n\`\`\``)).toHaveLength(1);
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
});
