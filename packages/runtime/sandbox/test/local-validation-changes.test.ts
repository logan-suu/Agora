import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { assertLocalValidationChanges } from '../src/local-validation-changes';

const base = [
  { path: 'app.js', content: Buffer.from('business'), executable: false },
  { path: 'existing.test.cjs', content: Buffer.from('test'), executable: false },
];
const current = base.map((file) => ({
  path: file.path,
  contentHash: createHash('sha256').update(file.content).digest('hex'),
  version: { executable: file.executable },
}));
const file = (path: string, content: string) => ({
  path,
  contentHash: createHash('sha256').update(content).digest('hex'),
  version: { executable: false },
});

it('permits committed tests and fixture changes while retaining inherited tests', () => {
  expect(() =>
    assertLocalValidationChanges(base, [
      ...current,
      file('new.test.cjs', 'new test'),
      file('tests/fixtures/input.json', '{}'),
    ]),
  ).not.toThrow();
});

it('rejects changed business bytes and executable bits', () => {
  expect(() =>
    assertLocalValidationChanges(base, [
      file('app.js', 'edited'),
      file('existing.test.cjs', 'test'),
    ]),
  ).toThrow('local_validation_business_file_changed');
  expect(() =>
    assertLocalValidationChanges(base, [
      { ...file('app.js', 'business'), version: { executable: true } },
      file('existing.test.cjs', 'test'),
    ]),
  ).toThrow('local_validation_business_file_changed');
});

it('rejects inherited test removal and new unsupported test types', () => {
  expect(() => assertLocalValidationChanges(base, [file('app.js', 'business')])).toThrow(
    'local_validation_inherited_test_removed',
  );
  expect(() =>
    assertLocalValidationChanges(base, [...current, file('new.test.ts', 'unsupported')]),
  ).toThrow('local_validation_business_file_changed');
});
