import { ExecutorRequestError } from '@agora/runtime-executor';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';
import { safeRunError } from '../src/server/run-error';

describe('public run error projection', () => {
  it('does not serialize arbitrary messages, thrown values or nested provider facts', () => {
    for (const error of [
      new Error('SECRET'),
      'SECRET',
      { message: 'SECRET' },
      new AggregateError([new Error('SECRET')], 'SECRET'),
    ]) {
      expect(safeRunError(error)).toBe('[RUN_FAILED] Task execution failed.');
      expect(safeRunError(error)).not.toContain('SECRET');
    }
  });
  it('finds typed provider failure through cleanup aggregates without exposing its cause', () => {
    const error = new AggregateError([
      new Error('worker', { cause: new ExecutorRequestError(new LlmError('SECRET', 'AUTH')) }),
      new Error('CLEANUP_SECRET'),
    ]);
    expect(safeRunError(error)).toBe(
      '[MODEL_REQUEST_FAILED] Model request failed. Check model availability and credentials.',
    );
  });
  it('bounds cyclic diagnostic traversal', () => {
    const error = new Error('SECRET');
    error.cause = error;
    expect(safeRunError(error)).toBe('[RUN_FAILED] Task execution failed.');
  });
  it('identifies a timeout inside parallel and cleanup failures without exposing provider text', () => {
    const error = new AggregateError([
      new ParallelBatchError(createInitialAppState('timeout', 'test'), [
        {
          workerId: 'coder',
          status: 'failed',
          message: 'PRIVATE_WORKER_DETAILS',
          cause: new ExecutorRequestError(new LlmError('SECRET_URL_AND_KEY', 'TIMEOUT')),
        },
      ]),
    ]);
    expect(safeRunError(error)).toBe(
      '[MODEL_REQUEST_TIMEOUT] The model service timed out after bounded retries. Check service availability before trying again.',
    );
  });
  it('never reflects an unknown provider code into the public summary', () => {
    expect(safeRunError(new ExecutorRequestError(new LlmError('SECRET', 'PRIVATE_CODE')))).toBe(
      '[MODEL_REQUEST_FAILED] Model request failed. Check model availability and credentials.',
    );
  });
});

import { createInitialAppState } from '@agora/core-domain';
import { ParallelBatchError } from '@agora/core-orchestration';
