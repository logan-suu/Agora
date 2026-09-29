/** Internal preparation of owned worktree roots. Does not publish registry authority. */
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { isGitObjectId, isWorkspaceRefV1, type WorkspaceRefV1 } from '@agora/core-domain';
import {
  assertLocalGitActionKind,
  type LocalGitSession,
  type LocalGitSessionOptions,
  readLocalGitRecord,
  withLocalGitSession,
  writeLocalGitRecord,
} from './local-git-session';
import { readOwnedLocalGitWorktree, verifyOwnedLocalGitWorktree } from './local-git-worktree';
import {
  type LocalLinkedRootRecord,
  type LocalRootRecord,
  localRecordHash,
  parseLocalLinkedRoot,
} from './local-registry-records';
import { initializeLocalRoot, localRootInitializationPolicy } from './local-root-initialization';
import { inspectSelectedLocalRoot } from './local-root-inspection';

type Options = LocalGitSessionOptions & {
  sourceRoot: LocalRootRecord;
  workspace: WorkspaceRefV1;
  creationActionId: string;
  bindingReceiptId: string;
  helpers: { inspector: string; initializer: string };
  journalRoot: string;
};
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function journalChain(path: string) {
  if (!isAbsolute(path) || path === '/' || normalize(path) !== path || realpathSync(path) !== path)
    throw Error('untrusted_runtime_path');
  const chain: { path: string; identity: string; mode: string; uid: string }[] = [];
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (current === path &&
        ((stat.mode & 0o777n) !== 0o700n || stat.uid !== BigInt(process.getuid?.() ?? -1)))
    )
      throw Error('untrusted_runtime_path');
    chain.push({
      path: current,
      identity: `${stat.dev}:${stat.ino}`,
      mode: String(stat.mode),
      uid: String(stat.uid),
    });
    if (current === '/') break;
    if (chain.length >= 128) throw Error('untrusted_runtime_path');
  }
  return chain;
}
function read(path: string): unknown {
  try {
    const chain = journalChain(dirname(path));
    const stamp = () => {
      const stat = lstatSync(path, { bigint: true });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n ||
        stat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (stat.mode & 0o777n) !== 0o400n
      )
        throw Error('local_linked_root_changed');
      return [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeNs, stat.ctimeNs].join(
        ':',
      );
    };
    const before = stamp();
    const bytes = readLocalGitRecord(path);
    if (
      !bytes ||
      before !== stamp() ||
      localRecordHash(chain) !== localRecordHash(journalChain(dirname(path)))
    )
      throw Error('local_linked_root_changed');
    return JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw Error('local_linked_root_changed', { cause });
  }
}
function snapshot(input: Options): Options {
  // Snapshot data before any await; the live authorization callback is retained.
  const { authorize, ...data } = input;
  localRecordHash(data);
  const copy = structuredClone(data);
  if (
    !isWorkspaceRefV1(copy.workspace) ||
    copy.workspace.mode !== 'linked-worktree' ||
    copy.workspace.projectId !== copy.projectId ||
    copy.workspace.taskId !== copy.taskId ||
    copy.workspace.rootId !== copy.sourceRoot.rootId ||
    copy.sourceRoot.projectId !== copy.projectId ||
    copy.sourceRoot.path !== copy.root ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(copy.creationActionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(copy.bindingReceiptId)
  )
    throw Error('invalid_local_linked_root');
  return { ...copy, authorize };
}
async function qualify(request: Options, session: LocalGitSession, expectedHead?: string) {
  const workspace = request.workspace;
  if (workspace.mode !== 'linked-worktree') throw Error('invalid_local_linked_root');
  await session.check();
  const source = inspectSelectedLocalRoot(request.root, request.helpers.inspector);
  if (
    localRecordHash(source) !== request.sourceRoot.inspectionHash ||
    source.volumeId !== request.sourceRoot.volumeId ||
    localRecordHash(source.chain.map(({ path, identity }) => ({ path, identity }))) !==
      localRecordHash(request.sourceRoot.chain) ||
    source.chain.at(-1)?.identity !== `${request.sourceRoot.dev}:${request.sourceRoot.inode}`
  )
    throw Error('root_identity_changed');
  const creation = readOwnedLocalGitWorktree(session, {
    ...request,
    workspaceId: workspace.workspaceId,
    gitHash: request.git.sha256,
  });
  const common = { path: creation.commonDir, identity: creation.commonDirIdentity };
  if (
    workspace.branch !== creation.branch ||
    workspace.baseCommit !== creation.baseCommit ||
    workspace.commonDirId !== `common:${localRecordHash(common)}`
  )
    throw Error('local_linked_root_changed');
  await verifyOwnedLocalGitWorktree(session, creation, expectedHead ?? creation.baseCommit);
  const inspection = inspectSelectedLocalRoot(creation.path, request.helpers.inspector);
  if (
    inspection.volumeId !== source.volumeId ||
    inspection.chain.at(-1)?.identity !== creation.identity
  )
    throw Error('local_linked_root_changed');
  return { creation, inspection, common };
}
function assertPhysical(
  record: LocalLinkedRootRecord,
  expected: Awaited<ReturnType<typeof qualify>>,
) {
  const { creation, inspection, common } = expected;
  const staging = lstatSync(record.staging.path, { bigint: true });
  if (
    record.path !== creation.path ||
    `${record.dev}:${record.inode}` !== creation.identity ||
    record.creation.receiptHash !== localRecordHash(creation) ||
    record.inspectionHash !== localRecordHash(inspection) ||
    localRecordHash(record.chain) !==
      localRecordHash(inspection.chain.map(({ path, identity }) => ({ path, identity }))) ||
    localRecordHash(record.commonDir) !==
      localRecordHash({ id: `common:${localRecordHash(common)}`, ...common }) ||
    record.metadata.path !== creation.metadata ||
    record.metadata.identity !== creation.metadataIdentity ||
    !staging.isDirectory() ||
    staging.isSymbolicLink() ||
    staging.uid !== BigInt(process.getuid?.() ?? -1) ||
    (staging.mode & 0o777n) !== 0o700n ||
    `${staging.dev}:${staging.ino}` !== record.staging.identity
  )
    throw Error('local_linked_root_changed');
}

/** A partially initialized operation remains blocked, even if a directory exists. */
export async function initializeLocalLinkedRoot(input: Options): Promise<LocalLinkedRootRecord> {
  return prepareOrVerify(input);
}

/** Read-only qualification of a registered root at a trusted current HEAD.
 * Missing evidence is never repaired, and this does not grant tool authority. */
export async function verifyLocalLinkedRoot(
  input: Options & { record: LocalLinkedRootRecord; expectedHead: string },
): Promise<LocalLinkedRootRecord> {
  const { record, expectedHead, ...options } = input;
  if (!isGitObjectId(expectedHead)) throw Error('invalid_local_linked_root');
  return prepareOrVerify(options, { record: parseLocalLinkedRoot(record), expectedHead });
}

async function prepareOrVerify(
  input: Options,
  verification?: { record: LocalLinkedRootRecord; expectedHead: string },
): Promise<LocalLinkedRootRecord> {
  const request = snapshot(input);
  return withLocalGitSession(request, async (session) => {
    assertLocalGitActionKind(session, 'linked-root');
    const nativeJournalChain = journalChain(request.journalRoot);
    const assertJournal = () => {
      if (
        localRecordHash(journalChain(request.journalRoot)) !== localRecordHash(nativeJournalChain)
      )
        throw Error('local_linked_root_changed');
    };
    const qualified = await qualify(request, session, verification?.expectedHead);
    const { creation, inspection, common } = qualified;
    const helperHashes = Object.fromEntries(
      Object.entries(request.helpers).map(([name, path]) => {
        const bytes = readLocalGitRecord(path);
        if (!bytes) throw Error('untrusted_runtime_path');
        return [name, { path, sha256: digest(bytes) }];
      }),
    );
    const inputHash = localRecordHash({
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
      sourceRoot: request.sourceRoot,
      workspace: request.workspace,
      creationActionId: request.creationActionId,
      creation,
      bindingReceiptId: request.bindingReceiptId,
      inspection,
      helperHashes,
      journalRoot: request.journalRoot,
      nativeJournalChain,
    });
    const prepared = join(session.privateRoot, `${session.key}.linked-root-prepared.json`);
    const completed = join(session.privateRoot, `${session.key}.linked-root-completed.json`);
    const prior = readLocalGitRecord(prepared, true);
    if (prior) {
      if (localRecordHash(JSON.parse(prior.toString('utf8'))) !== localRecordHash({ inputHash }))
        throw Error('operation_conflict');
      const bytes = readLocalGitRecord(completed, true);
      if (!bytes) throw Error('recovery_required');
      const envelope = JSON.parse(bytes.toString('utf8'));
      const record = parseLocalLinkedRoot(envelope.record);
      if (
        Object.keys(envelope).sort().join(',') !== 'inputHash,record' ||
        envelope.inputHash !== inputHash ||
        (verification !== undefined &&
          localRecordHash(record) !== localRecordHash(verification.record))
      )
        throw Error('local_linked_root_changed');
      assertJournal();
      await verifyRecord(request, session, record, qualified, inputHash);
      assertJournal();
      return record;
    }
    if (verification || readLocalGitRecord(completed, true)) throw Error('recovery_required');
    await session.check();
    assertJournal();
    writeLocalGitRecord(prepared, { inputHash });
    const native = await initializeLocalRoot({
      actionId: `linked-${session.key}`,
      inspection,
      authorityHash: inputHash,
      journalRoot: request.journalRoot,
      helper: request.helpers.initializer,
      authorize: async () => {
        await session.check();
        assertJournal();
        return true;
      },
    });
    if (
      native.stage !== 'applied' ||
      native.created !== true ||
      native.quiescent !== true ||
      !native.stagingIdentity
    )
      throw Error('recovery_required');
    const [dev, inode] = creation.identity.split(':');
    const record = parseLocalLinkedRoot({
      workspaceId: request.workspace.workspaceId,
      projectId: request.projectId,
      taskId: request.taskId,
      rootId: request.sourceRoot.rootId,
      grantId: request.workspace.grantId,
      path: creation.path,
      volumeId: inspection.volumeId,
      dev,
      inode,
      chain: inspection.chain.map(({ path, identity }) => ({ path, identity })),
      staging: { path: join(creation.path, '.agora-operations'), identity: native.stagingIdentity },
      inspectionHash: localRecordHash(inspection),
      commonDir: { id: `common:${localRecordHash(common)}`, ...common },
      metadata: { path: creation.metadata, identity: creation.metadataIdentity },
      creation: { actionId: request.creationActionId, receiptHash: localRecordHash(creation) },
      initialization: { actionId: request.actionId, receiptHash: localRecordHash(native) },
      bindingReceiptId: request.bindingReceiptId,
    });
    assertJournal();
    await verifyRecord(request, session, record, await qualify(request, session), inputHash);
    assertJournal();
    writeLocalGitRecord(completed, { inputHash, record });
    return record;
  });
}

async function verifyRecord(
  request: Options,
  session: LocalGitSession,
  record: LocalLinkedRootRecord,
  qualified: Awaited<ReturnType<typeof qualify>>,
  inputHash: string,
) {
  const nativePath = join(request.journalRoot, `linked-${session.key}`, 'result.json');
  const native = read(nativePath);
  const helperBytes = readLocalGitRecord(request.helpers.initializer);
  if (!helperBytes) throw Error('untrusted_runtime_path');
  const expectedNative = {
    schemaVersion: 'local-root-initialization-v1',
    actionId: `linked-${session.key}`,
    inputHash: localRecordHash({
      actionId: `linked-${session.key}`,
      authorityHash: inputHash,
      inspection: qualified.inspection,
      helperHash: digest(helperBytes),
    }),
    journalPath: join(request.journalRoot, `linked-${session.key}`),
    stage: 'applied',
    reason: 'none',
    created: true,
    stagingIdentity: record.staging.identity,
    quiescent: true,
    nativeExitCode: 0,
  };
  const prepared = read(join(request.journalRoot, `linked-${session.key}`, 'prepared.json'));
  const expectedPrepared = {
    schemaVersion: 'local-root-initialization-v1',
    stage: 'prepared',
    actionId: expectedNative.actionId,
    inputHash: expectedNative.inputHash,
    inspection: qualified.inspection,
    authorityHash: inputHash,
    helperHash: digest(helperBytes),
    policyHash: digest(
      Buffer.from(localRootInitializationPolicy(qualified.inspection, request.helpers.initializer)),
    ),
  };
  if (
    localRecordHash(prepared) !== localRecordHash(expectedPrepared) ||
    record.workspaceId !== request.workspace.workspaceId ||
    record.projectId !== request.projectId ||
    record.taskId !== request.taskId ||
    record.rootId !== request.sourceRoot.rootId ||
    record.grantId !== request.workspace.grantId ||
    record.bindingReceiptId !== request.bindingReceiptId ||
    record.creation.actionId !== request.creationActionId ||
    record.initialization.actionId !== request.actionId ||
    localRecordHash(native) !== record.initialization.receiptHash ||
    localRecordHash(native) !== localRecordHash(expectedNative)
  )
    throw Error('local_linked_root_changed');
  assertPhysical(record, qualified);
  await session.check();
}
