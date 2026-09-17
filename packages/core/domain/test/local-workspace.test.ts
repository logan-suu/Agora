import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceRefsTransition,
  isFileChangeV1,
  isFileVersionV1,
  isWorkspaceCall,
  isWorkspaceRefsV1,
  isWorkspaceRefV1,
  isWorkspaceVersionV1,
} from '../src/local-workspace';

const direct = {
  schemaVersion: 'workspace-v1',
  projectId: 'project',
  taskId: 'task',
  workspaceId: 'workspace',
  rootId: 'root',
  grantId: 'grant',
  purpose: 'coding',
  mode: 'direct',
  baselineManifestId: 'manifest',
};
const linked = {
  schemaVersion: 'workspace-v1',
  projectId: 'project',
  taskId: 'task',
  workspaceId: 'linked',
  rootId: 'root',
  grantId: 'grant',
  purpose: 'validation',
  mode: 'linked-worktree',
  commonDirId: 'common',
  branch: 'agora-worker',
  baseCommit: 'a'.repeat(40),
};
const regular = {
  kind: 'regular',
  identity: '1:23',
  sha256: 'a'.repeat(64),
  size: 0,
  executable: false,
  metadataHash: 'b'.repeat(64),
};
const absent = { kind: 'absent', parentIdentity: '1:22', name: '文件 name.ts' };
const put = { op: 'put', path: 'src/文件 name.ts', expected: absent, contentRef: 'content' };
const call = {
  projectId: 'project',
  taskId: 'task',
  workspaceId: 'workspace',
  workerId: 'worker',
  actionId: 'action',
  grantRevision: 0,
  writerEpoch: 0,
};

