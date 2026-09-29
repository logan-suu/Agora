// Real Git and Seatbelt in approved disposable roots. No dependency doubles.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createLocalGitBaseline } from '../src/local-git-baseline';
import { createLocalGitWorktree } from '../src/local-git-worktree';
import { localRecordHash } from '../src/local-registry-records';
import { inspectSelectedLocalRoot } from '../src/local-root-inspection';

import { binary, fixture, gitPath, hash, manifest, metadataHelper } from './local-git-fixture';

async function linkedInput(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  const helpers = {
    inspector: resolve('packages/runtime/sandbox/build/local-root-inspection-darwin-arm64'),
    initializer: resolve('packages/runtime/sandbox/build/local-root-initialization-darwin-arm64'),
  };
  const inspection = inspectSelectedLocalRoot(f.root, helpers.inspector);
  const [dev, inode] = (inspection.chain.at(-1)?.identity ?? '').split(':');
  if (!dev || !inode) throw Error('missing source identity');
  const options = {
    ...f,
    git: binary,
    metadataHelper,
    projectId: 'project',
    taskId: 'task',
    actionId: 'linked-baseline',
    authorize: async () => true,
    files: [{ path: 'file', content: Buffer.from('baseline'), executable: false }],
  };
  const baseline = await createLocalGitBaseline(options);
  const created = await createLocalGitWorktree({
    ...options,
    actionId: 'linked-create',
    workspaceId: 'workspace',
    baseCommit: baseline.commit,
  });
  const common = { path: created.commonDir, identity: created.commonDirIdentity };
  const journalRoot = join(f.base, 'linked-initializations');
  mkdirSync(journalRoot, { mode: 0o700 });
  const request = {
    root: f.root,
    privateRoot: f.privateRoot,
    git: binary,
    metadataHelper,
    projectId: 'project',
    taskId: 'task',
    authorize: options.authorize,
    actionId: 'linked-initialize',
    creationActionId: created.actionId,
    bindingReceiptId: 'binding:register',
    helpers,
    journalRoot,
    sourceRoot: {
      rootId: 'root',
      projectId: 'project',
      selectionRef: 'selection',
      path: f.root,
      volumeId: inspection.volumeId,
      dev,
      inode,
      chain: inspection.chain.map(({ path, identity }) => ({ path, identity })),
      staging: null,
      inspectionHash: localRecordHash(inspection),
    },
    workspace: {
      schemaVersion: 'workspace-v1' as const,
      projectId: 'project',
      taskId: 'task',
      workspaceId: 'workspace',
      rootId: 'root',
      grantId: 'grant',
      purpose: 'coding' as const,
      mode: 'linked-worktree' as const,
      commonDirId: `common:${localRecordHash(common)}`,
      branch: created.branch,
      baseCommit: created.baseCommit,
    },
  };
  return { request, created, journalRoot };
}

it('initializes an owned worktree staging area and binds its physical evidence to the source grant', async () =>
  fixture(async (f) => {
    const { initializeLocalLinkedRoot } = await import('../src/local-linked-root');
    const { request, created, journalRoot } = await linkedInput(f);
    const beforeIndex = readFileSync(join(f.metadata, 'index'));
    const value = await initializeLocalLinkedRoot(request);
    expect(value.path).toBe(created.path);
    expect(value.rootId).toBe('root');
    expect(value.grantId).toBe('grant');
    expect(value.creation.receiptHash).toBe(localRecordHash(created));
    const staging = lstatSync(join(created.path, '.agora-operations'));
    expect(value.staging.identity).toBe(`${staging.dev}:${staging.ino}`);
    expect(await initializeLocalLinkedRoot(request)).toEqual(value);
    expect(readFileSync(join(f.metadata, 'index'))).toEqual(beforeIndex);
    expect(existsSync(join(f.root, '.agora-operations'))).toBe(false);
    chmodSync(journalRoot, 0o755);
    try {
      await expect(initializeLocalLinkedRoot(request)).rejects.toThrow('untrusted_runtime_path');
    } finally {
      chmodSync(journalRoot, 0o700);
    }
    await expect(
      initializeLocalLinkedRoot({
        ...request,
        workspace: { ...request.workspace, grantId: 'other' },
      }),
    ).rejects.toThrow('operation_conflict');
    await expect(
      initializeLocalLinkedRoot({ ...request, authorize: async () => false }),
    ).rejects.toThrow('authorization_closed');
    const completedName = readdirSync(f.privateRoot).find((name) =>
      name.endsWith('.linked-root-completed.json'),
    );
    const nativeName = readdirSync(journalRoot)[0];
    if (!completedName || !nativeName) throw Error('missing initialization evidence');
    const completedPath = join(f.privateRoot, completedName);
    const nativePath = join(journalRoot, nativeName, 'result.json');
    const savedCompleted = readFileSync(completedPath);
    const savedNative = readFileSync(nativePath);
    const forgedNative = {
      ...JSON.parse(savedNative.toString()),
      stage: 'conflict',
      reason: 'conflict',
    };
    const forgedCompleted = JSON.parse(savedCompleted.toString());
    forgedCompleted.record.initialization.receiptHash = localRecordHash(forgedNative);
    chmodSync(nativePath, 0o600);
    writeFileSync(nativePath, JSON.stringify(forgedNative));
    chmodSync(nativePath, 0o400);
    writeFileSync(completedPath, JSON.stringify(forgedCompleted));
    try {
      await expect(initializeLocalLinkedRoot(request)).rejects.toThrow('local_linked_root_changed');
    } finally {
      chmodSync(nativePath, 0o600);
      writeFileSync(nativePath, savedNative);
      chmodSync(nativePath, 0o400);
      writeFileSync(completedPath, savedCompleted);
    }
    const saved = join(created.path, '.agora-operations-saved');
    const { renameSync } = await import('node:fs');
    renameSync(value.staging.path, saved);
    mkdirSync(value.staging.path, { mode: 0o700 });
    await expect(initializeLocalLinkedRoot(request)).rejects.toThrow('local_linked_root_changed');
  }));

