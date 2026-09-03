import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonProjectCollaborationStore } from '@agora/comm-channels';
import { createMainChannel, type RoleSpec, type RosterEntry } from '@agora/core-domain';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectRosterService } from '../src/index';

const roots: string[] = [];

function spec(role: string): RoleSpec {
  return {
    role,
    executor: 'harness',
    systemPrompt: `${role} responsibilities.`,
    tools: [],
    projection: ['global.summary'],
    routeWhen: 'always',
  };
}

const initialRoster: readonly RosterEntry[] = [
  { spec: spec('COORDINATOR'), status: 'enabled' },
  { spec: spec('CODER'), status: 'enabled' },
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agora-roster-service-test-'));
  roots.push(root);
  const store = new JsonProjectCollaborationStore(root);
  await store.initialize('project-a', initialRoster, [createMainChannel(['COORDINATOR', 'CODER'])]);
  return { store, service: new ProjectRosterService(store) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProjectRosterService', () => {
  it('adds a role and main participant in one collaboration revision', async () => {
    const { service, store } = await fixture();

    const result = await service.addRole('project-a', { ...spec('release_manager') });

    expect(result.changed).toBe(true);
    expect(result.snapshot.revision).toBe(1);
    expect(result.snapshot.roster.at(-1)?.spec.role).toBe('RELEASE_MANAGER');
    expect(result.snapshot.channels[0]?.participants).toEqual([
      'leader',
      'COORDINATOR',
      'CODER',
      'RELEASE_MANAGER',
    ]);
    await expect(store.load('project-a')).resolves.toEqual(result.snapshot);
  });

  it('makes identical add and same-state enable/disable replays storage no-ops', async () => {
    const { service } = await fixture();
    const first = await service.disableRole('project-a', 'CODER');
    const replay = await service.disableRole('project-a', 'coder');
    const enabled = await service.enableRole('project-a', 'CODER');
    const enableReplay = await service.enableRole('project-a', 'CODER');

    expect(first.snapshot.revision).toBe(1);
    expect(replay).toMatchObject({ changed: false, snapshot: { revision: 1 } });
    expect(enabled.snapshot.revision).toBe(2);
    expect(enableReplay).toMatchObject({ changed: false, snapshot: { revision: 2 } });
  });

  it('rejects Phase 7 external executors before persistence', async () => {
    const { service } = await fixture();
    await expect(
      service.addRole('project-a', { ...spec('EXTERNAL_REVIEWER'), executor: 'external' }),
    ).rejects.toThrow(/harness.*Phase 7/i);
  });
});
