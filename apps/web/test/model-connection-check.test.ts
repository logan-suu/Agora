// Only the external provider response is substituted; persistence, encryption,
// roster CAS and task freezing are real. This unit is not the real-model G5.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { JsonModelConfigStore } from '@agora/runtime-state';
import { expect, it } from 'vitest';
import { ChannelStream } from '../src/server/channel-stream';
import type { LocalBootstrap } from '../src/server/local-startup';
import { MessageRuntime } from '../src/server/message-runtime';
import { ModelSettingsService } from '../src/server/model-settings';

it('drains an admitted model check and refuses new settings work while stopping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-connection-drain-'));
  const host = globalThis as typeof globalThis & { __agoraLocalBootstrap?: LocalBootstrap };
  const previous = host.__agoraLocalBootstrap;
  const boot: LocalBootstrap = {
    system: {
      read: async () => {
        throw Error('unused credential stub');
      },
      create: async () => {
        throw Error('unused credential stub');
      },
    },
    adopt: false,
    draining: false,
    drains: new Set(),
  };
  host.__agoraLocalBootstrap = boot;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = new JsonModelConfigStore(root, () => undefined);
  let checking: ReturnType<ModelSettingsService['execute']> | undefined;
  let calls = 0;
  const service = new ModelSettingsService(
    new MessageRuntime(root, new ChannelStream(), DEFAULT_ROSTER),
    store,
    async () => {
      calls++;
      enter();
      await pending;
    },
  );
  try {
    const settings = await service.get('p');
    const draft = {
      action: 'test' as const,
      projectId: 'p',
      target: 'all',
      expectedRevision: settings.revision,
      model: 'm',
      baseURL: 'http://localhost:1234/v1',
      contextWindow: 4096,
      maxTokens: 1024,
      auth: 'none' as const,
    };
    checking = service.execute(draft);
    await entered;
    boot.draining = true;
    let drained = false;
    const drain = Promise.all([...boot.drains].map((fn) => fn())).then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drained).toBe(false);
    await expect(service.execute(draft)).rejects.toThrow('Agora is stopping');
    expect(calls).toBe(1);
    release();
    const result = await checking;
    await drain;
    if (!('connectionId' in result)) throw Error('missing connection proof');
    expect(await store.connectionChecked('p', result.connectionId, 'm')).toBe(true);
  } finally {
    release();
    await checking?.catch(() => {});
    if (previous) host.__agoraLocalBootstrap = previous;
    else delete host.__agoraLocalBootstrap;
    await rm(root, { recursive: true, force: true });
  }
});

it('binds a successful check to the saved connection and model across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-connection-check-'));
  const key = randomBytes(32).toString('base64');
  const store = new JsonModelConfigStore(root, () => key);
  const messages = new MessageRuntime(root, new ChannelStream(), DEFAULT_ROSTER);
  let calls = 0;
  const service = new ModelSettingsService(messages, store, async () => {
    calls++;
  });
  try {
    const initial = await service.get('p');
    const draft = {
      action: 'test' as const,
      projectId: 'p',
      target: 'all',
      expectedRevision: initial.revision,
      model: 'user-model',
      baseURL: 'https://example.com/v1',
      contextWindow: 32768,
      maxTokens: 4096,
      auth: 'replace' as const,
      apiKey: 'test-secret',
    };
    const checked = await service.execute(draft);
    if (!('connectionId' in checked)) throw Error('missing checked connection');
    expect((await service.get('p')).roles.every((r) => !r.connectionId)).toBe(true);
    await service.execute({
      ...draft,
      action: 'save',
      auth: 'keep',
      apiKey: '',
      connectionId: checked.connectionId,
    });
    const binding = await service.freeze({ projectId: 'p', taskId: 't' }, 'goal');
    await service.assertChecked(binding);
    expect(calls).toBe(1);
    expect((await service.get('p')).roles.every((r) => r.connectionChecked)).toBe(true);
    const restarted = new ModelSettingsService(
      new MessageRuntime(root, new ChannelStream(), DEFAULT_ROSTER),
      store,
    );
    await restarted.assertChecked(binding);
    const saved = await service.get('p');
    await service.execute({
      ...draft,
      action: 'save',
      auth: 'keep',
      apiKey: '',
      connectionId: checked.connectionId,
      target: 'CODER',
      model: 'different-model',
      expectedRevision: saved.revision,
    });
    const changed = await service.freeze({ projectId: 'p', taskId: 'next' }, 'next');
    await expect(service.assertChecked(changed)).rejects.toThrow('Connection check required');
    await service.assertChecked(binding);
    expect(JSON.stringify(await service.get('p'))).not.toContain('test-secret');
    await expect(service.assertChecked({ ...binding, projectId: 'other' })).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not turn a failed check or unchecked saved settings into startup approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-connection-failed-'));
  const store = new JsonModelConfigStore(root, () => randomBytes(32).toString('base64'));
  const service = new ModelSettingsService(
    new MessageRuntime(root, new ChannelStream(), DEFAULT_ROSTER),
    store,
    async () => {
      throw Error('private provider body');
    },
  );
  try {
    const initial = await service.get('p');
    const draft = {
      action: 'test' as const,
      projectId: 'p',
      target: 'all',
      expectedRevision: initial.revision,
      model: 'm',
      baseURL: 'http://localhost:1234/v1',
      contextWindow: 4096,
      maxTokens: 1024,
      auth: 'none' as const,
    };
    await expect(service.execute(draft)).rejects.toThrow('Connection test failed');
    await service.execute({ ...draft, action: 'save' });
    const binding = await service.freeze({ projectId: 'p', taskId: 't' }, 'g');
    await expect(service.assertChecked(binding)).rejects.toThrow('Connection check required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
