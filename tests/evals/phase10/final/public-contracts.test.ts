import { createInitialAppState } from '@agora/core-domain';
import { project } from '@agora/runtime-executor';
import { expect, it } from 'vitest';
import { fixedRoster } from './model-adapter';
import {
  assertPublicContractSources,
  PUBLIC_CONTRACTS,
  publicContractText,
} from './public-contracts';
import { publicTaskGoal } from './tasks';

it('gives a tool-free PM the cross-grade duplicate contract through the real projection in every variant', () => {
  const views: unknown[] = [];
  for (const variant of ['single', 'multi', 'mixed'] as const) {
    const roster = fixedRoster(variant);
    const goal = publicTaskGoal('grade-school', [
      'Original prose says duplicate additions are incorrect.',
    ]);
    const state = createInitialAppState('contract-test', goal);
    const view = project(state, 'PM', roster);
    const projectedGoal = (view.slices.goal as { goal: string }).goal;
    expect(roster.find((r) => r.role === 'PM')?.tools).toEqual([]);
    expect(projectedGoal).toContain("add('Aimee', 2), then add('Aimee', 1)");
    expect(projectedGoal).toContain('grade(2) must return []');
    expect(projectedGoal).toContain(
      "grade(grade) returns that grade's student names in alphabetical order, even when inserted out of order",
    );
    expect(projectedGoal).toContain('add() return values are not asserted');
    expect(projectedGoal).toContain('override ambiguous or conflicting original prose');
    expect(projectedGoal).toContain('The shell has no Git executable');
    expect(projectedGoal).not.toContain('expect(');
    views.push(projectedGoal);
  }
  expect(new Set(views).size).toBe(1);
});
it('refuses missing, duplicate or changed source fingerprints before using curated facts', () => {
  const sources = Object.entries(PUBLIC_CONTRACTS.wordy.sources).map(([path, sha256]) => ({
    path,
    sha256,
  }));
  expect(() => assertPublicContractSources('wordy', sources)).not.toThrow();
  expect(() => assertPublicContractSources('wordy', sources.slice(1))).toThrow('contract source');
  expect(() =>
    assertPublicContractSources('wordy', [...sources, sources[0] as (typeof sources)[number]]),
  ).toThrow('contract source');
  expect(() =>
    assertPublicContractSources(
      'wordy',
      sources.map((s, i) => (i ? s : { ...s, sha256: '0'.repeat(64) })),
    ),
  ).toThrow('contract source');
});
it('provides exact public API and error contracts without reference implementations or test bodies', () => {
  expect(publicContractText('wordy')).toContain('Unknown operation');
  expect(publicContractText('wordy')).toContain('Syntax error');
  expect(publicContractText('book-store')).toContain('integer cents');
  for (const message of [
    'Stack empty',
    'Division by zero',
    'Invalid definition',
    'Unknown command',
  ])
    expect(publicContractText('forth')).toContain(message);
  for (const name of ['grade-school', 'wordy', 'book-store', 'forth'] as const) {
    const text = publicContractText(name);
    expect(text.length).toBeLessThan(6000);
    expect(text).not.toMatch(/proof\.ci|reference implementation|describe\(|expect\(/);
  }
});
