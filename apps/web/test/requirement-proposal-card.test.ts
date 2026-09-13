import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RequirementProposalCard } from '../src/app/requirement-proposal-card';

it('renders a readable before/after review and prevents confirmation of a stale proposal', () => {
  const markup = renderToStaticMarkup(
    createElement(RequirementProposalCard, {
      proposal: {
        proposalId: 'private-protocol-id',
        sourceMsgId: 'source',
        status: 'stale',
        summary: 'Change price',
        changes: [
          {
            requirementId: 'ticket',
            before: {
              story: '1000 cents per person',
              acceptance: ['Two cost 2000'],
              nonGoals: ['No payments'],
            },
            after: {
              story: '900 cents per person',
              acceptance: ['Two cost 1800'],
              nonGoals: ['No payments'],
            },
          },
        ],
      },
      busy: false,
      onRespond: () => {},
    }),
  );
  expect(markup).toContain('Before');
  expect(markup).toContain('After');
  expect(markup).toContain('1000 cents per person');
  expect(markup).toContain('900 cents per person');
  expect(markup).toContain('Two cost 1800');
  expect(markup).toContain('No payments');
  expect(markup).toMatch(/disabled=""[^>]*>Confirm changes/);
  expect(markup).not.toContain('private-protocol-id');
  expect(markup).not.toContain('requirementId');
});
