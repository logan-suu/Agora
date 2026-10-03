/** One live registry owner serializes capability preparation and barrier
 * publication. Model execution and safe-point waits never hold this lane. */
const admissions = new WeakMap<object, Promise<void>>();
export async function serializeLocalRangeAdmission<T>(
  owner: object,
  work: () => Promise<T>,
): Promise<T> {
  const result = (admissions.get(owner) ?? Promise.resolve()).then(work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  admissions.set(owner, tail);
  try {
    return await result;
  } finally {
    if (admissions.get(owner) === tail) admissions.delete(owner);
  }
}
