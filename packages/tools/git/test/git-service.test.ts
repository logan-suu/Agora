import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeRegistry } from '@agora/tools-fs';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import {
  validateBranchName,
  validateRefArg,
  validateTaskId,
  WorktreeGitService,
} from '../src/git-service';

/**
 * Real-execution tests (decisions R11/G5): no mocks, no test doubles. Every case
 * drives the real system `git` binary through simple-git against real temp
 * directories (mkdtempSync under os.tmpdir()). The git binary and the service
 * are never stubbed.
 */
describe('WorktreeGitService', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function track<T extends { path: string }>(result: T): T {
    roots.push(result.path);
    return result;
  }

  it('lazily creates a temp main repo with an initial commit', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    const { path, branch } = track(await service.createWorktree('t1', 'feature-a'));

    expect(branch).toBe('feature-a');
    expect(registry.canonicalOf(path)).toBeDefined();

    // A linked worktree's `.git` is a file pointing at the main repo's gitdir.
    expect(readFileSync(join(path, '.git'), 'utf8')).toContain('gitdir:');

    // The branch was created from the main repo's HEAD, so the initial commit
    // must exist (otherwise `git worktree add -b` would have failed).
    const git = simpleGit(path);
    const log = await git.log();
    expect(log.total).toBeGreaterThanOrEqual(1);
    expect(log.latest?.message).toBe('initial');
    const branches = await git.branch();
    expect(branches.current).toBe('feature-a');
  });

  it('creates a real linked worktree with the expected branch and registers it', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    const { path, branch } = track(await service.createWorktree('t1', 'feature-x'));

    expect(branch).toBe('feature-x');
    expect(registry.canonicalOf(path)).toBeDefined();
    expect(existsSync(join(path, '.git'))).toBe(true);

    const git = simpleGit(path);
    const branches = await git.branch();
    expect(branches.current).toBe('feature-x');
    expect(branches.branches['feature-x']).toBeDefined();
  });

  it('rejects branch names that are not git-ref-safe', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);

    for (const bad of [
      'a/b',
      'a..b',
      'a b',
      'a~b',
      'a^b',
      'a:b',
      'a?b',
      'a*b',
      'a[b',
      'a\\b',
      '..',
      '.',
      'a.',
      '.a',
      'a@{b',
    ]) {
      expect(() => validateBranchName(bad), `name: ${bad}`).toThrow('invalid branch name');
      await expect(service.createWorktree('t1', bad)).rejects.toThrow('invalid branch name');
    }
    expect(validateBranchName('feature-ok')).toBe('feature-ok');
  });

  it('rejects task ids that could escape the worktrees directory (R7)', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);

    for (const bad of ['../escape', 'a/b', 'a\\b', 'a b', '..', '.', '.hidden', '']) {
      expect(() => validateTaskId(bad), `taskId: ${bad}`).toThrow('invalid task id');
      await expect(service.createWorktree(bad, 'feature-x')).rejects.toThrow('invalid task id');
    }
    expect(validateTaskId('t-1_ok')).toBe('t-1_ok');
  });

  it('rejects ref arguments that could be misparsed as git options', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    const { path } = track(await service.createWorktree('t1', 'feature-refs'));

    for (const bad of ['--output=/tmp/pwned', '-n', 'HEAD --stat']) {
      expect(() => validateRefArg(bad, 'ref'), `ref: ${bad}`).toThrow('invalid ref');
      await expect(service.diff(path, bad)).rejects.toThrow('invalid ref');
    }
    for (const bad of ['--strategy=ours', '-q']) {
      expect(() => validateRefArg(bad, 'base branch'), `base: ${bad}`).toThrow(
        'invalid base branch',
      );
      await expect(service.merge(bad, 'feature-x')).rejects.toThrow('invalid base branch');
    }
    // Legitimate ref syntax stays allowed (ranges, ancestors, shorthands).
    expect(validateRefArg('main..feature', 'ref')).toBe('main..feature');
    expect(validateRefArg('HEAD~1', 'ref')).toBe('HEAD~1');
  });

  it('applies a patch, commits, and returns a real commit id', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    const { path } = track(await service.createWorktree('t1', 'feature-patch'));

    writeFileSync(join(path, 'a.txt'), 'hello\n');
    const git = simpleGit(path);
    await git.add(['-A']);
    await git.commit('base');

    const patch = `${[
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+world',
    ].join('\n')}\n`;

    const commitId = await service.applyPatch(path, patch);
    expect(commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('world\n');

    const log = await git.log();
    expect(log.latest?.message).toBe('apply patch');
    expect(log.latest?.hash).toBe(commitId);
  });

  it('stops before committing when cancelled by an aborted signal (task 1.5 timeout policy)', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    const { path } = track(await service.createWorktree('t1', 'feature-cancel'));

    writeFileSync(join(path, 'a.txt'), 'hello\n');
    const git = simpleGit(path);
    await git.add(['-A']);
    await git.commit('base');

    const patch = `${[
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+world',
    ].join('\n')}\n`;

    const controller = new AbortController();
    controller.abort();
    await expect(service.applyPatch(path, patch, controller.signal)).rejects.toThrow('aborted');

    // No late commit: the mutation stopped before staging+commit.
    const log = await git.log();
    expect(log.latest?.message).toBe('base');
  });

  it('rejects an unregistered worktree root', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    const root = mkdtempSync(join(tmpdir(), 'agora-git-unregistered-'));
    roots.push(root);

    await expect(service.diff(root)).rejects.toThrow('not registered');
    await expect(service.applyPatch(root, '')).rejects.toThrow('not registered');
  });

  it('rejects a retargeted worktree root', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    const { path } = track(await service.createWorktree('t1', 'feature-retarget'));

    const elsewhere = mkdtempSync(join(tmpdir(), 'agora-git-elsewhere-'));
    roots.push(elsewhere);
    rmSync(path, { recursive: true, force: true });
    symlinkSync(elsewhere, path);

    await expect(service.diff(path)).rejects.toThrow('retargeted');
  });

  it('diffs working-tree changes vs HEAD when ref is omitted', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    const { path } = track(await service.createWorktree('t1', 'feature-diff'));

    writeFileSync(join(path, 'a.txt'), 'hello\n');
    const git = simpleGit(path);
    await git.add(['-A']);
    await git.commit('base');
    writeFileSync(join(path, 'a.txt'), 'world\n');

    const diff = await service.diff(path);
    expect(diff).toContain('-hello');
    expect(diff).toContain('+world');
  });

  it('diffs against an explicit ref', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    const { path } = track(await service.createWorktree('t1', 'feature-diff-ref'));

    writeFileSync(join(path, 'a.txt'), 'hello\n');
    const git = simpleGit(path);
    await git.add(['-A']);
    await git.commit('base');
    const baseCommit = (await git.revparse(['HEAD'])).trim();
    writeFileSync(join(path, 'a.txt'), 'world\n');
    await git.add(['-A']);
    await git.commit('second');

    const diff = await service.diff(path, baseCommit);
    expect(diff).toContain('-hello');
    expect(diff).toContain('+world');
  });

  it('merges a branch into the base cleanly', async () => {
    const registry = new WorktreeRegistry();
    const main = mkdtempSync(join(tmpdir(), 'agora-git-main-'));
    roots.push(main);
    const service = new WorktreeGitService(registry, main);

    const feature = track(await service.createWorktree('t1', 'feature-merge'));
    writeFileSync(join(feature.path, 'feature.txt'), 'feature\n');
    const git = simpleGit(feature.path);
    await git.add(['-A']);
    await git.commit('feature commit');

    const mainGit = simpleGit(main);
    const defaultBranch = (await mainGit.revparse(['--abbrev-ref', 'HEAD'])).trim();

    const result = await service.merge(defaultBranch, 'feature-merge');
    expect(result.ok).toBe(true);

    await mainGit.checkout(defaultBranch);
    expect(existsSync(join(main, 'feature.txt'))).toBe(true);
  });

  it('returns ok:false when the target branch is checked out by a linked worktree', async () => {
    const registry = new WorktreeRegistry();
    const main = mkdtempSync(join(tmpdir(), 'agora-git-main-'));
    roots.push(main);
    const service = new WorktreeGitService(registry, main);

    track(await service.createWorktree('t1', 'base-branch'));
    const feature = track(await service.createWorktree('t2', 'feature-branch'));
    writeFileSync(join(feature.path, 'feature.txt'), 'feature\n');
    const git = simpleGit(feature.path);
    await git.add(['-A']);
    await git.commit('feature commit');

    // `base-branch` is checked out by the linked worktree, so the main repo
    // cannot check it out to merge into it.
    const result = await service.merge('base-branch', 'feature-branch');
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts?.[0]).toContain('already');
  });

  it('returns ok:false with conflicting paths on a real merge conflict', async () => {
    const registry = new WorktreeRegistry();
    const main = mkdtempSync(join(tmpdir(), 'agora-git-main-'));
    roots.push(main);
    const service = new WorktreeGitService(registry, main);

    const feature = track(await service.createWorktree('t1', 'feature-conflict'));
    const mainGit = simpleGit(main);
    const defaultBranch = (await mainGit.revparse(['--abbrev-ref', 'HEAD'])).trim();

    writeFileSync(join(main, 'conflict.txt'), 'base\n');
    await mainGit.add(['-A']);
    await mainGit.commit('base content');

    writeFileSync(join(feature.path, 'conflict.txt'), 'feature\n');
    const git = simpleGit(feature.path);
    await git.add(['-A']);
    await git.commit('feature content');

    const result = await service.merge(defaultBranch, 'feature-conflict');
    expect(result.ok).toBe(false);
    expect(result.conflicts).toContain('conflict.txt');
  });
});
