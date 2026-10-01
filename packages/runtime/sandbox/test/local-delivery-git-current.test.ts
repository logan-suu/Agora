// Fixed baseline/session ports isolate retained-claim admission. Real native
// metadata and full Git repair/application are verified by Phase 12 tests.
import { createInitialAppState } from '@agora/core-domain';
import { beforeEach, expect, it, vi } from 'vitest';
import { readLocalDeliveryGitCurrent } from '../src/local-delivery-git-current';
import type { LocalCodingBaselineOptions } from '../src/local-git-workspaces';

const ports = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../src/local-delivery-git-baseline', () => ({
  readLocalDeliveryGitBaseline: async () => ({
    root: { projectId: 'p', rootId: 'root', volumeId: 'volume', dev: 1, inode: 2 },
    grant: { grantId: 'grant', policyHash: 'policy' },
  }),
}));
vi.mock('../src/local-git-session', () => ({ withLocalGitSession: ports.session }));
beforeEach(() => {
  ports.session.mockReset();
  ports.session.mockImplementation(async (options) => {
    await options.authorize();
    throw Error('native-boundary');
  });
});
function fixture() {
  const scope = { projectId: 'p', taskId: 't' };
  const state = createInitialAppState('t', 'Fixed claim admission', 'p');
  const registry = {
    roots: [{ projectId: 'p', rootId: 'root', volumeId: 'volume', dev: 1, inode: 2 }],
    workspaces: [{ projectId: 'p', workspaceId: 'repair', rootId: 'root', mode: 'direct' }],
    claims: [
      {
        ...scope,
        workspaceId: 'repair',
        workerId: 'coder',
        status: 'active',
      },
    ],
  };
  const options = {
    control: {
      assertClosed: async () => structuredClone(state),
      snapshot: async () => structuredClone(registry),
    },
    verifyGrant: vi.fn(async () => {}),
  } as unknown as LocalCodingBaselineOptions;
  return { scope, registry, options };
}
it('requires closure proof before admitting a retained direct claim', async () => {
  const f = fixture();
  await expect(readLocalDeliveryGitCurrent(f.options, f.scope)).rejects.toThrow(
    'delivery_user_root_busy',
  );
  expect(ports.session).not.toHaveBeenCalled();
  const closed = vi.fn(async () => 'closure');
  await expect(readLocalDeliveryGitCurrent(f.options, f.scope, closed)).rejects.toThrow(
    'native-boundary',
  );
  expect(closed).toHaveBeenCalledTimes(2);
  expect(f.registry.claims[0]?.status).toBe('active');
});
it('rechecks closure at the native boundary and refuses a lost proof', async () => {
  const f = fixture();
  const closed = vi
    .fn()
    .mockResolvedValueOnce('closure')
    .mockRejectedValueOnce(Error('not_closed'));
  await expect(readLocalDeliveryGitCurrent(f.options, f.scope, closed)).rejects.toThrow(
    'not_closed',
  );
  expect(closed).toHaveBeenCalledTimes(2);
});
it.each(['other-task', 'isolated', 'integration', 'delivery'])(
  'refuses %s claims even with a closure callback',
  async (mode) => {
    const f = fixture();
    const claim = f.registry.claims[0];
    if (!claim) throw Error('fixture');
    if (mode === 'other-task') claim.taskId = 'other';
    else if (mode === 'isolated') claim.status = mode;
    else Object.assign(claim, { kind: mode });
    const closed = vi.fn(async () => 'closure');
    await expect(readLocalDeliveryGitCurrent(f.options, f.scope, closed)).rejects.toThrow(
      'delivery_user_root_busy',
    );
    expect(closed).not.toHaveBeenCalled();
    expect(ports.session).not.toHaveBeenCalled();
  },
);
it('refuses registry drift while a retained claim is being verified', async () => {
  const f = fixture();
  const closed = async () => {
    const claim = f.registry.claims[0];
    if (claim) claim.status = 'released';
    return 'closure';
  };
  await expect(readLocalDeliveryGitCurrent(f.options, f.scope, closed)).rejects.toThrow(
    'delivery_git_source_changed',
  );
  expect(ports.session).not.toHaveBeenCalled();
});
