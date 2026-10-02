/** Read-only actual native file effects. No source path is opened, replayed or
 * repaired; missing evidence never grants inverse-write authority. */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileVersionV1 } from '@agora/core-domain';
import type {
  LocalCreationReceipt,
  LocalReplacementReceipt,
  LocalRestorationSource,
} from './local-file-transaction';
import { localRecordHash } from './local-registry-records';
import { localFileVersion } from './local-version-store';

type Request = {
  native: LocalCreationReceipt | LocalReplacementReceipt;
  journalRoot: string;
  bindingHash: string;
  path: string;
  expected: FileVersionV1;
  baselineMetadata: string | null;
  baseline: Buffer;
  candidate: Buffer;
  executable?: boolean;
  mode?: number;
  restoreFrom?: LocalRestorationSource;
  assertPrivateRoot(): Promise<void>;
};
const digest = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const exact = (v: unknown, keys: string): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function fail(): never {
  throw Error('native_file_effect_unverified');
}
async function sealed(path: string, max = 16 * 1024 * 1024): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat({ bigint: true });
    if (
      !st.isFile() ||
      st.nlink !== 1n ||
      st.uid !== BigInt(process.getuid?.() ?? -1) ||
      (st.mode & 0o777n) !== 0o400n ||
      st.size > BigInt(max)
    )
      fail();
    const bytes = Buffer.alloc(Number(st.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const got = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (!got.bytesRead) break;
      offset += got.bytesRead;
    }
    const after = await fd.stat({ bigint: true }),
      current = await lstat(path, { bigint: true });
    if (
      offset !== Number(st.size) ||
      current.isSymbolicLink() ||
      st.dev !== current.dev ||
      st.ino !== current.ino ||
      ['dev', 'ino', 'size', 'mode', 'nlink', 'uid', 'mtimeNs', 'ctimeNs'].some(
        (k) =>
          (st as unknown as Record<string, bigint>)[k] !==
          (after as unknown as Record<string, bigint>)[k],
      )
    )
      fail();
    return bytes.subarray(0, offset);
  } finally {
    await fd.close();
  }
}
async function optional(path: string) {
  try {
    return JSON.parse((await sealed(path, 16_384)).toString('utf8')) as unknown;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}
export async function readNativeInstalledFile(input: Request): Promise<{
  schemaVersion: 'local-native-file-effect-v1';
  effect: boolean;
  installedVersion: FileVersionV1 | null;
  installedMetadata: string | null;
  candidateProofHash: string | null;
  outcomeHash: string | null;
}> {
  const request = {
    ...input,
    native: structuredClone(input.native),
    expected: structuredClone(input.expected),
    baseline: Buffer.from(input.baseline),
    candidate: Buffer.from(input.candidate),
  };
  const { native, expected } = request;
  await request.assertPrivateRoot();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(native.actionId) ||
    native.journalPath !== join(request.journalRoot, native.actionId) ||
    !native.quiescent
  )
    fail();
  const dir = native.journalPath,
    directory = await lstat(dir, { bigint: true });
  if (
    (await realpath(dir)) !== dir ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== BigInt(process.getuid?.() ?? -1) ||
    (directory.mode & 0o777n) !== 0o700n
  )
    fail();
  const [rawPrepared, rawResult, baseline, candidate, candidateProof, outcome] = await Promise.all([
    sealed(join(dir, 'prepared.json'), 16_384),
    sealed(join(dir, 'result.json'), 16_384),
    sealed(join(dir, 'expected')),
    sealed(join(dir, 'replacement')),
    optional(join(dir, 'candidate-proof.json')),
    optional(join(dir, 'native-outcome.json')),
  ]);
  const prepared = JSON.parse(rawPrepared.toString('utf8')) as Record<string, unknown>;
  const creating = 'created' in native,
    effect = creating ? native.created : native.exchanged;
  if (
    typeof effect !== 'boolean' ||
    creating !== (expected.kind === 'absent') ||
    native.schemaVersion !==
      (creating ? 'local-creation-primitive-v1' : 'local-replacement-primitive-v1') ||
    localRecordHash(JSON.parse(rawResult.toString('utf8'))) !== localRecordHash(native) ||
    !exact(
      prepared,
      (creating
        ? 'actionId,binding,candidateName,expectedHash,helperHash,inputHash,parentIdentity,parents,path,policyHash,replacementHash,schemaVersion,stage'
        : 'actionId,binding,candidateName,expectedHash,expectedIdentity,expectedMetadata,helperHash,inputHash,parents,path,policyHash,replacementHash,schemaVersion,stage'
      )
        .split(',')
        .concat(
          request.executable === undefined ? [] : ['executable'],
          request.mode === undefined ? [] : ['mode'],
          request.restoreFrom === undefined ? [] : ['restoreFrom'],
        )
        .sort()
        .join(','),
    ) ||
    prepared.schemaVersion !== native.schemaVersion ||
    prepared.stage !== 'prepared' ||
    prepared.actionId !== native.actionId ||
    prepared.inputHash !== native.inputHash ||
    prepared.path !== request.path ||
    localRecordHash(prepared.restoreFrom ?? null) !==
      localRecordHash(request.restoreFrom ?? null) ||
    prepared.mode !== request.mode ||
    (request.mode !== undefined &&
      (!Number.isSafeInteger(request.mode) ||
        request.mode < 0 ||
        request.mode > 0o777 ||
        request.executable !== undefined)) ||
    prepared.executable !== request.executable ||
    (request.executable !== undefined && typeof request.executable !== 'boolean') ||
    prepared.candidateName !== native.candidateName ||
    native.candidateName !== `${native.actionId}-candidate` ||
    localRecordHash(prepared.binding) !== request.bindingHash ||
    !hash(prepared.helperHash) ||
    !hash(prepared.policyHash) ||
    !baseline.equals(request.baseline) ||
    !candidate.equals(request.candidate) ||
    prepared.expectedHash !== digest(baseline) ||
    prepared.replacementHash !== digest(candidate) ||
    !Array.isArray(prepared.parents)
  )
    fail();
  if (
    creating
      ? prepared.parentIdentity !== (expected.kind === 'absent' ? expected.parentIdentity : '') ||
        baseline.length !== 0 ||
        request.baselineMetadata !== null
      : expected.kind !== 'regular' ||
        prepared.expectedIdentity !== expected.identity ||
        prepared.expectedMetadata !== request.baselineMetadata ||
        digest(baseline) !== expected.sha256 ||
        baseline.length !== expected.size
  )
    fail();
  const original = {
    actionId: native.actionId,
    binding: prepared.binding,
    parents: prepared.parents,
    path: prepared.path,
    expected: {
      identity: creating ? prepared.parentIdentity : prepared.expectedIdentity,
      metadata: creating ? '' : prepared.expectedMetadata,
      content: creating ? '' : baseline,
    },
    content: candidate,
    helperHash: prepared.helperHash,
    ...(creating ? { operation: 'create' } : {}),
    ...(request.executable === undefined ? {} : { executable: request.executable }),
    ...(request.mode === undefined ? {} : { mode: request.mode }),
    ...(request.restoreFrom === undefined ? {} : { restoreFrom: request.restoreFrom }),
  };
  if (digest(JSON.stringify(original)) !== native.inputHash) fail();
  if (candidateProof !== undefined) {
    if (
      !exact(
        candidateProof,
        'actionId,contentHash,helperHash,identity,inputHash,metadata,operation,path,schemaVersion,size',
      ) ||
      candidateProof.schemaVersion !== 'local-file-candidate-proof-v1' ||
      candidateProof.actionId !== native.actionId ||
      candidateProof.inputHash !== native.inputHash ||
      candidateProof.helperHash !== prepared.helperHash ||
      candidateProof.path !== request.path ||
      candidateProof.operation !== (creating ? 'create' : 'replace') ||
      typeof candidateProof.identity !== 'string' ||
      !/^\d+:\d+$/.test(candidateProof.identity) ||
      typeof candidateProof.metadata !== 'string' ||
      !/^\d+:\d+:\d+:[a-f0-9]{64}$/.test(candidateProof.metadata) ||
      candidateProof.contentHash !== digest(candidate) ||
      candidateProof.size !== candidate.length
    )
      fail();
  }
  if (outcome !== undefined) {
    if (
      !exact(
        outcome,
        'actionId,candidateProofHash,checkpointCount,closed,exitCode,helperHash,inputHash,preparedHash,protocolFailed,result,schemaVersion,signal',
      ) ||
      outcome.schemaVersion !== 'local-file-native-outcome-v1' ||
      outcome.preparedHash !== digest(rawPrepared) ||
      outcome.candidateProofHash !==
        (candidateProof ? digest(JSON.stringify(candidateProof)) : null) ||
      outcome.actionId !== native.actionId ||
      outcome.inputHash !== native.inputHash ||
      outcome.helperHash !== prepared.helperHash ||
      outcome.closed !== true ||
      !Number.isSafeInteger(outcome.checkpointCount) ||
      (outcome.checkpointCount as number) < 0 ||
      (outcome.checkpointCount as number) > 3 ||
      typeof outcome.protocolFailed !== 'boolean' ||
      outcome.exitCode !== native.nativeExitCode ||
      (outcome.signal !== null && typeof outcome.signal !== 'string')
    )
      fail();
    const key = creating ? 'created' : 'exchanged';
    if (
      !exact(outcome.result, `reason,${key},stage`.split(',').sort().join(',')) ||
      outcome.result[key] !== effect ||
      !['applied', 'conflict', 'recoveryRequired'].includes(outcome.result.stage as string) ||
      typeof outcome.result.reason !== 'string' ||
      !/^[a-z_]{1,128}$/.test(outcome.result.reason)
    )
      fail();
  }
  // New interrupted proofs never masquerade as historical records. Legacy
  // journals can prove an effect but cannot qualify an installed object for undo.
  if (effect && (candidateProof === undefined) !== (outcome === undefined)) fail();
  const installed =
    effect &&
    candidateProof &&
    outcome &&
    !outcome.protocolFailed &&
    outcome.exitCode === 0 &&
    outcome.signal === null &&
    outcome.checkpointCount === 3 &&
    (outcome.result as Record<string, unknown>).stage === 'applied' &&
    (outcome.result as Record<string, unknown>).reason === 'none'
      ? localFileVersion({
          identity: (candidateProof as Record<string, string>).identity as string,
          metadata: (candidateProof as Record<string, string>).metadata as string,
          content: candidate,
        })
      : null;
  await request.assertPrivateRoot();
  const final = await lstat(dir, { bigint: true });
  if (
    (await realpath(dir)) !== dir ||
    final.dev !== directory.dev ||
    final.ino !== directory.ino ||
    final.uid !== directory.uid ||
    final.mode !== directory.mode
  )
    fail();
  return {
    schemaVersion: 'local-native-file-effect-v1',
    effect,
    installedVersion: installed,
    installedMetadata: installed
      ? ((candidateProof as Record<string, string>).metadata as string)
      : null,
    candidateProofHash: candidateProof ? localRecordHash(candidateProof) : null,
    outcomeHash: outcome ? localRecordHash(outcome) : null,
  };
}