it.each(['unproven', 'exact'] as const)(
  'checks initialized commits against the %s transaction identity',
  async (scenario) =>
    fixture(async (f) => {
      const { initializeLocalLinkedRoot } = await import('../src/local-linked-root');
      const { commitLocalGitWorktree, readLocalGitCommit } = await import(
        '../src/local-git-commit'
      );
      const { request, created } = await linkedInput(f);
      const physical = await initializeLocalLinkedRoot(request);
      writeFileSync(join(physical.path, 'file'), 'candidate');
      writeFileSync(join(physical.staging.path, 'private-journal'), 'control data');
      const commit = {
        root: f.root,
        privateRoot: f.privateRoot,
        git: binary,
        metadataHelper,
        projectId: 'project',
        taskId: 'task',
        actionId: 'initialized-commit',
        authorize: request.authorize,
        workspaceId: created.workspaceId,
        creationActionId: created.actionId,
        expectedHead: created.baseCommit,
        files: [{ path: 'file', content: Buffer.from('candidate'), executable: false }],
      };
      if (scenario === 'unproven') {
        await expect(commitLocalGitWorktree(commit)).rejects.toThrow('local_git_worktree_changed');
        await expect(commitLocalGitWorktree({ ...commit, stagingIdentity: '0:0' })).rejects.toThrow(
          'local_git_worktree_changed',
        );
        expect(
          readdirSync(f.privateRoot).some((name) => name.endsWith('.commit-prepared.json')),
        ).toBe(false);
        return;
      }
      const exact = { ...commit, stagingIdentity: physical.staging.identity };
      const untouched = readdirSync(f.privateRoot).sort();
      await expect(readLocalGitCommit(exact)).rejects.toThrow('local_git_recovery_required');
      expect(readdirSync(f.privateRoot).sort()).toEqual(untouched);
      expect(f.git(['-C', created.path, 'rev-parse', 'HEAD'])).toBe(created.baseCommit);
      const result = await commitLocalGitWorktree(exact);
      expect(await readLocalGitCommit(exact)).toEqual(result);
      expect(f.git(['ls-tree', '-r', '--name-only', result.commit])).toBe('file');
      expect(readFileSync(join(physical.staging.path, 'private-journal'), 'utf8')).toBe(
        'control data',
      );
      expect(await commitLocalGitWorktree(exact)).toEqual(result);
      chmodSync(physical.staging.path, 0o755);
      await expect(commitLocalGitWorktree(exact)).rejects.toThrow('local_git_worktree_changed');
    }),
);

it.each(['fixed-input', 'wrong-commit', 'changed-source', 'forged-tree', 'revoked'] as const)(
  'binds Git versions to real immutable manifest bytes: %s',
  async (scenario) =>
    fixture(async (f) => {
      const { acquireState } = await import('../../../../apps/desktop/src/storage');
      const { LocalControlObjects } = await import('../src/local-control-objects');
      const { LocalRegistryFile } = await import('../src/local-registry-file');
      const { parseLocalRegistry } = await import('../src/local-registry-records');
      const { LocalVersionStore } = await import('../src/local-version-store');
      const { LocalGitVersionStore } = await import('../src/local-git-version-store');
      const { LocalFixedInputs } = await import('../src/local-fixed-inputs');
      const { initializeLocalLinkedRoot } = await import('../src/local-linked-root');
      const { request, created } = await linkedInput(f);
      const record = await initializeLocalLinkedRoot(request);
      const owner = await acquireState(join(f.base, 'state'));
      try {
        await LocalRegistryFile.open(owner, parseLocalRegistry, true);
        const objects = await LocalControlObjects.open(owner);
        const versions = new LocalVersionStore(
          objects,
          resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
        );
        const gitVersions = new LocalGitVersionStore(objects, versions);
        const scope = {
          projectId: 'project',
          taskId: 'task',
          rootId: 'root',
          policyHash: hash('policy'),
        };
        const current = {
          ...request,
          record,
          expectedHead: scenario === 'wrong-commit' ? '0'.repeat(40) : created.baseCommit,
        };
        if (scenario === 'changed-source') writeFileSync(join(record.path, 'file'), 'uncommitted');
        const captured = gitVersions.capture(scope, current);
        if (scenario === 'wrong-commit' || scenario === 'changed-source') {
          await expect(captured).rejects.toThrow(
            scenario === 'wrong-commit' ? 'local_git_worktree_changed' : 'local_git_tree_mismatch',
          );
          return;
        }
        const version = await captured;
        expect(version.kind).toBe('git');
        if (version.kind !== 'git') throw Error('missing Git version');
        expect(version.commit).toBe(created.baseCommit);
        if (scenario === 'revoked') {
          await expect(
            gitVersions.verify(version, scope, { ...current, authorize: async () => false }),
          ).rejects.toThrow('authorization_closed');
          return;
        }
        if (scenario === 'forged-tree') {
          const envelope = await versions.readGitManifest(version, scope);
          const manifestHash = await objects.put({ ...envelope, tree: 'f'.repeat(40) });
          await expect(
            gitVersions.verify(
              { ...version, manifestId: `manifest:${manifestHash}`, manifestHash },
              scope,
              current,
            ),
          ).rejects.toThrow('local_git_tree_mismatch');
          return;
        }

        const manifest = await versions.read(version, scope);
        expect(manifest.files.map((file) => file.path)).toEqual(['file']);
        expect(manifest.excludedPaths).toEqual(['.agora-operations', '.git']);
        const fixed = await (await LocalFixedInputs.open(owner, objects, versions)).materialize(
          scope,
          version,
          'git-fixed-input',
          async () => true,
        );
        expect(readFileSync(join(fixed.path, 'file'), 'utf8')).toBe('baseline');
        await expect(gitVersions.verify(version, scope, current)).resolves.toBeUndefined();
        await expect(versions.read({ ...version, commit: 'f'.repeat(40) }, scope)).rejects.toThrow(
          'invalid_workspace_version',
        );
        await expect(
          versions.read(
            { kind: 'files', manifestId: version.manifestId, manifestHash: version.manifestHash },
            scope,
          ),
        ).rejects.toThrow('invalid_workspace_version');
        writeFileSync(join(record.path, 'file'), 'later edit');
        expect(readFileSync(join(fixed.path, 'file'), 'utf8')).toBe('baseline');
        await expect(gitVersions.verify(version, scope, current)).rejects.toThrow(
          'file_version_conflict',
        );
      } finally {
        await owner.release();
      }
    }),
  // This new compound case creates Git state, captures native bytes, and revalidates it.
  10_000,
);

