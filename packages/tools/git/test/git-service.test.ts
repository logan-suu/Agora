import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { WorktreeRegistry } from '@agora/tools-fs';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeGitIsolationKey,
  GIT_TEARDOWN_STAGING,
  initializeRegisteredWorktree,
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

  it('initializes and registers an existing sandbox worktree for host-side git tools', async () => {
    const registry = new WorktreeRegistry();
    const path = mkdtempSync(join(tmpdir(), 'agora-existing-worktree-'));
    roots.push(path);

    await initializeRegisteredWorktree(registry, path);

    expect(registry.canonicalOf(path)).toBeDefined();
    expect(await simpleGit(path).revparse(['--verify', 'HEAD'])).toBeTruthy();
    expect((await simpleGit(path).log()).latest?.message).toBe('initial');
  });

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

  it('initializes a nested task repository without discovering or branching the enclosing checkout', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'agora-nested-parent-'));
    roots.push(outer);
    const parent = simpleGit(outer);
    await parent.init();
    await parent.addConfig('user.name', 'Parent');
    await parent.addConfig('user.email', 'parent@localhost');
    writeFileSync(join(outer, 'private-parent.txt'), 'must never enter task worktrees');
    await parent.add('-A');
    await parent.commit('Parent-only source');
    const parentHead = (await parent.revparse(['HEAD'])).trim();
    const main = join(outer, '.data', 'task', 'repository');
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry, main);
    try {
      const worker = await service.createWorktree('task', 'isolated');
      expect(existsSync(join(worker.path, 'private-parent.txt'))).toBe(false);
      expect(realpathSync((await simpleGit(main).revparse(['--show-toplevel'])).trim())).toBe(
        realpathSync(main),
      );
      expect(await service.canonicalHead()).not.toBe(parentHead);
      expect((await parent.branch()).all).not.toContain('isolated');
      expect((await parent.revparse(['HEAD'])).trim()).toBe(parentHead);
      const standalone = join(outer, '.data', 'standalone');
      mkdirSync(standalone, { recursive: true });
      await initializeRegisteredWorktree(registry, standalone);
      expect(realpathSync((await simpleGit(standalone).revparse(['--show-toplevel'])).trim())).toBe(
        realpathSync(standalone),
      );
    } finally {
      await service.dispose();
    }
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

  it('isolates worktree directories for sibling main repositories', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'agora-git-sibling-mains-'));
    roots.push(parent);
    const first = new WorktreeGitService(new WorktreeRegistry(), join(parent, 'project-a'));
    const second = new WorktreeGitService(new WorktreeRegistry(), join(parent, 'project-b'));

    const [firstWorktree, secondWorktree] = await Promise.all([
      first.createWorktree('t1', 'feature-merge'),
      second.createWorktree('t1', 'feature-merge'),
    ]);

    expect(firstWorktree.path).not.toBe(secondWorktree.path);
    expect(existsSync(join(firstWorktree.path, '.git'))).toBe(true);
    expect(existsSync(join(secondWorktree.path, '.git'))).toBe(true);
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
      'worker.lock',
      '@',
      `control-${String.fromCharCode(1)}`,
    ]) {
      expect(() => validateBranchName(bad), `name: ${bad}`).toThrow('invalid branch name');
      await expect(service.createWorktree('t1', bad)).rejects.toThrow('invalid branch name');
    }
    expect(validateBranchName('feature-ok')).toBe('feature-ok');
  });

  it('encodes logical worker ids deterministically without Git-ref collisions', () => {
    const first = encodeGitIsolationKey('project-a', 'task-a', 'worker:dispatch:0');
    const replay = encodeGitIsolationKey('project-a', 'task-a', 'worker:dispatch:0');
    const sibling = encodeGitIsolationKey('project-a', 'task-a', 'worker/dispatch/0');

    expect(first).toBe(replay);
    expect(first).not.toBe(sibling);
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(() => validateBranchName(first)).not.toThrow();
  });

  it('migrates a legacy string path by inspecting its real Git branch, base, and HEAD', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'agora-git-legacy-migration-'));
    roots.push(parent);
    const main = join(parent, 'repository');
    const worktrees = join(parent, 'worktrees');
    const creator = new WorktreeGitService(new WorktreeRegistry(), main, worktrees);
    const created = await creator.createWorktree('task-a', 'legacy-worker');
    const baseCommit = await creator.canonicalHead();
    writeFileSync(join(created.path, 'migrated.txt'), 'legacy\n');
    await simpleGit(created.path).add(['-A']);
    await simpleGit(created.path).commit('legacy work');
    const headCommit = (await simpleGit(created.path).revparse(['HEAD'])).trim();

    // Simulate a process restart where State still contains only the old path.
    const restarted = new WorktreeGitService(new WorktreeRegistry(), main, worktrees);
    await expect(restarted.inspectLegacyWorktree(created.path, 'wrong-worker')).rejects.toThrow(
      'branch mismatch',
    );
    await expect(restarted.inspectLegacyWorktree(created.path, 'legacy-worker')).resolves.toEqual({
      path: realpathSync(created.path),
      branch: 'legacy-worker',
      baseCommit,
      headCommit,
    });
  });

  it('rejects the canonical main worktree even though it shares the same common directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'agora-git-main-recovery-'));
    roots.push(parent);
    const main = join(parent, 'repository');
    const service = new WorktreeGitService(new WorktreeRegistry(), main, join(parent, 'worktrees'));
    await service.canonicalHead();

    await expect(
      service.registerExistingWorktree(main, await service.canonicalBranch()),
    ).rejects.toThrow('canonical main worktree');
  });

  it('rejects an existing repository that is not linked to the configured canonical repo', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'agora-git-foreign-worktree-'));
    roots.push(parent);
    const main = join(parent, 'repository');
    const worktrees = join(parent, 'worktrees');
    const service = new WorktreeGitService(new WorktreeRegistry(), main, worktrees);
    await service.canonicalHead();
    const foreign = join(worktrees, 'foreign');
    mkdirSync(foreign, { recursive: true });
    await initializeRegisteredWorktree(new WorktreeRegistry(), foreign);

    await expect(service.registerExistingWorktree(foreign)).rejects.toThrow('canonical repository');
  });

  it('compensates a worktree created immediately before cancellation so retry can reuse its identity', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    let checks = 0;
    const signal = {
      throwIfAborted() {
        checks += 1;
        if (checks === 2) throw new DOMException('This operation was aborted', 'AbortError');
      },
    } as AbortSignal;

    await expect(
      service.createWorktreeFrom(
        't1',
        'worker-cancel-after-add',
        await service.canonicalHead(),
        signal,
      ),
    ).rejects.toThrow('aborted');
    const retried = track(
      await service.createWorktreeFrom(
        't1',
        'worker-cancel-after-add',
        await service.canonicalHead(),
      ),
    );
    expect(existsSync(retried.path)).toBe(true);
  });

  it('tracks service-owned worktrees by absolute paths when configured with relative roots', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'agora-git-relative-roots-'));
    roots.push(parent);
    const service = new WorktreeGitService(
      new WorktreeRegistry(),
      relative(process.cwd(), join(parent, 'repository')),
      relative(process.cwd(), join(parent, 'worktrees')),
    );
    const created = await service.createWorktree('task-a', 'relative-worker');

    expect(created.path).toBe(resolve(created.path));
    await expect(service.dispose()).resolves.toBeUndefined();
    expect(existsSync(created.path)).toBe(false);
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

  it('merges in a dedicated linked worktree and aborts a real conflict', async () => {
    const registry = new WorktreeRegistry();
    const root = mkdtempSync(join(tmpdir(), 'agora-git-integration-'));
    roots.push(root);
    const main = join(root, 'repository');
    const worktrees = join(root, 'worktrees');
    const service = new WorktreeGitService(registry, main, worktrees);
    const workerA = track(await service.createWorktree('t1', 'worker-a'));
    const baseCommit = await service.headOf(workerA.path);
    const workerB = track(await service.createWorktreeFrom('t1', 'worker-b', baseCommit));
    const integration = track(
      await service.createWorktreeFrom('t1', 'integration-wave-1', baseCommit),
    );

    writeFileSync(join(workerA.path, 'conflict.txt'), 'worker-a\n');
    await simpleGit(workerA.path).add(['-A']);
    await simpleGit(workerA.path).commit('worker a');
    writeFileSync(join(workerB.path, 'conflict.txt'), 'worker-b\n');
    await simpleGit(workerB.path).add(['-A']);
    await simpleGit(workerB.path).commit('worker b');

    const first = await service.mergeInWorktree(integration.path, workerA.branch);
    expect(first.ok).toBe(true);
    expect(
      await service.isAncestor(await service.headOf(workerA.path), first.headCommit as string),
    ).toBe(true);

    const conflict = await service.mergeInWorktree(integration.path, workerB.branch);
    expect(conflict).toMatchObject({ ok: false, conflicts: ['conflict.txt'] });
    const mergeHead = (
      await simpleGit(integration.path).revparse(['--git-path', 'MERGE_HEAD'])
    ).trim();
    expect(existsSync(resolve(integration.path, mergeHead))).toBe(false);
    expect(await simpleGit(integration.path).raw(['status', '--porcelain'])).toBe('');
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

  it('moves its service-owned temp base to staging on dispose (no leak)', async () => {
    const registry = new WorktreeRegistry();
    const service = new WorktreeGitService(registry);
    const { path } = await service.createWorktree('t1', 'feature-dispose');
    expect(existsSync(path)).toBe(true);

    await service.dispose();
    expect(existsSync(path)).toBe(false);
    const stagedBases = readdirSync(GIT_TEARDOWN_STAGING).filter((name) =>
      name.startsWith('agora-git-'),
    );
    expect(stagedBases.length).toBeGreaterThanOrEqual(1);
    const stagedWorktree = stagedBases
      .map((name) => join(GIT_TEARDOWN_STAGING, name, 'worktrees', basename(path)))
      .find((candidate) => existsSync(candidate));
    expect(stagedWorktree).toBeDefined();

    await expect(service.dispose()).resolves.toBeUndefined();
  });

  it('moves created worktrees to staging but preserves a caller-owned main repo on dispose', async () => {
    const registry = new WorktreeRegistry();
    const main = mkdtempSync(join(tmpdir(), 'agora-git-main-'));
    roots.push(main);
    const service = new WorktreeGitService(registry, main);
    const { path } = track(await service.createWorktree('t1', 'feature-dispose2'));

    await service.dispose();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(GIT_TEARDOWN_STAGING, basename(path)))).toBe(true);
    expect(existsSync(main)).toBe(true);
  });
});
