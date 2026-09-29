// Real managed Git fixtures with native proof capture and ownership-checked cleanup.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setImmediate as yieldToRunner } from 'node:timers/promises';
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const toolchainRoot = '/Applications/Agora.app/Contents/Resources/toolchains/darwin-arm64';
export const manifestBytes = readFileSync(join(toolchainRoot, 'manifest.json'));
export const manifest = JSON.parse(manifestBytes.toString('utf8'));
export const gitPath = join(toolchainRoot, 'git/bin/git');
export const helperPath = resolve('packages/runtime/sandbox/build/local-git-metadata-darwin-arm64');
export const metadataHelper = { path: helperPath, sha256: hash(readFileSync(helperPath)) };
export const binary = { path: gitPath, sha256: hash(readFileSync(gitPath)) };
if (
  manifest.versions.git !== '2.53.0' ||
  manifest.files.find((file: { path: string }) => file.path === 'git/bin/git')?.sha256 !==
    binary.sha256
)
  throw Error('managed_git_invalid');

export async function fixture(
  run: (f: {
    root: string;
    privateRoot: string;
    metadata: string;
    git(args: string[], input?: Buffer): string;
    base: string;
  }) => Promise<unknown>,
) {
  // Git/native calls are synchronous. Let the runner receive the previous
  // case's RPC acknowledgement before entering another long fixture.
  await yieldToRunner();
  const base = mkdtempSync('/private/tmp/agora-task124-git-');
  const identity = lstatSync(base);
  const starts = resolve('test-outputs/task124/fixture-starts');
  mkdirSync(starts, { recursive: true });
  writeFileSync(
    join(starts, `${base.split('/').at(-1)}.json`),
    JSON.stringify({
      base,
      dev: identity.dev,
      inode: identity.ino,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    }),
  );
  const space = statfsSync(base).bavail * statfsSync(base).bsize;
  const root = join(base, 'project'),
    privateRoot = join(base, 'private');
  mkdirSync(root);
  mkdirSync(privateRoot, { mode: 0o700 });
  const git = (args: string[], input?: Buffer) =>
    execFileSync(gitPath, ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
      encoding: 'utf8',
      input,
      env: {
        NODE_ENV: 'test',
        PATH: '/usr/bin:/bin',
        HOME: base,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_EXEC_PATH: join(toolchainRoot, 'git/libexec/git-core'),
        GIT_TEMPLATE_DIR: join(toolchainRoot, 'git/share/git-core/templates'),
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    }).trim();
  let error: unknown;
  try {
    git(['init', '-q']);
    writeFileSync(join(root, 'file.txt'), 'committed\n');
    git(['add', 'file.txt']);
    git(['commit', '-qm', 'Create fixture']);
    writeFileSync(join(root, 'file.txt'), 'staged\n');
    git(['add', 'file.txt']);
    writeFileSync(join(root, 'file.txt'), 'working\n');
    writeFileSync(join(root, 'new.txt'), 'untracked\n');
    await run({ root, privateRoot, metadata: join(root, '.git'), git, base });
  } catch (caught) {
    error = caught;
  } finally {
    const output = resolve('test-outputs/task124');
    mkdirSync(output, { recursive: true });
    const lsof = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' });
    const mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' });
    const current = lstatSync(base);
    const removable =
      lsof.status === 1 &&
      !lsof.stdout &&
      !lsof.stderr &&
      mounts.status === 0 &&
      !mounts.stderr &&
      !mounts.stdout.includes(base) &&
      current.dev === identity.dev &&
      current.ino === identity.ino &&
      !current.isSymbolicLink();
    const evidencePath = join(output, `${base.split('/').at(-1)}.json`);
    const evidence = {
      base,
      binary,
      metadataHelper,
      toolchainManifestHash: hash(manifestBytes),
      gitVersion: manifest.versions.git,
      host: process.platform,
      arch: process.arch,
      os: execFileSync('/usr/bin/sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim(),
      sourceHash: hash(readFileSync(resolve('packages/runtime/sandbox/src/local-git-baseline.ts'))),
      sourceHashes: Object.fromEntries(
        [
          'local-git-baseline.ts',
          'local-git-baseline-reader.ts',
          'local-coding-baseline.ts',
          'local-git-session.ts',
          'local-git-worktree.ts',
          'local-git-commit.ts',
          'local-git-merge.ts',
          'local-git-publish.ts',
          'local-merge-candidates.ts',
          'local-git-tree-files.ts',
          'local-linked-root.ts',
          'local-registry-records.ts',
          'local-root-initialization.ts',
          'local-git-version-store.ts',
          'local-version-store.ts',
          'local-root-inspection.ts',
          'local-git-workspaces.ts',
          'local-workspace-authority.ts',
          'local-integration-authority.ts',
          'local-integration-sources.ts',
          'local-integration-candidates.ts',
          'local-integration-tree-batch.ts',
          'local-integration-publication.ts',
          'local-integration-completion-records.ts',
          'local-integration-completion.ts',
          'local-integration-handoff.ts',
          'local-integration-handoff-records.ts',
          'local-integration-progress.ts',
          'local-integration-preparation.ts',
          'local-integration-application-records.ts',
          'local-grant-policy.ts',
          'local-workspace-operation.ts',
          'local-workspace-sessions.ts',
          'local-completed-worktree.ts',
          'local-workspace-files.ts',
          'local-workspace-tools.ts',
          'local-workspace-commands.ts',
        ].map((name) => [name, hash(readFileSync(resolve('packages/runtime/sandbox/src', name)))]),
      ),
      dispatchSourceHashes: Object.fromEntries(
        [
          'packages/core/orchestration/src/worker-runtime.ts',
          'packages/core/domain/src/integration-selection.ts',
          'packages/core/domain/src/integration-preparation.ts',
          'packages/core/domain/test/integration-preparation.test.ts',
          'tests/integration/phase12/phase12-4-integration-preparation.test.ts',
          'packages/core/domain/src/integration-acknowledgement.ts',
          'packages/core/domain/test/integration-acknowledgement.test.ts',
          'packages/core/domain/test/integration-fixture.ts',
          'packages/runtime/state/src/json-task-state-store.ts',
          'packages/runtime/state/test/json-task-state-store.test.ts',
          'tests/integration/phase12/phase12-4-integration-acknowledgement.test.ts',
          'tests/integration/phase12/phase12-4-cumulative-publication.test.ts',
          'tests/integration/phase12/phase12-4-integration-service.test.ts',
          'tests/integration/phase12/phase12-4-integration-handoff.test.ts',
          'packages/runtime/sandbox/test/local-integration-handoff-records.test.ts',
          'packages/core/orchestration/src/integrate.ts',
          'packages/core/domain/src/integration-completion.ts',
          'packages/core/domain/test/integration-completion.test.ts',
          'packages/core/domain/src/coding-worker-lineage.ts',
          'packages/core/domain/test/coding-worker-lineage.test.ts',
          'packages/core/domain/test/integration-selection.test.ts',
          'packages/runtime/executor/src/project.ts',
          'tests/integration/phase12/phase12-4-linked-workspace.test.ts',
          'tests/integration/phase12/phase12-4-completed-worktree.test.ts',
          'tests/integration/phase12/phase12-4-integration-sources.test.ts',
          'tests/integration/phase12/phase12-4-integration-candidates.test.ts',
          'tests/integration/phase12/phase12-4-applied-proofs.test.ts',
          'tests/integration/phase12/phase12-4-integration-publication.test.ts',
          'tests/integration/phase12/local-completed-integration-fixture.ts',
          'tests/integration/phase12/phase12-4-coding-retry.test.ts',
          'tests/integration/phase12/phase12-4-coding-baseline.test.ts',
          'tests/integration/phase12/local-linked-workspace-fixture.ts',
          'tests/integration/phase12/phase12-4-integration-authority.test.ts',
          'tests/integration/phase12/phase12-4-tree-batch.test.ts',
          'packages/runtime/sandbox/test/local-git-merge.test.ts',
          'packages/runtime/sandbox/test/local-git-publish.test.ts',
          'packages/runtime/sandbox/test/local-git-publication-proof.test.ts',
          'packages/runtime/sandbox/test/local-git-merge-tree.test.ts',
          'packages/runtime/sandbox/test/local-merge-candidates.test.ts',
          'packages/runtime/sandbox/test/local-git-tree-files.test.ts',
          'packages/runtime/sandbox/test/local-git-fixture.ts',
        ].map((path) => [path, hash(readFileSync(resolve(path)))]),
      ),
      mergeCandidates: (() => {
        const root = join(base, 'state/merge-candidates');
        const objects = join(base, 'state/local-workspaces/objects');
        const files: {
          path: string;
          identity: string;
          bytes: number;
          sha256: string;
          record?: unknown;
        }[] = [];
        const walk = (path: string, prefix: string) => {
          for (const name of readdirSync(path).sort()) {
            const target = join(path, name),
              relative = prefix ? `${prefix}/${name}` : name;
            const stat = lstatSync(target);
            if (stat.isDirectory()) walk(target, relative);
            else if (stat.isFile()) {
              const bytes = readFileSync(target);
              files.push({
                path: relative,
                identity: `${stat.dev}:${stat.ino}`,
                bytes: bytes.length,
                sha256: hash(bytes),
                ...(relative.includes('/journal/') && name.endsWith('.json')
                  ? { record: JSON.parse(bytes.toString('utf8')) }
                  : {}),
              });
            }
          }
        };
        if (existsSync(root)) walk(root, '');
        return {
          references:
            existsSync(root) && existsSync(objects)
              ? readdirSync(objects)
                  .filter((name) => name.endsWith('.ref'))
                  .map((name) => ({
                    name,
                    record: JSON.parse(readFileSync(join(objects, name), 'utf8')),
                  }))
              : [],
          records: existsSync(objects)
            ? readdirSync(objects)
                .filter((name) => name.endsWith('.json'))
                .flatMap((name) => {
                  const bytes = readFileSync(join(objects, name)),
                    record = JSON.parse(bytes.toString('utf8'));
                  return typeof record?.schemaVersion === 'string' &&
                    (record.schemaVersion.startsWith('local-merge-candidate-') ||
                      record.schemaVersion.startsWith('local-integration-candidate-') ||
                      (existsSync(root) && record.schemaVersion === 'local-file-manifest-v1'))
                    ? [{ name, sha256: hash(bytes), record }]
                    : [];
                })
            : [],
          files,
        };
      })(),
      workerCompletions: (() => {
        const objects = join(base, 'state/local-workspaces/objects');
        return existsSync(objects)
          ? readdirSync(objects)
              .sort()
              .flatMap((name) => {
                if (!name.endsWith('.json') && !name.endsWith('.ref')) return [];
                const bytes = readFileSync(join(objects, name));
                const record = JSON.parse(bytes.toString('utf8'));
                return name.endsWith('.ref') ||
                  [
                    'worker-git-completion-v1',
                    'workspace-worker-boundary-v1',
                    'local-file-manifest-v1',
                    'local-git-manifest-v1',
                  ].includes(record.schemaVersion) ||
                  (record.request && record.gitOptions) ||
                  (record.nextLocalExecution && record.records) ||
                  (record.receipt && record.worktree)
                  ? [{ name, sha256: hash(bytes), record }]
                  : [];
              })
          : [];
      })(),
      integrationControl: (() => {
        const objects = join(base, 'state/local-workspaces/objects');
        return existsSync(objects)
          ? readdirSync(objects)
              .filter((name) => name.endsWith('.json'))
              .flatMap((name) => {
                const bytes = readFileSync(join(objects, name));
                const record = JSON.parse(bytes.toString('utf8'));
                return (typeof record?.schemaVersion === 'string' &&
                  record.schemaVersion.startsWith('local-integration-')) ||
                  (record?.projectId && record?.taskId && Array.isArray(record?.messages)) ||
                  record?.schemaVersion === 'local-workspaces-v1'
                  ? [{ name, sha256: hash(bytes), record }]
                  : [];
              })
          : [];
      })(),
      treeBatches: (() => {
        const root = join(base, 'state/local-workspaces/integration-tree-transactions');
        const objects = join(base, 'state/local-workspaces/objects');
        return {
          records: existsSync(objects)
            ? readdirSync(objects)
                .filter((n) => n.endsWith('.json'))
                .flatMap((name) => {
                  const bytes = readFileSync(join(objects, name));
                  const record = JSON.parse(bytes.toString('utf8'));
                  return typeof record?.schemaVersion === 'string' &&
                    record.schemaVersion.startsWith('integration-tree-')
                    ? [{ name, sha256: hash(bytes), record }]
                    : [];
                })
            : [],
          journals: existsSync(root)
            ? readdirSync(root)
                .sort()
                .map((action) => ({
                  action,
                  files: readdirSync(join(root, action))
                    .sort()
                    .map((name) => {
                      const bytes = readFileSync(join(root, action, name));
                      return {
                        name,
                        bytes: bytes.length,
                        sha256: hash(bytes),
                        ...(name.endsWith('.json')
                          ? { record: JSON.parse(bytes.toString('utf8')) }
                          : {}),
                      };
                    }),
                }))
            : [],
        };
      })(),
      registration: [
        'state/local-workspaces/registry.json',
        'state/tasks/projects/project/tasks/task/state.json',
      ]
        .filter((path) => existsSync(join(base, path)))
        .map((path) => ({
          path,
          sha256: hash(readFileSync(join(base, path))),
          record: JSON.parse(readFileSync(join(base, path), 'utf8')),
        })),
      passed: error === undefined,
      error: error instanceof Error ? error.message : null,
      cause: error instanceof Error ? error.cause : null,
      lsofStatus: lsof.status,
      mountStatus: mounts.status,
      cleanup: removable ? 'checked' : 'retained',
      journals: readdirSync(privateRoot)
        .filter((name) => name.endsWith('.json'))
        .map((name) => ({
          name,
          sha256: hash(readFileSync(join(privateRoot, name))),
          record: JSON.parse(readFileSync(join(privateRoot, name), 'utf8')),
        })),
      initializations: existsSync(join(base, 'linked-initializations'))
        ? readdirSync(join(base, 'linked-initializations')).map((action) => ({
            action,
            records: readdirSync(join(base, 'linked-initializations', action)).map((name) => {
              const bytes = readFileSync(join(base, 'linked-initializations', action, name));
              return { name, sha256: hash(bytes), record: JSON.parse(bytes.toString('utf8')) };
            }),
          }))
        : [],
      spaceBefore: space,
    };
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    if (removable) rmSync(base, { recursive: true });
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          ...evidence,
          cleanup: removable ? 'removed' : 'retained',
          spaceAfter: statfsSync('/private/tmp').bavail * statfsSync('/private/tmp').bsize,
        },
        null,
        2,
      ),
    );
    if (!removable && !error) error = Error('fixture_cleanup_incomplete');
  }
  await yieldToRunner();
  if (error) throw error;
}
