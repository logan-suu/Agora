// Real JSON stores and roster CAS; no model request is made by saving settings.

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { JsonModelConfigStore } from '@agora/runtime-state';
import { expect, it } from 'vitest';
import { ChannelStream } from '../src/server/channel-stream';
import { MessageRuntime } from '../src/server/message-runtime';
import { ModelSettingsService, modelSettingsHandlers } from '../src/server/model-settings';

it('restores full capacity with the encrypted key while keeping old task connections immutable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-model-capacity-'));
  const masterKey = randomBytes(32).toString('base64');
  const store = new JsonModelConfigStore(root, () => masterKey);
  const service = new ModelSettingsService(
    new MessageRuntime(root, new ChannelStream(), DEFAULT_ROSTER),
    store,
  );
  try {
    const initial = await service.get('p');
    const command = {
      action: 'save' as const,
      projectId: 'p',
      target: 'all',
      expectedRevision: initial.revision,
      model: 'deepseek-v4-flash',
      baseURL: 'https://opencode.ai/zen/go/v1',
      contextWindow: 65536,
      maxTokens: 8192,
      auth: 'replace' as const,
      apiKey: 'local-test-key',
    };
    await service.execute(command);
    const before = await service.get('p');
    const oldConnection = before.roles[0]?.connectionId;
    if (!oldConnection) throw new Error('missing connection');
    const oldBinding = await service.freeze({ projectId: 'p', taskId: 'before' }, 'old goal');
    await service.execute({
      ...command,
      expectedRevision: before.revision,
      auth: 'keep',
      apiKey: '',
      connectionId: oldConnection,
      contextWindow: 1000000,
    });
    const after = await service.get('p');
    expect(after.roles).toHaveLength(6);
    expect(
      after.roles.every(
        (r) => r.contextWindow === 1000000 && r.maxTokens === 8192 && r.apiKeyConfigured,
      ),
    ).toBe(true);
    const newConnection = after.roles[0]?.connectionId;
    if (!newConnection) throw new Error('missing new connection');
    expect(newConnection).not.toBe(oldConnection);
    expect(await store.resolveKey('p', newConnection)).toBe('local-test-key');
    expect((await store.loadConnection('p', oldConnection)).contextWindow).toBe(65536);
    expect(JSON.stringify(after)).not.toContain('local-test-key');
    expect(await service.freeze({ projectId: 'p', taskId: 'before' }, 'old goal')).toEqual(
      oldBinding,
    );
    const newBinding = await service.freeze({ projectId: 'p', taskId: 'after' }, 'new goal');
    await service.execute({
      ...command,
      expectedRevision: after.revision,
      auth: 'keep',
      apiKey: '',
      connectionId: newConnection,
      contextWindow: 1000000,
      maxTokens: 384000,
    });
    const fullBinding = await service.freeze({ projectId: 'p', taskId: 'full' }, 'full limits');
    for (const [binding, capacity] of [
      [oldBinding, 65536],
      [newBinding, 1000000],
    ] as const) {
      const routes = await service.executorRoutes(binding);
      expect([...routes.values()].every((r) => r.compatible?.maxTokens === 8192)).toBe(true);
      expect([...routes.values()].every((r) => r.compatible?.contextWindow === capacity)).toBe(
        true,
      );
    }
    const fullRoutes = await service.executorRoutes(fullBinding);
    expect(
      [...fullRoutes.values()].every(
        (r) => r.compatible?.contextWindow === 1000000 && r.compatible.maxTokens === 384000,
      ),
    ).toBe(true);
    expect((await store.loadConnection('p', newConnection)).maxTokens).toBe(8192);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('updates disabled/custom Agents and rejects a competing atomic batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-model-cas-'));
  const messages = new MessageRuntime(root, new ChannelStream(), DEFAULT_ROSTER);
  const service = new ModelSettingsService(messages);
  try {
    await service.get('p');
    await messages.roster.disableRole('p', 'TESTER');
    await messages.roster.addRole('p', {
      role: 'RELEASE_MANAGER',
      executor: 'harness',
      systemPrompt: 'Review releases',
      tools: [],
      projection: ['global.summary'],
      routeWhen: 'leaderAssignment',
    });
    const before = await service.get('p');
    const command = {
      action: 'save' as const,
      projectId: 'p',
      expectedRevision: before.revision,
      target: 'all',
      model: 'one',
      baseURL: 'http://localhost:4567/v1',
      contextWindow: 32768,
      maxTokens: 4096,
      auth: 'none' as const,
    };
    const results = await Promise.allSettled([
      service.execute(command),
      service.execute({ ...command, model: 'two' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const saved = await service.get('p');
    expect(saved.revision).toBe(before.revision + 1);
    expect(new Set(saved.roles.map((r) => r.model)).size).toBe(1);
    expect(saved.roles.find((r) => r.role === 'TESTER')?.status).toBe('disabled');
    expect(saved.roles.find((r) => r.role === 'RELEASE_MANAGER')?.connectionId).toBeDefined();
    // The real lifecycle passes TaskStartInput, which contains request-only fields.
    const startInput = { projectId: 'p', taskId: 'old', requestId: 'browser-start', goal: 'goal' };
    const bound = await service.freeze(startInput, startInput.goal);
    expect(Object.keys(bound).sort()).toEqual(
      ['version', 'projectId', 'taskId', 'goal', 'defaultModel', 'roles'].sort(),
    );
    await service.execute({
      action: 'reset',
      projectId: 'p',
      expectedRevision: saved.revision,
      target: 'all',
    });
    expect((await service.get('p')).roles.every((r) => r.connectionId === undefined)).toBe(true);
    expect((await service.executorRoutes(bound)).size).toBe(7);
    expect(
      await new ModelSettingsService(
        new MessageRuntime(root, new ChannelStream(), DEFAULT_ROSTER),
      ).freeze({ projectId: 'p', taskId: 'old' }, 'goal'),
    ).toEqual(bound);
    const fresh = await service.get('p');
    const response = await modelSettingsHandlers(service).POST(
      new Request('http://localhost/api/model-settings', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3103',
          origin: 'http://127.0.0.1:3103',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...command, expectedRevision: fresh.revision }),
      }),
    );
    expect(response.status).toBe(200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('saves every configurable role atomically, permits one override, and freezes task routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-model-api-'));
  const key = randomBytes(32).toString('base64');
  const messages = new MessageRuntime(root, new ChannelStream(), DEFAULT_ROSTER);
  const service = new ModelSettingsService(messages, new JsonModelConfigStore(root, () => key));
  const handlers = modelSettingsHandlers(service);
  const post = (body: unknown, origin = 'http://localhost') =>
    handlers.POST(
      new Request('http://localhost/api/model-settings', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  try {
    const initial = await service.get('p');
    const body = {
      action: 'save',
      projectId: 'p',
      expectedRevision: initial.revision,
      target: 'all',
      model: 'shared-model',
      baseURL: 'https://example.com/v1',
      contextWindow: 32768,
      maxTokens: 4096,
      auth: 'replace',
      apiKey: 'private-test-key',
    };
    const saved = await post(body);
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain('private-test-key');
    const all = await service.get('p');
    expect(all.roles).toHaveLength(6);
    expect(all.roles.every((r) => r.model === 'shared-model' && r.apiKeyConfigured)).toBe(true);
    const frozen = await service.freeze({ projectId: 'p', taskId: 't' }, 'goal');
    expect((await post({ ...body, model: 'stale' })).status).toBe(409);
    expect(
      (
        await post({
          ...body,
          expectedRevision: all.revision,
          target: 'CODER',
          model: 'code-model',
          auth: 'keep',
          apiKey: undefined,
          connectionId: all.roles[0]?.connectionId,
        })
      ).status,
    ).toBe(200);
    const changed = await service.get('p');
    expect(changed.roles.filter((r) => r.model === 'code-model').map((r) => r.role)).toEqual([
      'CODER',
    ]);
    expect(await service.freeze({ projectId: 'p', taskId: 't' }, 'goal')).toEqual(frozen);
    expect(
      (await service.freeze({ projectId: 'p', taskId: 'new' }, 'goal')).roles.find(
        (r) => r.role === 'CODER',
      )?.model,
    ).toBe('code-model');
    expect(
      (await post({ ...body, expectedRevision: changed.revision }, 'https://evil.example')).status,
    ).toBe(403);
    expect(
      (
        await post({
          ...body,
          expectedRevision: changed.revision,
          auth: 'keep',
          apiKey: undefined,
          connectionId: all.roles[0]?.connectionId,
          baseURL: 'https://elsewhere.example/v1',
        })
      ).status,
    ).toBe(400);
    expect((await service.get('p')).revision).toBe(changed.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
