import { expect, it } from 'vitest';
import { mergeLocalUndoText } from '../src/local-undo-text';

it('restores the original only when the installed text is still current', () => {
  expect(
    mergeLocalUndoText('one\nagent\nthree\n', 'one\noriginal\nthree\n', 'one\nagent\nthree\n'),
  ).toEqual({ kind: 'merged', content: 'one\noriginal\nthree\n' });
});
it('preserves a nonoverlapping user edit while reversing only the original agent change', () => {
  expect(
    mergeLocalUndoText(
      'one\nagent\nthree\nfour\n',
      'one\noriginal\nthree\nfour\n',
      'one\nagent\nthree\nuser\n',
    ),
  ).toEqual({ kind: 'merged', content: 'one\noriginal\nthree\nuser\n' });
});
it('preserves original newline bytes and a final line without newline', () => {
  expect(
    mergeLocalUndoText(
      'first\r\nagent\r\nthird\r\nlast',
      'first\r\nbase\r\nthird\r\nlast',
      'FIRST\r\nagent\r\nthird\r\nlast',
    ),
  ).toEqual({ kind: 'merged', content: 'FIRST\r\nbase\r\nthird\r\nlast' });
});
it('never overwrites an overlapping user edit', () => {
  expect(mergeLocalUndoText('a\nagent\nz\n', 'a\nbase\nz\n', 'a\nuser\nz\n')).toMatchObject({
    kind: 'conflict',
  });
});
it('rejects ambiguous repeated-line matching rather than picking an alignment', () => {
  expect(mergeLocalUndoText('a\na\nx\n', 'a\nx\n', 'a\na\nuser\n')).toMatchObject({
    kind: 'conflict',
    reason: 'ambiguous_text',
  });
});
it('recognizes an already-applied identical inverse while preserving other user changes', () => {
  expect(mergeLocalUndoText('a\nagent\nz\n', 'a\nbase\nz\n', 'a\nbase\nZ\n')).toEqual({
    kind: 'merged',
    content: 'a\nbase\nZ\n',
  });
});
it('refuses binary text and oversized dynamic programming inputs with a fixed error', () => {
  expect(mergeLocalUndoText('a\0', 'b\0', 'u\0')).toMatchObject({
    kind: 'conflict',
    reason: 'unsupported_text',
  });
  const a = Array.from({ length: 1500 }, (_, i) => `a${i}\n`).join('');
  const b = Array.from({ length: 1500 }, (_, i) => `b${i}\n`).join('');
  const u = Array.from({ length: 1500 }, (_, i) => `u${i}\n`).join('');
  expect(mergeLocalUndoText(a, b, u)).toMatchObject({
    kind: 'conflict',
    reason: 'comparison_limit',
  });
});
