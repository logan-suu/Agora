// Real filesystem and independent process races; no filesystem test doubles.
import { spawn } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SecureFiles } from '../src/secure-files';

const roots: string[] = [];
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'agora-secure-files-'));
  roots.push(base);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'outside sentinel');
  return { root, outside, files: new SecureFiles(root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('supports nested files and bounded internal links while refusing escape and hard links', () => {
  const { root, outside, files } = fixture();
  files.write('nested/file', 'inside');
  symlinkSync(join(root, 'nested/file'), join(root, 'alias'));
  expect(files.read('alias')).toBe('inside');
  expect(files.list()).toEqual(['nested/file']);
  expect(files.measure().logicalBytes).toBeGreaterThanOrEqual(6);
  symlinkSync(outside, join(root, 'escape'));
  expect(() => files.read('escape/sentinel')).toThrow(/escapes worktree root/);
  expect(() => files.write('escape/new', 'bad')).toThrow(/escapes worktree root/);
  linkSync(join(outside, 'sentinel'), join(root, 'hard'));
  expect(() => files.read('hard')).toThrow(/hard link/);
  expect(() => files.write('hard', 'bad')).toThrow(/hard link/);
  expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('outside sentinel');
});

it('rejects a replaced root even when its pathname is unchanged', () => {
  const { root, files } = fixture();
  renameSync(root, `${root}-old`);
  mkdirSync(root);
  writeFileSync(join(root, 'sentinel'), 'replacement');
  expect(() => files.read('sentinel')).toThrow(/retargeted/);
  expect(() => files.write('sentinel', 'bad')).toThrow(/retargeted/);
  expect(() => files.list()).toThrow(/retargeted/);
});

it('snapshots binary files without Git metadata and refuses outside links', () => {
  const { root, outside, files } = fixture();
  const destination = `${root}-snapshot`;
  writeFileSync(join(root, 'binary'), Buffer.from([0, 255, 128, 10]));
  writeFileSync(join(root, '.git'), 'gitdir: outside metadata');
  files.snapshotTo(destination);
  expect(readFileSync(join(destination, 'binary'))).toEqual(Buffer.from([0, 255, 128, 10]));
  expect(() => readFileSync(join(destination, '.git'))).toThrow();
  symlinkSync(join(outside, 'sentinel'), join(root, 'leak'));
  expect(() => files.snapshotTo(`${root}-rejected`)).toThrow(/escapes worktree root/);
});

it('never reads or changes an outside sentinel while a separate process swaps an ancestor', async () => {
  const { root, outside, files } = fixture();
  mkdirSync(join(root, 'moving'));
  writeFileSync(join(root, 'moving/sentinel'), 'inside');
  expect(files.read('moving/sentinel')).toBe('inside');
  const script = `const fs=require('node:fs'); const [root,outside]=process.argv.slice(1);process.stdout.write('ready');for(;;){try{fs.renameSync(root+'/moving',root+'/parked');fs.symlinkSync(outside,root+'/moving');fs.unlinkSync(root+'/moving');fs.renameSync(root+'/parked',root+'/moving');}catch{}}`;
  const child = spawn(process.execPath, ['-e', script, root, outside], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve());
  });
  try {
    for (let i = 0; i < 150; i++) {
      try {
        expect(files.read('moving/sentinel')).not.toContain('outside');
      } catch (error) {
        if (error instanceof Error && error.name === 'AssertionError') throw error;
      }
      try {
        files.write('moving/sentinel', 'safe');
      } catch {
        /* Races may fail closed. */
      }
      try {
        expect(files.list()).not.toContain('outside/sentinel');
      } catch (error) {
        if (error instanceof Error && error.name === 'AssertionError') throw error;
      }
    }
  } finally {
    const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await stopped;
  }
  expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('outside sentinel');
}, 30_000);
