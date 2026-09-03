import type { Channel, RosterEntry } from '@agora/core-domain';
import { describe, expectTypeOf, it } from 'vitest';
import type {
  ProjectChannelCommit,
  ProjectChannelSnapshot,
  ProjectChannelStore,
  ProjectCollaborationCommit,
  ProjectCollaborationSnapshot,
  ProjectCollaborationStore,
} from '../src/index';

describe('ProjectChannelStore port', () => {
  it('locks the Phase 6 persistence signature', () => {
    expectTypeOf<ProjectChannelStore['initialize']>().toEqualTypeOf<
      (projectId: string, initial: readonly Channel[]) => Promise<ProjectChannelSnapshot>
    >();
    expectTypeOf<ProjectChannelStore['load']>().toEqualTypeOf<
      (projectId: string) => Promise<ProjectChannelSnapshot | undefined>
    >();
    expectTypeOf<ProjectChannelStore['commit']>().toEqualTypeOf<
      (
        projectId: string,
        expectedRevision: number,
        channels: readonly Channel[],
      ) => Promise<ProjectChannelCommit>
    >();
  });
});

describe('ProjectCollaborationStore port', () => {
  it('locks the Phase 7 roster-and-channel persistence signature', () => {
    expectTypeOf<ProjectCollaborationStore['initialize']>().toEqualTypeOf<
      (
        projectId: string,
        initialRoster: readonly RosterEntry[],
        initialChannels: readonly Channel[],
      ) => Promise<ProjectCollaborationSnapshot>
    >();
    expectTypeOf<ProjectCollaborationStore['load']>().toEqualTypeOf<
      (projectId: string) => Promise<ProjectCollaborationSnapshot | undefined>
    >();
    expectTypeOf<ProjectCollaborationStore['commit']>().toEqualTypeOf<
      (
        projectId: string,
        expectedRevision: number,
        next: { roster: readonly RosterEntry[]; channels: readonly Channel[] },
      ) => Promise<ProjectCollaborationCommit>
    >();
  });
});
