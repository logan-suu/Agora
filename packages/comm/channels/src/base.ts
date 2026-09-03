import type { Channel, RosterEntry } from '@agora/core-domain';

export interface ProjectChannelSnapshot {
  projectId: string;
  revision: number;
  channels: Channel[];
}

export interface ProjectChannelCommit {
  snapshot: ProjectChannelSnapshot;
  changed: boolean;
}

export interface ProjectChannelStore {
  initialize(projectId: string, initial: readonly Channel[]): Promise<ProjectChannelSnapshot>;
  load(projectId: string): Promise<ProjectChannelSnapshot | undefined>;
  commit(
    projectId: string,
    expectedRevision: number,
    channels: readonly Channel[],
  ): Promise<ProjectChannelCommit>;
}

export interface ProjectCollaborationSnapshot {
  projectId: string;
  revision: number;
  roster: RosterEntry[];
  channels: Channel[];
}

export interface ProjectCollaborationCommit {
  snapshot: ProjectCollaborationSnapshot;
  changed: boolean;
}

export interface ProjectCollaborationStore {
  initialize(
    projectId: string,
    initialRoster: readonly RosterEntry[],
    initialChannels: readonly Channel[],
  ): Promise<ProjectCollaborationSnapshot>;
  load(projectId: string): Promise<ProjectCollaborationSnapshot | undefined>;
  commit(
    projectId: string,
    expectedRevision: number,
    next: { roster: readonly RosterEntry[]; channels: readonly Channel[] },
  ): Promise<ProjectCollaborationCommit>;
}