it.each(['baseline', 'committed', 'incomplete'] as const)(
  'verifies persistent linked authority without initialization writes at %s',
  async (scenario) =>
    fixture(async (f) => {
      const { initializeLocalLinkedRoot, verifyLocalLinkedRoot } = await import(
        '../src/local-linked-root'
      );
      const { commitLocalGitWorktree } = await import('../src/local-git-commit');
      const { request, created } = await linkedInput(f);
      const record = await initializeLocalLinkedRoot(request);
      const userIndex = readFileSync(join(f.metadata, 'index'));
      let expectedHead = created.baseCommit;
      if (scenario === 'committed') {
        writeFileSync(join(record.path, 'file'), 'changed');
        const receipt = await commitLocalGitWorktree({
          ...request,
          actionId: 'verification-commit',
          workspaceId: created.workspaceId,
          expectedHead,
          stagingIdentity: record.staging.identity,
          files: [{ path: 'file', content: Buffer.from('changed'), executable: false }],
        });
        expectedHead = receipt.commit;
        await expect(
          verifyLocalLinkedRoot({ ...request, record, expectedHead: created.baseCommit }),
        ).rejects.toThrow('local_git_worktree_changed');
      }
      if (scenario === 'incomplete') {
        const completed = readdirSync(f.privateRoot).find((name) =>
          name.endsWith('.linked-root-completed.json'),
        );
        if (!completed) throw Error('missing completion');
        unlinkSync(join(f.privateRoot, completed));
        await expect(verifyLocalLinkedRoot({ ...request, record, expectedHead })).rejects.toThrow(
          'recovery_required',
        );
        expect(existsSync(join(f.privateRoot, completed))).toBe(false);
        return;
      }
      const names = readdirSync(f.privateRoot).sort();
      expect(await verifyLocalLinkedRoot({ ...request, record, expectedHead })).toEqual(record);
      expect(readdirSync(f.privateRoot).sort()).toEqual(names);
      expect(readFileSync(join(f.metadata, 'index'))).toEqual(userIndex);
      if (scenario === 'baseline') {
        await expect(
          verifyLocalLinkedRoot({
            ...request,
            record: { ...record, bindingReceiptId: 'binding:borrowed' },
            expectedHead,
          }),
        ).rejects.toThrow('local_linked_root_changed');
        await expect(
          verifyLocalLinkedRoot({ ...request, record, expectedHead, authorize: async () => false }),
        ).rejects.toThrow('authorization_closed');
      }
    }),
);

it.each(['missing', 'changed-policy', 'writable'] as const)(
  'rejects %s native preparation evidence during read-only linked verification',
  async (fault) =>
    fixture(async (f) => {
      const { initializeLocalLinkedRoot, verifyLocalLinkedRoot } = await import(
        '../src/local-linked-root'
      );
      const { request, created, journalRoot } = await linkedInput(f);
      const record = await initializeLocalLinkedRoot(request);
      const action = readdirSync(journalRoot)[0];
      if (!action) throw Error('missing native journal');
      const path = join(journalRoot, action, 'prepared.json');
      if (fault === 'missing') unlinkSync(path);
      else {
        chmodSync(path, 0o600);
        if (fault === 'changed-policy') {
          const prepared = JSON.parse(readFileSync(path, 'utf8'));
          writeFileSync(path, JSON.stringify({ ...prepared, policyHash: '0'.repeat(64) }));
          chmodSync(path, 0o400);
        }
      }
      await expect(
        verifyLocalLinkedRoot({ ...request, record, expectedHead: created.baseCommit }),
      ).rejects.toThrow('local_linked_root_changed');
    }),
);

for (const fault of ['revoked-after-effect', 'preexisting-staging'] as const)
  it(`keeps linked initialization blocked after ${fault}`, async () =>
    fixture(async (f) => {
      const { initializeLocalLinkedRoot } = await import('../src/local-linked-root');
      const { request, created } = await linkedInput(f);
      const staging = join(created.path, '.agora-operations');
      if (fault === 'preexisting-staging') mkdirSync(staging, { mode: 0o700 });
      const authorize =
        fault === 'revoked-after-effect' ? async () => !existsSync(staging) : request.authorize;
      await expect(initializeLocalLinkedRoot({ ...request, authorize })).rejects.toThrow(
        'recovery_required',
      );
      const actual = lstatSync(staging);
      expect(
        readdirSync(f.privateRoot).filter((name) => name.endsWith('.linked-root-completed.json')),
      ).toHaveLength(0);
      expect(
        readdirSync(f.privateRoot).filter((name) => name.endsWith('.linked-root-prepared.json')),
      ).toHaveLength(1);
      await expect(initializeLocalLinkedRoot(request)).rejects.toThrow('recovery_required');
      expect(lstatSync(staging).ino).toBe(actual.ino);
      expect(existsSync(join(f.root, '.agora-operations'))).toBe(false);
    }));

