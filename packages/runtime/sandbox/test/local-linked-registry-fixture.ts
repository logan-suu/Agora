import { localRecordHash } from '../src/local-registry-records';

export function linkedPhysicalFixture(path: string, inode: string) {
  return {
    path,
    volumeId: 'volume',
    dev: '1',
    inode,
    chain: [
      { path: '/', identity: '1:1' },
      { path, identity: `1:${inode}` },
    ],
    staging: { path: `${path}/.agora-operations`, identity: `1:${Number(inode) + 1}` },
    inspectionHash: 'a'.repeat(64),
  };
}
export function linkedRegistryFixture() {
  const common = { path: '/source/.git', identity: '1:4' };
  const commonDir = { id: `common:${localRecordHash(common)}`, ...common };
  const workspaces = ['initial', 'one', 'two', 'tester'].map((name, i) => ({
    schemaVersion: 'workspace-v1',
    projectId: 'project',
    taskId: 'task',
    workspaceId: name,
    rootId: 'source',
    grantId: 'grant',
    purpose: i === 0 ? 'integration' : i === 3 ? 'validation' : 'coding',
    mode: 'linked-worktree',
    commonDirId: commonDir.id,
    branch: `agora-${name}`,
    baseCommit: 'b'.repeat(40),
  }));
  const linkedRoots = workspaces.map((w, i) => ({
    workspaceId: w.workspaceId,
    projectId: w.projectId,
    taskId: w.taskId,
    rootId: w.rootId,
    grantId: w.grantId,
    ...linkedPhysicalFixture(`/${w.workspaceId}`, String(10 + i * 10)),
    commonDir,
    metadata: { path: `/source/.git/worktrees/${w.workspaceId}`, identity: `1:${50 + i}` },
    creation: { actionId: `create-${w.workspaceId}`, receiptHash: 'c'.repeat(64) },
    initialization: { actionId: `init-${w.workspaceId}`, receiptHash: 'd'.repeat(64) },
    bindingReceiptId: 'binding:register',
  }));
  return {
    schemaVersion: 'local-workspaces-v1',
    revision: 4,
    roots: [
      {
        rootId: 'source',
        projectId: 'project',
        selectionRef: 'selection',
        ...linkedPhysicalFixture('/source', '2'),
      },
    ],
    grants: [
      {
        grantId: 'grant',
        projectId: 'project',
        rootId: 'source',
        revision: 0,
        policyVersion: 'policy',
        actions: ['read', 'edit', 'run'],
        toolchainHash: 'e'.repeat(64),
        networkHash: 'f'.repeat(64),
        policyHash: 'a'.repeat(64),
        createdActionId: 'grant-action',
        leaderMessageId: 'leader-grant',
        status: 'active',
        revocationActionId: null,
      },
    ],
    workspaces,
    linkedRoots,
    claims: workspaces
      .filter((w) => w.purpose !== 'integration')
      .map((w, i) => ({
        claimId: `claim-${w.workspaceId}`,
        projectId: 'project',
        taskId: 'task',
        workspaceId: w.workspaceId,
        workerId: `worker-${w.workspaceId}`,
        writerEpoch: i + 1,
        createdActionId: 'register',
        status: 'active',
        closureReceiptId: null,
      })),
    operations: [
      {
        kind: 'root-initialization',
        actionId: 'initialize',
        inputHash: 'e'.repeat(64),
        receiptId: 'initialization',
        projectId: 'project',
        taskId: 'task',
        rootId: 'source',
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
      {
        actionId: 'register',
        inputHash: 'a'.repeat(64),
        receiptId: 'binding:register',
        projectId: 'project',
        taskId: 'task',
        preparedRevision: 3,
        stage: 'committed',
        previousLocalHash: 'd'.repeat(64),
        sourceMessageId: 'leader-grant',
        nextLocalExecution: {
          schemaVersion: 'local-execution-v1',
          rootIds: ['source'],
          workspaces,
          bindings: workspaces
            .filter((w) => w.purpose !== 'integration')
            .map((w) => ({
              workerId: `worker-${w.workspaceId}`,
              workspaceId: w.workspaceId,
              receiptId: 'binding:register',
            })),
          receipts: [
            {
              actionId: 'register',
              inputHash: 'a'.repeat(64),
              receiptId: 'binding:register',
              registryRevision: 3,
            },
          ],
          git: {
            version: 1,
            initialWorkspaceId: 'initial',
            worktrees: linkedRoots.map((w) => ({
              workspaceId: w.workspaceId,
              path: w.path,
              receiptId: w.bindingReceiptId,
            })),
          },
        },
      },
    ],
  };
}
