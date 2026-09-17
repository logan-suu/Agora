/** Trusted Leader control service. prepareGrant accepts only a selector result
 * from the composition root; never expose it as an HTTP path-taking operation. */
import { isAbsolute, relative } from 'node:path';
import {
  type AppState,
  type LocalExecutionV1,
  type Message,
  parseWorkspaceControl,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import { type LocalGrantPolicy, validateLocalGrantPolicy as policy } from './local-grant-policy';

export type { LocalGrantPolicy } from './local-grant-policy';

import { LocalControlObjects } from './local-control-objects';
import type { LocalRegistryOwner } from './local-registry-file';
import {
  assertLocalControlMessage,
  isLocalBindingOperation,
  type LocalGrantRecord,
  type LocalRootRecord,
  localRecordHash,
} from './local-registry-records';
import {
  inspectSelectedLocalRoot,
  type SelectedLocalRootInspection,
} from './local-root-inspection';

type Scope = { projectId: string; taskId: string };
interface Proposal extends Scope {
  schemaVersion: 'local-grant-proposal-v1';
  selectionRef: string;
  expectedRevision: number;
  inspection: SelectedLocalRootInspection;
  policy: LocalGrantPolicy;
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export class LocalGrantController {
  private constructor(
    private readonly privateRoot: string,
    private readonly control: LocalBindingCoordinator,
    private readonly objects: LocalControlObjects,
    private readonly tasks: { load(scope: Scope): Promise<AppState | undefined> },
    private readonly inspector: string,
    private readonly currentPolicy: () => Promise<LocalGrantPolicy>,
  ) {}
  static async open(
    owner: LocalRegistryOwner,
    control: LocalBindingCoordinator,
    tasks: { load(scope: Scope): Promise<AppState | undefined> },
    inspector: string,
    currentPolicy: () => Promise<LocalGrantPolicy>,
  ) {
    return new LocalGrantController(
      owner.root,
      control,
      await LocalControlObjects.open(owner),
      tasks,
      inspector,
      currentPolicy,
    );
  }
  async prepareGrant(scope: Scope, selected: { selectionRef: string; path: string }) {
    if (!id(scope.projectId) || !id(scope.taskId) || !id(selected.selectionRef))
      throw Error('invalid_workspace_selection');
    const input = structuredClone({ ...scope, ...selected });
    const within = (a: string, b: string) => {
      const path = relative(a, b);
      return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
    };
    if (within(input.path, this.privateRoot) || within(this.privateRoot, input.path))
      throw Error('workspace_private_root_forbidden');
    const snapshot = await this.control.snapshot();
    if (snapshot.operations.some((o) => o.stage === 'prepared'))
      throw Error('registry_recovery_required');
    const state = await this.tasks.load(scope);
    if (!state || state.projectId !== scope.projectId || state.taskId !== scope.taskId)
      throw Error('workspace_task_scope_mismatch');
    const configuration = policy(await this.currentPolicy());
    await this.objects.put(configuration);
    await this.objects.put(configuration.toolchain);
    await this.objects.put(configuration.network);
    const inspection = inspectSelectedLocalRoot(input.path, this.inspector);
    const proposal: Proposal = {
      schemaVersion: 'local-grant-proposal-v1',
      projectId: input.projectId,
      taskId: input.taskId,
      selectionRef: input.selectionRef,
      expectedRevision: snapshot.revision,
      inspection,
      policy: configuration,
    };
    const inputHash = await this.objects.put(proposal);
    return { policyProposalId: `grant:${inputHash}`, inputHash, proposal };
  }
  async assertGrant(scope: Scope, grantId: string): Promise<void> {
    const canonicalScope = { projectId: scope.projectId, taskId: scope.taskId };
    const snapshot = await this.control.snapshot();
    const grant = snapshot.grants.find(
      (g) => g.grantId === grantId && g.projectId === scope.projectId,
    );
    if (grant?.status !== 'active') throw Error('authorization_closed');
    const source = snapshot.operations.find((o) => o.actionId === grant.createdActionId);
    if (
      !source ||
      !isLocalBindingOperation(source) ||
      !source.sourceMessage ||
      source.sourceMessage.msgId !== grant.leaderMessageId
    )
      throw Error('workspace_control_source_invalid');
    await this.commit(canonicalScope, source.sourceMessage);
  }
  async commit(scope: Scope, sourceMessage: Message): Promise<AppState> {
    scope = structuredClone(scope);
    const message = structuredClone(sourceMessage);
    const intent = parseWorkspaceControl(message.display);
    if (intent?.verb !== 'grant') throw Error('workspace_control_not_available');
    assertLocalControlMessage(message, {
      ...scope,
      actionId: intent.actionId,
      sourceMessageId: message.msgId,
      expectedRevision: intent.expectedRevision,
    });
    if (intent.policyProposalId !== `grant:${intent.inputHash}`)
      throw Error('workspace_proposal_mismatch');
    const proposal = (await this.objects.get(intent.inputHash)) as Proposal;
    if (
      !proposal ||
      Object.keys(proposal).sort().join(',') !==
        'expectedRevision,inspection,policy,projectId,schemaVersion,selectionRef,taskId' ||
      proposal.schemaVersion !== 'local-grant-proposal-v1' ||
      proposal.projectId !== scope.projectId ||
      proposal.taskId !== scope.taskId ||
      proposal.selectionRef !== intent.selectionRef ||
      proposal.expectedRevision !== intent.expectedRevision
    )
      throw Error('workspace_proposal_mismatch');
    const configuration = policy(await this.currentPolicy());
    if (localRecordHash(configuration) !== localRecordHash(proposal.policy))
      throw Error('workspace_proposal_stale');
    if (
      localRecordHash(inspectSelectedLocalRoot(proposal.inspection.path, this.inspector)) !==
      localRecordHash(proposal.inspection)
    )
      throw Error('root_identity_changed');
    const snapshot = await this.control.snapshot();
    const rootId = `root:${localRecordHash({ projectId: scope.projectId, selectionRef: proposal.selectionRef })}`;
    const last = proposal.inspection.chain.at(-1);
    if (!last) throw Error('workspace_proposal_mismatch');
    const [dev, inode] = last.identity.split(':');
    if (!dev || !inode) throw Error('workspace_proposal_mismatch');
    const root: LocalRootRecord = {
      rootId,
      projectId: scope.projectId,
      selectionRef: proposal.selectionRef,
      path: proposal.inspection.path,
      volumeId: proposal.inspection.volumeId,
      dev,
      inode,
      chain: proposal.inspection.chain.map(({ path, identity }) => ({ path, identity })),
      staging: null,
      inspectionHash: localRecordHash(proposal.inspection),
    };
    const grant: LocalGrantRecord = {
      grantId: `grant:${localRecordHash({ ...scope, actionId: intent.actionId })}`,
      projectId: scope.projectId,
      rootId,
      revision: 0,
      policyVersion: configuration.version,
      actions: configuration.actions,
      toolchainHash: localRecordHash(configuration.toolchain),
      networkHash: localRecordHash(configuration.network),
      policyHash: localRecordHash(configuration),
      createdActionId: intent.actionId,
      leaderMessageId: message.msgId,
      status: 'active',
      revocationActionId: null,
    };
    const previous = snapshot.operations.find((o) => o.actionId === intent.actionId);
    if (previous) {
      const storedRoot = snapshot.roots.find((r) => r.rootId === root.rootId);
      const storedGrant = snapshot.grants.find((g) => g.grantId === grant.grantId);
      if (
        !isLocalBindingOperation(previous) ||
        !previous.sourceMessage ||
        localRecordHash(previous.sourceMessage) !==
          localRecordHash({ ...message, ts: previous.sourceMessage.ts }) ||
        !previous.nextLocalExecution.rootIds.includes(root.rootId) ||
        !storedRoot ||
        !storedGrant ||
        localRecordHash({ ...storedRoot, staging: null }) !== localRecordHash(root) ||
        localRecordHash({
          ...storedGrant,
          status: 'active',
          revision: 0,
          revocationActionId: null,
        }) !== localRecordHash(grant)
      )
        throw Error('operation_conflict');
      await this.control.recover(previous.actionId, previous.inputHash);
      return this.control.assertClosed(scope);
    }
    if (snapshot.revision !== proposal.expectedRevision) throw Error('workspace_proposal_stale');
    if (
      snapshot.roots.some(
        (r) =>
          r.rootId === rootId ||
          r.chain.some((part) => part.identity === last.identity) ||
          proposal.inspection.chain.some((part) => part.identity === `${r.dev}:${r.inode}`),
      )
    )
      throw Error('workspace_root_conflict');
    const state = await this.tasks.load(scope);
    if (!state || state.projectId !== scope.projectId || state.taskId !== scope.taskId)
      throw Error('workspace_task_scope_mismatch');
    if (state.localExecution) await this.control.assertClosed(scope);
    const execution: LocalExecutionV1 = structuredClone(
      state.localExecution ?? {
        schemaVersion: 'local-execution-v1',
        rootIds: [],
        workspaces: [],
        bindings: [],
        receipts: [],
      },
    );
    execution.rootIds.push(rootId);
    await this.control.commitBinding({
      ...scope,
      actionId: intent.actionId,
      sourceMessageId: message.msgId,
      sourceMessage: message,
      expectedRevision: proposal.expectedRevision,
      nextLocalExecution: execution,
      records: {
        roots: [...snapshot.roots, root],
        grants: [...snapshot.grants, grant],
        workspaces: snapshot.workspaces,
        claims: snapshot.claims,
      },
    });
    return this.control.assertClosed(scope);
  }
}
