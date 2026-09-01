import { describe, expect, it } from 'vitest';
import { reviewerTurnMutations } from '../src/runtime-contracts';

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
});
