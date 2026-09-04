import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Container } from 'dockerode';
import Dockerode from 'dockerode';
import { assertInside } from './path-guard';
import type { RecoverableWorktreeBinding } from './recoverable-sandbox-manager';
import type { SandboxManager } from './sandbox-manager';
import type { IntegrationResult, RunResult, Worktree } from './types';

/** Default per-command timeout (decision R7: 30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Grace after the wrapper deadline before the container-kill backstop fires. */
const BACKSTOP_GRACE_MS = 10_000;

/** Directory where torn-down sandbox roots are moved to (move, not delete). */
const TEARDOWN_STAGING = join(tmpdir(), 'agora-sandbox-trash');

/** Container-internal working dir for the per-task bind mount. */
const CONTAINER_WORKDIR = '/workspace';

/** Default image: Node 20 LTS slim (aligned with the monorepo runtime). */
const DEFAULT_IMAGE = 'node:20-slim';

/** Default memory limit: 512 MiB. */
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;

/** Default CPU weight (shares). */
const DEFAULT_CPU_SHARES = 512;

/** Options for the Phase 1+ Docker sandbox (decision D5 phase advance). */
export interface DockerSandboxOptions {
  /** Container image to run commands in (default `node:20-slim`). */
  image?: string;
  /** Docker network mode (default `none` = no networking, spec §6 "限网络"). */
  networkMode?: 'none' | 'bridge';
  /** Container memory limit in bytes (default 512 MiB). */
  memoryBytes?: number;
  /** Container CPU shares (default 512). */
  cpuShares?: number;
  /** Host directory under which per-task roots are created (default `os.tmpdir()`). */
  baseDir?: string;
  /** Injectable dockerode client (tests / remote daemon); default `new Dockerode()`. */
  docker?: Dockerode;
}

/** Per-task container state (one container per taskId, decision §7.2). */
interface ContainerRecord {
  container: Container;
  /** Host dir bind-mounted at {@link CONTAINER_WORKDIR}. */
  hostRoot: string;
  /** Role -> host worktree path created inside this container's root. */
  roles: Map<string, string>;
}

/**
 * Phase 1+ sandbox implementation (decision D5 / spec §7.2).
 *
 * One container per taskId (created lazily on first `createWorktree`), with the
 * task's host root bind-mounted at `/workspace`. Each role gets a subdirectory
 * inside that root; `read`/`write` operate on the host side of the bind mount
 * (shared file truth), while `run` executes via `docker exec` inside the
 * container — network and resource limited per the options.
 *
 * The {@link SandboxManager} signature stays identical to Phase 0 (decision R9);
 * only the implementation body differs from `LocalTempSandbox`.
 */
export class DockerSandbox implements SandboxManager {
  private readonly docker: Dockerode;
  private readonly image: string;
  private readonly networkMode: string;
  private readonly memoryBytes: number;
  private readonly cpuShares: number;
  private readonly baseDir: string;
  private readonly containers = new Map<string, ContainerRecord>();
  private readonly creating = new Map<string, Promise<ContainerRecord>>();

  constructor(options: DockerSandboxOptions = {}) {
    this.docker = options.docker ?? new Dockerode();
    this.image = options.image ?? DEFAULT_IMAGE;
    this.networkMode = options.networkMode ?? 'none';
    this.memoryBytes = options.memoryBytes ?? DEFAULT_MEMORY_BYTES;
    this.cpuShares = options.cpuShares ?? DEFAULT_CPU_SHARES;
    this.baseDir = options.baseDir ?? tmpdir();
  }

  async createWorktree(taskId: string, role: string): Promise<Worktree> {
    const record = await this.ensureContainer(taskId);
    const roleDir = sanitizeSegment(role);
    const hostPath = join(record.hostRoot, roleDir);
    const existing = record.roles.get(role);
    if (existing !== undefined) {
      return { path: existing, branch: `${taskId}-${role}` };
    }
    // Two distinct roles must never collapse to one workspace: sanitizeSegment
    // could map e.g. 'A/B' and 'A_B' to the same dir, silently merging isolation.
    for (const [otherRole, otherPath] of record.roles) {
      if (otherPath === hostPath && otherRole !== role) {
        throw new Error(
          `role '${role}' collides with '${otherRole}' under the same sanitized path`,
        );
      }
    }
    mkdirSync(hostPath, { recursive: true });
    record.roles.set(role, hostPath);
    // One container per task: the worktree path is the role's host dir inside
    // the shared bind mount; the container path is derived on demand.
    return { path: hostPath, branch: `${taskId}-${role}` };
  }

