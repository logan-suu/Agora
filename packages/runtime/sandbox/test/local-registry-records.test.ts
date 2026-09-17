import { describe, expect, it } from 'vitest';
import {
  assertLocalRegistryTransition,
  type LocalRootRecord,
  parseLocalRegistry,
} from '../src/local-registry-records';

const root = {
  rootId: 'root',
  projectId: 'project',
  selectionRef: 'selection',
  path: '/fixture',
  volumeId: 'volume',
  dev: '1',
  inode: '2',
  chain: [
    { path: '/', identity: '1:1' },
    { path: '/fixture', identity: '1:2' },
  ],
  staging: { path: '/fixture/.agora-operations', identity: '1:3' },
  inspectionHash: 'a'.repeat(64),
};
const grant = {
  grantId: 'grant',
  projectId: 'project',
  rootId: 'root',
  revision: 0,
  policyVersion: 'policy-v1',
  actions: ['read', 'edit', 'run'],
  toolchainHash: 'b'.repeat(64),
  networkHash: 'c'.repeat(64),
  policyHash: 'd'.repeat(64),
  createdActionId: 'grant-action',
  leaderMessageId: 'leader-grant',
  status: 'active',
  revocationActionId: null,
};
const fixture = () => ({
  schemaVersion: 'local-workspaces-v1',
  revision: 0,
  roots: [{ ...structuredClone(root), staging: null }] as LocalRootRecord[],
  grants: [structuredClone(grant)],
  workspaces: [],
  claims: [],
  operations: [],
});

describe('closed local registry records', () => {
  it('never attaches a source write claim to a validation snapshot', () => {
    const value = {
      ...fixture(),
      revision: 2,
      roots: [root],
      operations: [
        {
          kind: 'root-initialization',
          actionId: 'initialize',
          inputHash: 'e'.repeat(64),
          receiptId: 'initialization-receipt',
          projectId: 'project',
          taskId: 'task',
          rootId: 'root',
          grantId: 'grant',
          grantRevision: 0,
          sourceMessageId: 'leader-grant',
          preparedRevision: 1,
          stage: 'committed',
          nativeReceipt: {
            sha256: 'f'.repeat(64),
            stage: 'applied',
            created: true,
            stagingIdentity: '1:3',
            quiescent: true,
          },
        },
      ],
      workspaces: [
        {
          schemaVersion: 'workspace-v1',
          projectId: 'project',
          taskId: 'task',
          workspaceId: 'workspace',
          rootId: 'root',
          grantId: 'grant',
          purpose: 'coding',
          mode: 'direct',
          baselineManifestId: 'manifest',
        },
      ],
      claims: [
        {
          claimId: 'claim',
          projectId: 'project',
          taskId: 'task',
          workspaceId: 'workspace',
          workerId: 'worker',
          writerEpoch: 1,
          createdActionId: 'claim-action',
          status: 'active',
          closureReceiptId: null,
        },
      ],
    };
    expect(() => parseLocalRegistry(value)).not.toThrow();
    const workspace = value.workspaces[0];
    if (!workspace) throw Error('missing fixture');
    workspace.purpose = 'validation';
    expect(() => parseLocalRegistry(value)).toThrow('invalid_local_registry_records');
  });
  it('preserves valid records without assigning live authority', () => {
    expect(parseLocalRegistry(fixture())).toEqual(fixture());
  });
  it.each(['extra', 'revision', 'schemaVersion'])('rejects invalid envelope %s', (field) => {
    expect(() => parseLocalRegistry({ ...fixture(), [field]: 'invalid' })).toThrow();
  });
  it('rejects cross-project grants and unproven root identities', () => {
    const x = fixture();
    x.grants[0] = { ...grant, projectId: 'other' };
    expect(() => parseLocalRegistry(x)).toThrow();
    const y = fixture();
    y.roots[0] = { ...root, inode: '99' };
    expect(() => parseLocalRegistry(y)).toThrow();
  });
  it('rejects an incomplete parent chain or staging outside its root', () => {
    const x = fixture();
    x.roots[0] = { ...root, path: '/other/fixture' };
    expect(() => parseLocalRegistry(x)).toThrow();
    const y = fixture();
    y.roots[0] = { ...root, staging: { ...root.staging, path: '/outside' } };
    expect(() => parseLocalRegistry(y)).toThrow();
  });
  it('rejects grant expansion, deletion and revoked identity reuse', () => {
    const before = parseLocalRegistry(fixture());
    const expanded = fixture();
    expanded.revision = 1;
    expanded.grants[0]?.actions.push('remove');
    expect(() => assertLocalRegistryTransition(before, parseLocalRegistry(expanded))).toThrow();
    expect(() =>
      assertLocalRegistryTransition(
        before,
        parseLocalRegistry({ ...fixture(), revision: 1, grants: [] }),
      ),
    ).toThrow();
    const revoked = parseLocalRegistry({
      ...fixture(),
      revision: 1,
      grants: [{ ...grant, revision: 1, status: 'revoked', revocationActionId: 'revoke' }],
    });
    expect(() =>
      assertLocalRegistryTransition(revoked, parseLocalRegistry({ ...fixture(), revision: 2 })),
    ).toThrow();
  });
  it('rejects aliased roots even with distinct IDs', () => {
    expect(() =>
      parseLocalRegistry({ ...fixture(), roots: [root, { ...root, rootId: 'alias' }] }),
    ).toThrow();
  });
  it('rejects data accessors before serialization', () => {
    let reads = 0;
    const x = fixture();
    Object.defineProperty(x, 'roots', {
      enumerable: true,
      get: () => {
        reads++;
        return [];
      },
    });
    expect(() => parseLocalRegistry(x)).toThrow();
    expect(reads).toBe(0);
  });
});

