import { isGitObjectId, isGitSafeBranch } from './state';

/** Data references only. Trusted services must separately verify live authority. */
export type WorkspaceRefV1 = {
  schemaVersion: 'workspace-v1';
  projectId: string;
  taskId: string;
  workspaceId: string;
  rootId: string;
  grantId: string;
  purpose: 'coding' | 'validation' | 'integration';
} & (
  | { mode: 'direct'; baselineManifestId: string }
  | { mode: 'linked-worktree'; commonDirId: string; branch: string; baseCommit: string }
);

export type WorkspaceVersionV1 =
  | { kind: 'files'; manifestId: string; manifestHash: string }
  | { kind: 'git'; commit: string; manifestId: string; manifestHash: string };

export type FileVersionV1 =
  | { kind: 'absent'; parentIdentity: string; name: string }
  | {
      kind: 'regular';
      identity: string;
      sha256: string;
      size: number;
      executable: boolean;
      metadataHash: string;
    };

export type FileChangeV1 =
  | { op: 'put'; path: string; expected: FileVersionV1; contentRef: string }
  | { op: 'remove'; path: string; expected: FileVersionV1 };

export interface WorkspaceCall {
  projectId: string;
  taskId: string;
  workspaceId: string;
  workerId: string;
  actionId: string;
  grantRevision: number;
  writerEpoch: number;
}

const refCommon = [
  'schemaVersion',
  'projectId',
  'taskId',
  'workspaceId',
  'rootId',
  'grantId',
  'purpose',
  'mode',
];
const scopeIds = ['projectId', 'taskId', 'workspaceId'] as const;
const refIds = [...scopeIds, 'rootId', 'grantId'] as const;
const callIds = [...scopeIds, 'workerId', 'actionId'] as const;
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Accept JSON data objects, never invoke getters or inherited discriminants. */
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === 'string' &&
        descriptor?.enumerable === true &&
        Object.hasOwn(descriptor, 'value')
      );
    })
  );
}
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));

function textBytes(value: string): number | undefined {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)) return undefined;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
function segment(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || value.includes('/'))
    return false;
  const size = textBytes(value);
  return size !== undefined && size <= 255;
}
export function isWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const size = textBytes(value);
  return size !== undefined && size <= 4096 && value.split('/').every(segment);
}

export function isWorkspaceRefV1(value: unknown): value is WorkspaceRefV1 {
  if (
    !record(value) ||
    value.schemaVersion !== 'workspace-v1' ||
    !refIds.every((key) => id(value[key])) ||
    !['coding', 'validation', 'integration'].includes(value.purpose as string)
  )
    return false;
  if (value.mode === 'direct')
    return exact(value, [...refCommon, 'baselineManifestId']) && id(value.baselineManifestId);
  return (
    value.mode === 'linked-worktree' &&
    exact(value, [...refCommon, 'commonDirId', 'branch', 'baseCommit']) &&
    id(value.commonDirId) &&
    typeof value.branch === 'string' &&
    value.branch.length <= 128 &&
    isGitSafeBranch(value.branch) &&
    isGitObjectId(value.baseCommit)
  );
}

export function isWorkspaceVersionV1(value: unknown): value is WorkspaceVersionV1 {
  if (!record(value) || !id(value.manifestId) || !hash(value.manifestHash)) return false;
  return value.kind === 'files'
    ? exact(value, ['kind', 'manifestId', 'manifestHash'])
    : value.kind === 'git' &&
        exact(value, ['kind', 'manifestId', 'manifestHash', 'commit']) &&
        isGitObjectId(value.commit);
}

export function isFileVersionV1(value: unknown): value is FileVersionV1 {
  if (!record(value)) return false;
  if (value.kind === 'absent')
    return (
      exact(value, ['kind', 'parentIdentity', 'name']) &&
      id(value.parentIdentity) &&
      segment(value.name)
    );
  return (
    value.kind === 'regular' &&
    exact(value, ['kind', 'identity', 'sha256', 'size', 'executable', 'metadataHash']) &&
    id(value.identity) &&
    hash(value.sha256) &&
    integer(value.size) &&
    typeof value.executable === 'boolean' &&
    hash(value.metadataHash)
  );
}

export function isFileChangeV1(value: unknown): value is FileChangeV1 {
  if (!record(value) || !isWorkspaceRelativePath(value.path) || !isFileVersionV1(value.expected))
    return false;
  if (value.op === 'remove')
    return exact(value, ['op', 'path', 'expected']) && value.expected.kind === 'regular';
  return (
    value.op === 'put' &&
    exact(value, ['op', 'path', 'expected', 'contentRef']) &&
    id(value.contentRef) &&
    (value.expected.kind === 'regular' || value.expected.name === value.path.split('/').at(-1))
  );
}

export function isWorkspaceCall(value: unknown): value is WorkspaceCall {
  return (
    record(value) &&
    exact(value, [...callIds, 'grantRevision', 'writerEpoch']) &&
    callIds.every((key) => id(value[key])) &&
    integer(value.grantRevision) &&
    integer(value.writerEpoch)
  );
}

export function isWorkspaceRefsV1(value: unknown): value is WorkspaceRefV1[] {
  if (
    !Array.isArray(value) ||
    value.length > 4096 ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return false;
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    const ref = descriptor.value;
    if (!isWorkspaceRefV1(ref) || ids.has(ref.workspaceId)) return false;
    ids.add(ref.workspaceId);
  }
  return true;
}

/** Lifecycle changes belong to registry records, never to immutable references. */
export function assertWorkspaceRefsTransition(previous: unknown, next: unknown): void {
  if (!isWorkspaceRefsV1(previous) || !isWorkspaceRefsV1(next))
    throw new Error('invalid_workspace_refs');
  const byId = new Map(next.map((ref) => [ref.workspaceId, ref]));
  for (const ref of previous) {
    const successor = byId.get(ref.workspaceId);
    if (
      !successor ||
      Object.entries(ref).some(([key, value]) => successor[key as keyof WorkspaceRefV1] !== value)
    )
      throw new Error('workspace_identity_changed');
  }
}
