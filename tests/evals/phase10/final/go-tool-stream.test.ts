// Synthetic stream frames reproduce the recorded Go identity-clearing behavior without network I/O.
import { CallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { normalizeGoToolStream } from './go-tool-stream';

async function* stream(conflict = false): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 1, blockType: 'tool-call' };
  yield {
    type: 'tool-call-delta',
    index: 1,
    id: CallId('call-1'),
    name: 'read_audit',
    argumentsDelta: '',
  };
  yield {
    type: 'tool-call-delta',
    index: 1,
    id: CallId(''),
    name: conflict ? 'other_tool' : null,
    argumentsDelta: '{}',
  } as unknown as StreamChunk;
  yield {
    type: 'block-end',
    index: 1,
    block: { type: 'tool-call', id: CallId(''), name: '', arguments: '{}' },
  };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
it('preserves the recorded identity and exact arguments across null/empty continuations', async () => {
  const chunks = [];
  for await (const chunk of normalizeGoToolStream(stream())) chunks.push(chunk);
  expect(chunks[2]).toMatchObject({ id: 'call-1', name: 'read_audit', argumentsDelta: '{}' });
  expect(chunks[3]).toMatchObject({ block: { id: 'call-1', name: 'read_audit', arguments: '{}' } });
});
it('drains conflicting streams before rejecting without publishing any tool blocks', async () => {
  let drained = false;
  async function* conflict() {
    yield* stream(true);
    drained = true;
  }
  const seen: StreamChunk[] = [];
  const consume = async () => {
    for await (const chunk of normalizeGoToolStream(conflict())) seen.push(chunk);
  };
  await expect(consume()).rejects.toThrow('conflicting');
  expect(drained).toBe(true);
  expect(seen).toEqual([]);
});
