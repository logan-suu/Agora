/** Pure inverse candidate comparison. Actual-effect and current-root proofs are
 * supplied by the trusted service; a candidate grants no write authority. */
import { type FileVersionV1, isFileVersionV1, isWorkspaceRelativePath } from '@agora/core-domain';
import { localRecordHash } from './local-registry-records';
import { isLocalReservedName } from './local-reserved-path';
import { mergeLocalUndoText } from './local-undo-text';
import { localFileVersion } from './local-version-store';

type Regular = Extract<FileVersionV1, { kind: 'regular' }>;
export type LocalUndoFileEffect = {
  path: string;
  effect: boolean;
  kind: 'create' | 'replace';
  baselineVersion: FileVersionV1;
  baselineMetadata: string | null;
  baseline: Buffer;
  installedVersion: FileVersionV1 | null;
  installedMetadata: string | null;
  installed: Buffer;
};
export type LocalUndoCurrentFile =
  | { kind: 'regular'; version: Regular; metadata: string; content: Buffer }
  | { kind: 'absent'; version: Extract<FileVersionV1, { kind: 'absent' }> };
export type LocalUndoFilePlan =
  | {
      kind: 'candidate';
      path: string;
      operation: 'put' | 'remove' | 'none';
      expected: FileVersionV1;
      metadata: string | null;
      content: Buffer | null;
      mode?: number;
    }
  | {
      kind: 'conflict';
      path: string;
      reason:
        | 'created_object_changed'
        | 'target_removed'
        | 'unsupported_binary'
        | 'metadata_changed'
        | 'ambiguous_text'
        | 'overlapping_changes'
        | 'unsupported_text'
        | 'comparison_limit';
    };
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
function regular(version: unknown, metadata: unknown, content: unknown): version is Regular {
  if (
    !isFileVersionV1(version) ||
    version.kind !== 'regular' ||
    typeof metadata !== 'string' ||
    !Buffer.isBuffer(content) ||
    content.length > 16 * 1024 * 1024
  )
    return false;
  if (!/^[0-9]+:[0-9]+:[0-9]+:[a-f0-9]{64}$/.test(metadata)) return false;
  return same(version, localFileVersion({ identity: version.identity, metadata, content }));
}
function text(bytes: Buffer): string | undefined {
  const value = bytes.toString('utf8');
  return !value.includes('\0') && Buffer.from(value, 'utf8').equals(bytes) ? value : undefined;
}
export function planLocalUndoFile(
  effect: LocalUndoFileEffect,
  current: LocalUndoCurrentFile,
): LocalUndoFilePlan {
  if (
    !isWorkspaceRelativePath(effect.path) ||
    effect.path.split('/').some(isLocalReservedName) ||
    typeof effect.effect !== 'boolean' ||
    !['create', 'replace'].includes(effect.kind) ||
    !isFileVersionV1(effect.baselineVersion) ||
    !Buffer.isBuffer(effect.baseline) ||
    !Buffer.isBuffer(effect.installed)
  )
    throw Error('undo_source_invalid');
  if (
    effect.kind === 'create'
      ? effect.baselineVersion.kind !== 'absent' ||
        effect.baselineMetadata !== null ||
        effect.baseline.length !== 0
      : !regular(effect.baselineVersion, effect.baselineMetadata, effect.baseline)
  )
    throw Error('undo_source_invalid');
  if (
    current.kind === 'regular'
      ? !regular(current.version, current.metadata, current.content)
      : current.kind !== 'absent' ||
        !isFileVersionV1(current.version) ||
        current.version.kind !== 'absent'
  )
    throw Error('undo_source_invalid');
  const name = effect.path.split('/').at(-1);
  if (
    (effect.baselineVersion.kind === 'absent' && effect.baselineVersion.name !== name) ||
    (current.kind === 'absent' && current.version.name !== name)
  )
    throw Error('undo_source_invalid');
  let inverseMode: number | undefined;
  let inverseMetadata = current.kind === 'regular' ? current.metadata : null;
  const candidate = (
    operation: 'put' | 'remove' | 'none',
    content: Buffer | null = null,
  ): LocalUndoFilePlan => ({
    kind: 'candidate',
    path: effect.path,
    operation,
    expected: structuredClone(current.version),
    metadata: inverseMetadata,
    ...(inverseMode === undefined ? {} : { mode: inverseMode }),
    content: content === null ? null : Buffer.from(content),
  });
  const conflict = (
    reason: Extract<LocalUndoFilePlan, { kind: 'conflict' }>['reason'],
  ): LocalUndoFilePlan => ({ kind: 'conflict', path: effect.path, reason });
  if (!effect.effect) return candidate('none');
  if (!regular(effect.installedVersion, effect.installedMetadata, effect.installed))
    throw Error('undo_effect_unverified');
  if (effect.kind === 'create') {
    if (current.kind === 'absent') return candidate('none');
    if (
      !same(effect.installedVersion, current.version) ||
      effect.installedMetadata !== current.metadata ||
      !effect.installed.equals(current.content)
    )
      return conflict('created_object_changed');
    return candidate('remove');
  }
  if (current.kind === 'absent') return conflict('target_removed');
  const bMeta = (effect.baselineMetadata as string).split(':'),
    aMeta = (effect.installedMetadata as string).split(':'),
    uMeta = current.metadata.split(':');
  const bMode = Number(bMeta[0]),
    aMode = Number(aMeta[0]),
    uMode = Number(uMeta[0]);
  if (bMeta.slice(1).join(':') !== aMeta.slice(1).join(':') || ((bMode ^ aMode) & ~0o111) !== 0)
    return conflict('metadata_changed');
  const changed = (bMode ^ aMode) & 0o111;
  const mode = (uMode & ~changed) | (bMode & changed);
  if (mode !== uMode) {
    inverseMode = mode & 0o777;
    inverseMetadata = [mode, ...uMeta.slice(1)].join(':');
  }
  if (current.content.equals(effect.baseline))
    return inverseMode === undefined ? candidate('none') : candidate('put', effect.baseline);
  if (current.content.equals(effect.installed)) return candidate('put', effect.baseline);
  const before = text(effect.baseline),
    installed = text(effect.installed),
    user = text(current.content);
  if (before === undefined || installed === undefined || user === undefined)
    return conflict('unsupported_binary');
  const merged = mergeLocalUndoText(installed, before, user);
  if (merged.kind === 'conflict') return conflict(merged.reason);
  const content = Buffer.from(merged.content, 'utf8');
  return content.equals(current.content) && inverseMode === undefined
    ? candidate('none')
    : candidate('put', content);
}
