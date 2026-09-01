import type { Channel } from '@agora/core-domain';
import { describe, expectTypeOf, it } from 'vitest';
import type {
  ProjectChannelCommit,
  ProjectChannelSnapshot,
  ProjectChannelStore,
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
