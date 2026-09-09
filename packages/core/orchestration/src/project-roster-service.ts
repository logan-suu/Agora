import type {
  ProjectCollaborationCommit,
  ProjectCollaborationSnapshot,
  ProjectCollaborationStore,
} from '@agora/comm-channels';
import {
  addRole,
  configureRoleModels,
  disableRole,
  enableRole,
  type RoleModelSetting,
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

  async configureModels(
    projectId: string,
    expectedRevision: number,
    roles: readonly string[],
    setting: RoleModelSetting | null,
  ): Promise<ProjectCollaborationCommit> {
    const current = await this.#store.load(projectId);
    if (!current || current.revision !== expectedRevision)
      throw new Error('model settings revision conflict');
    const roster = configureRoleModels(current.roster, roles, setting);
    return this.#store.commit(projectId, expectedRevision, { roster, channels: current.channels });
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
