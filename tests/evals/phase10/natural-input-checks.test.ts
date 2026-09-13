import type { RequirementProposalView } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { assertNaturalPriceChanges } from './natural-input-checks';

const valid: RequirementProposalView['changes'] = [
  {
    requirementId: 'ticket',
    before: null,
    after: {
      story: 'Per-person ticket pricing is 900 cents.',
      acceptance: ['For 2 people, tickets total 1,800 cents.'],
      nonGoals: ['No payment processing.'],
    },
  },
  {
    requirementId: 'quote',
    before: null,
    after: {
      story: 'Combine the ticket cost with a venue rate of 5,000 cents per hour.',
      acceptance: ['Two people with three venue hours cost 16,800 cents in total.'],
      nonGoals: [],
    },
  },
];

it('accepts equivalent wording, counts and grouped amounts without fixing whole sentences', () => {
  expect(() => assertNaturalPriceChanges(valid)).not.toThrow();
});

it.each([
  ['ticket price', 0, 'story', 'Tickets cost 1900 cents per person.'],
  ['ticket total', 0, 'acceptance', ['Two tickets cost 11800 cents.']],
  ['quote total', 1, 'acceptance', ['Two people and three hours cost 116800 cents.']],
  ['venue price', 1, 'story', 'Venue costs 6000 cents per hour.'],
  ['ticket count', 0, 'acceptance', ['Three tickets cost 1800 cents.']],
  ['venue hours', 1, 'acceptance', ['Two people and two hours cost 16800 cents.']],
  ['ticket non-goal', 0, 'nonGoals', []],
  ['quote non-goal', 1, 'nonGoals', ['Do not validate venue pricing.']],
  ['extra wrong amount', 0, 'story', 'Tickets cost 900 cents, or 1900 cents per person.'],
  ['reversed ticket amount/count', 0, 'acceptance', ['1800 tickets cost 2 cents.']],
  ['reversed people/hours', 1, 'acceptance', ['Three people and two hours cost 16800 cents.']],
  ['reversed quote amount/hours', 1, 'acceptance', ['Two people and 16800 hours cost 3 cents.']],
  ['ticket rate unit', 0, 'story', 'Tickets cost 900 cents per hour.'],
  ['venue rate unit', 1, 'story', 'The venue costs 5000 cents per person.'],
] as const)('rejects an incorrect %s before confirmation', (_name, index, field, value) => {
  const changes = structuredClone(valid);
  const change = changes[index];
  if (!change) throw new Error('Missing test requirement');
  Object.assign(change.after, { [field]: value });
  expect(() => assertNaturalPriceChanges(changes)).toThrow();
});