describe('strict local workspace data boundaries', () => {
  it('accepts the specified direct and linked-worktree variants without conversion', () => {
    expect(isWorkspaceRefV1(direct)).toBe(true);
    expect(isWorkspaceRefV1(linked)).toBe(true);
    expect(isWorkspaceRefV1({ ...linked, baseCommit: 'f'.repeat(64) })).toBe(true);
    expect(isWorkspaceRefsV1([direct, linked])).toBe(true);
  });

  it.each([
    null,
    [],
    { ...direct, schemaVersion: 'workspace-v2' },
    { ...direct, mode: 'docker' },
    { ...direct, branch: 'fake' },
    { ...linked, baselineManifestId: 'fake' },
    { ...direct, projectId: '' },
    { ...direct, taskId: '../task' },
    { ...direct, rootId: 'r'.repeat(129) },
    { ...direct, grantId: ' grant' },
    { ...direct, purpose: 'leader-control' },
    { ...linked, branch: '-option' },
    { ...linked, branch: 'bad..name' },
    { ...linked, baseCommit: 'G'.repeat(40) },
    { ...direct, path: '/user/project' },
    { ...direct, baselineManifestId: undefined },
    Object.create(direct),
    { ...direct, [Symbol('hidden')]: true },
  ])('rejects invalid or mixed workspace records %#', (value) => {
    expect(isWorkspaceRefV1(value)).toBe(false);
  });

  it('rejects non-JSON accessors without invoking them', () => {
    let reads = 0;
    const value = { ...direct };
    Object.defineProperty(value, 'rootId', {
      get: () => {
        reads++;
        return 'root';
      },
    });
    expect(isWorkspaceRefV1(value)).toBe(false);
    expect(reads).toBe(0);
  });

  it('rejects collection accessors and hidden properties without reading them', () => {
    let reads = 0;
    const refs = [direct];
    Object.defineProperty(refs, '0', {
      get: () => {
        reads++;
        return direct;
      },
    });
    expect(isWorkspaceRefsV1(refs)).toBe(false);
    expect(reads).toBe(0);
    expect(isWorkspaceRefsV1(Object.assign([direct], { extra: true }))).toBe(false);
  });

  it('requires every field and rejects extra keys in each closed variant', () => {
    const examples: [Record<string, unknown>, (value: unknown) => boolean][] = [
      [direct, isWorkspaceRefV1],
      [linked, isWorkspaceRefV1],
      [regular, isFileVersionV1],
      [absent, isFileVersionV1],
      [put, isFileChangeV1],
      [call, isWorkspaceCall],
      [
        {
          kind: 'git',
          manifestId: 'manifest',
          manifestHash: 'a'.repeat(64),
          commit: 'b'.repeat(40),
        },
        isWorkspaceVersionV1,
      ],
    ];
    for (const [value, validate] of examples) {
      expect(validate({ ...value, unexpected: true })).toBe(false);
      for (const field of Object.keys(value)) {
        const missing = { ...value };
        delete missing[field];
        expect(validate(missing), field).toBe(false);
      }
    }
  });

  it('requires unique IDs even across project and task scopes', () => {
    expect(isWorkspaceRefsV1([direct, { ...direct, taskId: 'another' }])).toBe(false);
    expect(isWorkspaceRefsV1(new Array(1))).toBe(false);
    expect(
      isWorkspaceRefsV1(
        Array.from({ length: 4097 }, (_, n) => ({ ...direct, workspaceId: `w${n}` })),
      ),
    ).toBe(false);
  });

  it('allows reordering and additions but rejects removal and every identity-field rewrite', () => {
    expect(() => assertWorkspaceRefsTransition([direct], [linked, { ...direct }])).not.toThrow();
    expect(() => assertWorkspaceRefsTransition([direct], [])).toThrow('workspace_identity_changed');
    for (const [key, value] of Object.entries(direct)) {
      const changed = { ...direct, [key]: `${value}-changed` };
      expect(() => assertWorkspaceRefsTransition([direct], [changed]), key).toThrow();
    }
    expect(() =>
      assertWorkspaceRefsTransition([direct], [{ ...linked, workspaceId: direct.workspaceId }]),
    ).toThrow('workspace_identity_changed');
    expect(() => assertWorkspaceRefsTransition([direct, direct], [direct])).toThrow();
    expect(() =>
      assertWorkspaceRefsTransition([linked], [{ ...linked, baseCommit: 'b'.repeat(40) }]),
    ).toThrow('workspace_identity_changed');
  });

  it('separates file and git workspace versions with exact hashes and fields', () => {
    const files = { kind: 'files', manifestId: 'manifest', manifestHash: 'b'.repeat(64) };
    expect(isWorkspaceVersionV1(files)).toBe(true);
    expect(isWorkspaceVersionV1({ ...files, kind: 'git', commit: 'c'.repeat(40) })).toBe(true);
    expect(isWorkspaceVersionV1({ ...files, kind: 'git' })).toBe(false);
    expect(isWorkspaceVersionV1({ ...files, commit: 'c'.repeat(40) })).toBe(false);
    expect(isWorkspaceVersionV1({ ...files, manifestHash: 'B'.repeat(64) })).toBe(false);
  });

  it('validates complete file versions, exact sizes and metadata', () => {
    expect(isFileVersionV1(regular)).toBe(true);
    expect(isFileVersionV1(absent)).toBe(true);
    for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'])
      expect(isFileVersionV1({ ...regular, size })).toBe(false);
    expect(isFileVersionV1({ ...regular, metadataHash: undefined })).toBe(false);
    expect(isFileVersionV1({ ...absent, name: '../file' })).toBe(false);
    expect(isFileVersionV1({ ...absent, sha256: 'a'.repeat(64) })).toBe(false);
  });

  it('requires an exact absence name for creation and an existing version for removal', () => {
    expect(isFileChangeV1(put)).toBe(true);
    expect(isFileChangeV1({ ...put, expected: regular })).toBe(true);
    expect(isFileChangeV1({ ...put, expected: { ...absent, name: 'different' } })).toBe(false);
    expect(isFileChangeV1({ op: 'remove', path: put.path, expected: absent })).toBe(false);
    expect(isFileChangeV1({ op: 'remove', path: put.path, expected: regular })).toBe(true);
    expect(isFileChangeV1({ ...put, op: 'remove', expected: regular })).toBe(false);
  });

  it.each([
    '',
    '/absolute',
    '../file',
    'src/../file',
    'src//file',
    'src/./file',
    'file/',
    'file\u0000',
    'file\n',
    '\ud800',
    'a'.repeat(256),
    '界'.repeat(86),
    Array(18).fill('a'.repeat(240)).join('/'),
  ])('rejects noncanonical or oversized relative paths %#', (path) => {
    expect(isFileChangeV1({ ...put, path, expected: regular })).toBe(false);
  });

  it('preserves valid names and treats shape checks as distinct from permissions', () => {
    for (const path of [
      'src/文件 name.ts',
      '.env.example',
      'a'.repeat(255),
      '界'.repeat(85),
      'a\\b',
    ])
      expect(isFileChangeV1({ ...put, path, expected: regular }), path).toBe(true);
  });

  it('validates worker-call shape without manufacturing transport authority', () => {
    expect(isWorkspaceCall(call)).toBe(true);
    expect(isWorkspaceCall({ ...call, writerEpoch: Number.MAX_SAFE_INTEGER })).toBe(true);
    for (const number of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
      expect(isWorkspaceCall({ ...call, writerEpoch: number })).toBe(false);
      expect(isWorkspaceCall({ ...call, grantRevision: number })).toBe(false);
    }
    expect(isWorkspaceCall({ ...call, authority: 'leader' })).toBe(false);
    expect(isWorkspaceCall({ ...call, workerId: undefined })).toBe(false);
  });
});
