// Real formal file services, filesystem, processes and Docker; no security doubles.
import { spawn } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Dockerode,
  DockerSandbox,
  LocalTempSandbox,
  type SandboxManager,
} from '@agora/runtime-sandbox';
import { WorktreeFsService, WorktreeRegistry } from '@agora/tools-fs';
import { expect, it, onTestFinished } from 'vitest';

it.each(['fs', 'local', 'docker'] as const)(
  '%s formal entry refuses independent ancestor races and root replacement',
  async (kind) => {
    const base = mkdtempSync(join(tmpdir(), 'agora-formal-files-'));
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel'), 'outside secret');
    writeFileSync(join(outside, 'outside-only'), 'outside secret');
    const socket = join(process.env.HOME ?? '', '.docker/run/docker.sock');
    let sandbox: SandboxManager | undefined;
    if (kind === 'local') sandbox = new LocalTempSandbox();
    if (kind === 'docker')
      sandbox = new DockerSandbox({
        baseDir: base,
        docker: new Dockerode(existsSync(socket) ? { socketPath: socket } : {}),
      });
    const worktree =
      sandbox === undefined
        ? { path: join(base, 'root'), branch: 'test' }
        : await sandbox.createWorktree('boundary', 'worker');
    mkdirSync(worktree.path, { recursive: true });
    const registry = new WorktreeRegistry();
    onTestFinished(async () => {
      await sandbox?.teardown('boundary');
      registry.unregister(worktree.path);
      rmSync(`${worktree.path}-old`, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    });
    registry.register(worktree.path);
    const fs = new WorktreeFsService(registry);
    const read = (path: string) =>
      sandbox === undefined
        ? Promise.resolve(fs.read(worktree.path, path))
        : sandbox.read(worktree, path);
    const write = (path: string, value: string) =>
      sandbox === undefined
        ? Promise.resolve(fs.write(worktree.path, path, value))
        : sandbox.write(worktree, path, value);
    await write('nested/new', 'inside');
    symlinkSync('nested/new', join(worktree.path, 'internal'));
    expect(await read('internal')).toBe('inside');
    await write('internal', 'updated');
    expect(await read('nested/new')).toBe('updated');
    symlinkSync('nested/dangling', join(worktree.path, 'dangling'));
    await write('dangling', 'created');
    expect(await read('nested/dangling')).toBe('created');
    for (const name of ['final', 'missing']) {
      symlinkSync(
        join(outside, name === 'final' ? 'sentinel' : 'missing'),
        join(worktree.path, name),
      );
      await expect(async () => read(name)).rejects.toThrow(/escapes/);
      await expect(async () => write(name, 'bad')).rejects.toThrow(/escapes/);
    }
    symlinkSync('loop', join(worktree.path, 'loop'));
    await expect(async () => read('loop')).rejects.toThrow(/link limit/);
    linkSync(join(outside, 'sentinel'), join(worktree.path, 'hard'));
    await expect(async () => read('hard')).rejects.toThrow(/hard link/);
    await expect(async () => write('hard', 'bad')).rejects.toThrow(/hard link/);
    unlinkSync(join(worktree.path, 'hard'));
    expect(existsSync(join(outside, 'missing'))).toBe(false);
    mkdirSync(join(worktree.path, 'moving'));
    writeFileSync(join(worktree.path, 'moving/sentinel'), 'inside');
    const code = `const fs=require('node:fs');const [root,outside]=process.argv.slice(1);process.stdout.write('ready');for(;;){try{fs.renameSync(root+'/moving',root+'/parked');fs.symlinkSync(outside,root+'/moving');fs.unlinkSync(root+'/moving');fs.renameSync(root+'/parked',root+'/moving');}catch{}}`;
    const child = spawn(process.execPath, ['-e', code, worktree.path, outside], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', () => resolve());
    });
    try {
      for (let i = 0; i < 100; i++) {
        let value: string | undefined;
        try {
          value = await read('moving/sentinel');
        } catch (error) {
          expect(String(error)).toMatch(/escapes|cannot open|ENOENT/);
        }
        if (value !== undefined) expect(value).not.toContain('outside');
        try {
          await write('moving/sentinel', 'inside');
        } catch (error) {
          expect(String(error)).toMatch(/escapes|cannot open|ENOENT/);
        }
        if (kind === 'fs')
          try {
            expect(fs.list(worktree.path, '**')).not.toContain('moving/outside-only');
          } catch (error) {
            if (error instanceof Error && error.name === 'AssertionError') throw error;
            expect(String(error)).toMatch(/changed|cannot inspect|cannot read/);
          }
      }
      expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('outside secret');
    } finally {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    renameSync(worktree.path, `${worktree.path}-old`);
    mkdirSync(worktree.path);
    writeFileSync(join(worktree.path, 'replacement'), 'replacement');
    await expect(async () => read('replacement')).rejects.toThrow(/retargeted/);
    await expect(async () => write('replacement', 'bad')).rejects.toThrow(/retargeted/);
    if (kind === 'fs') expect(() => fs.list(worktree.path, '**')).toThrow(/retargeted/);
    expect(readFileSync(join(worktree.path, 'replacement'), 'utf8')).toBe('replacement');
  },
  30_000,
);
