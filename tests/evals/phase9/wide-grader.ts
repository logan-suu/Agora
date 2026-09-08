export interface ValidationOutcome {
  receiptId: string;
  passed: boolean;
}

/** Grade the fixed public DAG's execution history independently of timing. */
export function passesWideProcess(
  waves: readonly (readonly string[])[],
  outcomes: readonly ValidationOutcome[],
  acceptedReceiptId: string | undefined,
): boolean {
  const independent = ['A', 'B', 'C', 'D'];
  const accepted = outcomes.at(-1);
  return (
    JSON.stringify(waves[0]) === JSON.stringify(independent) &&
    JSON.stringify(waves.at(-1)) === JSON.stringify(['E']) &&
    waves.every(
      (wave) =>
        (wave.length === 1 && wave[0] === 'E') ||
        (wave.length > 0 &&
          new Set(wave).size === wave.length &&
          wave.every((id) => independent.includes(id))),
    ) &&
    acceptedReceiptId !== undefined &&
    accepted?.receiptId === acceptedReceiptId &&
    accepted.passed &&
    new Set(outcomes.map((outcome) => outcome.receiptId)).size === outcomes.length
  );
}
