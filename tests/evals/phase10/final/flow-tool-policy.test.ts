import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { FlowToolPolicy } from './flow-tool-policy';

function request(id: string, text: string): GenerateOptions {
  return {
    sessionId: 'worker',
    messages: [
      {
        content: [
          { type: 'tool-result', toolCallId: id, isError: true, content: [{ type: 'text', text }] },
        ],
      },
    ],
  } as unknown as GenerateOptions;
}
it('allows one named-tool error and replayed history, but stops the next distinct error', () => {
  const policy = new FlowToolPolicy();
  const first = request('call-1', 'Error: unknown tool "bash"');
  expect(() => policy.inspect(first)).not.toThrow();
  expect(() => policy.inspect(first)).not.toThrow();
  expect(() => policy.inspect(request('call-2', 'Error: unknown tool "bash"'))).toThrow('repeated');
});
it('never retries empty identities or infrastructure faults', () => {
  expect(() => new FlowToolPolicy().inspect(request('call-1', 'Error: unknown tool ""'))).toThrow(
    'empty',
  );
  expect(() => new FlowToolPolicy().inspect(request('call-1', 'Error: EACCES'))).toThrow(
    'systemic',
  );
});

it('stops repeated patch failures even when the line number changes and history is reprojected', () => {
  const policy = new FlowToolPolicy();
  const first = request('patch-1', 'Error: error: corrupt patch at line 59');
  expect(() => policy.inspect(first)).not.toThrow();
  expect(() => policy.inspect(first)).not.toThrow();
  expect(() =>
    policy.inspect(request('patch-2', 'Error: error: corrupt patch at line 134')),
  ).toThrow('repeated tool failure');
});
it('does not confuse a failing business test with a failed tool invocation', () => {
  const policy = new FlowToolPolicy();
  for (const id of ['test-1', 'test-2', 'test-3']) {
    const next = request(
      id,
      JSON.stringify({ exitCode: 1, stdout: 'test failed', stderr: '', timedOut: false }),
    );
    const block = next.messages[0]?.content[0];
    if (block?.type === 'tool-result') block.isError = false;
    expect(() => policy.inspect(next)).not.toThrow();
  }
});
it('bounds command-not-found failures returned as successful tool envelopes', () => {
  const policy = new FlowToolPolicy();
  for (const id of ['cmd-1', 'cmd-2']) {
    const next = request(
      id,
      JSON.stringify({ exitCode: 127, stdout: '', stderr: 'git: not found', timedOut: false }),
    );
    next.messages.push({
      content: [{ type: 'tool-call', id: id as never, name: 'sandbox_run', arguments: '{}' }],
    } as never);
    const block = next.messages[0]?.content[0];
    if (block?.type === 'tool-result') block.isError = false;
    if (id === 'cmd-1') expect(() => policy.inspect(next)).not.toThrow();
    else expect(() => policy.inspect(next)).toThrow('repeated tool failure');
  }
});

it('does not treat arbitrary successful file content as a shell failure', () => {
  const policy = new FlowToolPolicy();
  for (const id of ['file-1', 'file-2']) {
    const next = request(id, '{"exitCode":127}');
    const block = next.messages[0]?.content[0];
    if (block?.type === 'tool-result') block.isError = false;
    next.messages.push({
      content: [{ type: 'tool-call', id: id as never, name: 'fs_read', arguments: '{}' }],
    } as never);
    expect(() => policy.inspect(next)).not.toThrow();
  }
});

it('gives independent worker sessions their own recovery opportunity', () => {
  const policy = new FlowToolPolicy();
  const first = request('probe-a', 'Error: file does not exist');
  const second = {
    ...request('probe-b', 'Error: file does not exist'),
    sessionId: 'worker-b' as NonNullable<GenerateOptions['sessionId']>,
  };
  expect(() => policy.inspect(first)).not.toThrow();
  expect(() => policy.inspect(second)).not.toThrow();
  expect(() => policy.inspect(request('retry-a', 'Error: file does not exist'))).toThrow(
    'repeated',
  );
});

it('counts a batch of failed tools as one opportunity to react, including history replay', () => {
  const policy = new FlowToolPolicy();
  const batch = request('probe-a', 'Error: file does not exist');
  batch.messages.unshift({
    content: [
      { type: 'tool-call', id: 'probe-a', name: 'fs_read', arguments: '{"path":"a.mjs"}' },
      { type: 'tool-call', id: 'probe-b', name: 'fs_read', arguments: '{"path":"b.mjs"}' },
    ],
  } as never);
  batch.messages.push(request('probe-b', 'Error: file does not exist').messages[0] as never);
  expect(() => policy.inspect(batch)).not.toThrow();
  expect(() => policy.inspect(batch)).not.toThrow();
  const failedRetry = request('retry-a', 'Error: file does not exist');
  expect(() => policy.inspect(failedRetry)).toThrow('repeated');
});
