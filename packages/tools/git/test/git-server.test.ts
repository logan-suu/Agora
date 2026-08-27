import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeRegistry } from '@agora/tools-fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitServer } from '../src/git-server';

type TextBlock = { type: string; text: string };

function textOf(content: unknown): string {
  return (content as TextBlock[])[0]?.text ?? '';
}

/**
 * Round-trip the git-server over the SDK's real in-memory transport (G5: real
 * execution, not a test double). Every tool drives the real system `git` binary
 * through simple-git against real temp directories; only the transport is the
 * SDK's InMemoryTransport.
 */
describe('git-server MCP round-trip', () => {
  const clients: Client[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function connect(registry: WorktreeRegistry) {
    const server = createGitServer({ registry });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'git-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('creates a worktree and applies a patch through the MCP boundary', async () => {
    const registry = new WorktreeRegistry();
    const client = await connect(registry);

    const created = await client.callTool({
      name: 'createWorktree',
      arguments: { taskId: 't1', name: 'feature-mcp' },
    });
    expect(created.isError).toBeFalsy();
    const { path, branch } = JSON.parse(textOf(created.content));
    roots.push(path);
    expect(branch).toBe('feature-mcp');
    expect(registry.canonicalOf(path)).toBeDefined();

    writeFileSync(join(path, 'a.txt'), 'hello\n');
    const git = simpleGit(path);
    await git.add(['-A']);
    await git.commit('base');

    const patch = `${[
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+world',
    ].join('\n')}\n`;
    const applied = await client.callTool({
      name: 'applyPatch',
      arguments: { worktree: path, patch },
    });
    expect(applied.isError).toBeFalsy();
    const { commitId } = JSON.parse(textOf(applied.content));
    expect(commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('world\n');
  });

  it('serves diff in both modes through the MCP boundary', async () => {
    const registry = new WorktreeRegistry();
    const client = await connect(registry);

    const created = await client.callTool({
      name: 'createWorktree',
      arguments: { taskId: 't1', name: 'feature-diff' },
    });
    const { path } = JSON.parse(textOf(created.content));
    roots.push(path);

    writeFileSync(join(path, 'a.txt'), 'hello\n');
    const git = simpleGit(path);
    await git.add(['-A']);
    await git.commit('base');
    const baseCommit = (await git.revparse(['HEAD'])).trim();
    writeFileSync(join(path, 'a.txt'), 'world\n');

    const working = await client.callTool({
      name: 'diff',
      arguments: { worktree: path },
    });
    expect(working.isError).toBeFalsy();
    expect(textOf(working.content)).toContain('-hello');
    expect(textOf(working.content)).toContain('+world');

    await git.add(['-A']);
    await git.commit('second');
    const vsRef = await client.callTool({
      name: 'diff',
      arguments: { worktree: path, ref: baseCommit },
    });
    expect(vsRef.isError).toBeFalsy();
    expect(textOf(vsRef.content)).toContain('-hello');
    expect(textOf(vsRef.content)).toContain('+world');
  });

  it('serves merge through the MCP boundary', async () => {
    const registry = new WorktreeRegistry();
    const main = mkdtempSync(join(tmpdir(), 'agora-git-main-'));
    roots.push(main);
    const server = createGitServer({ registry, mainRepoPath: main });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'git-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const created = await client.callTool({
      name: 'createWorktree',
      arguments: { taskId: 't1', name: 'feature-merge' },
    });
    const { path } = JSON.parse(textOf(created.content));
    roots.push(path);
    writeFileSync(join(path, 'feature.txt'), 'feature\n');
    const git = simpleGit(path);
    await git.add(['-A']);
    await git.commit('feature commit');

    const mainGit = simpleGit(main);
    const defaultBranch = (await mainGit.revparse(['--abbrev-ref', 'HEAD'])).trim();

    const merged = await client.callTool({
      name: 'merge',
      arguments: { base: defaultBranch, branch: 'feature-merge' },
    });
    expect(merged.isError).toBeFalsy();
    const result = JSON.parse(textOf(merged.content));
    expect(result.ok).toBe(true);
  });

  it('returns isError for an unregistered worktree', async () => {
    const registry = new WorktreeRegistry();
    const client = await connect(registry);

    const res = await client.callTool({
      name: 'diff',
      arguments: { worktree: '/tmp/not-registered' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res.content)).toContain('not registered');
  });
});
