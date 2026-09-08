// Real Docker and filesystem: these assertions exercise the actual mount boundary.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Dockerode from 'dockerode';
import { expect, it } from 'vitest';
import { DockerSandbox } from '../src/docker-sandbox';

it('mounts only the executing worktree and suspends every task container', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agora-isolation-'));
  const root = join(base, 'task');
  const first = { path: join(root, 'worktrees', 'first'), branch: 'first' };
  const second = { path: join(root, 'worktrees', 'second'), branch: 'second' };
  mkdirSync(first.path, { recursive: true });
  mkdirSync(second.path, { recursive: true });
  writeFileSync(join(root, 'state.json'), 'task sentinel');
  writeFileSync(join(second.path, 'secret.txt'), 'sibling sentinel');
  const socketPath = join(process.env.HOME ?? '', '.docker/run/docker.sock');
  const docker = existsSync(socketPath) ? new Dockerode({ socketPath }) : new Dockerode();
  const sandbox = new DockerSandbox({ docker, baseDir: base });
  try {
    await sandbox.bindWorktree('task', 'first', first, root);
    await sandbox.bindWorktree('task', 'second', second, root);
    const result = await sandbox.run(
      first,
      'cat ../second/secret.txt ../../state.json; echo compromised > ../../state.json',
    );
    expect(result.stdout).not.toContain('sentinel');
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe('task sentinel');
    expect((await sandbox.run(first, 'pwd')).stdout.trim()).toBe('/workspace');
    await sandbox.run(second, 'echo own > own.txt');
    await sandbox.run(
      first,
      "node -e \"setInterval(()=>require('fs').writeFileSync('heartbeat',String(Date.now())),5)\" >/dev/null 2>&1 &",
    );
    await sandbox.run(first, 'sleep 0.1');
    await sandbox.withStableFiles(first.path, async () => {
      const before = readFileSync(join(first.path, 'heartbeat'), 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(readFileSync(join(first.path, 'heartbeat'), 'utf8')).toBe(before);
    });
    expect((await sandbox.run(first, 'echo resumed')).stdout).toContain('resumed');
    const containers = await docker.listContainers({ all: true });
    const owned = containers.filter((item) =>
      item.Mounts.some((mount) => mount.Source.includes(realpathSync(base))),
    );
    expect(owned).toHaveLength(2);
    expect(owned.flatMap((item) => item.Mounts.map((mount) => mount.Source))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/worktrees\/first$/),
        expect.stringMatching(/worktrees\/second$/),
      ]),
    );
    const binds = await Promise.all(
      owned.map(async (item) => (await docker.getContainer(item.Id).inspect()).HostConfig.Binds),
    );
    expect(binds.flat().sort()).toEqual(
      [
        `${realpathSync(first.path)}:/workspace:rw`,
        `${realpathSync(second.path)}:/workspace:rw`,
      ].sort(),
    );
    await sandbox.suspend('task');
    for (const container of owned)
      await expect(docker.getContainer(container.Id).inspect()).rejects.toThrow();
    expect(readFileSync(join(second.path, 'own.txt'), 'utf8')).toBe('own\n');
  } finally {
    await sandbox.suspend('task');
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);