it('commits exact owned worktree bytes and replays without changing the user index or HEAD', async () =>
  fixture(async (f) => {
    const { commitLocalGitWorktree } = await import('../src/local-git-commit');
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'commit-baseline',
      authorize: async () => true,
      files: [{ path: 'file', content: Buffer.from('baseline'), executable: false }],
    };
    const source = await createLocalGitBaseline(options);
    const created = await createLocalGitWorktree({
      ...options,
      actionId: 'commit-workspace',
      workspaceId: 'workspace',
      baseCommit: source.commit,
    });
    const index = readFileSync(join(f.metadata, 'index'));
    const head = f.git(['rev-parse', 'HEAD']);
    const hookMarker = join(f.base, 'commit-hook-ran');
    for (const name of ['pre-commit', 'post-commit', 'reference-transaction']) {
      const hook = join(f.metadata, 'hooks', name);
      writeFileSync(hook, `#!/bin/sh\nprintf bad > '${hookMarker}'\n`);
      chmodSync(hook, 0o755);
    }
    writeFileSync(join(created.path, 'file'), 'candidate');
    const request = {
      ...options,
      actionId: 'commit',
      creationActionId: 'commit-workspace',
      workspaceId: 'workspace',
      expectedHead: source.commit,
      files: [{ path: 'file', content: Buffer.from('candidate'), executable: false }],
    };
    const result = await commitLocalGitWorktree(request);
    expect(f.git(['rev-parse', `${result.commit}^`])).toBe(source.commit);
    expect(f.git(['-C', created.path, 'rev-parse', 'HEAD'])).toBe(result.commit);
    expect(f.git(['-C', created.path, 'status', '--porcelain'])).toBe('');
    expect(f.git(['show', `${result.commit}:file`])).toBe('candidate');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
    expect(existsSync(hookMarker)).toBe(false);
    expect(await commitLocalGitWorktree(request)).toEqual(result);
    await expect(
      commitLocalGitWorktree({ ...request, expectedHead: result.commit }),
    ).rejects.toThrow('operation_conflict');
  }));

it('rejects a substituted commit whose index matches but whose tree was never validated', async () =>
  fixture(async (f) => {
    const { commitLocalGitWorktree } = await import('../src/local-git-commit');
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'substituted-baseline',
      authorize: async () => true,
      files: [{ path: 'file', content: Buffer.from('baseline'), executable: false }],
    };
    const source = await createLocalGitBaseline(options);
    const created = await createLocalGitWorktree({
      ...options,
      actionId: 'substituted-workspace',
      workspaceId: 'workspace',
      baseCommit: source.commit,
    });
    writeFileSync(join(created.path, 'file'), 'candidate');
    const request = {
      ...options,
      actionId: 'substituted-commit',
      creationActionId: 'substituted-workspace',
      workspaceId: 'workspace',
      expectedHead: source.commit,
      files: [{ path: 'file', content: Buffer.from('candidate'), executable: false }],
    };
    const result = await commitLocalGitWorktree(request);
    writeFileSync(join(created.path, 'file'), 'unvalidated');
    f.git(['-C', created.path, 'add', 'file']);
    const tree = f.git(['-C', created.path, 'write-tree']);
    const commit = f.git(['commit-tree', tree, '-p', source.commit, '-m', 'Unvalidated fixture']);
    f.git(['update-ref', `refs/heads/${created.branch}`, commit, result.commit]);
    writeFileSync(join(created.path, 'file'), 'candidate');
    const name = readdirSync(f.privateRoot).find((name) => name.endsWith('.commit-completed.json'));
    if (!name) throw Error('missing_fixture_receipt');
    const receipt = { ...result, tree, commit };
    writeFileSync(
      join(f.privateRoot, name),
      JSON.stringify({ receipt, hash: localRecordHash(receipt) }),
    );
    await expect(commitLocalGitWorktree(request)).rejects.toThrow('local_git_tree_mismatch');
  }));

it('preserves an advanced branch after revocation and never completes or repeats the partial commit', async () =>
  fixture(async (f) => {
    const { commitLocalGitWorktree } = await import('../src/local-git-commit');
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'partial-baseline',
      authorize: async () => true,
      files: [{ path: 'file', content: Buffer.from('baseline'), executable: false }],
    };
    const source = await createLocalGitBaseline(options);
    const created = await createLocalGitWorktree({
      ...options,
      actionId: 'partial-workspace',
      workspaceId: 'workspace',
      baseCommit: source.commit,
    });
    writeFileSync(join(created.path, 'file'), 'candidate');
    const request = {
      ...options,
      actionId: 'partial-commit',
      creationActionId: 'partial-workspace',
      workspaceId: 'workspace',
      expectedHead: source.commit,
      files: [{ path: 'file', content: Buffer.from('candidate'), executable: false }],
      authorize: async () => f.git(['rev-parse', `refs/heads/${created.branch}`]) === source.commit,
    };
    await expect(commitLocalGitWorktree(request)).rejects.toThrow('authorization_closed');
    const actualHead = f.git(['rev-parse', `refs/heads/${created.branch}`]);
    expect(actualHead).not.toBe(source.commit);
    expect(
      readdirSync(f.privateRoot).filter((name) => name.endsWith('.commit-prepared.json')),
    ).toHaveLength(1);
    expect(
      readdirSync(f.privateRoot).filter((name) => name.endsWith('.commit-completed.json')),
    ).toHaveLength(0);
    await expect(
      commitLocalGitWorktree({ ...request, authorize: async () => true }),
    ).rejects.toThrow('local_git_recovery_required');
    expect(f.git(['rev-parse', `refs/heads/${created.branch}`])).toBe(actualHead);
  }));

it('refuses a commit whose fixed bytes differ from its physical workspace before preparing writes', async () =>
  fixture(async (f) => {
    const { commitLocalGitWorktree } = await import('../src/local-git-commit');
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'mismatch-baseline',
      authorize: async () => true,
      files: [{ path: 'file', content: Buffer.from('baseline'), executable: false }],
    };
    const source = await createLocalGitBaseline(options);
    const created = await createLocalGitWorktree({
      ...options,
      actionId: 'mismatch-workspace',
      workspaceId: 'workspace',
      baseCommit: source.commit,
    });
    const before = readdirSync(f.privateRoot).sort();
    await expect(
      commitLocalGitWorktree({
        ...options,
        actionId: 'mismatch-commit',
        creationActionId: 'mismatch-workspace',
        workspaceId: 'workspace',
        expectedHead: source.commit,
        files: [{ path: 'file', content: Buffer.from('unwritten'), executable: false }],
      }),
    ).rejects.toThrow('local_git_worktree_changed');
    expect(readdirSync(f.privateRoot).sort()).toEqual(before);
    expect(f.git(['-C', created.path, 'rev-parse', 'HEAD'])).toBe(source.commit);
  }));
