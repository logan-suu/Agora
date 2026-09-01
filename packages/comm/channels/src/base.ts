import type { Channel } from '@agora/core-domain';

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
