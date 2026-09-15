import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireState, initializeFormat } from '../src/storage.js';
import { applyUpgrade, recoverUpgrade } from '../src/upgrades.js';

const roots: string[] = [];
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'agora114-upgrade-'));
  roots.push(parent);
  const owner = await acquireState(join(parent, 'state'));
  await initializeFormat(owner.root);
  await mkdir(join(owner.root, 'settings'));
  await writeFile(
    join(owner.root, 'settings/model.json'),
    '{"binding":"unchanged","ciphertext":"opaque"}',
    { mode: 0o600 },
  );
  await writeFile(join(owner.root, 'settings/roles.json'), '{"revision":1}', { mode: 0o600 });
  return owner;
}
const migration = {
  id: 'fixture-v1-v2',
  from: 1,
  to: 2,
  sourceVersion: 'fixture-1',
  converterVersion: 'fixture-2',
  files: ['settings/model.json', 'settings/roles.json'],
  transform: (path: string, bytes: Buffer) =>
    Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), format: 2, path })),
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('durable desktop upgrades', () => {
  for (const point of ['backup:0', 'file:0']) {
    it(`retries a rolled back ${point} attempt while preserving its journal and backups`, async () => {
      const owner = await fixture();
      const operation = join(roots.at(-1) ?? '', 'upgrade', migration.id);
      await expect(
        applyUpgrade(owner, migration, (stage) => {
          if (stage === point) throw new Error('interrupted');
        }),
      ).rejects.toThrow('interrupted');
      await expect(applyUpgrade(owner, migration)).rejects.toThrow('upgrade_requires_quiescence');
      await recoverUpgrade(owner, migration, 'rollback');
      const original = new Map(
        await Promise.all(
          (await readdir(operation)).map(
            async (name) => [name, await readFile(join(operation, name))] as const,
          ),
        ),
      );
      await expect(
        applyUpgrade(owner, migration, (stage) => {
          if (stage === 'archived') throw new Error('retry_interrupted');
        }),
      ).rejects.toThrow('retry_interrupted');
      await initializeFormat(owner.root);
      expect((await applyUpgrade(owner, migration)).phase).toBe('committed');
      const history = join(roots.at(-1) ?? '', 'upgrade-history');
      const archives = await readdir(history);
      expect(archives).toHaveLength(1);
      for (const [name, bytes] of original) {
        expect(await readFile(join(history, archives[0] ?? '', name))).toEqual(bytes);
      }
      expect(JSON.parse(await readFile(join(owner.root, 'desktop-format.json'), 'utf8'))).toEqual({
        version: 2,
      });
      await owner.release();
    });
  }
  it('refuses a linked archive directory without moving the closed attempt', async () => {
    const owner = await fixture();
    await expect(
      applyUpgrade(owner, migration, (point) => {
        if (point === 'prepared') throw new Error('interrupted');
      }),
    ).rejects.toThrow('interrupted');
    await recoverUpgrade(owner, migration, 'rollback');
    const parent = roots.at(-1) ?? '';
    const journal = join(parent, 'upgrade', migration.id, 'journal.json');
    const before = await readFile(journal);
    await mkdir(join(parent, 'outside'), { mode: 0o700 });
    await symlink(join(parent, 'outside'), join(parent, 'upgrade-history'));
    await expect(applyUpgrade(owner, migration)).rejects.toThrow('unsafe_upgrade_directory');
    expect(await readFile(journal)).toEqual(before);
    expect(await readdir(join(parent, 'outside'))).toEqual([]);
    await owner.release();
  });
  for (const point of ['preparing', 'backup:0']) {
    it(`rolls back incomplete backups at ${point} without touching source state`, async () => {
      const owner = await fixture();
      const before = await readFile(join(owner.root, 'settings/model.json'));
      await expect(
        applyUpgrade(owner, migration, (stage) => {
          if (stage === point) throw new Error('disk_full');
        }),
      ).rejects.toThrow('disk_full');
      await expect(recoverUpgrade(owner, migration, 'continue')).rejects.toThrow(
        'upgrade_preparation_incomplete',
      );
      expect((await recoverUpgrade(owner, migration, 'rollback')).phase).toBe('rolled_back');
      await initializeFormat(owner.root);
      expect(await readFile(join(owner.root, 'settings/model.json'))).toEqual(before);
      await owner.release();
    });
  }
  it('refuses corrupted backup bytes before changing any source file', async () => {
    const owner = await fixture();
    await expect(
      applyUpgrade(owner, migration, (stage) => {
        if (stage === 'prepared') throw new Error('interrupted');
      }),
    ).rejects.toThrow();
    await writeFile(join(roots[0] ?? '', 'upgrade', migration.id, '0.before'), 'corrupt');
    await expect(recoverUpgrade(owner, migration, 'rollback')).rejects.toThrow(
      'invalid_upgrade_backup',
    );
    expect(JSON.parse(await readFile(join(owner.root, 'settings/roles.json'), 'utf8'))).toEqual({
      revision: 1,
    });
    await owner.release();
  });

  it('commits data before the format and preserves source backups', async () => {
    const owner = await fixture();
    const before = await readFile(join(owner.root, migration.files[0] ?? ''));
    const result = await applyUpgrade(owner, migration);
    expect(result.phase).toBe('committed');
    expect(JSON.parse(await readFile(join(owner.root, 'desktop-format.json'), 'utf8'))).toEqual({
      version: 2,
    });
    expect(await readFile(join(roots[0] ?? '', 'upgrade', migration.id, '0.before'))).toEqual(
      before,
    );
    expect(
      JSON.parse(await readFile(join(owner.root, migration.files[0] ?? ''), 'utf8')),
    ).toMatchObject({ binding: 'unchanged', ciphertext: 'opaque' });
    await owner.release();
  });
  for (const point of ['prepared', 'file:0', 'file:1', 'format']) {
    for (const action of ['continue', 'rollback'] as const) {
      it(`recovers ${point} through ${action} using durable hashes`, async () => {
        const owner = await fixture();
        await expect(
          applyUpgrade(owner, migration, (stage) => {
            if (stage === point) throw new Error('power_loss');
          }),
        ).rejects.toThrow('power_loss');
        await expect(initializeFormat(owner.root)).rejects.toThrow('upgrade_requires_quiescence');
        const result = await recoverUpgrade(owner, migration, action);
        expect(result.phase).toBe(action === 'continue' ? 'committed' : 'rolled_back');
        const bytes = await readFile(join(owner.root, 'settings/roles.json'), 'utf8');
        expect(JSON.parse(bytes).format).toBe(action === 'continue' ? 2 : undefined);
        if (action === 'rollback') await initializeFormat(owner.root);
        await owner.release();
      });
    }
  }
  it('rejects changed state, bad backups, traversal, and released ownership', async () => {
    const owner = await fixture();
    await expect(applyUpgrade(owner, { ...migration, files: ['../outside'] })).rejects.toThrow(
      'invalid_upgrade_path',
    );
    await expect(
      applyUpgrade(owner, migration, (stage) => {
        if (stage === 'prepared') throw new Error('power_loss');
      }),
    ).rejects.toThrow();
    await writeFile(join(owner.root, 'settings/roles.json'), '{"external":true}');
    await expect(recoverUpgrade(owner, migration, 'continue')).rejects.toThrow(
      'upgrade_state_changed',
    );
    await owner.release();
    await expect(recoverUpgrade(owner, migration, 'rollback')).rejects.toThrow(
      'state_owner_changed',
    );
  });
});
