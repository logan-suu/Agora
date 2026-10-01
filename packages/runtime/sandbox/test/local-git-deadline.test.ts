// Real Git metadata helper and wall-clock expiry; no clock or subprocess doubles.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { withLocalGitSession } from '../src/local-git-session';
import { binary, fixture, metadataHelper } from './local-git-fixture';

it('rejects expired authorization before starting another metadata helper or Git command', async () => {
  await fixture(async (f) => {
    const head = f.git(['rev-parse', 'HEAD']);
    const index = readFileSync(join(f.metadata, 'index'));
    let authorized = 0;
    let commandReturned = false;
    await expect(
      withLocalGitSession(
        {
          ...f,
          git: binary,
          metadataHelper,
          projectId: 'project',
          taskId: 'task',
          actionId: 'expired-authorization',
          authorize: async () => {
            authorized++;
            await delay(30_100);
            return true;
          },
        },
        async (session) => {
          await session.run(['rev-parse', 'HEAD']);
          commandReturned = true;
        },
      ),
    ).rejects.toThrow('local_git_deadline');
    expect(authorized).toBe(1);
    expect(commandReturned).toBe(false);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
  });
}, 60_000);

it('releases the Git session when read-only authorization never settles', async () => {
  await fixture(async (f) => {
    const head = f.git(['rev-parse', 'HEAD']);
    const index = readFileSync(join(f.metadata, 'index'));
    let commandReturned = false;
    await expect(
      withLocalGitSession(
        {
          ...f,
          git: binary,
          metadataHelper,
          projectId: 'project',
          taskId: 'task',
          actionId: 'stalled-authorization',
          authorize: () => new Promise<boolean>(() => undefined),
        },
        async (session) => {
          await session.run(['rev-parse', 'HEAD']);
          commandReturned = true;
        },
      ),
    ).rejects.toThrow('local_git_deadline');
    expect(commandReturned).toBe(false);
    const next = await withLocalGitSession(
      {
        ...f,
        git: binary,
        metadataHelper,
        projectId: 'project',
        taskId: 'task',
        actionId: 'after-stalled-authorization',
        authorize: async () => true,
      },
      (session) => session.run(['rev-parse', 'HEAD']),
    );
    expect(next).toBe(head);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
  });
}, 60_000);
