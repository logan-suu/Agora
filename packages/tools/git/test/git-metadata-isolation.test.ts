// Real repositories: a model-owned .git file must not redirect host Git operations.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorktreeRegistry } from '@agora/tools-fs';
import { expect, it } from 'vitest';
import { WorktreeGitService } from '../src/git-service';

it('pins linked metadata after registration even if the worktree .git pointer is replaced', async () => {
  const service = new WorktreeGitService(new WorktreeRegistry());
  const foreign = new WorktreeGitService(new WorktreeRegistry());
  try {
    const own = await service.createWorktree('task', 'own');
    const other = await foreign.createWorktree('foreign', 'other');
    await writeFile(join(other.path, 'foreign.txt'), 'foreign');
    const foreignHead = await foreign.applyPatch(other.path, '');
    const ownHead = await service.headOf(own.path);
    await writeFile(join(own.path, '.git'), await readFile(join(other.path, '.git')));
    expect(await service.headOf(own.path)).toBe(ownHead);
    await writeFile(join(own.path, 'own.txt'), 'own');
    expect(await service.applyPatch(own.path, '')).not.toBe(ownHead);
    expect(await foreign.headOf(other.path)).toBe(foreignHead);
  } finally {
    await service.dispose();
    await foreign.dispose();
  }
});
