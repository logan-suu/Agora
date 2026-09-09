/** Attempt every cleanup in order, preserving the body error and all teardown failures. */
export async function finishWithCleanup(
  bodyErrors: readonly unknown[],
  operations: readonly (() => unknown | Promise<unknown>)[],
): Promise<void> {
  const errors = [...bodyErrors];
  for (const cleanup of operations) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'phase10 execution and cleanup failed');
}
