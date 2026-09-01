import { describe, expectTypeOf, it } from 'vitest';
import type { ProjectChannelStore } from '../src/index';

describe('ProjectChannelStore port', () => {
  it('locks the Phase 6 persistence signature', () => {
    expectTypeOf<ProjectChannelStore['initialize']>().toBeFunction();
    expectTypeOf<ProjectChannelStore['load']>().toBeFunction();
    expectTypeOf<ProjectChannelStore['commit']>().toBeFunction();
  });
});
