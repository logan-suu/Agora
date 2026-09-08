import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared across capabilities for the same root, including the separate fs server.
const frozenWrites = new Map<string, number>();

/** Trusted read window: reject synchronous host writes until container thaw completes. */
export async function withFrozenFileWrites<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const canonical = realpathSync(root);
  frozenWrites.set(canonical, (frozenWrites.get(canonical) ?? 0) + 1);
  try {
    return await operation();
  } finally {
    const remaining = (frozenWrites.get(canonical) as number) - 1;
    if (remaining === 0) frozenWrites.delete(canonical);
    else frozenWrites.set(canonical, remaining);
  }
}

/** L3 companion for synchronous, root-confined file operations. */
export interface RootFiles {
  verifyRoot(): void;
  read(path: string): string;
  write(path: string, content: string): void;
  list(): string[];
}

/** Root identity is pinned at registration, never refreshed during a tool call. */
export class SecureFiles implements RootFiles {
  readonly root: string;
  private readonly dev: bigint;
  private readonly ino: bigint;
  private readonly alias: string;

  constructor(
    root: string,
    private readonly label: 'worktree' | 'sandbox' = 'worktree',
  ) {
    this.root = realpathSync(root);
    this.alias = resolve(root);
    const fd = openSync(
      this.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(fd, { bigint: true });
      this.dev = stat.dev;
      this.ino = stat.ino;
    } finally {
      closeSync(fd);
    }
  }

  read(path: string): string {
    return this.invoke('read', path).toString('utf8');
  }
  write(path: string, content: string): void {
    if (frozenWrites.has(this.root))
      throw new Error('cannot write while worktree files are frozen');
    this.invoke('write', path, content);
  }
  list(): string[] {
    return this.invoke('list', '').toString('utf8').split('\0').filter(Boolean).sort();
  }

  measure(): { logicalBytes: number; allocatedBytes: number } {
    const value: unknown = JSON.parse(this.invoke('measure', '').toString('utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      !('logicalBytes' in value) ||
      !('allocatedBytes' in value) ||
      !Number.isSafeInteger(value.logicalBytes) ||
      !Number.isSafeInteger(value.allocatedBytes)
    )
      throw new Error('invalid file measurement');
    return value as { logicalBytes: number; allocatedBytes: number };
  }

  verifyRoot(): void {
    closeSync(this.openRoot());
  }

  /** Copy through directory handles into a new trusted staging directory. */
  snapshotTo(destination: string): void {
    const rel = relative(this.root, resolve(destination));
    if (!rel.startsWith('..')) throw new Error('snapshot destination must be outside source');
    mkdirSync(destination, { mode: 0o700 });
    const output = openSync(
      destination,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      this.invoke('snapshot', '', undefined, output);
    } finally {
      closeSync(output);
    }
  }

  private invoke(operation: string, path: string, input?: string, destination?: number): Buffer {
    const fd = this.openRoot();
    try {
      const helper =
        process.env.AGORA_SECURE_FILES_HELPER ??
        fileURLToPath(
          new URL(`../build/secure-files-${process.platform}-${process.arch}`, import.meta.url),
        );
      if (!isAbsolute(helper))
        throw new Error('secure file helper must be an absolute trusted path');
      const result = spawnSync(helper, [operation, this.root, path, this.alias], {
        input,
        stdio:
          destination === undefined
            ? ['pipe', 'pipe', 'pipe', fd]
            : ['pipe', 'pipe', 'pipe', fd, destination],
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
      });
      if (result.error)
        throw new Error('secure file helper unavailable or failed; run pnpm build:sandbox-native', {
          cause: result.error,
        });
      if (result.status !== 0)
        throw new Error(
          result.stderr
            .toString('utf8')
            .trim()
            .replace('path escapes worktree root', `path escapes ${this.label} root`) ||
            'secure file operation failed',
        );
      return result.stdout;
    } finally {
      closeSync(fd);
    }
  }

  private openRoot(): number {
    if (realpathSync(this.alias) !== this.root) throw new Error('worktree root retargeted');
    const fd = openSync(
      this.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (stat.dev !== this.dev || stat.ino !== this.ino)
        throw new Error('worktree root retargeted');
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
}
