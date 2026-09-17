/** Internal immutable command binding. Authority comes from the trusted registry
 * seam, never from project input; capture is registration, not an execution refresh.
 * This detects drift, not instantaneous revocation of existing OS capabilities.
 */
import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { release } from 'node:os';
import { dirname, isAbsolute, normalize, relative } from 'node:path';

const stringKeys = [
  'projectId',
  'taskId',
  'workspaceId',
  'rootId',
  'grantId',
  'workerId',
  'policyVersion',
] as const;
const hashKeys = ['grantHash', 'toolchainHash', 'networkHash'] as const;
const numberKeys = ['grantRevision', 'writerEpoch'] as const;
export type LocalCommandAuthority = Record<
  (typeof stringKeys)[number] | (typeof hashKeys)[number],
  string
> &
  Record<(typeof numberKeys)[number], number>;
export type BindingStage =
  | 'admission'
  | 'spawn'
  | 'register'
  | 'release'
  | 'running'
  | 'completion';
export type BindingFailure = 'authority_changed' | 'root_changed' | 'tool_changed' | 'host_changed';
export type CommandInvocation = {
  commandId: string;
  bootstrap: string;
  executable: string;
  helper: string;
  argv: string[];
  policy: string;
  outputRoot: string;
};
type Directory = { path: string; identity: string; uid: number; mode: number };
type Root = { path: string; chain: Directory[] };
type Tool = Root & {
  name: 'bootstrap' | 'executable' | 'helper' | 'sandboxExec';
  metadata: string;
  sha256: string;
};
export type CommandBindingSnapshot = {
  version: 1;
  authority: LocalCommandAuthority;
  invocationHash: string;
  host: { release: string; arch: string };
  roots: Root[];
  tools: Tool[];
};
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const pathValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  isAbsolute(value) &&
  normalize(value) === value &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function authority(value: LocalCommandAuthority) {
  if (
    !value ||
    Object.keys(value).length !== stringKeys.length + hashKeys.length + numberKeys.length ||
    !stringKeys.every((k) => id(value[k])) ||
    !hashKeys.every((k) => hash(value[k])) ||
    !numberKeys.every((k) => Number.isSafeInteger(value[k]) && value[k] >= 0)
  )
    throw new Error('invalid_command_authority');
  return Object.fromEntries(
    [...stringKeys, ...hashKeys, ...numberKeys].map((k) => [k, value[k]]),
  ) as LocalCommandAuthority;
}
function invocationHash(value: CommandInvocation) {
  if (
    !id(value.commandId) ||
    !Array.isArray(value.argv) ||
    value.argv.length > 256 ||
    value.argv.some((a) => typeof a !== 'string' || a.includes('\0')) ||
    ![value.bootstrap, value.executable, value.helper, value.outputRoot].every(
      (p) => pathValid(p) && p !== '/',
    ) ||
    typeof value.policy !== 'string'
  )
    throw new Error('invalid_command_binding');
  const bytes = JSON.stringify([
    value.commandId,
    value.bootstrap,
    value.executable,
    value.helper,
    value.argv,
    value.policy,
    value.outputRoot,
  ]);
  if (Buffer.byteLength(bytes) > 65536) throw new Error('invalid_command_binding');
  return digest(bytes);
}
function directory(path: string): Directory {
  const s = lstatSync(path, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('invalid_command_root');
  return { path, identity: `${s.dev}:${s.ino}`, uid: Number(s.uid), mode: Number(s.mode) };
}
function chain(path: string) {
  const result: Directory[] = [];
  for (let p = path; ; p = dirname(p)) {
    result.unshift(directory(p));
    if (p === '/') break;
  }
  return result;
}
function sameChain(entries: Directory[]) {
  return entries.every((e) => JSON.stringify(directory(e.path)) === JSON.stringify(e));
}
function fileMetadata(s: BigIntStats) {
  if (!s.isFile() || s.nlink !== 1n || (s.mode & 0o022n) !== 0n || (s.mode & 0o111n) === 0n)
    throw new Error('invalid_command_tool');
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}:${s.uid}:${s.nlink}`;
}
function tool(name: Tool['name'], path: string): Tool {
  if (!pathValid(path) || realpathSync(path) !== path) throw new Error('invalid_command_tool');
  const parents = chain(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    const metadata = fileMetadata(before);
    if (before.size > 512n * 1024n * 1024n) throw new Error('command_tool_too_large');
    const hasher = createHash('sha256');
    const bytes = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, null);
      if (!count) break;
      total += count;
      if (total > Number(before.size)) throw new Error('command_tool_changed');
      hasher.update(bytes.subarray(0, count));
    }
    if (
      total !== Number(before.size) ||
      metadata !== fileMetadata(fstatSync(fd, { bigint: true })) ||
      metadata !== fileMetadata(lstatSync(path, { bigint: true })) ||
      !sameChain(parents)
    )
      throw new Error('command_tool_changed');
    return { name, path, chain: parents, metadata, sha256: hasher.digest('hex') };
  } finally {
    closeSync(fd);
  }
}
function validChain(entries: Directory[], last: string) {
  return (
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.length <= 128 &&
    new Set(entries.map((entry) => entry.path)).size === entries.length &&
    entries[0]?.path === '/' &&
    entries.at(-1)?.path === last &&
    entries.every(
      (e, i) =>
        e &&
        pathValid(e.path) &&
        /^\d+:\d+$/.test(e.identity) &&
        Number.isSafeInteger(e.uid) &&
        e.uid >= 0 &&
        Number.isSafeInteger(e.mode) &&
        e.mode >= 0 &&
        (i === 0 || dirname(e.path) === entries[i - 1]?.path),
    )
  );
}
export function validCommandBinding(value: CommandBindingSnapshot): boolean {
  try {
    authority(value.authority);
    return (
      value.version === 1 &&
      hash(value.invocationHash) &&
      typeof value.host.release === 'string' &&
      value.host.release.length <= 128 &&
      value.host.arch === 'arm64' &&
      Array.isArray(value.roots) &&
      value.roots.length > 0 &&
      value.roots.length <= 16 &&
      value.roots.every(
        (r) => pathValid(r.path) && r.path !== '/' && validChain(r.chain, r.path),
      ) &&
      new Set(value.roots.map((r) => r.path)).size === value.roots.length &&
      Array.isArray(value.tools) &&
      value.tools.length === 4 &&
      value.tools.every(
        (t, i) =>
          t.name === ['bootstrap', 'executable', 'helper', 'sandboxExec'][i] &&
          pathValid(t.path) &&
          t.path !== '/' &&
          hash(t.sha256) &&
          /^(\d+:){7}\d+$/.test(t.metadata) &&
          validChain(t.chain, dirname(t.path)),
      )
    );
  } catch {
    return false;
  }
}

export class LocalCommandBinding {
  #snapshot: CommandBindingSnapshot;
  #failure: BindingFailure | null = null;
  constructor(
    invocation: CommandInvocation,
    roots: string[],
    expected: LocalCommandAuthority,
    private readonly readAuthority: (stage: BindingStage) => LocalCommandAuthority | null,
  ) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64')
      throw new Error('sandbox_unavailable');
    const bound = roots.map((path) => {
      if (!pathValid(path) || path === '/' || realpathSync(path) !== path)
        throw new Error('invalid_command_root');
      return { path, chain: chain(path) };
    });
    const within = (a: string, b: string) => {
      const r = relative(a, b);
      return !r || (r !== '..' && !r.startsWith('../') && !isAbsolute(r));
    };
    if (
      bound.some((r, i) =>
        bound.some(
          (other, j) => i !== j && (within(r.path, other.path) || within(other.path, r.path)),
        ),
      ) ||
      !roots.includes(invocation.outputRoot)
    )
      throw new Error('invalid_command_binding');
    this.#snapshot = {
      version: 1,
      authority: authority(expected),
      invocationHash: invocationHash(invocation),
      host: { release: release(), arch: process.arch },
      roots: bound,
      tools: [
        tool('bootstrap', invocation.bootstrap),
        tool('executable', invocation.executable),
        tool('helper', invocation.helper),
        tool('sandboxExec', '/usr/bin/sandbox-exec'),
      ],
    };
    if (this.#snapshot.tools.some((t) => within(invocation.outputRoot, t.path)))
      throw new Error('mutable_command_tool');
    if (!validCommandBinding(this.#snapshot)) throw new Error('invalid_command_binding');
    if (this.check('admission')) throw new Error('command_binding_invalidated');
  }
  snapshot() {
    return structuredClone(this.#snapshot);
  }
  matches(invocation: CommandInvocation, workspaceId: string) {
    return (
      this.#snapshot.invocationHash === invocationHash(invocation) &&
      this.#snapshot.authority.workspaceId === workspaceId
    );
  }
  controlAllowed() {
    try {
      const t = this.#snapshot.tools[2] as Tool;
      return (
        release() === this.#snapshot.host.release &&
        sameChain(t.chain) &&
        fileMetadata(lstatSync(t.path, { bigint: true })) === t.metadata
      );
    } catch {
      return false;
    }
  }
  private invalidate(reason: BindingFailure) {
    this.#failure = reason;
    return reason;
  }
  check(stage: BindingStage): BindingFailure | null {
    if (this.#failure) return this.#failure;
    try {
      const current = this.readAuthority(stage);
      if (
        !current ||
        JSON.stringify(authority(current)) !== JSON.stringify(this.#snapshot.authority)
      )
        throw new Error('changed');
    } catch {
      return this.invalidate('authority_changed');
    }
    if (release() !== this.#snapshot.host.release || process.arch !== this.#snapshot.host.arch)
      return this.invalidate('host_changed');
    try {
      if (this.#snapshot.roots.some((r) => !sameChain(r.chain))) throw new Error('changed');
    } catch {
      return this.invalidate('root_changed');
    }
    try {
      if (
        this.#snapshot.tools.some(
          (t) =>
            !sameChain(t.chain) || fileMetadata(lstatSync(t.path, { bigint: true })) !== t.metadata,
        )
      )
        throw new Error('changed');
    } catch {
      return this.invalidate('tool_changed');
    }
    return null;
  }
}
