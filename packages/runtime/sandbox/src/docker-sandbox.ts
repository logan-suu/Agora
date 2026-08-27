import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Container, Exec } from 'dockerode';
import Dockerode from 'dockerode';
import { assertInside } from './path-guard';
import type { SandboxManager } from './sandbox-manager';
import type { IntegrationResult, RunResult, Worktree } from './types';

/** Default per-command timeout (decision R7: 30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

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
    const exec = await record.container.exec({
      Cmd: ['/bin/sh', '-c', cmd],
      WorkingDir: containerPath,
      AttachStdout: true,
      AttachStderr: true,
    });
    return new Promise<RunResult>((resolvePromise, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // dockerode 4.x has no exec.kill(); use the Docker API directly
        // (POST /exec/{id}/kill), falling back to killing the whole container.
        void killExec(record.container, exec).catch(() => {
          void record.container.kill().catch(() => {});
        });
      }, timeout);

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
              resolvePromise({ exitCode: info.ExitCode ?? null, stdout, stderr, timedOut: false });
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

  private async ensureContainer(taskId: string): Promise<ContainerRecord> {
    const existing = this.containers.get(taskId);
    if (existing !== undefined) {
      return existing;
    }
    await this.ensureImage();
    const hostRoot = mkdtempSync(join(this.baseDir, `agora-docker-${sanitizeSegment(taskId)}-`));
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

/** Kill a running exec via the Docker API (POST /exec/{id}/kill). */
function killExec(container: Container, exec: Exec): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    container.modem.dial(
      {
        path: `/exec/${exec.id}/kill`,
        method: 'POST',
        statusCodes: { 200: true, 404: 'no such exec' },
      },
      (err: Error | null) => {
        if (err) reject(err);
        else resolvePromise();
      },
    );
  });
}

/** Reduce an arbitrary segment to a filesystem-safe name. */
function sanitizeSegment(segment: string): string {
  const safe = segment.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.length === 0 ? 'worktree' : safe;
}
