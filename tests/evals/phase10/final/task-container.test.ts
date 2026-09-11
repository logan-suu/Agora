import { expect, it } from 'vitest';
import { mountBelongsToTask } from './task-container';

it('matches Docker Desktop VM and host mount paths without counting sibling tasks', () => {
  expect(
    mountBelongsToTask('/host_mnt/Users/me/task/worktrees/a', '/Users/me/task', 'darwin'),
  ).toBe(true);
  expect(
    mountBelongsToTask('/host_mnt/private/var/folders/task/a', '/var/folders/task', 'darwin'),
  ).toBe(true);
  expect(mountBelongsToTask('/Users/me/task/a', '/Users/me/task', 'darwin')).toBe(true);
  expect(mountBelongsToTask('/host_mnt/Users/me/task-other/a', '/Users/me/task', 'darwin')).toBe(
    false,
  );
  expect(mountBelongsToTask('/host_mnt/Users/me/task/../other', '/Users/me/task', 'darwin')).toBe(
    false,
  );
});
it('keeps native Linux paths and rejects relative or filesystem-root scopes', () => {
  expect(mountBelongsToTask('/data/task/a', '/data/task', 'linux')).toBe(true);
  expect(mountBelongsToTask('/host_mnt/data/task/a', '/data/task', 'linux')).toBe(false);
  expect(mountBelongsToTask('task/a', 'task', 'linux')).toBe(false);
  expect(mountBelongsToTask('/data/task/a', '/', 'linux')).toBe(false);
});
