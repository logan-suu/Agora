import type {
  ProjectCollaborationCommit,
  ProjectCollaborationSnapshot,
  ProjectCollaborationStore,
} from '@agora/comm-channels';
import {
  addRole,
  disableRole,
  enableRole,
  type RoleSpec,
  type RosterTransition,
} from '@agora/core-domain';

export class ProjectRosterService {
  readonly #store: ProjectCollaborationStore;

  constructor(store: ProjectCollaborationStore) {
    this.#store = store;
  }

  async addRole(projectId: string, spec: RoleSpec): Promise<ProjectCollaborationCommit> {
    if (spec.executor !== 'harness') {
      throw new Error(`role "${spec.role}" must use the harness executor in Phase 7`);
    }
    return this.#transition(projectId, (snapshot) => addRole(snapshot.roster, spec));
  }

  async enableRole(projectId: string, role: string): Promise<ProjectCollaborationCommit> {
    return this.#transition(projectId, (snapshot) => enableRole(snapshot.roster, role));
  }

  async disableRole(projectId: string, role: string): Promise<ProjectCollaborationCommit> {
    return this.#transition(projectId, (snapshot) => disableRole(snapshot.roster, role));
  }

  async #transition(
    projectId: string,
    transition: (snapshot: ProjectCollaborationSnapshot) => RosterTransition,
  ): Promise<ProjectCollaborationCommit> {
    const current = await this.#store.load(projectId);
    if (current === undefined) {
      throw new Error(
        `project collaboration store is not initialized for projectId "${projectId}"`,
      );
    }
    const result = transition(current);
    if (!result.changed) return { snapshot: current, changed: false };

    const enabledRoles = result.roster
      .filter((entry) => entry.status === 'enabled')
      .map((entry) => entry.spec.role);
    const channels = current.channels.map((channel) =>
      channel.kind === 'main'
        ? { ...channel, participants: ['leader' as const, ...enabledRoles] }
        : channel,
    );
    return this.#store.commit(projectId, current.revision, {
      roster: result.roster,
      channels,
    });
  }
}
