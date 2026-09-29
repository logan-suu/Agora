/** Read-only bridge to the existing D17 coordinator. No task, wave, worker or
 * execution capability is created here; all referenced proofs stay host-owned. */
import { type AppState, canonicalJson, isGitObjectId } from '@agora/core-domain';
import { controlFingerprint } from './wave-validation';

type Base = { branch: string; commit: string };
type Proofs = {
  readInitialBase(state: AppState): Promise<Base>;
  verifyReceipt(state: AppState, receiptId: string): Promise<unknown>;
  load(): Promise<AppState | undefined>;
};
export async function readLocalParallelContext(state: AppState, proofs: Proofs) {
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  if (!state.localExecution?.git || !same(await proofs.load(), state))
    throw Error('local_parallel_state_changed');
  const initialBase = await proofs.readInitialBase(state);
  const execution = state.parallelExecution;
  if (
    !initialBase.branch ||
    !isGitObjectId(initialBase.commit) ||
    (execution && !same(initialBase, execution.initialBase))
  )
    throw Error('local_parallel_base_changed');
  const sources = new Set<string>();
  if (execution?.acceptedReceiptId) sources.add(execution.acceptedReceiptId);
  const pending = execution?.activeWave?.validation?.receiptId;
  if (pending) sources.add(pending);
  if (state.phase === 'planning' && execution) {
    const dispatch = [...state.messages]
      .reverse()
      .find(
        (m) =>
          m.fromRole === 'COORDINATOR' &&
          m.type === 'announce' &&
          m.payload.nextRole === 'ARCHITECT',
      );
    if (dispatch?.payload.kind === 'parallel_replan_dispatch') {
      const source = dispatch.payload.replanSourceReceiptId;
      if (typeof source !== 'string' || !source)
        throw Error('local_parallel_replan_source_required');
      sources.add(source);
    }
  }
  for (const receiptId of sources) await proofs.verifyReceipt(state, receiptId);
  if (!same(await proofs.load(), state)) throw Error('local_parallel_state_changed');
  return { initialBase, controlFingerprint: controlFingerprint(state) };
}