describe('root registration before authorized initialization', () => {
  it('accepts an inspected root with no staging capability', () => {
    const records = { ...fixture(), roots: [{ ...root, staging: null }] };
    expect(parseLocalRegistry(records).roots[0]?.staging).toBe(null);
  });
  it('refuses workspace registration against an uninitialized root', () => {
    const records = {
      ...fixture(),
      roots: [{ ...root, staging: null }],
      workspaces: [
        {
          schemaVersion: 'workspace-v1',
          projectId: 'project',
          taskId: 'task',
          workspaceId: 'workspace',
          rootId: 'root',
          grantId: 'grant',
          purpose: 'coding',
          mode: 'direct',
          baselineManifestId: 'manifest',
        },
      ],
    };
    expect(() => parseLocalRegistry(records)).toThrow('invalid_local_registry_records');
  });
  it('does not permit an unproven staging completion in the generic transition', () => {
    const before = { ...fixture(), roots: [{ ...root, staging: null }] };
    expect(() =>
      assertLocalRegistryTransition(before, { ...fixture(), roots: [root], revision: 1 }),
    ).toThrow('invalid_local_registry_records');
  });
});

describe('root initialization evidence transitions', () => {
  const operation = () => ({
    kind: 'root-initialization',
    actionId: 'initialize',
    inputHash: 'e'.repeat(64),
    receiptId: 'initialization-receipt',
    projectId: 'project',
    taskId: 'task',
    rootId: 'root',
    grantId: 'grant',
    grantRevision: 0,
    sourceMessageId: 'leader-grant',
    preparedRevision: 1,
    stage: 'prepared',
    nativeReceipt: null,
  });
  const pending = () => ({
    ...fixture(),
    revision: 1,
    roots: [{ ...root, staging: null }],
    operations: [operation()],
  });
  const completed = () => ({
    ...fixture(),
    roots: [structuredClone(root)],
    revision: 2,
    operations: [
      {
        ...operation(),
        stage: 'committed',
        nativeReceipt: {
          sha256: 'f'.repeat(64),
          stage: 'applied',
          created: true,
          stagingIdentity: '1:3',
          quiescent: true,
        },
      },
    ],
  });
  it('publishes staging exactly once after a prepared initialization receipt', () => {
    expect(() => assertLocalRegistryTransition(pending(), completed())).not.toThrow();
    const changed = completed();
    changed.roots[0] = { ...root, staging: { ...root.staging, identity: '1:4' } };
    expect(() => assertLocalRegistryTransition(completed(), { ...changed, revision: 3 })).toThrow();
  });
  it('rejects a new initialized root without its prior operation', () => {
    expect(() =>
      assertLocalRegistryTransition(
        { ...fixture(), roots: [], grants: [] },
        { ...fixture(), roots: [root], revision: 1 },
      ),
    ).toThrow('invalid_local_registry_records');
  });
  it('rejects mismatched effect identity and incomplete quiescence', () => {
    const value = completed();
    const op = value.operations[0];
    if (!op) throw Error('missing fixture');
    op.nativeReceipt.stagingIdentity = '1:4';
    expect(() => parseLocalRegistry(value)).toThrow();
    op.nativeReceipt.stagingIdentity = '1:3';
    op.nativeReceipt.quiescent = false;
    expect(() => parseLocalRegistry(value)).toThrow();
  });
  it('retains a failed initialization without opening a workspace', () => {
    const value = {
      ...pending(),
      revision: 2,
      operations: [
        {
          ...operation(),
          nativeReceipt: {
            sha256: 'f'.repeat(64),
            stage: 'recoveryRequired',
            created: true,
            stagingIdentity: '1:3',
            quiescent: true,
          },
        },
      ],
    };
    expect(() => assertLocalRegistryTransition(pending(), value)).not.toThrow();
    expect(() => assertLocalRegistryTransition(value, { ...completed(), revision: 3 })).toThrow();
  });
});

it('refuses an initialized root loaded without its initialization receipt', () => {
  expect(() => parseLocalRegistry({ ...fixture(), roots: [root] })).toThrow(
    'invalid_local_registry_records',
  );
});
