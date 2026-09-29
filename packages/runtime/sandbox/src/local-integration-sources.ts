/** Read current branch provenance without granting merge or delivery authority. */
import { selectIntegrationBranch } from '@agora/core-domain';
import type { LocalGitWorkspaces } from './local-git-workspaces';
import type { ApplicationRequest } from './local-integration-application-records';
import type {
  LocalIntegrationAuthority,
  LocalIntegrationCall,
} from './local-integration-authority';
import { localRecordHash } from './local-registry-records';
import type { LocalWorkspaceSessions } from './local-workspace-sessions';

export class LocalIntegrationSources {
  constructor(
    private readonly options: {
      authority: LocalIntegrationAuthority;
      sessions: LocalWorkspaceSessions;
      workspaces: LocalGitWorkspaces;
    },
  ) {}

  withAuthority(authority: LocalIntegrationAuthority) {
    return new LocalIntegrationSources({ ...this.options, authority });
  }

  async readNext(input: LocalIntegrationCall) {
    return this.read(input);
  }
  async readPublished(request: ApplicationRequest) {
    return this.read(request.call, structuredClone(request));
  }
  async readHistorical(request: ApplicationRequest, anchor?: ApplicationRequest) {
    return this.read(
      structuredClone(request.call),
      anchor && structuredClone(anchor),
      structuredClone(request),
    );
  }
  private async read(
    input: LocalIntegrationCall,
    published?: ApplicationRequest,
    historical?: ApplicationRequest,
  ) {
    localRecordHash(input);
    const call = structuredClone(input);
    const admission = () =>
      published
        ? this.options.authority.readPublishedCheckpoint(published)
        : this.options.authority.readCheckpoint(call);
    const before = await admission();
    const historicalSelection = historical
      ? await this.options.authority.readHistoricalSelection(historical, published)
      : undefined;
    const selection =
      historicalSelection ??
      (published
        ? await this.options.authority.readPublishedSelection(published)
        : selectIntegrationBranch(before.state, call.integrationId));
    const scope = {
      projectId: call.projectId,
      taskId: call.taskId,
      workerId: selection.branch.workerId,
    };
    const baseline = published
      ? before.state.parallelExecution?.acceptedReceiptId
        ? await this.options.workspaces.readAcceptedCodingBaseline(scope)
        : await this.options.workspaces.readPublishedCodingBaseline(scope, published)
      : before.state.parallelExecution?.acceptedReceiptId
        ? await this.options.workspaces.readAcceptedCodingBaseline(scope)
        : await this.options.workspaces.readCodingBaseline(scope);
    const source = await this.options.sessions.readCompletedWorktree({
      projectId: call.projectId,
      taskId: call.taskId,
      workerId: selection.branch.workerId,
    });
    const after = await admission();
    if (
      after.snapshot.revision !== before.snapshot.revision ||
      localRecordHash(after.state) !== localRecordHash(before.state) ||
      localRecordHash(
        historical
          ? await this.options.authority.readHistoricalSelection(historical, published)
          : published
            ? await this.options.authority.readPublishedSelection(published)
            : selectIntegrationBranch(after.state, call.integrationId),
      ) !== localRecordHash(selection) ||
      localRecordHash(source.worktree) !== localRecordHash(selection.branch.worktree)
    )
      throw Error('integration_selection_changed');
    return { selection, source, baseline };
  }
}
