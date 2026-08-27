import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeFsService } from '../src/fs-service';
import { WorktreeRegistry } from '../src/worktree-registry';

describe('WorktreeFsService', () => {
  let root: string;
  let registry: WorktreeRegistry;
  let service: WorktreeFsService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agora-fs-test-'));
    registry = new WorktreeRegistry();
    registry.register(root);
    service = new WorktreeFsService(registry);
  });

  afterEach(() => {
    registry.unregister(root);
  });

  it('writes then reads a file', () => {
    service.write(root, 'src/a.ts', 'hello');
    expect(service.read(root, 'src/a.ts')).toBe('hello');
  });

  it('creates intermediate directories on write', () => {
    service.write(root, 'deep/nested/file.txt', 'x');
    expect(existsSync(join(root, 'deep/nested/file.txt'))).toBe(true);
  });

  it('rejects a path escaping the worktree via ..', () => {
    expect(() => service.read(root, '../../etc/passwd')).toThrow(/escapes worktree root/);
  });

  it('rejects an absolute path escaping the worktree', () => {
    expect(() => service.write(root, '/etc/passwd', 'x')).toThrow(/escapes worktree root/);
  });

  it('rejects an unregistered worktree root', () => {
    const other = mkdtempSync(join(tmpdir(), 'agora-other-'));
    try {
      expect(() => service.read(other, 'a.txt')).toThrow(/not registered/);
      expect(() => service.list(other, '**')).toThrow(/not registered/);
    } finally {
      registry.unregister(other);
    }
  });

  it('read honors a character range', () => {
    service.write(root, 'a.txt', 'abcdef');
    expect(service.read(root, 'a.txt', { start: 1, end: 4 })).toBe('bcd');
    expect(service.read(root, 'a.txt', { start: 2 })).toBe('cdef');
  });

  it('read rejects an inverted range', () => {
    service.write(root, 'a.txt', 'abcdef');
    expect(() => service.read(root, 'a.txt', { start: 4, end: 1 })).toThrow(/exceeds end/);
  });

  it('list matches a glob across directories', () => {
    service.write(root, 'a.ts', '');
    service.write(root, 'src/b.ts', '');
    service.write(root, 'src/nested/c.ts', '');
    service.write(root, 'src/readme.md', '');
    expect(service.list(root, '**/*.ts')).toEqual(['a.ts', 'src/b.ts', 'src/nested/c.ts']);
    expect(service.list(root, 'src/*.ts')).toEqual(['src/b.ts']);
    expect(service.list(root, '**')).toEqual([
      'a.ts',
      'src/b.ts',
      'src/nested/c.ts',
      'src/readme.md',
    ]);
  });

  it('list skips VCS and dependency directories', () => {
    service.write(root, '.git/config', '');
    service.write(root, 'node_modules/x/index.js', '');
    service.write(root, 'app.js', '');
    const all = service.list(root, '**');
    expect(all).toContain('app.js');
    expect(all).not.toContain('.git/config');
    expect(all).not.toContain('node_modules/x/index.js');
  });
});