if (
  manifest.versions.git !== '2.53.0' ||
  manifest.files.find((file: { path: string }) => file.path === 'git/bin/git')?.sha256 !==
    binary.sha256
)
  throw Error('managed_git_invalid');

it('preserves ordinary lock-suffixed and binary files in a linked tree', async () =>
  fixture(async (f) => {
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'lock-files-baseline',
      authorize: async () => true,
      files: ['file', 'file.lock'].map((path) => ({
        path,
        content: Buffer.from([0, 1, 255]),
        executable: false,
      })),
    };
    const source = await createLocalGitBaseline(options);
    const result = await createLocalGitWorktree({
      ...options,
      actionId: 'lock-files-tree',
      workspaceId: 'workspace',
      baseCommit: source.commit,
    });
    expect(readFileSync(join(result.path, 'file.lock'))).toEqual(Buffer.from([0, 1, 255]));
  }));

it('creates an empty baseline and empty linked tree without importing the user index', async () =>
  fixture(async (f) => {
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'empty-baseline',
      authorize: async () => true,
      files: [],
    };
    const index = readFileSync(join(f.metadata, 'index'));
    const source = await createLocalGitBaseline(options);
    expect(f.git(['ls-tree', '-r', source.commit])).toBe('');
    const result = await createLocalGitWorktree({
      ...options,
      actionId: 'empty-tree',
      workspaceId: 'workspace',
      baseCommit: source.commit,
    });
    expect(readdirSync(result.path)).toEqual(['.git']);
    expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
  }));

it(
  'materializes and commits exact empty directory paths alongside the Git tree',
  async () =>
    fixture(async (f) => {
      const options = {
        ...f,
        git: binary,
        metadataHelper,
        projectId: 'project',
        taskId: 'task',
        actionId: 'directories-baseline',
        authorize: async () => true,
        files: [{ path: 'src/file', content: Buffer.from('fixed'), executable: false }],
        directories: ['empty', 'empty/nested', 'src'],
      };
      const source = await createLocalGitBaseline(options);
      const request = {
        ...options,
        actionId: 'directories-tree',
        workspaceId: 'workspace',
        baseCommit: source.commit,
      };
      const created = await createLocalGitWorktree(request);
      expect(readdirSync(join(created.path, 'empty'))).toEqual(['nested']);
      expect(readdirSync(join(created.path, 'empty/nested'))).toEqual([]);
      expect(await createLocalGitWorktree(request)).toEqual(created);
      await expect(
        createLocalGitWorktree({ ...request, directories: ['other', 'other/nested', 'src'] }),
      ).rejects.toThrow('operation_conflict');
      const { commitLocalGitWorktree } = await import('../src/local-git-commit');
      const commitInput = {
        ...options,
        actionId: 'directories-commit',
        workspaceId: 'workspace',
        creationActionId: created.actionId,
        expectedHead: created.baseCommit,
      };
      const committed = await commitLocalGitWorktree(commitInput);
      expect(await commitLocalGitWorktree(commitInput)).toEqual(committed);
      renameSync(join(created.path, 'empty'), join(created.path, 'other'));
      await expect(commitLocalGitWorktree(commitInput)).rejects.toThrow(
        'local_git_worktree_changed',
      );
    }),
  15_000,
);

it('rejects invalid directory manifests before creating any private Git state', async () =>
  fixture(async (f) => {
    for (const directories of [
      [''],
      ['../outside'],
      ['.git'],
      ['.ENV'],
      ['parent/child'],
      ['same', 'same'],
      ['file'],
      Array.from({ length: 4097 }, (_, i) => `directory-${i}`),
    ]) {
      await expect(
        createLocalGitWorktree({
          ...f,
          git: binary,
          metadataHelper,
          projectId: 'project',
          taskId: 'task',
          actionId: 'invalid-directories',
          workspaceId: 'workspace',
          baseCommit: f.git(['rev-parse', 'HEAD']),
          authorize: async () => true,
          files: [{ path: 'file', content: Buffer.from('fixed'), executable: false }],
          directories,
        }),
      ).rejects.toThrow('invalid_local_git_input');
      expect(readdirSync(f.privateRoot)).toEqual([]);
    }
  }));

it.each(['HEAD', 'packed-refs'])(
  'rejects embedded NUL in textual %s metadata before writes',
  async (name) =>
    fixture(async (f) => {
      const path = join(f.metadata, name);
      const bytes =
        name === 'HEAD' ? readFileSync(path) : Buffer.from('# pack-refs with: peeled\n');
      writeFileSync(path, Buffer.concat([bytes, Buffer.from('\0hidden suffix')]));
      await expect(
        createLocalGitBaseline({
          ...f,
          git: binary,
          metadataHelper,
          projectId: 'project',
          taskId: 'task',
          actionId: 'nul-metadata',
          authorize: async () => true,
          files: [{ path: 'file', content: Buffer.from('fixed'), executable: false }],
        }),
      ).rejects.toThrow('local_git_metadata_invalid');
      expect(readdirSync(f.privateRoot)).toEqual([]);
    }),
);

it('rejects reusing an action across baseline and worktree operations in both orders', async () =>
  fixture(async (f) => {
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'baseline',
      authorize: async () => true,
      files: [{ path: 'file', content: Buffer.from('fixed'), executable: false }],
    };
    const source = await createLocalGitBaseline(options);
    await expect(
      createLocalGitWorktree({
        ...options,
        workspaceId: 'workspace',
        baseCommit: source.commit,
      }),
    ).rejects.toThrow('operation_conflict');
    await createLocalGitWorktree({
      ...options,
      actionId: 'workspace',
      workspaceId: 'workspace',
      baseCommit: source.commit,
    });
    await expect(createLocalGitBaseline({ ...options, actionId: 'workspace' })).rejects.toThrow(
      'operation_conflict',
    );
  }));

