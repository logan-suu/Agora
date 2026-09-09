import { ParallelBatchError } from '@agora/core-orchestration';
import { ExecutorRequestError } from '@agora/runtime-executor';

/** Public summaries never interpolate untrusted exception text or provider codes. */
export function safeRunError(error: unknown): string {
  const queue = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 32) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    if (next instanceof ExecutorRequestError)
      return '[MODEL_REQUEST_FAILED] Model request failed. Check model availability and credentials.';
    if (next instanceof Error && next.cause !== undefined) queue.push(next.cause);
    if (next instanceof AggregateError) queue.push(...next.errors.slice(0, 32));
    if (next instanceof ParallelBatchError)
      queue.push(...next.failures.slice(0, 32).map((f) => f.cause));
  }
  return '[RUN_FAILED] Task execution failed.';
}
