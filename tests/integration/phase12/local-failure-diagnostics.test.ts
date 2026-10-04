// Synthetic errors exercise diagnostics only; no execution or safety checks are mocked.
import { expect, it } from 'vitest';
import { failureDiagnostics } from './local-failure-diagnostics';

it('retains both execution and cleanup causes inside an aggregate', () => {
  const error = new AggregateError(
    [new Error('worker_failed', { cause: new Error('binding_failed') }), new Error('close_failed')],
    'Local worker execution and quiescence failed',
  );
  expect(failureDiagnostics(error)).toEqual({
    message: 'Local worker execution and quiescence failed',
    errors: [
      { message: 'worker_failed', cause: { message: 'binding_failed' } },
      { message: 'close_failed' },
    ],
  });
});

it('records cycles and non-Error rejections without losing sibling errors', () => {
  const cyclic = new Error('cycle');
  cyclic.cause = cyclic;
  expect(failureDiagnostics(new AggregateError([cyclic, 'untrusted/value'], 'failed'))).toEqual({
    message: 'failed',
    errors: [{ message: 'cycle', cause: { truncated: 'cycle' } }, { nonError: 'string' }],
  });
});

it('keeps unsafe messages out of codes and makes truncation explicit', () => {
  const error = new Error('https://example.invalid/private?token=not-a-real-token');
  error.name = 'also/untrusted';
  expect(failureDiagnostics(error)).toEqual({ message: 'Error' });
  const aggregate = new AggregateError(
    Array.from({ length: 100 }, () => new Error('failed')),
    'many',
  );
  expect(JSON.stringify(failureDiagnostics(aggregate))).toContain('truncated');
});
