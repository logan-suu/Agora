import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { JsonModelConfigStore } from '../src/model-config-store';

it('rejects unsafe endpoints, symlinked storage, wrong keys and competing task goals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-model-safety-'));
  const master = randomBytes(32).toString('base64');
  try {
    const store = new JsonModelConfigStore(root, () => master);
    const options = { baseURL: 'https://example.com/v1', contextWindow: 32768, maxTokens: 4096 };
    for (const baseURL of [
      'http://example.com/v1',
      'https://user:secret@example.com/v1',
      'https://example.com/v1?key=x',
      'https://example.com/v1#secret',
      'file:///etc/passwd',
    ])
      await expect(store.createConnection('p', { ...options, baseURL })).rejects.toThrow();
    const connection = await store.createConnection('p', options, 'secret-test');
    await expect(
      new JsonModelConfigStore(root, () => randomBytes(32).toString('base64')).resolveKey(
        'p',
        connection.id,
      ),
    ).rejects.toThrow('cannot be decrypted');
    await mkdir(join(root, 'projects/linked'));
    await symlink(
      join(root, 'projects/p/model-connections'),
      join(root, 'projects/linked/model-connections'),
    );
    await expect(store.loadConnection('linked', connection.id)).rejects.toThrow('directory');
    const binding = {
      version: 1 as const,
      projectId: 'p',
      taskId: 'concurrent',
      goal: 'first',
      roles: [{ role: 'CODER', model: 'one', connectionId: connection.id }],
    };
    const result = await Promise.allSettled([
      store.bindTask(binding),
      store.bindTask({ ...binding, goal: 'second' }),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('encrypts project credentials, survives restart, and rejects corruption and wrong scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-model-config-'));
  const key = randomBytes(32).toString('base64');
  try {
    const store = new JsonModelConfigStore(root, () => key);
    const connection = await store.createConnection(
      'project',
      { baseURL: 'https://example.com/v1/', contextWindow: 32768, maxTokens: 4096 },
      'test-secret-value',
    );
    const path = join(root, 'projects/project/model-connections', `${connection.id}.json`);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('test-secret-value');
    expect(
      await new JsonModelConfigStore(root, () => key).resolveKey('project', connection.id),
    ).toBe('test-secret-value');
    await expect(store.loadConnection('other', connection.id)).rejects.toThrow();
    const corrupted = JSON.parse(raw);
    corrupted.baseURL = 'https://other.example/v1';
    await writeFile(path, JSON.stringify(corrupted));
    await expect(store.resolveKey('project', connection.id)).rejects.toThrow();
    await expect(
      new JsonModelConfigStore(root, () => undefined).createConnection(
        'project',
        { baseURL: 'https://example.com', contextWindow: 32768, maxTokens: 4096 },
        'key',
      ),
    ).rejects.toThrow();
    expect((await readdir(join(root, 'projects/project/model-connections'))).length).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('freezes the first task model binding and rejects a mismatched task goal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-model-bind-'));
  try {
    const store = new JsonModelConfigStore(root);
    const first = {
      version: 1 as const,
      projectId: 'p',
      taskId: 't',
      goal: 'goal',
      roles: [{ role: 'CODER', model: 'a' }],
    };
    await store.bindTask(first);
    expect(await store.bindTask({ ...first, roles: [{ role: 'CODER', model: 'b' }] })).toEqual(
      first,
    );
    await expect(store.bindTask({ ...first, goal: 'changed' })).rejects.toThrow();
    await expect(store.loadTask({ projectId: '../bad', taskId: 't' })).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
