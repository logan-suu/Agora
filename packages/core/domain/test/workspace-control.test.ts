import { describe, expect, it } from 'vitest';
import { parseWorkspaceControl } from '../src/workspace-control';

const common = { projectId: 'project', taskId: 'task', actionId: 'action', expectedRevision: 0 };
const grant = {
  ...common,
  selectionRef: 'selection',
  policyProposalId: 'proposal',
  inputHash: 'a'.repeat(64),
};
const text = (verb: string, value: unknown) => `/workspace ${verb} ${JSON.stringify(value)}`;

describe('Leader workspace control grammar', () => {
  it('only parses an explicit workspace command', () => {
    expect(parseWorkspaceControl('please grant access')).toBeUndefined();
    expect(parseWorkspaceControl('explain /workspace grant')).toBeUndefined();
    expect(parseWorkspaceControl(text('grant', grant))).toEqual({
      kind: 'workspace_control',
      verb: 'grant',
      ...grant,
    });
  });
  it.each([
    ['revoke', { ...common, grantId: 'grant' }],
    ['takeover', { ...common, workspaceId: 'workspace', paths: ['src/index.ts', '中文/文件.ts'] }],
    ['return', { ...common, takeoverReceiptId: 'takeover' }],
    ['apply', { ...common, deliveryProposalId: 'delivery', inputHash: 'a'.repeat(64) }],
    ['undo', { ...common, fileApplyReceiptId: 'receipt', inputHash: 'a'.repeat(64) }],
  ])('parses the closed %s shape without granting execution', (verb, value) => {
    expect(parseWorkspaceControl(text(verb as string, value))).toEqual({
      kind: 'workspace_control',
      verb,
      ...(value as object),
    });
  });
  it.each([
    { ...grant, path: '/outside' },
    { ...grant, expectedRevision: -1 },
    { ...grant, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...grant, inputHash: 'short' },
    { ...grant, actionId: '../escape' },
    { ...grant, selectionRef: null },
    { ...grant, projectId: '' },
    { ...grant, policyProposalId: undefined },
  ])('rejects malformed or broadened grant input', (value) => {
    expect(() => parseWorkspaceControl(text('grant', value))).toThrow('invalid_workspace_control');
  });
  it.each(['../secret', '/outside', 'src//file', 'src/./file', 'src/../file', 'src/\u0000file'])(
    'rejects noncanonical takeover path %s',
    (path) => {
      expect(() =>
        parseWorkspaceControl(
          text('takeover', { ...common, workspaceId: 'workspace', paths: [path] }),
        ),
      ).toThrow('invalid_workspace_control');
    },
  );
  it('rejects duplicate paths, empty scope and extra commands', () => {
    for (const paths of [[], ['a', 'a']])
      expect(() =>
        parseWorkspaceControl(text('takeover', { ...common, workspaceId: 'workspace', paths })),
      ).toThrow('invalid_workspace_control');
    expect(() => parseWorkspaceControl(`${text('grant', grant)}\n/workspace revoke {}`)).toThrow(
      'invalid_workspace_control',
    );
    expect(() => parseWorkspaceControl('/workspace destroy {}')).toThrow(
      'invalid_workspace_control',
    );
  });
  it('rejects duplicate JSON keys rather than silently taking the last scope', () => {
    const serialized = JSON.stringify(grant).replace(
      '"projectId":"project"',
      '"projectId":"other","projectId":"project"',
    );
    expect(() => parseWorkspaceControl(`/workspace grant ${serialized}`)).toThrow(
      'invalid_workspace_control',
    );
  });
});