  async read(worktree: Worktree, path: string): Promise<string> {
    const target = assertInside(worktree.path, path);
    return readFileSync(target, 'utf8');
  }

  async write(worktree: Worktree, path: string, content: string): Promise<void> {
    const target = assertInside(worktree.path, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  async run(worktree: Worktree, cmd: string, timeout = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
    const record = this.recordFor(worktree);
    const containerPath = this.toContainerPath(record, worktree.path);
    // Docker has no POST /exec/{id}/kill (404); wrap the command in coreutils
    // `timeout -s KILL` so a timeout kills only the exec process group and the
    // container stays usable. argv-array form avoids a shell re-parse of `cmd`.
    const seconds = Math.max(1, Math.ceil(timeout / 1000));
    const exec = await record.container.exec({
      Cmd: ['timeout', '-s', 'KILL', String(seconds), '/bin/sh', '-c', cmd],
      WorkingDir: containerPath,
      AttachStdout: true,
      AttachStderr: true,
    });
    return new Promise<RunResult>((resolvePromise, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const startedAt = Date.now();

      const timer = setTimeout(() => {
        timedOut = true;
        // Backstop: if the image lacks coreutils `timeout`, kill the whole
        // container so the exec stream ends and the caller never hangs. Fires
        // long after the wrapper deadline so a healthy container is unaffected.
        void record.container.kill().catch(() => {});
      }, timeout + BACKSTOP_GRACE_MS);

      exec.start({ Detach: false }).then(
        (stream) => {
          // demuxStream expects raw Buffers — never setEncoding on this stream.
          const stdoutSink = {
            write: (chunk: Buffer | string) => {
              stdout += chunk.toString();
            },
          };
          const stderrSink = {
            write: (chunk: Buffer | string) => {
              stderr += chunk.toString();
            },
          };
          record.container.modem.demuxStream(stream, stdoutSink, stderrSink);
          stream.on('end', async () => {
            clearTimeout(timer);
            if (timedOut) {
              resolvePromise({ exitCode: null, stdout, stderr, timedOut: true });
              return;
            }
            try {
              const info = await exec.inspect();
              // The coreutils wrapper enforces the real deadline (ceil to whole
              // seconds); if the process died at/after the requested timeout, it
              // was the wrapper that killed it (ExitCode 137 = 128+SIGKILL).
              const wrapperTimedOut =
                (info.ExitCode ?? 0) === 137 && Date.now() - startedAt >= timeout;
              resolvePromise({
                exitCode: wrapperTimedOut ? null : (info.ExitCode ?? null),
                stdout,
                stderr,
                timedOut: wrapperTimedOut,
              });
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
          stream.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        },
        (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  integrate(_base: string, _branches: string[]): Promise<IntegrationResult> {
    // Git semantics live in packages/tools/git (1.3). The sandbox layer keeps
    // the same explicit not-implemented stance as LocalTempSandbox — never silent.
    return Promise.reject(
      new Error(
        'DockerSandbox.integrate is not implemented in Phase 1 (git semantics live in packages/tools/git; Phase 9 integrate checkpoint)',
      ),
    );
  }

  async teardown(taskId: string): Promise<void> {
    const record = this.containers.get(taskId);
    if (record === undefined) {
      return;
    }
    this.containers.delete(taskId);
    // Stop + remove the container, then move (not delete) the host root to
    // staging — honoring the spec §6 file-protection stance of LocalTempSandbox.
    await record.container.stop({ t: 2 }).catch(() => {});
    await record.container.remove({ force: true }).catch(() => {});
    mkdirSync(TEARDOWN_STAGING, { recursive: true });
    renameSync(record.hostRoot, join(TEARDOWN_STAGING, basename(record.hostRoot)));
  }

  /** Stop runtime resources without moving the host worktree (D4 non-terminal suspend). */
  async suspend(taskId: string): Promise<void> {
    const record = this.containers.get(taskId);
    if (record === undefined) return;
    this.containers.delete(taskId);
    await record.container.stop({ t: 2 }).catch(() => {});
    await record.container.remove({ force: true }).catch(() => {});
  }

  /** Recreate the task container around explicitly persisted host worktree bindings. */
  async resume(taskId: string, bindings: readonly RecoverableWorktreeBinding[]): Promise<void> {
    if (bindings.length === 0) throw new Error('DockerSandbox resume requires a worktree binding');
    const roles = new Map<string, string>();
    let hostRoot: string | undefined;
    for (const binding of bindings) {
      const path = realpathSync(binding.worktree.path);
      if (!statSync(path).isDirectory())
        throw new Error('persisted Docker worktree is not a directory');
      if (basename(path) !== sanitizeSegment(binding.role)) {
        throw new Error(`persisted Docker worktree does not match role "${binding.role}"`);
      }
      const parent = dirname(path);
      const base = realpathSync(this.baseDir);
      const relativeRoot = relative(base, parent);
      if (relativeRoot.startsWith('..') || relativeRoot === '') {
        throw new Error('persisted Docker task root is outside the configured base directory');
      }
      if (!basename(parent).startsWith(dockerTaskRootPrefix(taskId))) {
        throw new Error(`persisted Docker worktree does not belong to task "${taskId}"`);
      }
      if (hostRoot !== undefined && hostRoot !== parent) {
        throw new Error('persisted Docker worktrees do not share one task root');
      }
      hostRoot = parent;
      roles.set(binding.role, path);
    }
    const active = this.containers.get(taskId);
    if (active !== undefined) {
      if (active.hostRoot !== hostRoot || !sameRolePaths(active.roles, roles)) {
        throw new Error(`task "${taskId}" already has a different active sandbox`);
      }
      return;
    }
    const record = await this.createContainer(taskId, hostRoot);
    record.roles = roles;
  }

  private async ensureContainer(taskId: string): Promise<ContainerRecord> {
    const existing = this.containers.get(taskId);
    if (existing !== undefined) {
      return existing;
    }
    // Serialize per-task creation: concurrent createWorktree calls for the same
    // new task must share ONE container instead of both creating a record.
    const inflight = this.creating.get(taskId);
    if (inflight !== undefined) {
      return inflight;
    }
    const promise = this.createContainer(taskId);
    this.creating.set(taskId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(taskId);
    }
  }

  /** Create + start the per-task container and its host root (not serialized). */
  private async createContainer(
    taskId: string,
    existingHostRoot?: string,
  ): Promise<ContainerRecord> {
    await this.ensureImage();
    const hostRoot =
      existingHostRoot ?? mkdtempSync(join(this.baseDir, dockerTaskRootPrefix(taskId)));
    const container = await this.docker.createContainer({
      Image: this.image,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: CONTAINER_WORKDIR,
      HostConfig: {
        Binds: [`${hostRoot}:${CONTAINER_WORKDIR}:rw`],
        NetworkMode: this.networkMode,
        Memory: this.memoryBytes,
        MemorySwap: this.memoryBytes,
        CpuShares: this.cpuShares,
        SecurityOpt: ['no-new-privileges:true'],
      },
    });
    await container.start();
    const record: ContainerRecord = { container, hostRoot, roles: new Map() };
    this.containers.set(taskId, record);
    return record;
  }

  private async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(this.image).inspect();
      return;
    } catch {
      // Image missing — pull it, tracking progress to completion.
    }
    await new Promise<void>((resolvePromise, reject) => {
      this.docker.pull(this.image, {}, (err: Error | null, stream) => {
        if (err) {
          reject(err);
          return;
        }
        if (stream === undefined) {
          reject(new Error(`docker pull returned no stream for ${this.image}`));
          return;
        }
        this.docker.modem.followProgress(
          stream,
          (pullErr: Error | null) => {
            if (pullErr) reject(pullErr);
            else resolvePromise();
          },
          () => {},
        );
      });
    });
  }

  /** Locate the container record that owns a given worktree path. */
  private recordFor(worktree: Worktree): ContainerRecord {
    for (const record of this.containers.values()) {
      if ([...record.roles.values()].some((p) => resolve(p) === resolve(worktree.path))) {
        return record;
      }
    }
    throw new Error(`no container record for worktree: ${worktree.path}`);
  }

  /** Map a host worktree path to its container-visible path. */
  private toContainerPath(record: ContainerRecord, hostPath: string): string {
    const rel = relative(record.hostRoot, resolve(hostPath));
    return join(CONTAINER_WORKDIR, rel);
  }
}

/** Reduce an arbitrary segment to a filesystem-safe name. */
function sanitizeSegment(segment: string): string {
  const safe = segment.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.length === 0 ? 'worktree' : safe;
}

function dockerTaskRootPrefix(taskId: string): string {
  const identity = createHash('sha256').update(taskId).digest('hex').slice(0, 16);
  return `agora-docker-${sanitizeSegment(taskId)}-${identity}-`;
}

function sameRolePaths(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [role, path] of left) {
    if (right.get(role) !== path) return false;
  }
  return true;
}
