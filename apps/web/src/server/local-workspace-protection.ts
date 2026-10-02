/** Explicit Phase 12 protection composition. The host supplies actual native
 * sources/closure readers; this does not grant roots or open a normal project
 * entry. Long closure/Fork/inverse work runs outside the original Leader queue. */
import {
  type AppState,
  type Message,
  type Mutation,
  parseWorkspaceControl,
  workspaceVersionChanges,
} from '@agora/core-domain';
import { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalControlObjects } from '../../../../packages/runtime/sandbox/src/local-control-objects';
import {
  LocalRangeController,
  type LocalRangeLifecycle,
  type LocalRangeSources,
} from '../../../../packages/runtime/sandbox/src/local-range-controller';
import {
  type LocalRangeForkEvidence,
  type LocalRangeForkPlan,
  LocalRangeResumeController,
} from '../../../../packages/runtime/sandbox/src/local-range-resume-controller';
import { LocalRangeReturnController } from '../../../../packages/runtime/sandbox/src/local-range-return-controller';
import type { LocalRangeReturnEvidence } from '../../../../packages/runtime/sandbox/src/local-range-return-evidence';
import type { LocalRegistryOwner } from '../../../../packages/runtime/sandbox/src/local-registry-file';
import type {
  LocalUndoAuthority,
  LocalUndoCall,
} from '../../../../packages/runtime/sandbox/src/local-undo-authority';
import type { LocalUndoCompletion } from '../../../../packages/runtime/sandbox/src/local-undo-completion';
import type { WorkspaceControlPort } from './message-runtime';
import type { TaskOrchestrationRuntime } from './task-orchestration-runtime';

type Scope = { projectId: string; taskId: string };
export type WorkspaceProtectionTaskPort = {
  load(scope: Scope): Promise<AppState | undefined>;
  compareAndCommit(
    scope: Scope,
    expected: AppState,
    mutations: readonly Mutation[],
  ): Promise<{ state: AppState; changed: boolean }>;
};
type Options = {
  owner: LocalRegistryOwner;
  objects: LocalControlObjects;
  runtime: TaskOrchestrationRuntime;
  sources: LocalRangeSources;
  lifecycle: LocalRangeLifecycle;
  evidence: LocalRangeReturnEvidence;
  /** Static official JSONL reader also works after the composition is disposed.
   * It must not load an Agent, rebuild resources, repair data or call a model. */
  readFork(plan: LocalRangeForkPlan, fresh: boolean): Promise<LocalRangeForkEvidence>;
  fallback: WorkspaceControlPort;
  undo?(input: {
    control: LocalBindingCoordinator;
    canonical: WorkspaceProtectionTaskPort;
    facts: WorkspaceProtectionTaskPort;
    serializeTask<T>(scope: Scope, work: () => Promise<T>): Promise<T>;
  }): Promise<{
    authority: Pick<LocalUndoAuthority, 'acquire'>;
    completion: Pick<LocalUndoCompletion, 'finish'>;
  }>;
};
const actionKey = (scope: Scope, message: Message) =>
  JSON.stringify([scope.projectId, scope.taskId, message.msgId]);
export async function createLocalWorkspaceProtection(options: Options) {
  const messages = options.runtime.messages,
    canonical = {
      load: (scope: Scope) => messages.store.load(scope),
      compareAndCommit: (scope: Scope, expected: AppState, mutations: readonly Mutation[]) =>
        messages.compareAndCommitControl(scope, expected, mutations),
      commit: (scope: Scope, mutations: readonly Mutation[]) =>
        messages.commitMutations(scope, mutations),
    },
    serializeTask = <T>(scope: Scope, work: () => Promise<T>) =>
      messages.runTaskSerial(scope, work),
    facts: WorkspaceProtectionTaskPort = {
      load: canonical.load,
      compareAndCommit: (scope, expected, mutations) =>
        serializeTask(scope, () => canonical.compareAndCommit(scope, expected, mutations)),
    },
    control = await LocalBindingCoordinator.open(options.owner, canonical),
    take = new LocalRangeController({
      control,
      objects: options.objects,
      tasks: canonical,
      sources: options.sources,
      lifecycle: options.lifecycle,
    }),
    resume = new LocalRangeResumeController({
      control,
      objects: options.objects,
      tasks: facts,
      evidence: options.evidence,
      prepareFork: (plan, state) => options.runtime.prepareRangeFork(plan, state),
      readFork: options.readFork,
      register: async (request, verify) => {
        const workerRuntime = options.runtime.rangeWorkerRuntime(request);
        if (!workerRuntime) throw Error('range_worker_runtime_unavailable');
        await workerRuntime.registerRangeResumes(request, verify);
      },
    });
  options.evidence.setResumeReader((hold, ref) => resume.read(hold, ref));
  control.setRangeEvidenceVerifier((registry, state) =>
    options.evidence.verifyAdmission(registry, state),
  );
  const returns = new LocalRangeReturnController({
    control,
    objects: options.objects,
    tasks: canonical,
    commitFacts: facts.compareAndCommit,
    evidence: options.evidence,
    onReleased: async (hold) => {
      await resume.prepare(hold);
      const registry = await control.snapshot();
      for (const scope of new Map(
        registry.workspaces.map((w) => [`${w.projectId}/${w.taskId}`, w]),
      ).values()) {
        const state = await canonical.load(scope);
        if (!state) throw Error('workspace_task_scope_mismatch');
        const selected = new Set(
          workspaceVersionChanges(state)
            .filter((c) => c.takeoverId === hold.plan.takeoverId)
            .flatMap((c) => c.affectedWorkerIds),
        );
        if (
          state.workers.some(
            (w) => selected.has(w.workerId) && ['paused', 'pending'].includes(w.status),
          )
        )
          await options.runtime.startRangeReturn(scope, hold.plan.takeoverId);
      }
    },
  });
  const undo = await options.undo?.({ control, canonical, facts, serializeTask }),
    freshUndo = new Map<string, LocalUndoCall>();
  const port: WorkspaceControlPort = {
    async commit(scope, message) {
      const intent = parseWorkspaceControl(message.display);
      if (intent?.verb === 'takeover') return take.commit(scope, message);
      if (intent?.verb === 'return') return returns.commit(scope, message);
      if (intent?.verb === 'undo' && undo) {
        const admitted = await undo.authority.acquire(scope, message);
        if (!admitted.replayed) freshUndo.set(actionKey(scope, message), admitted.call);
        return control.assertClosed(scope);
      }
      return options.fallback.commit(scope, message);
    },
    async afterCommit(scope, message) {
      const intent = parseWorkspaceControl(message.display);
      if (intent?.verb === 'takeover') await take.hold(`takeover:${intent.actionId}`);
      else if (intent?.verb === 'return') await returns.release(intent.takeoverReceiptId);
      else if (intent?.verb === 'undo' && undo) {
        const key = actionKey(scope, message),
          call = freshUndo.get(key);
        freshUndo.delete(key);
        if (call) await undo.completion.finish(call);
      } else return options.fallback.afterCommit?.(scope, message);
      return canonical.load(scope);
    },
  };
  messages.bindWorkspaceControlPort(port);
  return { control, take, returns, resume, port };
}
