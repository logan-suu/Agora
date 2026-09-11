import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WorktreeRegistry } from '@agora/tools-fs';
import { initializeRegisteredWorktree, WorktreeGitService } from '@agora/tools-git';

/** Called only with trusted allowlisted task seeds, before exposing a workspace to an agent. */
export async function seedRepository(root: string, files: Readonly<Record<string, string>>) {
  await mkdir(root, { recursive: true });
  const registry = new WorktreeRegistry();
  await initializeRegisteredWorktree(registry, root);
  for (const [path, content] of Object.entries(files)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path) ||
      path.split('/').some((p) => p === '..' || p === '.git')
    )
      throw new Error('invalid seed path');
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, { flag: 'wx' });
  }
  const git = new WorktreeGitService(registry, root);
  const commit = Object.keys(files).length
    ? await git.applyPatch(root, '')
    : await git.headOf(root);
  return { registry, git, commit };
}
