/** Recheck the original native/Git completion after canonical TESTER dispatch.
 * This reader is internal proof only: it creates no workspace or worker authority.
 */
import type { LocalIntegrationCompletion } from './local-integration-completion';
import { localRecordHash } from './local-registry-records';
import type {
  LocalValidationPreparationControl,
  ValidationPreparationProofReader,
  ValidationPreparationReference,
} from './local-validation-preparation-control';
import type { ValidationDispatchCommitSource } from './validation-dispatch-port';

const equal = (left: unknown, right: unknown) => localRecordHash(left) === localRecordHash(right);

export class LocalValidationPreparationSource implements ValidationDispatchCommitSource {
  constructor(
    private readonly options: {
      control: LocalValidationPreparationControl;
      completion: LocalIntegrationCompletion;
    },
  ) {}

  async read(input: ValidationPreparationReference) {
    const reference = structuredClone(input);
    const before = await this.options.control.read(reference);
    const version = await this.options.completion.verifyPreparation(
      before.call,
      this.options.control,
      reference,
    );
    if (!equal(version, before.version))
      throw Error('initial_validation_preparation_source_changed');
    const after = await this.options.control.read(reference);
    if (!equal(after, before)) throw Error('initial_validation_preparation_source_changed');
    return after;
  }

  /** Re-prove the original native/Git chain against an exact registered-stage
   * reader. The reader itself grants no worker execution capability. */
  async readRegistered(
    input: ValidationPreparationReference,
    registered: ValidationPreparationProofReader,
  ) {
    const reference = structuredClone(input);
    const before = await registered.read(reference);
    if (before.stage !== 'registered') throw Error('initial_validation_preparation_source_changed');
    const version = await this.options.completion.verifyPreparation(
      before.call,
      registered,
      reference,
    );
    if (!equal(version, before.version))
      throw Error('initial_validation_preparation_source_changed');
    const after = await registered.read(reference);
    if (!equal(after, before)) throw Error('initial_validation_preparation_source_changed');
    return after;
  }

  /** Trusted plan/control read only. The caller must still perform the full
   * readForCommit proof immediately before committing this fixed plan. */
  async readFixedForCommit(input: ValidationPreparationReference) {
    return this.options.control.readFixedDispatch(structuredClone(input));
  }

  /** Full native/Git proof required directly before and after the State CAS. */
  async readForCommit(input: ValidationPreparationReference) {
    const reference = structuredClone(input);
    const before = await this.read(reference);
    const fixed = await this.options.control.readFixedDispatch(reference);
    const after = await this.options.control.read(reference);
    if (
      !equal(before, after) ||
      !equal(
        { stage: fixed.stage, call: fixed.call, version: fixed.version, planHash: fixed.planHash },
        before,
      )
    )
      throw Error('initial_validation_preparation_source_changed');
    return fixed;
  }
}
