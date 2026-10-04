/** Test-only codes; never publish internal errors through HTTP or Trace. */
export function failureDiagnostics(error: unknown): unknown {
  const ancestors = new Set<Error>();
  let remaining = 64;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth >= 8 || remaining-- <= 0) return { truncated: 'limit' };
    if (!(value instanceof Error)) return { nonError: value === null ? 'null' : typeof value };
    if (ancestors.has(value)) return { truncated: 'cycle' };
    ancestors.add(value);
    const result = {
      message: /^[A-Za-z0-9_ :.[\]-]{1,256}$/.test(value.message) ? value.message : 'Error',
      ...(value instanceof AggregateError
        ? {
            errors: value.errors.slice(0, 16).map((child) => visit(child, depth + 1)),
            ...(value.errors.length > 16 ? { truncated: 'children' } : {}),
          }
        : {}),
      ...(value.cause === undefined ? {} : { cause: visit(value.cause, depth + 1) }),
    };
    ancestors.delete(value);
    return result;
  };
  return visit(error, 0);
}
