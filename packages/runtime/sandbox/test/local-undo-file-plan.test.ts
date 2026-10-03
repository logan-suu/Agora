// Pure byte/version comparisons use actual buffers, without filesystem or model
// doubles. Native effects, proposal admission and inverse transactions have G5.
import { expect, it } from 'vitest';
import { planLocalUndoFile } from '../src/local-undo-file-plan';
import { localFileVersion } from '../src/local-version-store';

const metadata = `33188:501:20:${'a'.repeat(64)}`;
const file = (content: Buffer | string, identity = '1:10', meta = metadata) => {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    kind: 'regular' as const,
    version: localFileVersion({ identity, metadata: meta, content: bytes }),
    metadata: meta,
    content: bytes,
  };
};
const replaced = (before: Buffer | string, after: Buffer | string) => {
  const b = file(before, '1:1'),
    a = file(after, '1:2');
  return {
    path: 'file.txt',
    effect: true,
    kind: 'replace' as const,
    baselineVersion: b.version,
    baselineMetadata: b.metadata,
    baseline: b.content,
    installedVersion: a.version,
    installedMetadata: a.metadata,
    installed: a.content,
  };
};
it('restores exact bytes while preserving an independent user metadata change and fresh target identity', () => {
  const effect = replaced('original\n', 'agent\n');
  const current = file('agent\n', '1:20', `33261:501:20:${'b'.repeat(64)}`);
  const plan = planLocalUndoFile(effect, current);
  expect(plan).toMatchObject({
    kind: 'candidate',
    operation: 'put',
    expected: current.version,
    metadata: current.metadata,
  });
  if (plan.kind !== 'candidate') throw Error('missing candidate');
  expect(plan.content).toEqual(Buffer.from('original\n'));
});
it('keeps nonoverlapping user content and rejects overlapping or ambiguous edits', () => {
  const effect = replaced('a\nb\nc\n', 'a\nB\nc\n');
  const plan = planLocalUndoFile(effect, file('a\nB\nC\n', '1:30'));
  expect(plan.kind).toBe('candidate');
  if (plan.kind !== 'candidate') throw Error('missing candidate');
  expect(plan.content?.toString()).toBe('a\nb\nC\n');
  expect(planLocalUndoFile(effect, file('a\nuser\nc\n'))).toMatchObject({
    kind: 'conflict',
    reason: 'overlapping_changes',
  });
  expect(planLocalUndoFile(replaced('x\nx\n', 'x\n'), file('y\n'))).toMatchObject({
    kind: 'conflict',
    reason: 'ambiguous_text',
  });
});
it('removes only the original created object and preserves a later same-name object even when bytes match', () => {
  const installed = file('agent\n', '1:2');
  const effect = {
    path: 'created.txt',
    effect: true,
    kind: 'create' as const,
    baselineVersion: { kind: 'absent' as const, parentIdentity: '1:1', name: 'created.txt' },
    baselineMetadata: null,
    baseline: Buffer.alloc(0),
    installedVersion: installed.version,
    installedMetadata: metadata,
    installed: installed.content,
  };
  expect(planLocalUndoFile(effect, installed)).toMatchObject({
    kind: 'candidate',
    operation: 'remove',
    expected: installed.version,
    content: null,
  });
  expect(planLocalUndoFile(effect, file('agent\n', '1:3'))).toMatchObject({
    kind: 'conflict',
    reason: 'created_object_changed',
  });
  expect(planLocalUndoFile(effect, file('user\n', '1:2'))).toMatchObject({
    kind: 'conflict',
    reason: 'created_object_changed',
  });
  expect(
    planLocalUndoFile(effect, { kind: 'absent', version: effect.baselineVersion }),
  ).toMatchObject({ kind: 'candidate', operation: 'none' });
});
it('permits exact binary reversal but never text-merges a changed binary or invalid UTF-8', () => {
  const effect = replaced(Buffer.from([0, 1]), Buffer.from([0, 2]));
  const plan = planLocalUndoFile(effect, file(Buffer.from([0, 2]), '1:5'));
  expect(plan.kind).toBe('candidate');
  if (plan.kind !== 'candidate') throw Error('missing candidate');
  expect(plan.content).toEqual(Buffer.from([0, 1]));
  expect(planLocalUndoFile(effect, file(Buffer.from([0, 3])))).toMatchObject({
    kind: 'conflict',
    reason: 'unsupported_binary',
  });
  expect(
    planLocalUndoFile(replaced(Buffer.from([255]), Buffer.from([254])), file(Buffer.from([253]))),
  ).toMatchObject({ kind: 'conflict', reason: 'unsupported_binary' });
});
it('does not resurrect an externally removed replacement and refuses unknown installation proof', () => {
  const effect = replaced('before', 'after');
  expect(
    planLocalUndoFile(effect, {
      kind: 'absent',
      version: { kind: 'absent', parentIdentity: '1:1', name: 'file.txt' },
    }),
  ).toMatchObject({ kind: 'conflict', reason: 'target_removed' });
  expect(() => planLocalUndoFile({ ...effect, installedVersion: null }, file('after'))).toThrow(
    'undo_effect_unverified',
  );
  expect(() =>
    planLocalUndoFile(effect, { ...file('after'), content: Buffer.from('forged') }),
  ).toThrow('undo_source_invalid');
});

it('restores only original executable-bit changes while preserving user mode and ACL changes', () => {
  const b = file('original\n', '1:1', metadata),
    a = file('agent\n', '1:2', `33261:501:20:${'a'.repeat(64)}`);
  const effect = {
    ...replaced('original\n', 'agent\n'),
    installedVersion: a.version,
    installedMetadata: a.metadata,
  };
  const user = file('agent\n', '1:3', `33277:501:20:${'b'.repeat(64)}`);
  const result = planLocalUndoFile(effect, user);
  expect(result).toMatchObject({
    kind: 'candidate',
    operation: 'put',
    mode: 0o664,
    metadata: `33204:501:20:${'b'.repeat(64)}`,
  });
  if (result.kind !== 'candidate') throw Error('missing inverse');
  expect(result.content).toEqual(b.content);
  const sameBytes = planLocalUndoFile(effect, file('original\n', '1:3', a.metadata));
  expect(sameBytes).toMatchObject({ kind: 'candidate', operation: 'put', mode: 0o644 });
});
it('refuses original ownership, ACL or non-executable mode effects without a proved restoration primitive', () => {
  const effect = replaced('b', 'a');
  const a = file('a', '1:2', `33188:501:20:${'b'.repeat(64)}`);
  expect(
    planLocalUndoFile({ ...effect, installedVersion: a.version, installedMetadata: a.metadata }, a),
  ).toMatchObject({ kind: 'conflict', reason: 'metadata_changed' });
  const changedMode = file('a', '1:2', `33204:501:20:${'a'.repeat(64)}`);
  expect(
    planLocalUndoFile(
      { ...effect, installedVersion: changedMode.version, installedMetadata: changedMode.metadata },
      changedMode,
    ),
  ).toMatchObject({ kind: 'conflict', reason: 'metadata_changed' });
});
