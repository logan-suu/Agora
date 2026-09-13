import type { RequirementProposalView } from '@agora/core-domain';
import { expect } from 'vitest';

// This English synthetic fixture has explicit prices/counts, not a general NLP grader.
// Compare all numeric facts in each field, including unchanged venue pricing.
const numberLiteral = String.raw`[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;

function normalize(text: string): string {
  return text
    .replace(/\btwo\b/gi, '2')
    .replace(/\bthree\b/gi, '3')
    .replace(/[*_`]/g, '');
}

function numericFacts(text: string): number[] {
  return [...normalize(text).matchAll(new RegExp(numberLiteral, 'g'))]
    .map(([value]) => Number(value.replaceAll(',', '')))
    .sort((a, b) => a - b);
}

function quantities(text: string, unit: string): number[] {
  const pattern = new RegExp(`(${numberLiteral})[\\s-]+(?:${unit})\\b`, 'gi');
  return [...normalize(text).matchAll(pattern)].map((match) =>
    Number(match[1]?.replaceAll(',', '')),
  );
}

export function assertNaturalPriceChanges(changes: RequirementProposalView['changes']) {
  expect(changes.map((c) => c.requirementId).sort()).toEqual(['quote', 'ticket']);
  const ticket = changes.find((c) => c.requirementId === 'ticket');
  const quote = changes.find((c) => c.requirementId === 'quote');
  if (!ticket || !quote) throw new Error('Missing related requirement changes');
  for (const [field, facts] of [
    [ticket.after.story, [900]],
    [ticket.after.acceptance.join('\n'), [2, 1800]],
    [quote.after.story, [5000]],
    [quote.after.acceptance.join('\n'), [2, 3, 16800]],
  ] as const) {
    expect(field).toMatch(/\bcents?\b/i);
    expect(numericFacts(field)).toEqual(facts);
  }
  expect(ticket.after.acceptance).toHaveLength(1);
  expect(quote.after.acceptance).toHaveLength(1);
  expect(quantities(ticket.after.story, 'cents?')).toEqual([900]);
  expect(normalize(ticket.after.story)).toMatch(
    /\bper[\s-]+(?:person|ticket)\b|\b(?:a|each)\s+(?:person|ticket)\b/i,
  );
  expect(quantities(quote.after.story, 'cents?')).toEqual([5000]);
  expect(normalize(quote.after.story)).toMatch(
    /\bper[\s-]+hour\b|\b(?:an?|each)\s+hour\b|\bhourly\b/i,
  );
  const ticketAcceptance = ticket.after.acceptance.join('\n');
  expect(quantities(ticketAcceptance, 'cents?')).toEqual([1800]);
  expect(quantities(ticketAcceptance, 'tickets?|people|persons?')).toEqual([2]);
  const quoteAcceptance = quote.after.acceptance.join('\n');
  expect(quantities(quoteAcceptance, 'cents?')).toEqual([16800]);
  expect(quantities(quoteAcceptance, 'people|persons?')).toEqual([2]);
  expect(quantities(quoteAcceptance, '(?:venue\\s+)?hours?')).toEqual([3]);
  expect(ticket.after.nonGoals).toEqual(['No payment processing.']);
  expect(quote.after.nonGoals).toEqual([]);
}
