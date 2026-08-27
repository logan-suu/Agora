import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertInside } from '../src/path-guard';

// Real-execution tests (R11/G5): genuine temp dirs + genuine symlinks, no mocks.
// assertInside returns canonical paths; on macOS `/var` is a symlink to
// `/private/var`, so expectations align via realpathSync (same as 1.2).

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agora-guard-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('assertInside (shared path guard, R7 confinement)', () => {
  it('resolves a normal path inside the root', () => {
    const root = realpathSync(makeRoot());
    const target = assertInside(root, 'src/lru.ts');
    expect(target).toBe(join(root, 'src/lru.ts'));
  });

  it('rejects literal `..` traversal escaping the root', () => {
    const root = makeRoot();
    expect(() => assertInside(root, '../../etc/passwd')).toThrow(/escapes sandbox root/);
  });

  it('rejects a symlink that redirects a read target outside the root (DEF-001)', () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), 'agora-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'top-secret');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));

    expect(() => assertInside(root, 'leak.txt')).toThrow(/escapes sandbox root/);
  });

  it('rejects a symlinked parent directory that escapes the root (DEF-001)', () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), 'agora-outside-'));
    roots.push(outside);
    mkdirSync(join(root, 'sub'));
    symlinkSync(outside, join(root, 'sub', 'escape'));

    // Writing into a new file under the escaping symlink dir must be rejected.
    expect(() => assertInside(root, 'sub/escape/new.txt')).toThrow(/escapes sandbox root/);
  });

  it('allows a symlink that stays inside the root', () => {
    const root = realpathSync(makeRoot());
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a', 'real.txt'), 'data');
    symlinkSync(join(root, 'a'), join(root, 'alias'));

    expect(assertInside(root, 'alias/real.txt')).toBe(join(root, 'a', 'real.txt'));
  });

  it('rejects a dangling final symlink pointing outside the root (DEF-001)', () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), 'agora-outside-'));
    roots.push(outside);
    // Target does not exist yet: realpath fails, but the symlink itself lstats.
    symlinkSync(join(outside, 'new.txt'), join(root, 'leak.txt'));

    expect(() => assertInside(root, 'leak.txt')).toThrow(/escapes sandbox root/);
  });

  it('rejects a dangling symlinked parent escaping the root (DEF-001)', () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), 'agora-outside-'));
    roots.push(outside);
    symlinkSync(join(outside, 'missing-dir'), join(root, 'dangling'));

    expect(() => assertInside(root, 'dangling/new.txt')).toThrow(/escapes sandbox root/);
  });

  it('throws a clear error when the path cannot be resolved at all', () => {
    const root = makeRoot();
    expect(() => assertInside(root, '/definitely/not/under/root')).toThrow(/escapes sandbox root/);
  });
});
