// Real filesystem identities; the native dialog is represented by its trusted result.
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DesktopSelections } from '../src/selections';

it('binds a selection to its scope, acceptance boundary and original directory identity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agora-selection-')));
  try {
    const allowed = join(root, 'allowed');
    await mkdir(allowed);
    const selected = join(allowed, 'project');
    await mkdir(selected);
    const selections = await DesktopSelections.create([allowed]);
    const scope = { projectId: 'p', taskId: 't' };
    const view = await selections.select(scope, 'open-1', selected);
    expect(await selections.resolve(scope, view.selectionRef)).toBe(selected);
    expect(await selections.select(scope, 'open-1', selected)).toEqual(view);
    await expect(
      selections.resolve({ ...scope, projectId: 'other' }, view.selectionRef),
    ).rejects.toThrow();
    await expect(selections.select(scope, 'outside', root)).rejects.toThrow(
      'outside_acceptance_scope',
    );
    const alias = join(allowed, 'alias');
    await symlink(selected, alias);
    await expect(selections.select(scope, 'alias', alias)).rejects.toThrow();
    await rename(selected, join(allowed, 'old'));
    await mkdir(selected);
    await expect(selections.resolve(scope, view.selectionRef)).rejects.toThrow('selection_changed');
    const restarted = await DesktopSelections.create([allowed]);
    await expect(restarted.resolve(scope, view.selectionRef)).rejects.toThrow(
      'selection_unavailable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('leaves default installations closed and refuses reuse of an action for another selection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agora-selection-')));
  try {
    const closed = await DesktopSelections.create([]);
    await expect(closed.select({ projectId: 'p', taskId: 't' }, 'a', root)).rejects.toThrow(
      'outside_acceptance_scope',
    );
    const selections = await DesktopSelections.create([root]);
    const a = join(root, 'a'),
      b = join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    await selections.select({ projectId: 'p', taskId: 't' }, 'a', a);
    await expect(selections.select({ projectId: 'p', taskId: 't' }, 'a', b)).rejects.toThrow(
      'selection_action_conflict',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
