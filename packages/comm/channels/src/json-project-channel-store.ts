import {
  type Channel,
  normalizeRoleId,
  type RoleId,
  type RoleSpec,
  type RosterEntry,
} from '@agora/core-domain';

import type { ProjectChannelCommit, ProjectChannelSnapshot, ProjectChannelStore } from './base';
import { JsonProjectCollaborationStore } from './json-project-collaboration-store';
import type { LegacyBubbledSummary } from './legacy-channel-migration';

/** Frozen Phase 6 Channel port backed by the D12 collaboration snapshot. */
export class JsonProjectChannelStore implements ProjectChannelStore {
  readonly collaboration: JsonProjectCollaborationStore;
  readonly #initialRoster: readonly RosterEntry[];

  constructor(
    rootOrCollaboration: string | JsonProjectCollaborationStore,
    roster: readonly RoleId[] | readonly RosterEntry[],
  ) {
    this.collaboration =
      typeof rootOrCollaboration === 'string'
        ? new JsonProjectCollaborationStore(rootOrCollaboration)
        : rootOrCollaboration;
    this.#initialRoster = toRosterEntries(roster);
  }

  async initialize(
    projectId: string,
    initial: readonly Channel[],
  ): Promise<ProjectChannelSnapshot> {
    const snapshot = await this.collaboration.initialize(projectId, this.#initialRoster, initial);
    return channelSnapshot(snapshot);
  }

  async load(projectId: string): Promise<ProjectChannelSnapshot | undefined> {
    const snapshot = await this.collaboration.load(projectId);
    return snapshot === undefined ? undefined : channelSnapshot(snapshot);
  }

  async commit(
    projectId: string,
    expectedRevision: number,
    channels: readonly Channel[],
  ): Promise<ProjectChannelCommit> {
    const current = await this.collaboration.load(projectId);
    if (current === undefined) {
      throw new Error(`project channel store is not initialized for projectId "${projectId}"`);
    }
    const legacySummaries = await this.collaboration.legacyBubbledSummaries(projectId);
    for (const legacy of legacySummaries) {
      const candidate = channels.find(
        (channel) => channel.kind === 'sub' && channel.channelId === legacy.channelId,
      );
      if (
        candidate?.kind !== 'sub' ||
        candidate.bubbledSummaryRef?.taskId !== legacy.taskId ||
        candidate.bubbledSummaryRef.msgId !== `channel-bubble:${legacy.channelId}`
      ) {
        throw new Error(
          `legacy bubbledSummary for channel "${legacy.channelId}" must be migrated before commit`,
        );
      }
    }
    const result = await this.collaboration.commit(projectId, expectedRevision, {
      roster: current.roster,
      channels,
    });
    return { changed: result.changed, snapshot: channelSnapshot(result.snapshot) };
  }

  async legacyBubbledSummaries(projectId: string): Promise<LegacyBubbledSummary[]> {
    return this.collaboration.legacyBubbledSummaries(projectId);
  }

  async acknowledgeLegacyBubbledSummary(projectId: string, channelId: string): Promise<void> {
    return this.collaboration.acknowledgeLegacyBubbledSummary(projectId, channelId);
  }
}

function toRosterEntries(
  roster: readonly RoleId[] | readonly RosterEntry[],
): readonly RosterEntry[] {
  return roster.map((entry) => {
    if (typeof entry !== 'string') return structuredClone(entry);
    const role = normalizeRoleId(entry);
    return { spec: compatibilitySpec(role), status: 'enabled' };
  });
}

function compatibilitySpec(role: string): RoleSpec {
  return {
    role,
    executor: 'harness',
    systemPrompt: `Compatibility definition for ${role}.`,
    tools: [],
    projection: ['global.summary'],
    routeWhen: 'always',
  };
}

function channelSnapshot(snapshot: {
  projectId: string;
  revision: number;
  channels: readonly Channel[];
}): ProjectChannelSnapshot {
  return {
    projectId: snapshot.projectId,
    revision: snapshot.revision,
    channels: structuredClone([...snapshot.channels]),
  };
}

export type { LegacyBubbledSummary } from './legacy-channel-migration';