it('uses absolute owned pointers when the user prefers relative worktrees', async () =>
  fixture(async (f) => {
    f.git(['config', 'worktree.useRelativePaths', 'true']);
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'relative-baseline',
      authorize: async () => true,
      files: [{ path: 'file', content: Buffer.from('fixed'), executable: false }],
    };
    const source = await createLocalGitBaseline(options);
    const result = await createLocalGitWorktree({
      ...options,
      actionId: 'relative-tree',
      workspaceId: 'workspace',
      baseCommit: source.commit,
    });
    expect(readFileSync(join(result.path, '.git'), 'utf8')).toBe(`gitdir: ${result.metadata}\n`);
    expect(f.git(['config', 'worktree.useRelativePaths'])).toBe('true');
  }));

it('rejects duplicate membership through a canonical path alias', async () =>
  fixture(async (f) => {
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'alias-baseline',
      authorize: async () => true,
      files: [{ path: 'file', content: Buffer.from('fixed'), executable: false }],
    };
    const source = await createLocalGitBaseline(options);
    const request = {
      ...options,
      actionId: 'alias-tree',
      workspaceId: 'workspace',
      baseCommit: source.commit,
    };
    const result = await createLocalGitWorktree(request);
    const alias = join(f.privateRoot, 'alias');
    symlinkSync(result.path, alias);
    const duplicate = join(f.metadata, 'worktrees', 'duplicate');
    mkdirSync(duplicate);
    writeFileSync(join(duplicate, 'gitdir'), `${alias}/.git\n`);
    writeFileSync(join(duplicate, 'HEAD'), `ref: refs/heads/${result.branch}\n`);
    writeFileSync(join(duplicate, 'commondir'), '../..\n');
    expect(f.git(['worktree', 'list', '--porcelain'])).toContain(`worktree ${alias}`);
    await expect(createLocalGitWorktree(request)).rejects.toThrow('local_git_worktree_changed');
  }));

it.each(['extra', 'indexHash'])(
  'rejects invalid completed receipt field %s even with a matching hash',
  async (field) =>
    fixture(async (f) => {
      const options = {
        ...f,
        git: binary,
        metadataHelper,
        projectId: 'project',
        taskId: 'task',
        actionId: 'receipt-baseline',
        authorize: async () => true,
        files: [{ path: 'file', content: Buffer.from('fixed'), executable: false }],
      };
      const source = await createLocalGitBaseline(options);
      const request = {
        ...options,
        actionId: 'receipt-tree',
        workspaceId: 'workspace',
        baseCommit: source.commit,
      };
      await createLocalGitWorktree(request);
      const name = readdirSync(f.privateRoot).find((name) =>
        name.endsWith('.worktree-completed.json'),
      );
      if (!name) throw Error('missing_fixture_receipt');
      const path = join(f.privateRoot, name);
      const envelope = JSON.parse(readFileSync(path, 'utf8'));
      envelope.receipt[field] = 'invalid';
      envelope.hash = localRecordHash(envelope.receipt);
      chmodSync(path, 0o600);
      writeFileSync(path, JSON.stringify(envelope));
      await expect(createLocalGitWorktree(request)).rejects.toThrow('local_git_worktree_changed');
    }),
);

it('creates two actual linked worktrees from fixed bytes without touching user HEAD or index', async () =>
  fixture(async (f) => {
    const files = [
      { path: 'nested/file.txt', content: Buffer.from('literal\r\n'), executable: true },
    ];
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'source-baseline',
      files,
      authorize: async () => true,
    };
    const source = await createLocalGitBaseline(options);
    const index = readFileSync(join(f.metadata, 'index'));
    const one = await createLocalGitWorktree({
      ...options,
      actionId: 'one',
      workspaceId: 'one',
      baseCommit: source.commit,
    });
    const two = await createLocalGitWorktree({
      ...options,
      actionId: 'two',
      workspaceId: 'two',
      baseCommit: source.commit,
    });
    expect(one.path).not.toBe(two.path);
    expect(one.branch).not.toBe(two.branch);
    for (const result of [one, two]) {
      expect(result.stage).toBe('applied');
      expect(result.baseCommit).toBe(source.commit);
      expect(readFileSync(join(result.path, 'nested/file.txt'))).toEqual(files[0]?.content);
      expect(lstatSync(join(result.path, 'nested/file.txt')).mode & 0o111).toBeTruthy();
      expect(f.git(['worktree', 'list', '--porcelain'])).toContain(`worktree ${result.path}`);
      expect(f.git(['-C', result.path, 'status', '--porcelain'])).toBe('');
    }
    expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(source.sourceHead.commit);
    expect(
      await createLocalGitWorktree({
        ...options,
        actionId: 'one',
        workspaceId: 'one',
        baseCommit: source.commit,
      }),
    ).toEqual(one);
    writeFileSync(join(two.path, 'nested/file.txt'), 'independent staged change');
    f.git(['-C', two.path, 'add', 'nested/file.txt']);
    await expect(
      createLocalGitWorktree({
        ...options,
        actionId: 'two',
        workspaceId: 'two',
        baseCommit: source.commit,
      }),
    ).rejects.toThrow('local_git_worktree_changed');
    const marker = join(one.path, '.git');
    unlinkSync(marker);
    symlinkSync(join(two.path, '.git'), marker);
    await expect(
      createLocalGitWorktree({
        ...options,
        actionId: 'one',
        workspaceId: 'one',
        baseCommit: source.commit,
      }),
    ).rejects.toThrow('local_git_worktree_changed');
  }));

