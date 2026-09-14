import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireState, initializeFormat } from '../src/storage.js';

const roots: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'agora113-storage-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('desktop state ownership', () => {
  it('allows exactly one writer and preserves state after release', async () => {
    const root = await directory();
    const owner = await acquireState(root);
    await expect(acquireState(root)).rejects.toThrow('state_in_use');
    await initializeFormat(root);
    const before = await readFile(join(root, 'desktop-format.json'), 'utf8');
    await owner.release();
    const second = await acquireState(root);
    await initializeFormat(root);
    expect(await readFile(join(root, 'desktop-format.json'), 'utf8')).toBe(before);
    await second.release();
  });
  it('never deletes an unproven stale owner or writes unknown formats', async () => {
    const root = await directory();
    await writeFile(join(root, '.desktop-owner'), 'stale');
    await expect(acquireState(root)).rejects.toThrow('state_in_use');
    expect(await readFile(join(root, '.desktop-owner'), 'utf8')).toBe('stale');
    await writeFile(join(root, 'desktop-format.json'), JSON.stringify({ version: 2 }));
    await expect(initializeFormat(root)).rejects.toThrow('unsupported_state_version');
  });
  it('rejects symlinks and unversioned nonempty state', async () => {
    const root = await directory();
    await mkdir(join(root, 'projects'));
    await expect(initializeFormat(root)).rejects.toThrow('unsupported_state_version');
    const link = join(await directory(), 'link');
    await symlink(root, link);
    await expect(acquireState(link)).rejects.toThrow('unsafe_state_path');
  });
  it('refuses an unfinished upgrade before opening normal state', async () => {
    const parent = await directory();
    const root = join(parent, 'state');
    await mkdir(root);
    await mkdir(join(parent, 'upgrade'));
    await writeFile(join(parent, 'upgrade/prepared.json'), '{}');
    await expect(initializeFormat(root)).rejects.toThrow('upgrade_requires_quiescence');
  });
});
