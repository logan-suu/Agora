/** Internal Git execution boundary shared by fixed trusted operations. Not an MCP API. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isGitObjectId, isWorkspaceRelativePath } from '@agora/core-domain';
import { localRecordHash } from './local-registry-records';

export type LocalGitSessionOptions = {
  actionId: string;
  projectId: string;
  taskId: string;
  root: string;
  privateRoot: string;
  git: { path: string; sha256: string };
  metadataHelper: { path: string; sha256: string };
  authorize(): Promise<boolean>;
};
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const id = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const queues = new Map<string, Promise<void>>();
async function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => done);
  queues.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
function identity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('local_git_root_changed');
  return {
    path,
    identity: `${stat.dev}:${stat.ino}`,
    uid: Number(stat.uid),
    mode: Number(stat.mode),
  };
}
function canonical(path: string) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    !isWorkspaceRelativePath(path.slice(1)) ||
    realpathSync(path) !== path
  )
    throw Error('local_git_root_changed');
  return path;
}
export function readLocalGitRecord(path: string, optional = false): Buffer | null {
  if (optional && !existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
    throw Error('local_git_metadata_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function writeLocalGitRecord(path: string, value: unknown) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export interface LocalGitSession {
  root: string;
  privateRoot: string;
  metadata: string;
  key: string;
  index: string;
  chains: { path: string; identity: string; uid: number; mode: number }[];
  initialUserState: string;
  sourceHead: { symbolicRef: string | null; commit: string | null; indexHash: string | null };
  check(): Promise<void>;
  run(argv: string[], stdin?: Buffer, linked?: { path: string; metadata: string }): Promise<string>;
  readObjectBytes(argv: ['ls-tree', ...string[]] | ['cat-file', 'blob', string]): Promise<Buffer>;
  mergeObjects(
    ours: string,
    theirs: string,
    replay?: boolean,
    existingActionId?: string,
  ): Promise<{ status: number; output: string }>;
  readLinked(
    path: string,
    kind: 'marker' | 'linked' | 'tree',
    stagingIdentity?: string,
  ): Record<string, unknown>;
}
export function assertLocalGitActionKind(
  session: Pick<LocalGitSession, 'privateRoot' | 'key'>,
  kind: 'baseline' | 'worktree' | 'commit' | 'linked-root' | 'merge' | 'publish',
) {
  for (const other of ['baseline', 'worktree', 'commit', 'linked-root', 'merge', 'publish']) {
    if (other === kind) continue;
    const prefix = other === 'baseline' ? '' : `${other}-`;
    if (
      ['prepared', 'completed', 'invalid'].some((stage) =>
        existsSync(join(session.privateRoot, `${session.key}.${prefix}${stage}.json`)),
      )
    )
      throw Error('operation_conflict');
  }
}
export async function withLocalGitSession<T>(
  input: LocalGitSessionOptions,
  operation: (session: LocalGitSession) => Promise<T>,
): Promise<T> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('sandbox_unavailable');
  const request = { ...input, git: { ...input.git }, metadataHelper: { ...input.metadataHelper } };
  if (![request.actionId, request.projectId, request.taskId].every(id))
    throw Error('invalid_local_git_input');
  const root = canonical(request.root),
    privateRoot = canonical(request.privateRoot),
    metadata = canonical(join(root, '.git'));
  canonical(request.git.path);
  canonical(request.metadataHelper.path);
  for (const tool of [request.git, request.metadataHelper]) {
    for (const writable of [root, privateRoot]) {
      const path = relative(writable, tool.path);
      if (path === '' || (!path.startsWith('../') && path !== '..'))
        throw Error('local_git_untrusted_binary');
    }
  }
  const independent = relative(root, privateRoot);
  if (!independent.startsWith('../') || relative(privateRoot, root) === '..')
    throw Error('local_git_private_root_overlap');
  const privateIdentity = identity(privateRoot);
  if ((privateIdentity.mode & 0o777) !== 0o700 || privateIdentity.uid !== process.getuid?.())
    throw Error('local_git_private_root_invalid');
  return serialize(metadata, async () => {
    const chains = new Map<string, ReturnType<typeof identity>>();
    for (const directory of [
      root,
      metadata,
      privateRoot,
      dirname(request.git.path),
      dirname(request.metadataHelper.path),
    ]) {
      for (let path = directory; ; path = dirname(path)) {
        chains.set(path, identity(path));
        if (path === '/') break;
      }
    }
    const verifyBinaries = () => {
      for (const tool of [request.git, request.metadataHelper]) {
        const executable = lstatSync(tool.path);
        if (
          !executable.isFile() ||
          executable.nlink !== 1 ||
          executable.mode & 0o022 ||
          !(executable.mode & 0o111) ||
          hash(readFileSync(tool.path)) !== tool.sha256
        )
          throw Error('local_git_binary_changed');
      }
    };
    verifyBinaries();
    const deadline = Date.now() + 30_000;
    const remainingTime = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('local_git_deadline');
      return remaining;
    };
    const checkDeadline = (error?: Error) => {
      if (error && 'code' in error && error.code === 'ETIMEDOUT') throw Error('local_git_deadline');
      remainingTime();
    };
    const key = localRecordHash({
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
    });
    const index = join(privateRoot, `${key}.index`);
    const assertRoots = () => {
      for (const [path, before] of chains)
        if (localRecordHash(identity(path)) !== localRecordHash(before))
          throw Error('local_git_root_changed');
      verifyBinaries();
    };
    const userState = () => {
      assertRoots();
      const q = JSON.stringify;
      const ordered = [];
      for (let path = metadata; ; path = dirname(path)) {
        ordered.unshift(chains.get(path)?.identity ?? 'invalid');
        if (path === '/') break;
      }
      const policy = [
        '(version 1)',
        '(deny default)',
        '(allow sysctl-read)',
        `(allow process-exec (literal ${q(request.metadataHelper.path)}))`,
        '(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS"))',
        ...[...chains.keys()].map((path) => `(allow file-read* (literal ${q(path)}))`),
        `(allow file-read* file-map-executable (literal ${q(request.metadataHelper.path)}))`,
        `(allow file-read* (subpath ${q(metadata)}))`,
      ].join('\n');
      const result = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-p', policy, request.metadataHelper.path, metadata, ...ordered],
        {
          cwd: '/',
          env: { NODE_ENV: 'production', HOME: '/', TMPDIR: '/', LANG: 'C', LC_ALL: 'C' },
          timeout: remainingTime(),
          maxBuffer: 16 * 1024,
        },
      );
      assertRoots();
      checkDeadline(result.error);
      if (result.status === 67) throw Error('local_git_external_lock');
      if (result.error || result.status !== 0 || result.signal)
        throw Error('local_git_metadata_invalid');
      const snapshot = JSON.parse(result.stdout.toString('utf8')) as Record<string, unknown>;
      if (
        Object.keys(snapshot).sort().join(',') !==
          'commit,configHash,headHash,indexHash,packedRefsHash,refHash,schemaVersion,symbolicRef' ||
        snapshot.schemaVersion !== 'local-git-metadata-v1' ||
        !['headHash', 'indexHash', 'configHash', 'packedRefsHash', 'refHash'].every(
          (key) =>
            snapshot[key] === null ||
            (typeof snapshot[key] === 'string' && /^[a-f0-9]{64}$/.test(snapshot[key])),
        ) ||
        (snapshot.commit !== null && !isGitObjectId(snapshot.commit)) ||
        (snapshot.symbolicRef !== null &&
          (typeof snapshot.symbolicRef !== 'string' ||
            !snapshot.symbolicRef.startsWith('refs/heads/') ||
            !isWorkspaceRelativePath(snapshot.symbolicRef)))
      )
        throw Error('local_git_metadata_invalid');
      return {
        hash: localRecordHash(snapshot),
        sourceHead: {
          symbolicRef: snapshot.symbolicRef as string | null,
          commit: snapshot.commit as string | null,
          indexHash: snapshot.indexHash as string | null,
        },
      };
    };
    const original = userState();
    const initialUserState = original.hash;
    const readLinked = (
      path: string,
      kind: 'marker' | 'linked' | 'tree',
      stagingIdentity?: string,
    ) => {
      if (
        stagingIdentity !== undefined &&
        (kind !== 'tree' || !/^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$/.test(stagingIdentity))
      )
        throw Error('invalid_local_git_input');
      const parent = kind === 'linked' ? join(metadata, 'worktrees') : privateRoot;
      const suffix = relative(parent, path);
      if (!suffix || suffix === '..' || suffix.startsWith('../') || suffix.startsWith('/'))
        throw Error('local_git_worktree_changed');
      assertRoots();
      const pins: ReturnType<typeof identity>[] = [];
      for (let current = canonical(path); ; current = dirname(current)) {
        pins.unshift(identity(current));
        if (current === '/') break;
      }
      const q = JSON.stringify;
      const policy = [
        '(version 1)',
        '(deny default)',
        '(allow sysctl-read)',
        `(allow process-exec (literal ${q(request.metadataHelper.path)}))`,
        '(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS"))',
        ...[...chains.keys(), ...pins.map((entry) => entry.path)].map(
          (directory) => `(allow file-read* (literal ${q(directory)}))`,
        ),
        `(allow file-read* file-map-executable (literal ${q(request.metadataHelper.path)}))`,
        `(allow file-read* (subpath ${q(path)}))`,
      ].join('\n');
      const result = spawnSync(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          policy,
          request.metadataHelper.path,
          ...(stagingIdentity === undefined
            ? [`--${kind}`]
            : ['--tree-with-staging', stagingIdentity]),
          path,
          ...pins.map((entry) => entry.identity),
        ],
        {
          cwd: '/',
          env: { NODE_ENV: 'production', HOME: '/', TMPDIR: '/', LANG: 'C', LC_ALL: 'C' },
          timeout: remainingTime(),
          maxBuffer: kind === 'tree' ? 16 * 1024 * 1024 : 16 * 1024,
        },
      );
      assertRoots();
      checkDeadline(result.error);
      if (
        result.error ||
        result.status !== 0 ||
        result.signal ||
        pins.some((entry) => localRecordHash(identity(entry.path)) !== localRecordHash(entry))
      )
        throw Error('local_git_worktree_changed');
      const record = JSON.parse(result.stdout.toString('utf8'));
      if (record.schemaVersion !== (kind === 'tree' ? 'local-git-tree-v2' : 'local-git-linked-v1'))
        throw Error('local_git_worktree_changed');
      return record as Record<string, unknown>;
    };
    const check = async () => {
      checkDeadline();
      let authorizationTimer: NodeJS.Timeout | undefined;
      try {
        // A stalled read-only authorization must not hold the Git session queue
        // beyond the same wall-clock deadline used for its commands.
        const expired = new Promise<never>((_, reject) => {
          authorizationTimer = setTimeout(
            () => reject(Error('local_git_deadline')),
            remainingTime(),
          );
        });
        if (!(await Promise.race([request.authorize(), expired])))
          throw Error('authorization_closed');
      } finally {
        if (authorizationTimer) clearTimeout(authorizationTimer);
      }
      checkDeadline();
      if (userState().hash !== initialUserState) throw Error('local_git_user_state_changed');
      checkDeadline();
    };
    const q = JSON.stringify;
    const policy = [
      '(version 1)',
      '(deny default)',
      `(allow process-exec (literal ${q(request.git.path)}))`,
      '(allow process-fork)',
      '(allow sysctl-read)',
      '(allow file-read* (literal "/"))',
      '(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS"))',
      '(allow file-read* (literal "/dev/urandom"))',
      '(allow file-read* file-write* (literal "/dev/null"))',
      ...[...chains.keys()].map((path) => `(allow file-read-metadata (literal ${q(path)}))`),
      `(allow file-read* file-map-executable (literal ${q(request.git.path)}))`,
      `(allow file-read* file-write* (subpath ${q(metadata)}))`,
      `(allow file-read* file-write* (subpath ${q(privateRoot)}))`,
    ].join('\n');
    const configurations = [
      'core.hooksPath=/dev/null',
      'core.fsmonitor=false',
      'core.attributesFile=/dev/null',
      'core.bare=false',
      `core.worktree=${root}`,
      'core.splitIndex=false',
      'core.untrackedCache=false',
      'core.sparseCheckout=false',
      'core.fsync=all',
      'core.fsyncMethod=fsync',
      'worktree.useRelativePaths=false',
      'commit.gpgSign=false',
      'tag.gpgSign=false',
      'gc.auto=0',
      'maintenance.auto=false',
      'protocol.allow=never',
      'core.pager=cat',
    ];
    const execute = async (
      argv: string[],
      stdin?: Buffer,
      linked?: { path: string; metadata: string },
      isolated?: { path: string; attributeSource: string },
    ) => {
      await check();
      if (linked) {
        readLinked(linked.path, 'marker');
        readLinked(linked.metadata, 'linked');
      }
      const result = spawnSync(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          policy,
          request.git.path,
          ...configurations.flatMap((c) => ['-c', c]),
          ...(isolated ? ['-c', 'core.bare=true', '-c', 'merge.default=text'] : []),
          `--git-dir=${isolated?.path ?? linked?.metadata ?? metadata}`,
          `--work-tree=${linked?.path ?? root}`,
          ...argv,
        ],
        {
          cwd: privateRoot,
          input: stdin,
          maxBuffer: 16 * 1024 * 1024,
          timeout: remainingTime(),
          env: {
            NODE_ENV: 'production',
            HOME: privateRoot,
            TMPDIR: privateRoot,
            PATH: `${dirname(request.git.path)}:/usr/bin:/bin`,
            GIT_EXEC_PATH: dirname(request.git.path),
            LANG: 'C',
            LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_INDEX_FILE: linked ? join(linked.metadata, 'index') : index,
            GIT_OPTIONAL_LOCKS: '0',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_NO_LAZY_FETCH: '1',
            ...(isolated
              ? {
                  GIT_OBJECT_DIRECTORY: join(metadata, 'objects'),
                  GIT_ATTR_SOURCE: isolated.attributeSource,
                  GIT_ATTR_NOSYSTEM: '1',
                }
              : {}),
            GIT_AUTHOR_NAME: 'Agora',
            GIT_AUTHOR_EMAIL: 'agora@example.invalid',
            GIT_COMMITTER_NAME: 'Agora',
            GIT_COMMITTER_EMAIL: 'agora@example.invalid',
            GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
            GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
          },
        },
      );
      checkDeadline(result.error);
      await check();
      if (linked) {
        readLinked(linked.path, 'marker');
        readLinked(linked.metadata, 'linked');
      }
      if (
        result.error ||
        (result.status !== 0 && !(isolated && argv[0] === 'merge-tree' && result.status === 1)) ||
        result.signal
      ) {
        const stderr = result.stderr?.toString('utf8') ?? '';
        throw Error('local_git_command_failed', {
          cause: {
            command: argv[0],
            status: result.status,
            signal: result.signal,
            sandboxInitializationDenied: /sandbox_(init|apply): Operation not permitted/.test(
              stderr,
            ),
            permissionDenied: /Operation not permitted|Permission denied/.test(stderr),
            forkDenied: /cannot fork|unable to fork|fork: Operation not permitted/.test(stderr),
            stderrHash: hash(stderr),
          },
        });
      }
      return { status: result.status as number, bytes: result.stdout };
    };
    const run: LocalGitSession['run'] = async (...args) =>
      (await execute(...args)).bytes.toString('utf8').trim();
    const readObjectBytes: LocalGitSession['readObjectBytes'] = async (args) =>
      (await execute(args)).bytes;
    const mergeObjects: LocalGitSession['mergeObjects'] = async (
      ours,
      theirs,
      replay = false,
      existingActionId,
    ) => {
      if (![ours, theirs].every(isGitObjectId)) throw Error('invalid_local_git_input');
      if (existingActionId !== undefined && (!replay || !id(existingActionId)))
        throw Error('invalid_local_git_input');
      const format = await run(['rev-parse', '--show-object-format']);
      if (!['sha1', 'sha256'].includes(format)) throw Error('local_git_metadata_invalid');
      const attributeSource = await run(
        ['hash-object', '-t', 'tree', '--stdin', '-w'],
        Buffer.alloc(0),
      );
      if (!isGitObjectId(attributeSource)) throw Error('local_git_tree_mismatch');
      const mergeKey = existingActionId
        ? localRecordHash({
            projectId: request.projectId,
            taskId: request.taskId,
            actionId: existingActionId,
          })
        : key;
      const path = join(privateRoot, `${mergeKey}.merge-repository`);
      if (existsSync(path) !== replay) throw Error('local_git_recovery_required');
      await check();
      if (!replay) {
        mkdirSync(path, { mode: 0o700 });
        mkdirSync(join(path, 'objects'), { mode: 0o700 });
        mkdirSync(join(path, 'refs'), { mode: 0o700 });
      }
      const files = {
        HEAD: 'ref: refs/heads/unborn\n',
        config: `[core]\nrepositoryformatversion = ${format === 'sha1' ? 0 : 1}\nbare = true\n${format === 'sha256' ? '[extensions]\nobjectFormat = sha256\n' : ''}`,
      };
      for (const [name, content] of replay ? [] : Object.entries(files)) {
        const fd = openSync(
          join(path, name),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o400,
        );
        try {
          writeFileSync(fd, content);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      const pinned = identity(path);
      const verify = () => {
        if (localRecordHash(identity(path)) !== localRecordHash(pinned))
          throw Error('local_git_root_changed');
        if (readdirSync(path).sort().join(',') !== 'HEAD,config,objects,refs')
          throw Error('local_git_metadata_invalid');
        for (const directory of [path, join(path, 'objects'), join(path, 'refs')]) {
          const current = identity(directory);
          if (
            (current.mode & 0o777) !== 0o700 ||
            current.uid !== process.getuid?.() ||
            (directory !== path && readdirSync(directory).length !== 0)
          )
            throw Error('local_git_metadata_invalid');
        }
        for (const [name, content] of Object.entries(files)) {
          const stat = lstatSync(join(path, name));
          if (
            (stat.mode & 0o777) !== 0o400 ||
            stat.uid !== process.getuid?.() ||
            readLocalGitRecord(join(path, name))?.toString('utf8') !== content
          )
            throw Error('local_git_metadata_invalid');
        }
      };
      verify();
      if (!replay) {
        for (const directory of [join(path, 'objects'), join(path, 'refs'), path, privateRoot]) {
          const fd = openSync(
            directory,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
      }
      const result = await execute(
        ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', ours, theirs],
        undefined,
        undefined,
        { path, attributeSource },
      );
      verify();
      await check();
      return { status: result.status, output: result.bytes.toString('utf8').trim() };
    };

    return operation({
      root,
      privateRoot,
      metadata,
      key,
      index,
      chains: [...chains.values()],
      initialUserState,
      sourceHead: original.sourceHead,
      check,
      run,
      readObjectBytes,
      mergeObjects,
      readLinked,
    });
  });
}