it('rejects supplied bytes that do not match the exact Git tree before creating a worktree', async () =>
  fixture(async (f) => {
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'source-baseline',
      files: [{ path: 'file.txt', content: Buffer.from('fixed'), executable: false }],
      authorize: async () => true,
    };
    const source = await createLocalGitBaseline(options);
    const before = readdirSync(f.privateRoot).sort();
    await expect(
      createLocalGitWorktree({
        ...options,
        actionId: 'bad-content',
        workspaceId: 'bad',
        baseCommit: source.commit,
        files: [{ path: 'file.txt', content: Buffer.from('different'), executable: false }],
      }),
    ).rejects.toThrow('local_git_tree_mismatch');
    expect(readdirSync(f.privateRoot).sort()).toEqual(before);
    expect(f.git(['worktree', 'list', '--porcelain'])).not.toContain('agora-workspace-');
  }));

it('materializes literal worktree bytes without invoking checkout hooks or required filters', async () =>
  fixture(async (f) => {
    const marker = join(f.base, 'callback-ran'),
      script = join(f.root, 'callback');
    writeFileSync(script, `#!/bin/sh\nprintf bad > '${marker}'\n`);
    chmodSync(script, 0o755);
    for (const name of ['post-checkout', 'reference-transaction']) {
      writeFileSync(join(f.metadata, 'hooks', name), readFileSync(script));
      chmodSync(join(f.metadata, 'hooks', name), 0o755);
    }
    f.git(['config', 'core.hooksPath', join(f.metadata, 'hooks')]);
    f.git(['config', 'filter.attack.clean', script]);
    f.git(['config', 'filter.attack.smudge', script]);
    f.git(['config', 'filter.attack.required', 'true']);
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'hostile-base',
      files: [
        { path: '.gitattributes', content: Buffer.from('* filter=attack\n'), executable: false },
        { path: 'file.txt', content: Buffer.from('literal\r\n'), executable: false },
      ],
      authorize: async () => true,
    };
    const base = await createLocalGitBaseline(options);
    const tree = await createLocalGitWorktree({
      ...options,
      actionId: 'hostile-worktree',
      workspaceId: 'hostile',
      baseCommit: base.commit,
    });
    expect(readFileSync(join(tree.path, 'file.txt'))).toEqual(Buffer.from('literal\r\n'));
    expect(existsSync(marker)).toBe(false);
  }));

it('preserves an incompletely created worktree after revocation and refuses an automatic retry', async () =>
  fixture(async (f) => {
    const options = {
      ...f,
      git: binary,
      metadataHelper,
      projectId: 'project',
      taskId: 'task',
      actionId: 'revoked-base',
      files: [{ path: 'file.txt', content: Buffer.from('fixed'), executable: false }],
      authorize: async () => true,
    };
    const base = await createLocalGitBaseline(options);
    const input = {
      ...options,
      actionId: 'revoked-worktree',
      workspaceId: 'revoked',
      baseCommit: base.commit,
      authorize: async () =>
        !readdirSync(f.privateRoot).some((name) => name.startsWith('worktree-')),
    };
    await expect(createLocalGitWorktree(input)).rejects.toThrow('authorization_closed');
    expect(readdirSync(f.privateRoot).filter((name) => name.startsWith('worktree-'))).toHaveLength(
      1,
    );
    expect(
      readdirSync(f.privateRoot).filter((name) => name.endsWith('.worktree-completed.json')),
    ).toHaveLength(0);
    const before = f.git(['worktree', 'list', '--porcelain']);
    await expect(createLocalGitWorktree({ ...input, authorize: async () => true })).rejects.toThrow(
      'local_git_recovery_required',
    );
    expect(f.git(['worktree', 'list', '--porcelain'])).toBe(before);
  }));

it.each(['symlink', 'hardlink'] as const)(
  'rejects a %s introduced into a created worktree',
  async (kind) =>
    fixture(async (f) => {
      const options = {
        ...f,
        git: binary,
        metadataHelper,
        projectId: 'project',
        taskId: 'task',
        actionId: 'links-base',
        files: [{ path: 'file.txt', content: Buffer.from('fixed'), executable: false }],
        authorize: async () => true,
      };
      const base = await createLocalGitBaseline(options);
      const input = {
        ...options,
        actionId: 'links-worktree',
        workspaceId: 'links',
        baseCommit: base.commit,
      };
      const worktree = await createLocalGitWorktree(input);
      const external = join(f.base, 'independent-sentinel');
      writeFileSync(external, 'fixed fake private sentinel');
      unlinkSync(join(worktree.path, 'file.txt'));
      if (kind === 'symlink') symlinkSync(external, join(worktree.path, 'file.txt'));
      else linkSync(external, join(worktree.path, 'file.txt'));
      await expect(createLocalGitWorktree(input)).rejects.toThrow('local_git_worktree_changed');
      expect(readFileSync(external, 'utf8')).toBe('fixed fake private sentinel');
    }),
);

it('constructs an exact private baseline without changing user HEAD, index, or working files', async () =>
  fixture(async (f) => {
    const head = f.git(['rev-parse', 'HEAD']),
      index = readFileSync(join(f.metadata, 'index'));
    const input = {
      actionId: 'baseline',
      projectId: 'project',
      taskId: 'task',
      root: f.root,
      privateRoot: f.privateRoot,
      git: binary,
      metadataHelper,
      files: [
        { path: 'file.txt', content: Buffer.from('working\n'), executable: false },
        { path: 'new.txt', content: Buffer.from('untracked\n'), executable: true },
      ],
      authorize: async () => true,
    };
    const result = await createLocalGitBaseline(input);
    expect(result.stage).toBe('applied');
    expect(result.sourceHead.commit).toBe(head);
    expect(result.sourceHead.indexHash).toBe(hash(index));
    expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
    expect(readFileSync(join(f.root, 'file.txt'), 'utf8')).toBe('working\n');
    expect(f.git(['show', `${result.commit}:file.txt`])).toBe('working');
    expect(f.git(['show', `${result.commit}:new.txt`])).toBe('untracked');
    expect(f.git(['ls-tree', result.commit, 'new.txt'])).toMatch(/^100755 blob /);
    expect(await createLocalGitBaseline(input)).toEqual(result);
    await expect(
      createLocalGitBaseline({
        ...input,
        files: [
          {
            ...input.files[0],
            path: 'different',
            content: Buffer.from('different'),
            executable: false,
          },
        ],
      }),
    ).rejects.toThrow('operation_conflict');
  }));

it('does not execute project hooks, filters, fsmonitor, or inherited Git configuration', async () =>
  fixture(async (f) => {
    const sentinel = join(f.base, 'must-not-run');
    const script = join(f.root, 'callback');
    writeFileSync(script, `#!/bin/sh\nprintf bad > '${sentinel}'\n`);
    chmodSync(script, 0o755);
    for (const [key, value] of [
      ['filter.attack.clean', script],
      ['filter.attack.smudge', script],
      ['core.fsmonitor', script],
      ['credential.helper', script],
      ['core.hooksPath', join(f.metadata, 'hooks')],
    ] as const)
      f.git(['config', key, value]);
    writeFileSync(join(f.metadata, 'hooks', 'reference-transaction'), readFileSync(script));
    chmodSync(join(f.metadata, 'hooks', 'reference-transaction'), 0o755);
    writeFileSync(join(f.root, '.gitattributes'), '* filter=attack\n');
    const result = await createLocalGitBaseline({
      actionId: 'hostile',
      projectId: 'project',
      taskId: 'task',
      root: f.root,
      privateRoot: f.privateRoot,
      git: binary,
      metadataHelper,
      files: [{ path: 'file.txt', content: Buffer.from('literal\r\n'), executable: false }],
      authorize: async () => true,
    });
    expect(result.stage).toBe('applied');
    expect(existsSync(sentinel)).toBe(false);
    expect(
      execFileSync(gitPath, ['-C', f.root, 'cat-file', 'blob', `${result.commit}:file.txt`]),
    ).toEqual(Buffer.from('literal\r\n'));
  }));

it('refuses external index locks before publishing a baseline and never removes them', async () =>
  fixture(async (f) => {
    writeFileSync(join(f.metadata, 'index.lock'), 'external lock');
    await expect(
      createLocalGitBaseline({
        actionId: 'locked',
        projectId: 'project',
        taskId: 'task',
        root: f.root,
        privateRoot: f.privateRoot,
        git: binary,
        metadataHelper,
        files: [{ path: 'file.txt', content: Buffer.from('fixed'), executable: false }],
        authorize: async () => true,
      }),
    ).rejects.toThrow('local_git_external_lock');
    expect(readFileSync(join(f.metadata, 'index.lock'), 'utf8')).toBe('external lock');
    expect(f.git(['for-each-ref', '--format=%(refname)', 'refs/heads/agora-'])).toBe('');
  }));

it('retains a prepared operation when authorization closes and refuses to repeat its writes', async () =>
  fixture(async (f) => {
    let calls = 0;
    const input = {
      actionId: 'revoked',
      projectId: 'project',
      taskId: 'task',
      root: f.root,
      privateRoot: f.privateRoot,
      git: binary,
      metadataHelper,
      files: [{ path: 'file.txt', content: Buffer.from('fixed'), executable: false }],
      authorize: async () => ++calls < 3,
    };
    await expect(createLocalGitBaseline(input)).rejects.toThrow('authorization_closed');
    expect(readdirSync(f.privateRoot).filter((p) => p.endsWith('.prepared.json'))).toHaveLength(1);
    expect(readdirSync(f.privateRoot).filter((p) => p.endsWith('.completed.json'))).toHaveLength(0);
    await expect(createLocalGitBaseline({ ...input, authorize: async () => true })).rejects.toThrow(
      'local_git_recovery_required',
    );
  }));

it('invalidates the operation when an independent writer changes the user index', async () =>
  fixture(async (f) => {
    let calls = 0;
    const index = readFileSync(join(f.metadata, 'index'));
    await expect(
      createLocalGitBaseline({
        actionId: 'drift',
        projectId: 'project',
        taskId: 'task',
        root: f.root,
        privateRoot: f.privateRoot,
        git: binary,
        metadataHelper,
        files: [{ path: 'file.txt', content: Buffer.from('fixed'), executable: false }],
        authorize: async () => {
          if (++calls === 3)
            writeFileSync(
              join(f.metadata, 'index'),
              Buffer.concat([index, Buffer.from('external edit')]),
            );
          return true;
        },
      }),
    ).rejects.toThrow('local_git_user_state_changed');
    expect(readFileSync(join(f.metadata, 'index'))).toEqual(
      Buffer.concat([index, Buffer.from('external edit')]),
    );
    expect(readdirSync(f.privateRoot).some((p) => p.endsWith('.completed.json'))).toBe(false);
  }));

it.each(['symlink', 'hardlink'])(
  'rejects %s metadata without reading an independent sentinel',
  async (kind) =>
    fixture(async (f) => {
      const sentinel = join(f.base, 'independent-secret');
      writeFileSync(sentinel, 'test-only independent credential sentinel');
      unlinkSync(join(f.metadata, 'index'));
      if (kind === 'symlink') symlinkSync(sentinel, join(f.metadata, 'index'));
      else linkSync(sentinel, join(f.metadata, 'index'));
      await expect(
        createLocalGitBaseline({
          actionId: 'linked-index',
          projectId: 'project',
          taskId: 'task',
          root: f.root,
          privateRoot: f.privateRoot,
          git: binary,
          metadataHelper,
          files: [{ path: 'file.txt', content: Buffer.from('fixed'), executable: false }],
          authorize: async () => true,
        }),
      ).rejects.toThrow('local_git_metadata_invalid');
      expect(readFileSync(sentinel, 'utf8')).toBe('test-only independent credential sentinel');
      expect(readdirSync(f.privateRoot)).toEqual([]);
    }),
);
